import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import { parseSha256Sum, patchCliNpmChecksums } from "./patch-cli-npm-checksums.mjs";

function write(root, relativePath, content) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

// A minimal `binary-install.js` carrying the real cargo-dist 0.32.0 download/extract anchor
// (indentation confirmed against a real generated copy of the file), so the fixture exercises
// the actual replace target rather than a hand-simplified stand-in.
const BINARY_INSTALL_JS = `class Package {
  install(directory) {
    return new Promise((resolve, reject) => {
      https.get(this.url, (res) => {
        this._download(res, directory, (tempFile) => {
          try {
            let tempFile2 = tempFile;
            const sink = res.pipe(createWriteStream(tempFile2));
            sink.on("error", (err) => reject(err));
            sink.on("close", () => {
              if (/\\.tar\\.*/.test(this.zipExt)) {
                const result = spawnSync("tar", ["xf", tempFile2, "-C", directory]);
                resolve(result);
              }
            });
          } catch (err) {
            reject(err);
          }
        });
      });
    });
  }
}
`;

const DIGEST_DARWIN_ARM = "419505ba889a06a1210687b8bd6fdfe8f850923641f99259f315627541cbf25a";
const DIGEST_LINUX_X64 = "aa5e78f5696511e2331658f176523c99202b4ecdb2a44a918c80e8071175bbd2";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warble-patch-cli-npm-checksums-"));
  write(
    root,
    "package-dir/package.json",
    JSON.stringify(
      {
        name: "@warble/cli",
        version: "0.8.0",
        supportedPlatforms: {
          "aarch64-apple-darwin": {
            artifactName: "warble-cli-aarch64-apple-darwin.tar.xz",
            bins: { warble: "warble" },
            zipExt: ".tar.xz",
          },
          "x86_64-unknown-linux-gnu": {
            artifactName: "warble-cli-x86_64-unknown-linux-gnu.tar.xz",
            bins: { warble: "warble" },
            zipExt: ".tar.xz",
          },
        },
      },
      null,
      2,
    ),
  );
  write(root, "package-dir/binary-install.js", BINARY_INSTALL_JS);
  write(
    root,
    "sha256.sum",
    [
      `${DIGEST_DARWIN_ARM} *warble-cli-aarch64-apple-darwin.tar.xz`,
      `${DIGEST_LINUX_X64} *warble-cli-x86_64-unknown-linux-gnu.tar.xz`,
      "199f99b3624730da6e161524cf6a515adf17553d3ac17b0d2747a87dd054f6b8 *source.tar.gz",
    ].join("\n") + "\n",
  );
  return root;
}

function readPackageJson(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "package-dir", "package.json"), "utf8"));
}

function readBinaryInstall(root) {
  return fs.readFileSync(path.join(root, "package-dir", "binary-install.js"), "utf8");
}

test("parseSha256Sum parses sha256sum -b style lines into a filename->digest map", () => {
  const map = parseSha256Sum(
    `${DIGEST_DARWIN_ARM} *warble-cli-aarch64-apple-darwin.tar.xz\n\n${DIGEST_LINUX_X64} *warble-cli-x86_64-unknown-linux-gnu.tar.xz\n`,
  );
  assert.equal(map.get("warble-cli-aarch64-apple-darwin.tar.xz"), DIGEST_DARWIN_ARM);
  assert.equal(map.get("warble-cli-x86_64-unknown-linux-gnu.tar.xz"), DIGEST_LINUX_X64);
  assert.equal(map.size, 2);
});

test("parseSha256Sum rejects a line that is not a valid checksum entry", () => {
  assert.throws(() => parseSha256Sum("not-a-checksum-line\n"), /not a valid/);
});

test("parseSha256Sum rejects a digest that is not 64 hex characters", () => {
  assert.throws(() => parseSha256Sum("abcd *somefile\n"), /not a valid/);
});

test("parseSha256Sum rejects a duplicate filename entry", () => {
  assert.throws(
    () => parseSha256Sum(`${DIGEST_DARWIN_ARM} *dup.tar.xz\n${DIGEST_LINUX_X64} *dup.tar.xz\n`),
    /duplicate entry/,
  );
});

