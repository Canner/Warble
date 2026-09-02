import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  COMPARED_MANIFEST_FIELD_NAMES,
  checkGatedOutputPath,
  compareRunManifest,
  describeManifestMismatch,
  prepareManifestSchema,
  type PrepareManifest,
} from "../src/runtime-layout.js";

/* -------------------------------------------------------------------------- */
/* The run-versus-runtime manifest cross-check                                */
/* -------------------------------------------------------------------------- */

/**
 * A prepared tree, exactly as `prepare-cli` records one.
 *
 * It is parsed through the package's own schema rather than cast, so a fixture that stopped being
 * a manifest fails here instead of quietly making the comparison test vacuous.
 */
function manifest(overrides: Record<string, unknown> = {}): PrepareManifest {
  return prepareManifestSchema.parse({
    version: 1,
    createdAt: "2026-08-25T03:14:40.149Z",
    official: { repository: "https://example.invalid/bird.git", commit: "4".repeat(40) },
    publicSnapshot: {
      repository: "https://example.invalid/hf",
      commit: "5".repeat(40),
      fileCount: 57,
      manifestSha256: "6".repeat(64),
    },
    groundTruth: { file: "private/gt.jsonl", sha256: "7".repeat(64) },
    outputs: {
      combined: { file: "runtime/combined.jsonl", rows: 300, sha256: "8".repeat(64) },
      smoke: { file: "runtime/smoke-alien-5.jsonl", rows: 5, sha256: "a".repeat(64) },
      mdl: { file: "runtime/mdl.json", sha256: "b".repeat(64) },
    },
    database: {
      name: "alien",
      template: "alien_template",
      container: "warble_bird_interact_postgresql",
      hostPort: 55432,
      imageReference: "docker.io/shawnxxh/bird-interact-postgresql:latest",
      imageId: `sha256:${"c".repeat(64)}`,
      repoDigests: ["shawnxxh/bird-interact-postgresql@sha256:" + "d".repeat(64)],
    },
    wren: { version: "wrenai 0.8.1" },
    taskIds: ["alien_1", "alien_2", "alien_3", "alien_4", "alien_5"],
    ...overrides,
  }) as PrepareManifest;
}

test("a run prepared against this very tree reports no difference", () => {
  assert.deepEqual(compareRunManifest(manifest(), manifest()), []);
});

/**
 * The state this branch is actually in: `data/runs/alien-3` recorded a three-task tree, and
 * `data/runtime/` now holds the five-task one. Without this the autopsy replays the re-prepared
 * dataset's gold and writes those verdicts into alien-3's directory.
 */
test("a re-prepared tree is a difference, named field by field", () => {
  const run = manifest({
    taskIds: ["alien_1", "alien_2", "alien_3"],
    outputs: {
      combined: { file: "runtime/combined.jsonl", rows: 300, sha256: "8".repeat(64) },
      smoke: { file: "runtime/smoke-alien-3.jsonl", rows: 3, sha256: "e".repeat(64) },
      mdl: { file: "runtime/mdl.json", sha256: "b".repeat(64) },
    },
  });
  const differences = compareRunManifest(run, manifest());
  assert.deepEqual(
    differences.map((difference) => difference.field).sort(),
    ["outputs.smoke.file", "outputs.smoke.sha256", "taskIds"],
  );
  const taskIds = differences.find((difference) => difference.field === "taskIds");
  assert.equal(taskIds?.run, "alien_1, alien_2, alien_3");
  assert.equal(taskIds?.runtime, "alien_1, alien_2, alien_3, alien_4, alien_5");
});

/**
 * Re-preparing byte-identical inputs writes a new timestamp and changes nothing about the data.
 * Comparing it would refuse every legitimate re-preparation, which is how a cross-check gets
 * disabled rather than fixed.
 */
test("a differing createdAt is not a difference", () => {
  assert.deepEqual(compareRunManifest(manifest({ createdAt: "2026-08-24T18:15:22.007Z" }), manifest()), []);
});

/** `imageId` pins the image; the tag it was pulled under and the registry digests do not. */
test("the mutable image tag and the registry digests are not compared, but the image id is", () => {
  const relabelled = manifest({
    database: { ...manifest().database, imageReference: "bird-interact-postgresql:pinned", repoDigests: [] },
  });
  assert.deepEqual(compareRunManifest(relabelled, manifest()), []);

  const rebuilt = manifest({ database: { ...manifest().database, imageId: `sha256:${"f".repeat(64)}` } });
  assert.deepEqual(
    compareRunManifest(rebuilt, manifest()).map((difference) => difference.field),
    ["database.imageId"],
  );
});

/** Every field the autopsy connects through, because it takes all of them from the runtime tree. */
test("the whole database identity and the dataset content hashes are compared", () => {
  for (const field of [
    "official.commit",
    "publicSnapshot.commit",
    "publicSnapshot.manifestSha256",
    "groundTruth.sha256",
    "outputs.combined.file",
    "outputs.combined.sha256",
    "outputs.mdl.sha256",
    "database.name",
    "database.template",
    "database.container",
    "database.hostPort",
    "taskIds",
  ]) {
    assert.ok(COMPARED_MANIFEST_FIELD_NAMES.includes(field), `${field} must be cross-checked`);
  }
  assert.ok(!COMPARED_MANIFEST_FIELD_NAMES.includes("createdAt"));
});

