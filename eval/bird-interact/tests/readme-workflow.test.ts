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
import { CLASS_LABEL } from "../src/report-diagnose.js";
import { statesAnOutcome } from "../src/report-model.js";
import { COMPARED_MANIFEST_FIELD_NAMES } from "../src/runtime-layout.js";
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
    // The tolerant column counts TASKS. It carries no reward and no average, so nothing on it can
    // be read as strict's reward improving.
    /counts tasks/i,
    /carries no\s+reward|no\s+reward-named field/i,
    // An empty verdict map is a refusal now, not a fourth reportable state.
    /empty `\{\}`/,
  ]);
  assert.ok(
    !/judged nothing|a real state, not/i.test(text),
    'an empty tolerant.json is refused, so the README must not describe it as a reportable state',
  );
});

/**
 * The three refusals both report commands raise before they write anything.
 *
 * Each exists because the alternative is an artifact a reader would quote: a report describing a
 * dataset the run never faced, a tolerant score for something never measured, and gated
 * ground-truth SQL written where Git can see it. The compared manifest fields are sampled against
 * `runtime-layout`'s own list rather than spelled out here, so the README cannot come to describe a
 * comparison the code does not make.
 */
test("the README documents the three refusals and what each one prevents", async () => {
  const text = await readme();

  // 1. The run must have run against the data/runtime tree this command is reading.
  assertAll(text, "README", [
    "data/runtime/manifest.json",
    /dataset identity and database identity|dataset and database identity/i,
    /the run never faced|never faced/i,
    // The timestamp is deliberately NOT compared: re-preparing identical inputs moves it.
    "createdAt",
  ]);
  for (const field of ["taskIds", "groundTruth.sha256", "database.imageId"]) {
    assert.ok(
      COMPARED_MANIFEST_FIELD_NAMES.includes(field),
      `${field} must actually be one of the compared manifest fields`,
    );
    assert.ok(text.includes(field), `README must name the compared manifest field ${field}`);
  }

  // 2. A tolerant.json that exists must carry verdicts -- empty and malformed alike are refusals.
  assertAll(text, "README", [
    /empty `\{\}`/,
    /refuses/i,
    // Why empty is the most dangerous of the three: it renders as a tolerant column identical to
    // strict, computed from nothing measured.
    /identical to strict/i,
  ]);

  // 3. A gold-bearing artifact may only land inside the ignored data/ tree.
  assertAll(text, "README", [
    "--out",
    "--json",
    /refused, not written/i,
    /git add -A/,
    /gitignored|Git ignores/i,
  ]);
});

/**
 * Every class the report can publish, and the two that exist to stop it claiming more than it
 * knows. The class list is read off `CLASS_LABEL` rather than retyped, so a class added to the
 * code and not to the README fails here.
 */
test("the README lists every failure class, including the ones that decline to judge", async () => {
  const text = await readme();
  for (const failureClass of Object.keys(CLASS_LABEL)) {
    assert.ok(text.includes(failureClass), `README must document the ${failureClass} class`);
  }
  assertAll(text, "README", [
    // no-record: with no trace at all, "nothing was submitted" would be derived from the absence
    // of the record of submissions.
    /kept no trace|no trace of this task/i,
    // intent-ungraded: intent-ok is the strongest claim in the agent's favour, so it now needs
    // evidence rather than the absence of contrary evidence.
    /requires evidence|evidence rather than the absence/i,
    // inconclusive: a snippet carrying no qualified column cannot be evidence of a misread.
    "inconclusive",
    /qualified/i,
    /only `miss` counts against the agent/i,
  ]);
});

/**
 * What the autopsy writes, and the one thing it now refuses to write. "The autopsy measured
 * nothing" is no longer a state a file can be in, so the README must not still describe one.
 */
