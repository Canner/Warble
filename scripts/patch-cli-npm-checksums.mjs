#!/usr/bin/env node
//
// cargo-dist's npm installer target has no config surface for embedding checksums: the generated
// `binary-install.js` downloads a platform tarball at `npm install` (postinstall) time and
// extracts it with no integrity check at all (confirmed by reading a real generated copy -- no
// `sha|checksum|integrity|digest|signature|verif|crypto` token appears anywhere in
// `binary-install.js`, `binary.js`, or `install.js`). Upstream tracks this gap as
// axodotdev/cargo-dist#439 (open since 2023-09-20); there is no config flag to opt into today.
//
// So this script patches cargo-dist's generated npm package in place, after
// `dist build --artifacts=global` and before `npm publish`, the same way
// scripts/patch-cli-npm-package.mjs already injects the peerDependencies/warble.irVersion
// IR-version binding into the same directory. It bakes each platform's already-published sha256
// digest into `package.json`, then patches `binary-install.js` to verify the download against it
// before extracting -- so the digest ships with the npm package itself and a user's install adds
// no extra network request.
//
// The digests come from `sha256.sum`, the same aggregate checksum file cargo-dist already
// uploads to the GitHub Release (the file the generated shell installer bakes its own per-target
// digests from at release-build time -- see RELEASING.md). This script does not compute or fetch
// anything itself; the caller (the publish workflow) downloads that one file from the release
// that was just confirmed to exist, and passes its path in.
//
// Every precondition below is deliberately load-bearing, matching patch-cli-npm-package.mjs's own
// standard: a future cargo-dist upgrade that changes the generated shape (a `supportedPlatforms`
// entry with a different key set, a renamed `binary-install.js` download/extract anchor, or --
// the interesting case -- cargo-dist growing its own checksum verification and starting to emit
// `sha256` fields or verification code itself) must fail this script loudly rather than silently
// no-op, silently skip verification, or double-apply a second layer of it on top of cargo-dist's
// own.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HEX64 = /^[0-9a-f]{64}$/;

function readJson(filePath, label) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    throw new Error(`${label}: could not read ${filePath}: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label}: ${filePath} is not valid JSON: ${e.message}`);
  }
}

function readText(filePath, label) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e) {
    throw new Error(`${label}: could not read ${filePath}: ${e.message}`);
  }
}

// Parses a `sha256sum -b` style checksum file (`<64-hex-digest> *<filename>` per line, the same
// binary-mode format RELEASING.md documents for this repo's other checksummed release assets)
// into a Map from filename to lowercase-hex digest. Blank lines are skipped; any non-blank line
// that doesn't parse into exactly a 64-lowercase-hex-char digest plus a filename is a hard error
// -- a malformed or truncated checksum file must never be treated as "no entry for this file",
// which would silently disable verification for whatever artifact it was supposed to cover.
export function parseSha256Sum(content, label = "sha256.sum") {
  const digestsByFilename = new Map();
  const lines = content.split("\n");
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line);
    if (!match) {
      throw new Error(`${label}:${index + 1}: not a valid "<digest> *<filename>" checksum line: ${JSON.stringify(rawLine)}`);
    }
    const digest = match[1].toLowerCase();
    if (!HEX64.test(digest)) {
      throw new Error(`${label}:${index + 1}: digest is not 64 lowercase hex characters: ${JSON.stringify(match[1])}`);
    }
    const filename = match[2];
    if (digestsByFilename.has(filename)) {
      throw new Error(`${label}:${index + 1}: duplicate entry for ${JSON.stringify(filename)}`);
    }
    digestsByFilename.set(filename, digest);
  }
  return digestsByFilename;
}

// Injects each supported platform's published sha256 digest into package.json's
// `supportedPlatforms[target].sha256`. `this.platform` inside the generated `binary-install.js`
// is a direct reference to this same object (see binary.js's `getPlatform`), so the download
// verification patched into binary-install.js below reads `this.platform.sha256` with no other
// wiring needed.
function patchPackageJsonChecksums(packageJsonPath, digestsByFilename) {
  const pkg = readJson(packageJsonPath, "package.json");

  if (pkg.name !== "@warble/cli") {
    throw new Error(`package.json: expected name "@warble/cli", found ${JSON.stringify(pkg.name)}`);
  }
  if (typeof pkg.version !== "string" || pkg.version === "") {
    throw new Error("package.json: missing a non-empty string version");
  }
  if (typeof pkg.supportedPlatforms !== "object" || pkg.supportedPlatforms === null) {
    throw new Error("package.json: missing a supportedPlatforms object");
  }
  const targets = Object.keys(pkg.supportedPlatforms);
  if (targets.length === 0) {
    throw new Error("package.json: supportedPlatforms is empty -- nothing to verify");
  }

  const patchedTargets = [];
  for (const target of targets) {
    const platform = pkg.supportedPlatforms[target];
    if (typeof platform !== "object" || platform === null) {
      throw new Error(`package.json: supportedPlatforms["${target}"] is not an object`);
    }
    if (typeof platform.artifactName !== "string" || platform.artifactName === "") {
      throw new Error(`package.json: supportedPlatforms["${target}"].artifactName is missing or not a non-empty string`);
    }
    if (Object.hasOwn(platform, "sha256")) {
      throw new Error(
        `package.json: supportedPlatforms["${target}"] already declares a sha256 field -- cargo-dist may have ` +
          "started emitting this key itself; stop and reconcile with this script instead of silently overwriting it",
      );
    }
    const digest = digestsByFilename.get(platform.artifactName);
    if (!digest) {
      throw new Error(
        `sha256.sum has no entry for ${JSON.stringify(platform.artifactName)} (needed for supportedPlatforms["${target}"]) -- ` +
          "refusing to publish a package that would silently skip verification for this platform",
      );
    }
    platform.sha256 = digest;
    patchedTargets.push(target);
  }

  fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);

  // Re-read what was actually written rather than trusting the in-memory object -- catches a
  // filesystem or serialization bug in the write above rather than a logic bug in the merge.
  const written = readJson(packageJsonPath, "package.json (post-write)");
  for (const target of patchedTargets) {
    const expected = pkg.supportedPlatforms[target].sha256;
    if (written.supportedPlatforms?.[target]?.sha256 !== expected) {
      throw new Error(`package.json: supportedPlatforms["${target}"].sha256 did not persist as written`);
    }
  }

  return patchedTargets;
}

