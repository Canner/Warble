import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assetDirForIr, landAssets } from "../src/index.js";
import type { WarbleIr } from "../src/ir.js";

// IR 0.7 let a component declare the files it needs and compile recorded their identity, but nothing
// consumed the manifest — the agent ran in a directory that did not contain them, with no error.
// These cover the landing and both refusals, since a silent partial landing is what made the
// original defect invisible.

const CONTENT = "body { color: black }\n";
const HASH = `sha256:${createHash("sha256").update(CONTENT).digest("hex")}`;

function irWithAsset(hash = HASH): WarbleIr {
  return {
    warble_ir_version: "0.7",
    profile: "fixture",
    context_binding: {} as never,
    config: {},
    components: [
      {
        id: "asker",
        assets: [{ path: "themes/dark.css", hash, bytes: CONTENT.length }],
      } as never,
    ],
  } as WarbleIr;
}

/** Stage an IR file, optionally with its travelling asset directory populated. */
function stage(options: { content?: string } = {}): { irPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "assets-"));
  const irPath = join(dir, "ir.json");
  writeFileSync(irPath, "{}");
  if (options.content !== undefined) {
    const target = join(assetDirForIr(irPath), "asker", "themes");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "dark.css"), options.content);
  }
  return { irPath, dir };
}

test("a declared asset lands at its authored path in the agent's working directory", () => {
  const { irPath, dir } = stage({ content: CONTENT });
  const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
  try {
    const landed = landAssets(irWithAsset(), irPath, cwd);
    assert.equal(landed.length, 1);
    assert.equal(readFileSync(join(cwd, "themes/dark.css"), "utf8"), CONTENT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an asset missing from the travelling directory is refused", () => {
  // What a copied IR produces: the manifest names a file that did not come with it.
  const { irPath, dir } = stage();
  const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
  try {
    assert.throws(
      () => landAssets(irWithAsset(), irPath, cwd),
      /declared in the IR but missing from/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an asset whose content no longer matches its manifest is refused", () => {
  const { irPath, dir } = stage({ content: "body { color: red }\n" });
  const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
  try {
    assert.throws(() => landAssets(irWithAsset(), irPath, cwd), /does not match its manifest/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a refusal lands nothing at all, rather than part of a component's files", () => {
  // Verified rather than asserted from the code shape: the second asset is the one that fails, so a
  // write-as-you-go implementation would already have landed the first by the time it threw.
  const { irPath, dir } = stage({ content: CONTENT });
  const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
  try {
    const ir = irWithAsset();
    (ir.components[0] as { assets: { path: string; hash: string; bytes: number }[] }).assets.push({
      path: "themes/light.css",
      hash: HASH,
      bytes: CONTENT.length,
    });

    assert.throws(() => landAssets(ir, irPath, cwd), /missing from/);
    assert.throws(
      () => readFileSync(join(cwd, "themes/dark.css")),
      /ENOENT/,
      "the asset that WAS present must not have landed either",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an IR whose components declare no assets touches nothing", () => {
  const { irPath, dir } = stage();
  const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
  try {
    const ir = { ...irWithAsset(), components: [{ id: "asker" } as never] } as WarbleIr;
    assert.deepEqual(landAssets(ir, irPath, cwd), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the travelling directory is derived from the IR's own name, not a fixed one", () => {
  // A sibling derived from the path, so an IR that is renamed or sits beside another one still finds
  // its own assets. Recording the location inside the IR would stop being true the moment it moved.
  assert.equal(assetDirForIr("/x/ir.json"), "/x/ir.assets");
  assert.equal(assetDirForIr("/x/answer.ir.json"), "/x/answer.ir.assets");
});
