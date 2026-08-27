import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  COMBINED_FILENAME,
  DEFAULT_SMOKE_DATABASE,
  GT_FILENAME,
  IDENTITY_PROJECTS,
  PUBLIC_CACHE_DIRECTORY,
  PUBLIC_MAIN_JSONL,
  RUNTIME_DIRECTORY,
  runDirectory,
  smokeFilename,
  smokeTaskIds,
} from "../src/runtime-layout.js";
import {
  BIRD_COMMIT,
  HF_COMMIT,
  HF_RESOLVE_ROOT,
  HF_TREE_URL,
  MAIN_PUBLIC_SHA256,
} from "../src/source-cache.js";

const execFileAsync = promisify(execFile);

/**
 * A database other than the default, and a profile label other than the baseline's.
 *
 * The README names both to show that the `alien` paths above them are the DEFAULT database's rather
 * than fixed, and that a second profile lands beside the baseline instead of on top of it. Neither
 * is derivable — they are illustrative choices — but every name the README builds out of them is,
 * so the example goes stale here rather than in the doc.
 */
const ALTERNATE_DATABASE = "polar";
const ALTERNATE_PROFILE_LABEL = "greedy";

async function gitCheckIgnore(repository: string, path: string): Promise<number> {
  try {
    await execFileAsync("git", ["check-ignore", "--no-index", "--quiet", path], {
      cwd: repository,
      timeout: 5_000,
    });
    return 0;
  } catch (error) {
    return (error as { code?: number }).code ?? -1;
  }
}

/**
 * `data/.gitignore` un-ignores `.gitignore` and `README.md` and nothing else, so that README is the
 * only description of the tree an outside reader ever gets. It therefore has to describe the tree
 * the code produces TODAY, and to claim nothing about the gated-data boundary it cannot justify.
 *
 * Every name below is derived from the module that produces it rather than copied out of the README,
 * because a copy pins the doc to whatever revision the copy was made at. `SMOKE_TASK_COUNT` moving
 * from 3 to 5 renamed `smoke-<db>-3.jsonl` and `runs/<db>-3`, and a hardcoded assertion held the
 * README at the old names instead of failing on them. Deriving is not circular: the README is
 * hand-written prose, so this still compares two independent statements of the same layout — it just
 * makes the next such rename fail loudly here rather than lock in the drift.
 */
test("keeps private BIRD data local while tracking its boundary documentation", async () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const dataRoot = "eval/bird-interact/data";
  const database = DEFAULT_SMOKE_DATABASE;
  const smoke = smokeFilename(database);
  const identityMdl = `${IDENTITY_PROJECTS}/${database}/target/mdl.json`;
  const runs = runDirectory(database);
  const labelledRuns = runDirectory(database, ALTERNATE_PROFILE_LABEL);
  const [firstTask] = smokeTaskIds(database);
  assert.ok(firstTask !== undefined, "the smoke must promote at least one task");
  const localOnlyPaths = [
    `${dataRoot}/private/${GT_FILENAME}`,
    `${dataRoot}/cache/BIRD-Interact/schema.json`,
    `${dataRoot}/cache/${PUBLIC_CACHE_DIRECTORY}/_warble-source.json`,
    `${dataRoot}/cache/wren-cli/bin/wren`,
    `${dataRoot}/${RUNTIME_DIRECTORY}/${COMBINED_FILENAME}`,
    `${dataRoot}/${RUNTIME_DIRECTORY}/${smoke}`,
    `${dataRoot}/${RUNTIME_DIRECTORY}/${identityMdl}`,
    `${dataRoot}/${RUNTIME_DIRECTORY}/manifest.json`,
    `${dataRoot}/${runs}/traces/${firstTask}/trace.json`,
    `${dataRoot}/${labelledRuns}/traces/${firstTask}/trace.json`,
  ];
  const readme = `${dataRoot}/README.md`;
  const gitignore = `${dataRoot}/.gitignore`;

  for (const path of localOnlyPaths) {
    assert.equal(await gitCheckIgnore(repository, path), 0, `${path} must be ignored`);
  }
  assert.equal(await gitCheckIgnore(repository, gitignore), 1);
  assert.equal(await gitCheckIgnore(repository, readme), 1);
  assert.equal(await gitCheckIgnore(repository, `${dataRoot}/arbitrary-top-level-data.json`), 0);

  const contents = await readFile(resolve(repository, readme), "utf8");
  for (const statement of [
    "private/",
    "cache/",
    `${PUBLIC_CACHE_DIRECTORY}/_warble-source.json`,
    `${RUNTIME_DIRECTORY}/`,
    // The tree block nests each run directory under its parent, so the two are matched separately.
    `${posix.dirname(runs)}/`,
    `${posix.basename(runs)}/`,
    GT_FILENAME,
    COMBINED_FILENAME,
    smoke,
    identityMdl,
    "manifest.json",
    // The default database is a default, and a second profile does not displace the baseline.
    "--database",
    `${smokeFilename(ALTERNATE_DATABASE)}`,
    `${IDENTITY_PROJECTS}/${ALTERNATE_DATABASE}/target/mdl.json`,
    `${runDirectory(ALTERNATE_DATABASE)}/`,
    "--profile",
    `${posix.basename(labelledRuns)}/`,
    `${labelledRuns}/`,
    // Gated GT enters only through the operator's own copy, never through public acquisition.
    "official gated process",
    "--gt <file>",
    "--public-data <file>",
    PUBLIC_MAIN_JSONL,
    "0600",
    "private/.env",
    BIRD_COMMIT,
    HF_COMMIT,
    MAIN_PUBLIC_SHA256,
    "immutable HF tree/resolve acquisition is pinned",
    HF_TREE_URL,
    HF_RESOLVE_ROOT,
    "schema",
    "column-meaning",
    "KB metadata",
    "not a score source unless the preparation manifest validates it",
  ]) {
    assert.match(contents, new RegExp(statement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