// The exact anchor cargo-dist 0.32.0 generates immediately after the downloaded tarball's
// tempfile write stream closes, and immediately before extraction begins. Matched verbatim
// (including indentation) so a change in cargo-dist's generated formatting -- not just logic --
// is treated as shape drift rather than silently matched loosely and patched somewhere
// unintended.
const EXTRACT_ANCHOR = `            sink.on("close", () => {
              if (/\\.tar\\.*/.test(this.zipExt)) {`;

// A distinctive token that only appears in the injected verification block. Used both to detect
// "already patched" (double-apply guard) before patching, and to confirm the patch actually
// landed after writing.
const PATCH_MARKER = "warble: verify downloaded archive checksum before extracting";

function buildVerificationBlock() {
  return `            sink.on("close", () => {
              // ${PATCH_MARKER} -- injected by scripts/patch-cli-npm-checksums.mjs.
              // this.platform is package.json's supportedPlatforms[target] entry (see
              // binary.js's getPlatform), patched by that same script to carry a sha256 field
              // alongside the artifactName cargo-dist already puts there.
              const expectedSha256 = this.platform.sha256;
              if (typeof expectedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
                return reject(
                  new Error(
                    \`no valid baked-in sha256 checksum for \${this.filename} -- refusing to extract an unverified download\`,
                  ),
                );
              }
              const actualSha256 = require("node:crypto")
                .createHash("sha256")
                .update(require("node:fs").readFileSync(tempFile))
                .digest("hex");
              if (actualSha256 !== expectedSha256) {
                return reject(
                  new Error(
                    \`checksum mismatch for \${this.filename}: expected \${expectedSha256}, got \${actualSha256} -- \` +
                      "the download may be corrupted or tampered with; retrying the install is a safe next step",
                  ),
                );
              }
              if (/\\.tar\\.*/.test(this.zipExt)) {`;
}

function patchBinaryInstallChecksums(binaryInstallPath) {
  const content = readText(binaryInstallPath, "binary-install.js");

  if (content.includes(PATCH_MARKER)) {
    throw new Error(
      "binary-install.js: already contains the checksum-verification patch marker -- refusing to double-apply it",
    );
  }

  const occurrences = content.split(EXTRACT_ANCHOR).length - 1;
  if (occurrences === 0) {
    throw new Error(
      "binary-install.js: expected download/extract anchor not found -- cargo-dist may have changed the generated " +
        "shape of the extraction callback; update EXTRACT_ANCHOR in scripts/patch-cli-npm-checksums.mjs to match, " +
        "after confirming the new shape still gates extraction on a single write-stream close callback",
    );
  }
  if (occurrences > 1) {
    throw new Error(
      `binary-install.js: expected download/extract anchor found ${occurrences} times, not exactly once -- ` +
        "cannot determine which occurrence to patch",
    );
  }

  const patched = content.replace(EXTRACT_ANCHOR, buildVerificationBlock());
  fs.writeFileSync(binaryInstallPath, patched);

  // Re-read what was actually written rather than trusting the in-memory string.
  const written = readText(binaryInstallPath, "binary-install.js (post-write)");
  if (!written.includes(PATCH_MARKER)) {
    throw new Error("binary-install.js: checksum-verification patch did not persist as written");
  }
}

// Patches a cargo-dist-generated `@warble/cli` npm package directory in place so that
// `npm install` verifies the downloaded platform archive's sha256 against the digest this repo
// already published for it, before extracting. `packageDir` is a directory containing
// `package.json` and `binary-install.js` (e.g. cargo-dist's
// `target/distrib/warble-cli-npm-package/`); `sha256SumPath` is a `sha256sum -b`-format checksum
// file covering every artifact named in `package.json`'s `supportedPlatforms` (the release's own
// `sha256.sum` asset).
export function patchCliNpmChecksums(packageDir, sha256SumPath) {
  const packageJsonPath = path.join(packageDir, "package.json");
  const binaryInstallPath = path.join(packageDir, "binary-install.js");

  const digestsByFilename = parseSha256Sum(readText(sha256SumPath, "sha256.sum"), path.basename(sha256SumPath));
  const patchedTargets = patchPackageJsonChecksums(packageJsonPath, digestsByFilename);
  patchBinaryInstallChecksums(binaryInstallPath);

  return { packageJsonPath, binaryInstallPath, patchedTargets };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const packageDir = process.argv[2];
  const sha256SumPath = process.argv[3];
  if (!packageDir || !sha256SumPath) {
    console.error("usage: patch-cli-npm-checksums.mjs <npm-package-dir> <sha256.sum-path>");
    process.exitCode = 1;
  } else {
    try {
      const result = patchCliNpmChecksums(path.resolve(packageDir), path.resolve(sha256SumPath));
      console.log(
        `patch-cli-npm-checksums: patched ${result.packageJsonPath} and ${result.binaryInstallPath} ` +
          `(targets: ${result.patchedTargets.join(", ")})`,
      );
    } catch (e) {
      console.error(`patch-cli-npm-checksums: ${e.message}`);
      process.exitCode = 1;
    }
  }
}