test("bakes each platform's sha256 into package.json and gates extraction in binary-install.js", () => {
  const root = fixture();
  const result = patchCliNpmChecksums(path.join(root, "package-dir"), path.join(root, "sha256.sum"));

  assert.deepEqual(result.patchedTargets.sort(), ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"]);

  const onDiskPkg = readPackageJson(root);
  assert.equal(onDiskPkg.supportedPlatforms["aarch64-apple-darwin"].sha256, DIGEST_DARWIN_ARM);
  assert.equal(onDiskPkg.supportedPlatforms["x86_64-unknown-linux-gnu"].sha256, DIGEST_LINUX_X64);
  // Pre-existing fields survive untouched.
  assert.equal(onDiskPkg.supportedPlatforms["aarch64-apple-darwin"].artifactName, "warble-cli-aarch64-apple-darwin.tar.xz");
  assert.equal(onDiskPkg.name, "@warble/cli");

  const onDiskBinaryInstall = readBinaryInstall(root);
  assert.match(onDiskBinaryInstall, /warble: verify downloaded archive checksum before extracting/);
  assert.match(onDiskBinaryInstall, /this\.platform\.sha256/);
  assert.match(onDiskBinaryInstall, /createHash\("sha256"\)/);
  // The original extraction logic still follows the verification, untouched.
  assert.match(onDiskBinaryInstall, /if \(\/\\\.tar\\\.\*\/\.test\(this\.zipExt\)\) \{/);
});

// Everything above asserts that the injected block is *present*; these run it. That distinction
// matters: a textual assertion on `createHash("sha256")` still passes if the comparison guarding
// it has been made vacuous (short-circuiting `actualSha256 !== expectedSha256` leaves the string
// intact), so without these three cases the entire verification the patch exists to add is
// behaviourally untested. Rather than stand up an HTTP server and drive the real installer, this
// slices the injected statements straight out of the patched file and calls them with a real
// temp file -- so it is the emitted bytes under test, not a re-implementation of them.
function runInjectedVerification(root, { sha256, fileContents }) {
  const patched = fs.readFileSync(path.join(root, "package-dir/binary-install.js"), "utf8");
  const start = patched.indexOf("const expectedSha256 = this.platform.sha256;");
  const end = patched.indexOf("if (/\\.tar\\.*/.test(this.zipExt))");
  assert.ok(start !== -1 && end > start, "could not slice the injected verification block");
  const body = patched.slice(start, end);

  const tempFile = path.join(root, "downloaded.tar.xz");
  fs.writeFileSync(tempFile, fileContents);

  const rejections = [];
  const reject = (error) => {
    rejections.push(error);
    return "REJECTED";
  };
  const platform = sha256 === undefined ? {} : { sha256 };
  const outcome = new Function(
    "tempFile",
    "reject",
    "require",
    `${body}\nreturn "PROCEEDED_TO_EXTRACT";`,
  ).call({ platform, filename: "downloaded.tar.xz" }, tempFile, reject, createRequire(import.meta.url));

  return { outcome, rejections };
}

test("the injected block lets a matching digest proceed to extraction", () => {
  const root = fixture();
  patchCliNpmChecksums(path.join(root, "package-dir"), path.join(root, "sha256.sum"));
  const contents = "genuine archive bytes";
  const digest = createRequire(import.meta.url)("node:crypto")
    .createHash("sha256")
    .update(contents)
    .digest("hex");

  const { outcome, rejections } = runInjectedVerification(root, { sha256: digest, fileContents: contents });
  assert.equal(rejections.length, 0);
  assert.equal(outcome, "PROCEEDED_TO_EXTRACT");
});

test("the injected block rejects a digest that does not match the downloaded bytes", () => {
  const root = fixture();
  patchCliNpmChecksums(path.join(root, "package-dir"), path.join(root, "sha256.sum"));

  const { outcome, rejections } = runInjectedVerification(root, {
    sha256: "0".repeat(64),
    fileContents: "tampered archive bytes",
  });
  assert.equal(outcome, "REJECTED");
  assert.equal(rejections.length, 1);
  assert.match(rejections[0].message, /checksum mismatch for downloaded\.tar\.xz/);
  assert.match(rejections[0].message, /may be corrupted or tampered with/);
});

test("the injected block refuses to extract when no baked digest is present", () => {
  const root = fixture();
  patchCliNpmChecksums(path.join(root, "package-dir"), path.join(root, "sha256.sum"));

  const { outcome, rejections } = runInjectedVerification(root, {
    sha256: undefined,
    fileContents: "genuine archive bytes",
  });
  assert.equal(outcome, "REJECTED");
  assert.equal(rejections.length, 1);
  assert.match(rejections[0].message, /refusing to extract an unverified download/);
});

test("rejects a package.json whose name is not @warble/cli", () => {
  const root = fixture();
  write(
    root,
    "package-dir/package.json",
    JSON.stringify({ name: "@warble/warble-cli", version: "0.8.0", supportedPlatforms: {} }, null, 2),
  );
  assert.throws(
    () => patchCliNpmChecksums(path.join(root, "package-dir"), path.join(root, "sha256.sum")),
    /expected name "@warble\/cli"/,
  );
});

test("rejects a package.json missing a version", () => {
  const root = fixture();
  write(root, "package-dir/package.json", JSON.stringify({ name: "@warble/cli", supportedPlatforms: {} }, null, 2));
  assert.throws(
    () => patchCliNpmChecksums(path.join(root, "package-dir"), path.join(root, "sha256.sum")),
    /missing a non-empty string version/,
  );
});

test("rejects a package.json missing supportedPlatforms", () => {
  const root = fixture();
  write(root, "package-dir/package.json", JSON.stringify({ name: "@warble/cli", version: "0.8.0" }, null, 2));
  assert.throws(
    () => patchCliNpmChecksums(path.join(root, "package-dir"), path.join(root, "sha256.sum")),
    /missing a supportedPlatforms object/,
  );
});

test("rejects a package.json with an empty supportedPlatforms", () => {
  const root = fixture();
  write(
    root,
    "package-dir/package.json",
    JSON.stringify({ name: "@warble/cli", version: "0.8.0", supportedPlatforms: {} }, null, 2),
  );
  assert.throws(
    () => patchCliNpmChecksums(path.join(root, "package-dir"), path.join(root, "sha256.sum")),
    /supportedPlatforms is empty/,
  );
});

test("rejects a platform entry missing artifactName", () => {
  const root = fixture();
  const pkg = readPackageJson(root);
  delete pkg.supportedPlatforms["aarch64-apple-darwin"].artifactName;
  write(root, "package-dir/package.json", JSON.stringify(pkg, null, 2));
  assert.throws(
    () => patchCliNpmChecksums(path.join(root, "package-dir"), path.join(root, "sha256.sum")),
    /artifactName is missing or not a non-empty string/,
  );
});

test("rejects a platform entry that already declares a sha256 field", () => {
  const root = fixture();
  const pkg = readPackageJson(root);
  pkg.supportedPlatforms["aarch64-apple-darwin"].sha256 = "0".repeat(64);
  write(root, "package-dir/package.json", JSON.stringify(pkg, null, 2));
  assert.throws(
    () => patchCliNpmChecksums(path.join(root, "package-dir"), path.join(root, "sha256.sum")),
    /already declares a sha256 field/,
  );
});

test("rejects a platform whose artifact has no entry in sha256.sum", () => {
  const root = fixture();
  write(
    root,
    "sha256.sum",
    `${DIGEST_DARWIN_ARM} *warble-cli-aarch64-apple-darwin.tar.xz\n`, // missing the linux-x64 entry
  );
  assert.throws(
    () => patchCliNpmChecksums(path.join(root, "package-dir"), path.join(root, "sha256.sum")),
    /sha256\.sum has no entry for "warble-cli-x86_64-unknown-linux-gnu\.tar\.xz"/,
  );
});

test("rejects a missing sha256.sum file", () => {
  const root = fixture();
  assert.throws(
    () => patchCliNpmChecksums(path.join(root, "package-dir"), path.join(root, "does-not-exist.sum")),
    /could not read/,
  );
});

test("rejects a binary-install.js missing the expected download/extract anchor", () => {
  const root = fixture();
  write(root, "package-dir/binary-install.js", "// cargo-dist changed shape entirely\n");
  assert.throws(
    () => patchCliNpmChecksums(path.join(root, "package-dir"), path.join(root, "sha256.sum")),
    /expected download\/extract anchor not found/,
  );
});

test("rejects a binary-install.js whose anchor appears more than once", () => {
  const root = fixture();
  // Two install paths carrying the same anchor: patching one and leaving the other unverified
  // would be worse than refusing, since the resulting package would look patched. cargo-dist
  // emits exactly one today, so a second occurrence means the generated shape changed in a way
  // this script cannot reason about.
  write(root, "package-dir/binary-install.js", BINARY_INSTALL_JS + "\n" + BINARY_INSTALL_JS);
  assert.throws(
    () => patchCliNpmChecksums(path.join(root, "package-dir"), path.join(root, "sha256.sum")),
    /anchor found 2 times, not exactly once/,
  );
});

test("rejects a binary-install.js already carrying the checksum-verification patch", () => {
  const root = fixture();
  patchCliNpmChecksums(path.join(root, "package-dir"), path.join(root, "sha256.sum"));
  // Re-run against the now-patched package.json: restore a fresh unpatched package.json (with no
  // sha256 fields) but leave the already-patched binary-install.js in place, isolating the
  // double-apply guard to binary-install.js specifically.
  const pkg = readPackageJson(root);
  delete pkg.supportedPlatforms["aarch64-apple-darwin"].sha256;
  delete pkg.supportedPlatforms["x86_64-unknown-linux-gnu"].sha256;
  write(root, "package-dir/package.json", JSON.stringify(pkg, null, 2));
  assert.throws(
    () => patchCliNpmChecksums(path.join(root, "package-dir"), path.join(root, "sha256.sum")),
    /already contains the checksum-verification patch marker/,
  );
});
