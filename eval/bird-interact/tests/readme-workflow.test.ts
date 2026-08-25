import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  DEFAULT_POSTGRES_CONTAINER,
  DEFAULT_POSTGRES_PORT,
  GT_FILENAME,
  POSTGRES_IMAGE,
  SMOKE_TASK_IDS,
} from "../src/prepare-cli.js";
import { DEFAULT_PYTHON_BIN, DEFAULT_SYSTEM_MODEL, RUN_DIRECTORY } from "../src/smoke-cli.js";
import { BIRD_COMMIT, BIRD_REPOSITORY, HF_COMMIT, HF_REPOSITORY, MAIN_PUBLIC_SHA256 } from "../src/source-cache.js";

const packageDir = resolve(import.meta.dirname, "..");
const warbleRoot = resolve(packageDir, "..", "..");

async function readme(): Promise<string> {
  return readFile(join(packageDir, "README.md"), "utf8");
}

async function justfile(): Promise<string> {
  return readFile(join(warbleRoot, "justfile"), "utf8");
}

function assertAll(text: string, label: string, required: readonly (string | RegExp)[]): void {
  const missing = required.filter((needle) =>
    typeof needle === "string" ? !text.includes(needle) : !needle.test(text),
  );
  assert.deepEqual(missing.map(String), [], `${label} is missing documentation`);
}

test("the README documents the gated ground truth without inventing a public URL", async () => {
  const text = await readme();
  assertAll(text, "README", [
    GT_FILENAME,
    /gated/i,
    /official BIRD (process|gated process|request)/i,
    "--gt",
    // How to actually obtain it: the request path the pinned checkout documents for itself.
    "bird.bench25@gmail.com",
    "[bird-interact-lite GT&Test Cases]",
    /300 rows/i,
  ]);
  assert.ok(
    !/https?:\/\/\S*gt_kg_testcases/i.test(text),
    "the README must never publish a download URL for the gated ground truth",
  );
});

test("the README pins every official source and explains how reuse is verified", async () => {
  const text = await readme();
  assertAll(text, "README", [
    BIRD_REPOSITORY,
    BIRD_COMMIT,
    HF_REPOSITORY,
    HF_COMMIT,
    MAIN_PUBLIC_SHA256,
    "public-snapshot.json",
    "57",
    /tree\?recursive=true|tree API/i,
    /resolve\//,
    /blob OID|Git blob OID/i,
    POSTGRES_IMAGE,
  ]);
});

test("the README explains why the mutable latest tag is never provenance", async () => {
  const text = await readme();
  assertAll(text, "README", [
    /latest.{0,40}mutable|mutable.{0,40}latest/is,
    /repository digest/i,
    /image ID/i,
    "docker inspect",
  ]);
});

test("the README states the verified Python contract and its honest provenance limits", async () => {
  const text = await readme();
  assertAll(text, "README", [
    "--python-bin",
    DEFAULT_PYTHON_BIN,
    /3\.10/,
    /3\.13|3\.12/,
    "requirements.txt",
    "python-freeze.txt",
    "python-environment.json",
    /pip freeze/i,
    /not.{0,60}pinned|does not pin|are not pinned/is,
  ]);
});

test("the README installs a Warble-local pinned Wren CLI", async () => {
  const text = await readme();
  assertAll(text, "README", [
    "data/cache/wren-cli",
    "wrenai==0.8.1",
    "--wren-bin",
  ]);
});

test("the README gives the import, prepare, oracle-only, and full smoke commands", async () => {
  const text = await readme();
  assertAll(text, "README", [
    "just install-bird-eval",
    "just prepare-bird-eval",
    "just smoke-bird-eval --oracle-only",
    /just smoke-bird-eval \\?\n?\s*--python-bin/,
    /later runs omit|omit `--gt`|without `--gt`/i,
  ]);
});

test("the README shows the private env example without tracking a secret file", async () => {
  const text = await readme();
  assertAll(text, "README", [
    "data/private/.env",
    ".env.example",
    "USER_SIM_MODEL",
    "ANTHROPIC_API_KEY",
    /OPENAI_API_KEY|LITELLM_API_KEY|GEMINI_API_KEY/,
  ]);
});

/**
 * Neither the subset framing nor the leaderboard warning is asserted here: both live in the
 * generated report -- `warningsFor` emits them into every run, and `report-build.test.ts` guards
 * them there -- which is the artifact a reader would actually quote a number out of.
 */
test("the README names the fixed task range", async () => {
  const text = await readme();
  // The README writes the set as a range (`alien_1 through alien_5`), so the endpoints are what it
  // actually guarantees; asserting every id would only force it to spell the range out longhand.
  const first = SMOKE_TASK_IDS[0];
  const last = SMOKE_TASK_IDS[SMOKE_TASK_IDS.length - 1];
  assert.ok(first !== undefined && last !== undefined, "the smoke task set must not be empty");
  assertAll(text, "README", [first, last]);
});

