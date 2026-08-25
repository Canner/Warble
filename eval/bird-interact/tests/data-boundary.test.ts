import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

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

test("keeps private BIRD data local while tracking its boundary documentation", async () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const dataRoot = "eval/bird-interact/data";
  const localOnlyPaths = [
    `${dataRoot}/private/bird_interact_gt_kg_testcases_1008.jsonl`,
    `${dataRoot}/cache/BIRD-Interact/schema.json`,
    `${dataRoot}/cache/bird-interact-lite/_warble-source.json`,
    `${dataRoot}/cache/wren-cli/bin/wren`,
    `${dataRoot}/runtime/bird_interact_data_with_gt.jsonl`,
    `${dataRoot}/runtime/smoke-alien-3.jsonl`,
    `${dataRoot}/runtime/identity-projects/alien/target/mdl.json`,
    `${dataRoot}/runtime/manifest.json`,
    `${dataRoot}/runs/alien-3/trace.json`,
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
    "runtime/",
    "runs/",
    "bird_interact_data_with_gt.jsonl",
    "smoke-alien-3.jsonl",
    "identity-projects/alien/target/mdl.json",
    "manifest.json",
    "https://huggingface.co/api/datasets/birdsql/bird-interact-lite/tree/f7881a9c2b9630cc4fc13b0c39279740b0a2fd87?recursive=true&limit=1000",
    "https://huggingface.co/datasets/birdsql/bird-interact-lite/resolve/f7881a9c2b9630cc4fc13b0c39279740b0a2fd87",
    "official gated process",
    "0600",
    "private/.env",
    "immutable HF tree/resolve acquisition is pinned",
    "schema",
    "column-meaning",
    "KB metadata",
    "not a score source unless the preparation manifest validates it",
  ]) {
    assert.match(contents, new RegExp(statement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
