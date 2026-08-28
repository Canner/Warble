import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { patchCliNpmPackage } from "./patch-cli-npm-package.mjs";

function write(root, relativePath, content) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warble-patch-cli-npm-"));
  write(
    root,
    "package-dir/package.json",
    JSON.stringify({ name: "@warble/cli", version: "0.5.1", license: "Apache-2.0" }, null, 2),
  );
  write(
    root,
    "npm-metadata.json",
    JSON.stringify(
      { peerDependencies: { "@warble/ir-spec": "0.6.x" }, warble: { irVersion: "0.6" } },
      null,
      2,
    ),
  );
  return root;
}

function readPackageJson(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "package-dir", "package.json"), "utf8"));
}

test("injects peerDependencies and warble.irVersion from the metadata fragment", () => {
  const root = fixture();
  const patched = patchCliNpmPackage(path.join(root, "package-dir"), path.join(root, "npm-metadata.json"));
  assert.deepEqual(patched.peerDependencies, { "@warble/ir-spec": "0.6.x" });
  assert.deepEqual(patched.warble, { irVersion: "0.6" });
  // What is actually on disk, not just the returned object.
  const onDisk = readPackageJson(root);
  assert.deepEqual(onDisk.peerDependencies, { "@warble/ir-spec": "0.6.x" });
  assert.deepEqual(onDisk.warble, { irVersion: "0.6" });
  // Pre-existing fields survive the merge untouched.
  assert.equal(onDisk.name, "@warble/cli");
  assert.equal(onDisk.version, "0.5.1");
});

test("rejects a package.json whose name is not @warble/cli", () => {
  const root = fixture();
  write(
    root,
    "package-dir/package.json",
    JSON.stringify({ name: "@warble/warble-cli", version: "0.5.1" }, null, 2),
  );
  assert.throws(
    () => patchCliNpmPackage(path.join(root, "package-dir"), path.join(root, "npm-metadata.json")),
    /expected name "@warble\/cli"/,
  );
});

test("rejects a package.json missing a version", () => {
  const root = fixture();
  write(root, "package-dir/package.json", JSON.stringify({ name: "@warble/cli" }, null, 2));
  assert.throws(
    () => patchCliNpmPackage(path.join(root, "package-dir"), path.join(root, "npm-metadata.json")),
    /missing a non-empty string version/,
  );
});

test("rejects a package.json that already declares peerDependencies", () => {
  const root = fixture();
  write(
    root,
    "package-dir/package.json",
    JSON.stringify(
      { name: "@warble/cli", version: "0.5.1", peerDependencies: { "@warble/ir-spec": "0.6.x" } },
      null,
      2,
    ),
  );
  assert.throws(
    () => patchCliNpmPackage(path.join(root, "package-dir"), path.join(root, "npm-metadata.json")),
    /already declares peerDependencies/,
  );
});

test("rejects a package.json that already declares a warble field", () => {
  const root = fixture();
  write(
    root,
    "package-dir/package.json",
    JSON.stringify({ name: "@warble/cli", version: "0.5.1", warble: { irVersion: "0.6" } }, null, 2),
  );
  assert.throws(
    () => patchCliNpmPackage(path.join(root, "package-dir"), path.join(root, "npm-metadata.json")),
    /already declares a warble field/,
  );
});

test("rejects a metadata fragment with an unexpected peerDependencies shape", () => {
  const root = fixture();
  write(
    root,
    "npm-metadata.json",
    JSON.stringify(
      { peerDependencies: { "@warble/ir-spec": "0.6.x", extra: "1.0.0" }, warble: { irVersion: "0.6" } },
      null,
      2,
    ),
  );
  assert.throws(
    () => patchCliNpmPackage(path.join(root, "package-dir"), path.join(root, "npm-metadata.json")),
    /peerDependencies must declare exactly one dependency/,
  );
});

test("rejects a metadata fragment with an unexpected warble shape", () => {
  const root = fixture();
  write(
    root,
    "npm-metadata.json",
    JSON.stringify(
      { peerDependencies: { "@warble/ir-spec": "0.6.x" }, warble: { irVersion: "0.6", extra: true } },
      null,
      2,
    ),
  );
  assert.throws(
    () => patchCliNpmPackage(path.join(root, "package-dir"), path.join(root, "npm-metadata.json")),
    /warble must declare exactly one field/,
  );
});

test("rejects a missing metadata fragment", () => {
  const root = fixture();
  assert.throws(
    () => patchCliNpmPackage(path.join(root, "package-dir"), path.join(root, "does-not-exist.json")),
    /could not read/,
  );
});
