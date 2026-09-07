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

test("a manifest path that climbs out of the working directory is refused", () => {
  // Not authorable — compile refuses such a reference — but an IR is a document that can arrive from
  // anywhere, and until review constructed this, nothing looked at the path again on the way in.
  const { irPath, dir } = stage({ content: CONTENT });
  const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
  try {
    const ir = irWithAsset();
    (ir.components[0] as { assets: { path: string }[] }).assets[0]!.path = "../escaped.css";
    assert.throws(() => landAssets(ir, irPath, cwd), /must be a relative path/);
    assert.throws(
      () => readFileSync(join(cwd, "..", "escaped.css")),
      /ENOENT/,
      "and nothing is written outside the working directory",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an absolute manifest path is refused, since join would replace the base entirely", () => {
  const { irPath, dir } = stage({ content: CONTENT });
  const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
  try {
    const ir = irWithAsset();
    (ir.components[0] as { assets: { path: string }[] }).assets[0]!.path =
      "/tmp/warble-absolute-escape.css";
    assert.throws(() => landAssets(ir, irPath, cwd), /must be a relative path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a symlinked parent inside the working directory does not let an asset escape", async () => {
  // Review constructed this after the string check landed: a manifest path with no `..` and not
  // absolute still escapes when a directory component of it is a symlink pointing elsewhere. It is
  // reachable here in particular, because this back-end's working directory is the bound project —
  // a real directory somebody else may have written to, not one freshly created per dispatch.
  const { symlinkSync } = await import("node:fs");
  const { irPath, dir } = stage({ content: CONTENT });
  const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
  try {
    symlinkSync(elsewhere, join(cwd, "themes"), "dir");
    assert.throws(() => landAssets(irWithAsset(), irPath, cwd), /resolves outside/);
    assert.throws(
      () => readFileSync(join(elsewhere, "dark.css")),
      /ENOENT/,
      "and nothing is written through the symlink",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a symlink inside the travelling directory is not read through", async () => {
  // The read side of the same gap. Lower severity — the attacker must already know the exact bytes
  // to pass the hash — but it is a content-read-through-symlink primitive the string check misses.
  const { symlinkSync } = await import("node:fs");
  const { irPath, dir } = stage();
  const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "outside-"));
  try {
    writeFileSync(join(elsewhere, "secret.css"), CONTENT);
    const travelling = join(assetDirForIr(irPath), "asker", "themes");
    mkdirSync(travelling, { recursive: true });
    symlinkSync(join(elsewhere, "secret.css"), join(travelling, "dark.css"), "file");

    // The content hashes correctly — the manifest matches — so only the resolved-location check
    // can refuse this.
    assert.throws(() => landAssets(irWithAsset(), irPath, cwd), /resolves outside/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a pipe planted at a declared asset path is refused rather than read", async (t) => {
  // Review constructed this after the symlink fix: reading before deciding meant a FIFO with no
  // writer hung the dispatch forever, and the containment check never ran. No symlink and no path
  // trickery — the path is exactly the one the component declared — so the previous round's check
  // could not help. `landAssets` is synchronous, so a regression wedges this test rather than
  // failing it; the assertion below is still what makes the fix falsifiable.
  if (process.platform === "win32") return t.skip("no mkfifo on this platform");
  const { execFileSync } = await import("node:child_process");

  const { irPath, dir } = stage();
  const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
  try {
    const travelling = join(assetDirForIr(irPath), "asker", "themes");
    mkdirSync(travelling, { recursive: true });
    execFileSync("mkfifo", [join(travelling, "dark.css")]);

    assert.throws(() => landAssets(irWithAsset(), irPath, cwd), /is not a regular file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
