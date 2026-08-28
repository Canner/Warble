#!/usr/bin/env node
//
// cargo-dist's npm installer target has no config surface for peerDependencies or arbitrary
// package.json fields (its documented per-crate npm keys are npm-scope, npm-package,
// npm-shrinkwrap, and bin-aliases only). `@warble/cli` still has to carry the same IR-version
// binding the two TS dispatchers declare -- a peerDependency on `@warble/ir-spec` plus an
// advisory `warble.irVersion` field -- so this script patches cargo-dist's generated
// package.json in place, after `dist build --artifacts=global` and before `npm publish`.
//
// cli/npm-metadata.json is the single source of truth for the injected fields. It uses the same
// JSON shape the dispatcher package.json files already declare (peerDependencies + warble.irVersion),
// which is what lets core/tests/ir_version_lockstep_tests.rs check it with the exact same
// extraction helpers it already uses for the dispatchers -- one lockstep test, one shape, three
// consumers.
//
// Every precondition below is deliberately load-bearing, not defensive filler: a future
// cargo-dist upgrade that changes npm-package's generated shape (a different name, a version
// cargo-dist no longer emits as a plain string, or -- the interesting case -- cargo-dist growing
// its own peerDependencies/warble support and starting to emit these keys itself) must fail this
// script loudly rather than have the injected values silently merge over or duplicate something
// already there. A release pipeline step that runs this script and then `npm publish`s the same
// directory turns any thrown error here into a failed release, not a silently under-specified
// published package -- that coupling is what satisfies the "can't publish without these fields"
// requirement; this script only supplies the half of it that can be tested in isolation.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// Fails loudly on anything but the exact `{"@warble/ir-spec": "<string>"}` shape the dispatcher
// package.json files use -- an empty object, extra keys, or a non-string value are all shape
// drift in the fragment this script is supposed to be copying verbatim.
function validatePeerDependencies(peerDependencies, label) {
  const keys = Object.keys(peerDependencies ?? {});
  if (keys.length !== 1 || keys[0] !== "@warble/ir-spec") {
    throw new Error(
      `${label}: peerDependencies must declare exactly one dependency, "@warble/ir-spec" (found: ${JSON.stringify(keys)})`,
    );
  }
  if (typeof peerDependencies["@warble/ir-spec"] !== "string" || peerDependencies["@warble/ir-spec"] === "") {
    throw new Error(`${label}: peerDependencies["@warble/ir-spec"] must be a non-empty string`);
  }
}

function validateWarbleField(warble, label) {
  const keys = Object.keys(warble ?? {});
  if (keys.length !== 1 || keys[0] !== "irVersion") {
    throw new Error(`${label}: warble must declare exactly one field, "irVersion" (found: ${JSON.stringify(keys)})`);
  }
  if (typeof warble.irVersion !== "string" || warble.irVersion === "") {
    throw new Error(`${label}: warble.irVersion must be a non-empty string`);
  }
}

function loadMetadataFragment(metadataPath) {
  const metadata = readJson(metadataPath, "npm-metadata.json");
  validatePeerDependencies(metadata.peerDependencies, "npm-metadata.json");
  validateWarbleField(metadata.warble, "npm-metadata.json");
  return metadata;
}

// Patches the peerDependencies + warble.irVersion IR-version binding into a cargo-dist-generated
// npm package directory's package.json, in place. `packageDir` is a directory containing a
// package.json (e.g. cargo-dist's `target/distrib/warble-cli-npm-package/`); `metadataPath`
// defaults to the repo's `cli/npm-metadata.json`.
export function patchCliNpmPackage(packageDir, metadataPath) {
  const packageJsonPath = path.join(packageDir, "package.json");
  const pkg = readJson(packageJsonPath, "package.json");

  // Preconditions on cargo-dist's generated output -- catch a shape change before it reaches the
  // merge below, rather than have it succeed on the wrong package.
  if (pkg.name !== "@warble/cli") {
    throw new Error(`package.json: expected name "@warble/cli", found ${JSON.stringify(pkg.name)}`);
  }
  if (typeof pkg.version !== "string" || pkg.version === "") {
    throw new Error("package.json: missing a non-empty string version");
  }
  if (Object.hasOwn(pkg, "peerDependencies")) {
    throw new Error(
      "package.json: already declares peerDependencies -- cargo-dist may have started emitting this key itself; " +
        "stop and reconcile with the injected fragment instead of silently overwriting it",
    );
  }
  if (Object.hasOwn(pkg, "warble")) {
    throw new Error(
      "package.json: already declares a warble field -- cargo-dist may have started emitting this key itself; " +
        "stop and reconcile with the injected fragment instead of silently overwriting it",
    );
  }

  const metadata = loadMetadataFragment(metadataPath);
  pkg.peerDependencies = metadata.peerDependencies;
  pkg.warble = metadata.warble;

  fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);

  // Re-read what was actually written rather than trusting the in-memory object -- catches a
  // filesystem or serialization bug in the write above rather than a logic bug in the merge.
  const written = readJson(packageJsonPath, "package.json (post-write)");
  if (written.peerDependencies?.["@warble/ir-spec"] !== metadata.peerDependencies["@warble/ir-spec"]) {
    throw new Error("package.json: peerDependencies did not persist as written");
  }
  if (written.warble?.irVersion !== metadata.warble.irVersion) {
    throw new Error("package.json: warble.irVersion did not persist as written");
  }

  return written;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const packageDir = process.argv[2];
  if (!packageDir) {
    console.error("usage: patch-cli-npm-package.mjs <npm-package-dir> [metadata-path]");
    process.exitCode = 1;
  } else {
    const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
    const metadataPath = process.argv[3] ?? path.join(repoRoot, "cli", "npm-metadata.json");
    try {
      const patched = patchCliNpmPackage(path.resolve(packageDir), path.resolve(metadataPath));
      console.log(
        `patch-cli-npm-package: patched ${path.join(packageDir, "package.json")} ` +
          `(peerDependencies["@warble/ir-spec"]=${patched.peerDependencies["@warble/ir-spec"]}, ` +
          `warble.irVersion=${patched.warble.irVersion})`,
      );
    } catch (e) {
      console.error(`patch-cli-npm-package: ${e.message}`);
      process.exitCode = 1;
    }
  }
}
