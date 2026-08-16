import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkReleaseConsistency } from "./check-release-consistency.mjs";

function write(root, relativePath, content) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warble-docs-release-check-"));
  write(
    root,
    "docs/site/docs/getting-started/installation.md",
    "https://github.com/Canner/Warble/releases/latest/download/warble-cli-installer.sh\n",
  );
  write(
    root,
    "docs/site/docs/getting-started/quickstart.md",
    "https://github.com/Canner/Warble/releases/latest/download/source.tar.gz\n",
  );
  write(root, "core/src/compile.rs", 'json!({ "warble_ir_version": "0.5" })\n');
  write(
    root,
    "docs/spec/ir-schema.md",
    "# Warble IR — the compile contract (`warble_ir_version: 0.5`)\n",
  );
  write(
    root,
    "docs/site/docs/reference/ir-schema.md",
    '---\ntitle: "IR schema"\ndescription: "The Warble IR compile contract"\n---\n',
  );
  return root;
}

test("accepts stable release URLs and a synchronized IR contract", () => {
  assert.doesNotThrow(() => checkReleaseConsistency(fixture()));
});

test("rejects a stale pinned release instruction", () => {
  const root = fixture();
  write(
    root,
    "docs/site/docs/getting-started/installation.md",
    "https://github.com/Canner/Warble/releases/download/v0.1.0/warble-cli-installer.sh\n",
  );
  assert.throws(() => checkReleaseConsistency(root), /release-facing instructions pin/);
});

test("rejects stale generated IR metadata", () => {
  const root = fixture();
  write(
    root,
    "docs/site/docs/reference/ir-schema.md",
    '---\ntitle: "IR schema"\ndescription: "warble_ir_version 0.3"\n---\n',
  );
  assert.throws(() => checkReleaseConsistency(root), /metadata says 0\.3, compiler emits 0\.5/);
});