test("the README documents what the autopsy writes and what it refuses to write", async () => {
  const text = await readme();
  assertAll(text, "README", [
    "autopsy.html",
    "tolerant.json",
    // tolerant.json is conditional now; the page is not.
    /measured at least one task|whenever it measured/i,
    /the page is written and the verdict file is not/i,
    // Both pages carry the same gated-material notice.
    /notice\s+under the title|under the title/i,
    // Management is a per-task "could not measure", not one of the "not attempted" reasons.
    /Management[\s\S]{0,200}could not measure/,
    "preprocess_sql",
    /not attempted/i,
  ]);
});

/**
 * A void run withholds every route back to the number, not only the two headline scores -- and the
 * schema is what enforces it, so a report that withholds while publishing a recoverable score
 * cannot validate.
 */
test("the README says a void run withholds per-task verdicts and breakdown figures too", async () => {
  const text = await readme();
  assertAll(text, "README", [
    /withholding is total/i,
    "failureClass",
    "phase1Passed",
    "averageReward",
    /schema/i,
    /does not validate|cannot validate/i,
  ]);
});

/**
 * The envelope reaches inside the submission, which was the last route out of a withheld report:
 * sixteen `result` strings reading "SQL failed Phase 1." reconstruct the phase-1 count the rest of
 * the page withholds, and a submission labelled phase 2 says the scorer accepted the one before it.
 *
 * The exemption is asserted too. `result` is enforced in both directions, `phase` only forward --
 * a trace that recorded no phase yields `null` on a perfectly reportable run -- and a README that
 * claimed both would be describing a rule the schema does not make.
 */
test("the README says the withheld envelope reaches inside every submission", async () => {
  const text = await readme();
  assertAll(text, "README", [
    // Both masked submission fields, named as such.
    /submission[\s\S]{0,120}`result`/,
    /`result` and `phase`|`phase`/,
    // Why each one is a verdict rather than a fact about the agent.
    /scorer's own sentence/i,
    /accepted the phase-1 attempt|phase 2.{0,80}accepted/is,
    // What deliberately survives: what the agent DID.
    /attempt number/i,
    /budget either side/i,
    // `phase` is exempt from the reverse rule; the README must not claim otherwise.
    /exception to that reverse rule|only the forward direction/i,
  ]);
});

/**
 * The defect array is the one place a withheld report still speaks in prose, so the README quotes
 * the before-and-after of a masked line. Both wordings are run through `statesAnOutcome` -- the
 * very predicate the schema refinement holds a withheld report's defects to -- rather than being
 * eyeballed here: the full line must be the kind of sentence the rule catches, and the README's
 * masked replacement must survive it. A README that quoted a "masked" wording which still stated an
 * outcome would be documenting a leak as if it were the fix.
 */
test("the README's masked defect wording really is value-free", async () => {
  const text = await readme();
  const full = "official reward 0.7 but trace reward 0";
  const masked = "the official reward and the trace reward disagree; both values are withheld";
  assert.ok(statesAnOutcome(full), "the unmasked wording must be the kind of line the rule catches");
  assert.ok(!statesAnOutcome(masked), "the README's masked wording must pass the rule it documents");
  assertAll(text, "README", [
    full,
    masked,
    // Reworded, not deleted -- a defect is a statement about the record, not about the agent.
    /reworded, never masked|never masked/i,
    /about the \*record\*|about the record/i,
    // And the honest limits of the check that enforces it.
    "statesAnOutcome",
    /tripwire/i,
    /reword the defect/i,
  ]);
});

/**
 * The mandatory differential only guards anything if it actually runs. The recipe points at the
 * checkout preparation writes, so the README must no longer instruct the reader to export the
 * variable by hand.
 */
test("just test-bird-eval points the pinned tests at the prepared checkout itself", async () => {
  const recipes = await justfile();
  assertAll(recipes, "justfile", ["test-bird-eval:", "BIRD_INTERACT_CHECKOUT", "data/cache/BIRD-Interact"]);

  const text = await readme();
  assertAll(text, "README", [/runs it for you|now runs it/i, "data/cache/BIRD-Interact"]);
  assert.ok(
    !/BIRD_INTERACT_CHECKOUT[^\n]*just test-bird-eval/.test(text),
    "the README must not tell the reader to set BIRD_INTERACT_CHECKOUT by hand for just test-bird-eval",
  );
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