test("the README lists every result, log, trace, manifest, and cleanup location", async () => {
  const text = await readme();
  assertAll(text, "README", [
    `data/${RUN_DIRECTORY}/oracle.json`,
    `data/${RUN_DIRECTORY}/a-interact.json`,
    `data/${RUN_DIRECTORY}/logs/`,
    `data/${RUN_DIRECTORY}/traces/`,
    `data/${RUN_DIRECTORY}/manifest.json`,
    "data/runtime/manifest.json",
    `docker stop ${DEFAULT_POSTGRES_CONTAINER}`,
    String(DEFAULT_POSTGRES_PORT),
  ]);
});

test("the README documents official-process isolation and virtualenv matching", async () => {
  const text = await readme();
  assertAll(text, "README", [
    "PYTHON_DOTENV_DISABLED=1",
    "PYTHONDONTWRITEBYTECODE=1",
    /\.env.{0,80}(inside|within).{0,40}checkout|checkout.{0,60}\.env.{0,40}rejected/is,
    /bytecode/i,
    /same major\/minor|matching major\/minor|major\/minor/i,
  ]);
});

test("the README states that no runtime command reads a project outside this repository", async () => {
  const text = await readme();
  assert.match(
    text,
    /no runtime command reads any project outside this repository|never reads any project outside this repository/i,
  );
  assert.ok(
    !/WREN_PROJECT_ROOT=\/absolute\/path/.test(text),
    "the README must no longer require externally provisioned identity projects",
  );
  assert.ok(
    !/bird-identity-wren-projects/.test(text),
    "identity projects are generated into data/runtime, not maintained outside Warble",
  );
});

test("the README preserves the protocol, scoring, and differential instructions", async () => {
  const text = await readme();
  assertAll(text, "README", [
    "BIRD_INTERACT_CHECKOUT",
    "official-differential.test.ts",
    /nine charged tools|nine tools/i,
    /budget/i,
    "just lint-bird-eval",
    "just test-bird-eval",
    "just build-bird-eval",
  ]);
});

/**
 * The two commands that read a finished run.
 *
 * The README is where a reader learns which command writes which artifact -- and, above all, that
 * a run whose user simulator was void carries no score at all. That rule is the one a reader can
 * only get wrong in the expensive direction, so the cause is asserted too, not just the verdict:
 * an error-free row from a simulator that answered nothing is the exact shape of a result someone
 * would otherwise quote.
 */
test("the README documents both report commands and the void rule", async () => {
  const text = await readme();
  assertAll(text, "README", [
    "just report-bird-eval",
    "just autopsy-bird-eval",
    "report.json",
    "report.html",
    "tolerant.json",
    "autopsy.html",
    /void/i,
    /withheld|withhold/i,
    // The CAUSE: the official simulator's own call is hardcoded at this temperature, and a model
    // that rejects the value fails every call and falls through to a canned non-answer.
    /temperature=0/,
    /canned/i,
    // Why a canned answer is fatal rather than merely unhelpful.
    /one required knowledge entry/i,
  ]);
});

/**
 * Strict and tolerant are easy to document into a lie: as rivals, as the same unit, or with a
 * rounding rule this package invented. They are none of those, and the README has to say so.
 */
test("the README keeps strict and tolerant honest about each other", async () => {
  const text = await readme();
  assertAll(text, "README", [
    // The tolerant rounding is the pinned benchmark's own default, not a number chosen here.
    "preprocess_results",
    /2 decimal places/i,
    // Tolerant counts every strict pass too, so it can never read as the harder bar.
    /superset/i,
    // The two columns are in different units and must not be differenced.
    /never subtract|never be subtracted/i,
    // Absent and malformed are different states: one is normal, the other is a refusal.
    /not computed/i,
    /refuses/i,
  ]);
});

test("the README says the difficulty breakdown does not merge the two vocabularies", async () => {
  const text = await readme();
  assertAll(text, "README", ["difficulty_tier", /two vocabular/i, /not merged|does not merge/i]);
});

test("the justfile forwards arguments to both self-contained recipes", async () => {
  const text = await justfile();
  assertAll(text, "justfile", [
    /prepare-bird-eval \*args:/,
    /smoke-bird-eval \*args:/,
    /warble-bird-prepare|prepare-cli\.js/,
    /warble-bird-smoke|smoke-cli\.js/,
    "{{args}}",
  ]);
});

test("the justfile forwards arguments to the report recipes", async () => {
  const text = await justfile();
  assertAll(text, "justfile", [
    /report-bird-eval \*args:/,
    /autopsy-bird-eval \*args:/,
    /warble-bird-report|report-cli\.js/,
    /warble-bird-autopsy|autopsy-cli\.js/,
  ]);
});

test("the README names the system-agent model default it actually ships", async () => {
  const text = await readme();
  assert.ok(text.includes(DEFAULT_SYSTEM_MODEL), "README must document the shipped --system-model default");
  assert.ok(text.includes("--system-model"), "README must document the --system-model flag");
});