test("the refusal names every differing field with both values and the caller's consequence", () => {
  const message = describeManifestMismatch(
    "alien-3",
    compareRunManifest(manifest({ taskIds: ["alien_1"] }), manifest()),
    "The autopsy would replay that other tree's gold.",
  );
  assert.match(message, /alien-3/);
  assert.match(message, /taskIds/);
  assert.match(message, /the run recorded alien_1;/);
  assert.match(message, /data\/runtime\/manifest\.json now has alien_1, alien_2/);
  assert.match(message, /The autopsy would replay that other tree's gold\./);
});

/* -------------------------------------------------------------------------- */
/* Where a gold-bearing artifact may be written                               */
/* -------------------------------------------------------------------------- */

/**
 * `report.json`, `report.html` and `autopsy.html` all embed the benchmark's `sol_sql`. `data/` is
 * the only tree Git ignores, and the justfile recipes `cd eval/bird-interact` first — so
 * `--out report.html` resolved to a TRACKED directory, one `git add -A` from a commit.
 */
async function dataTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "warble-gated-out-"));
  await mkdir(join(root, "data", "runs", "alien-5"), { recursive: true });
  return root;
}

async function refusal(root: string, path: string): Promise<string | null> {
  const checked = await checkGatedOutputPath({
    dataRoot: join(root, "data"),
    path,
    flag: "--out",
    artifact: "report.html",
  });
  return checked.refusal;
}

test("a path inside the ignored data tree is allowed, even before it exists", async () => {
  const root = await dataTree();
  try {
    assert.equal(await refusal(root, join(root, "data", "runs", "alien-5", "report.html")), null);
    assert.equal(await refusal(root, join(root, "data", "not", "yet", "made", "report.html")), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a path outside it is refused, naming the path and why", async () => {
  const root = await dataTree();
  try {
    const message = await refusal(root, join(root, "report.html"));
    assert.ok(message !== null, "a tracked directory must be refused");
    assert.match(message, /--out/);
    assert.match(message, /report\.html/);
    assert.ok(message.includes(join(root, "report.html")), "the refusal must name the resolved path");
    assert.match(message, /ground-truth SQL/);
    assert.match(message, /gitignored/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("`..` traversal out of the tree is refused after it collapses", async () => {
  const root = await dataTree();
  try {
    assert.notEqual(await refusal(root, join(root, "data", "runs", "..", "..", "..", "report.html")), null);
    // And a traversal that comes back INSIDE is fine: the check is on where the write lands.
    assert.equal(await refusal(root, join(root, "data", "runs", "..", "report.html")), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A string-prefix check would call `data-public/` part of `data/`. It is not. */
test("a sibling directory whose name merely starts with the data root is refused", async () => {
  const root = await dataTree();
  try {
    await mkdir(join(root, "data-public"), { recursive: true });
    assert.notEqual(await refusal(root, join(root, "data-public", "report.html")), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** The path is inside data/; what it points at is not. Only a resolved path can tell. */
test("a symlink inside the tree that points out of it is refused", async () => {
  const root = await dataTree();
  try {
    const outside = join(root, "tracked");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(root, "data", "escape"));
    const message = await refusal(root, join(root, "data", "escape", "report.html"));
    assert.ok(message !== null, "a symlink out of the tree must be refused");
    assert.ok(
      message.includes(join(outside, "report.html")),
      "the refusal must name where the write would actually land",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** The data root is a directory: a write there could only fail, so it is not "inside". */
test("the data root itself is not a writable output path", async () => {
  const root = await dataTree();
  try {
    assert.notEqual(await refusal(root, join(root, "data")), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** The resolved path is what the caller writes to, so a symlinked tree still lands inside it. */
test("a symlinked data tree resolves to the real one rather than being refused", async () => {
  const root = await dataTree();
  try {
    const link = join(root, "link-to-data");
    await symlink(join(root, "data"), link);
    const checked = await checkGatedOutputPath({
      dataRoot: link,
      path: join(link, "runs", "alien-5", "report.html"),
      flag: "--out",
      artifact: "report.html",
    });
    assert.equal(checked.refusal, null);
    assert.equal(checked.resolved, join(await realDir(join(root, "data")), "runs", "alien-5", "report.html"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** macOS hands out `/var/...` temp directories that are really `/private/var/...`. */
async function realDir(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}

/** A guard that only ever saw absolute paths would miss the exact command a person actually types. */
test("a bare relative path is resolved against the working directory, not assumed inside", async () => {
  const root = await dataTree();
  const cwd = process.cwd();
  try {
    process.chdir(root);
    await writeFile(join(root, "keep"), "", "utf8");
    const message = await refusal(root, "report.html");
    assert.ok(message !== null, "`--out report.html` from a tracked directory must be refused");
    assert.ok(message.includes(dirname(join(await realDir(root), "report.html"))));
  } finally {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  }
});
