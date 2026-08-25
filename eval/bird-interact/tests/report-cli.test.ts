import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CliUsageError } from "../src/cli-usage.js";
import { buildRunReport } from "../src/report-build.js";
import { loadRunInputs, parseReportArgs, readTolerant, ReportError } from "../src/report-cli.js";
import { renderReportHtml } from "../src/report-html.js";
import { COMBINED_FILENAME, RUNTIME_DIRECTORY, USER_SIMULATOR_FILENAME } from "../src/runtime-layout.js";

test("parses run names as positionals and an optional output pair", () => {
  const parsed = parseReportArgs(["alien-5", "alien-3", "--out", "/tmp/r.html", "--json", "/tmp/r.json"]);
  assert.equal(parsed.kind, "run");
  if (parsed.kind !== "run") return;
  assert.deepEqual(parsed.config.runs, ["alien-5", "alien-3"]);
  assert.equal(parsed.config.out, "/tmp/r.html");
  assert.equal(parsed.config.json, "/tmp/r.json");
});

test("help and version short-circuit before any run is required", () => {
  assert.equal(parseReportArgs(["--help"]).kind, "help");
  assert.equal(parseReportArgs(["-V"]).kind, "version");
});

test("naming no run is a usage error, not an empty report", () => {
  assert.throws(() => parseReportArgs([]), CliUsageError);
});

test("an unknown flag is a usage error", () => {
  assert.throws(() => parseReportArgs(["alien-5", "--nope"]), CliUsageError);
});

/* -------------------------------------------------------------------------- */
/* tolerant.json: absent, malformed and empty must read differently           */
/* -------------------------------------------------------------------------- */

/**
 * `buildRunReport` scores the tolerant column whenever the verdicts are not `null`, so a malformed
 * `tolerant.json` that got coerced into `{}` would render a confident `tolerant 0/N` block
 * describing nothing. These tests exist to keep that failure impossible.
 */
async function runDirWith(contents: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "warble-tolerant-"));
  if (contents !== null) await writeFile(join(dir, "tolerant.json"), contents, "utf8");
  return dir;
}

test("a valid tolerant.json parses into the verdict map", async () => {
  const dir = await runDirWith('{"alien_1": true, "alien_2": false}');
  try {
    assert.deepEqual(await readTolerant(dir), { alien_1: true, alien_2: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an absent tolerant.json is null: no autopsy has run", async () => {
  const dir = await runDirWith(null);
  try {
    assert.equal(await readTolerant(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an empty tolerant.json stays {} and is never downgraded to null", async () => {
  const dir = await runDirWith("{}");
  try {
    const verdicts = await readTolerant(dir);
    // An autopsy that ran and judged nothing is a real state, distinct from one that never ran.
    assert.notEqual(verdicts, null);
    assert.deepEqual(verdicts, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tolerant.json that is not a JSON object throws instead of scoring", async () => {
  for (const contents of ["[]", '"nope"', "42", "null"]) {
    const dir = await runDirWith(contents);
    try {
      await assert.rejects(
        () => readTolerant(dir),
        (error: unknown) =>
          error instanceof ReportError && /not a JSON object/.test(error.message),
        `${contents} must be rejected, not coerced`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("a non-boolean verdict throws and the message names the offending key", async () => {
  const dir = await runDirWith('{"alien_1": {"passed": true}, "alien_2": false}');
  try {
    await assert.rejects(
      () => readTolerant(dir),
      (error: unknown) => {
        assert.ok(error instanceof ReportError, "must be a ReportError");
        assert.match(error.message, /alien_1/, "the message must name the offending key");
        assert.match(error.message, /not a boolean/, "the message must say what was wrong");
        assert.match(error.message, /tolerant\.json/, "the message must name the file");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unparseable tolerant.json throws rather than reading as absent", async () => {
  const dir = await runDirWith('{"alien_1": tru');
  try {
    await assert.rejects(
      () => readTolerant(dir),
      (error: unknown) => error instanceof ReportError && /not valid JSON/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* Provenance: the user-simulator model comes from the RUN, never from .env    */
/* -------------------------------------------------------------------------- */

/**
 * The defect these tests exist to keep fixed: `loadRunInputs` used to read `USER_SIM_MODEL` out of
 * the current `data/private/.env` and hand it to the report as the finished run's provenance. That
 * file is edited between runs, so a report regenerated afterwards stated today's model as the
 * model of a run that used a different one — a false claim in the one section a reader is least
 * likely to question.
 *
 * Every fixture below plants a DIFFERENT model in `.env` from the one the run recorded. If the
 * fallback is ever restored, the second test reads `MISATTRIBUTED_MODEL` instead of `null` and
 * fails; the third finds that string in the rendered page and fails with it.
 */
const RUN = "alien-5";
const MISATTRIBUTED_MODEL = "openai/gpt-4o-todays-env-not-the-runs";

const PREPARE_MANIFEST = {
  version: 1,
  createdAt: "2026-08-25T00:00:00.000Z",
  official: { repository: "r", commit: "4".repeat(40) },
  publicSnapshot: { repository: "h", commit: "5".repeat(40), fileCount: 57, manifestSha256: "6".repeat(64) },
  groundTruth: { file: "private/gt.jsonl", sha256: "7".repeat(64) },
  outputs: {
    combined: { file: "c", rows: 300, sha256: "8".repeat(64) },
    smoke: { file: "s", rows: 1, sha256: "8".repeat(64) },
    mdl: { file: "m", sha256: "8".repeat(64) },
  },
  database: {
    name: "alien", template: "alien_template", container: "c", hostPort: 55432,
    imageReference: "i", imageId: `sha256:${"9".repeat(64)}`, repoDigests: [],
  },
  wren: { version: "wrenai 0.8.1" },
  taskIds: ["alien_1"],
};

/** A finished run on disk: recorded simulator model or not, and a `.env` that disagrees. */
async function dataRootWith(recordedModel: string | null): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "warble-provenance-"));
  const runDir = join(dataRoot, "runs", RUN);
  await mkdir(runDir, { recursive: true });
  await mkdir(join(dataRoot, RUNTIME_DIRECTORY), { recursive: true });
  await mkdir(join(dataRoot, "private"), { recursive: true });
  await writeFile(join(dataRoot, RUNTIME_DIRECTORY, COMBINED_FILENAME), "", "utf8");
  await writeFile(join(runDir, "manifest.json"), JSON.stringify(PREPARE_MANIFEST), "utf8");
  await writeFile(
    join(runDir, "a-interact.json"),
    JSON.stringify({
      metrics: { total_tasks: 0, total_reward: 0, average_reward: 0, phase1_rate: 0, phase1_count: 0, phase2_rate: 0, phase2_count: 0 },
      results: [],
    }),
    "utf8",
  );
  // The live environment names a model, and a key beside it. Neither is a fact about this run.
  await writeFile(
    join(dataRoot, "private", ".env"),
    `USER_SIM_MODEL=${MISATTRIBUTED_MODEL}\nOPENAI_API_KEY=sk-never-read-by-the-report\n`,
    "utf8",
  );
  if (recordedModel !== null) {
    await writeFile(
      join(runDir, USER_SIMULATOR_FILENAME),
      `${JSON.stringify({ version: 1, model: recordedModel })}\n`,
      "utf8",
    );
  }
  return dataRoot;
}

test("a run that recorded its simulator model reports that model, not the one in .env", async () => {
  const dataRoot = await dataRootWith("anthropic/claude-haiku-4-5-20251001");
  try {
    const inputs = await loadRunInputs(dataRoot, RUN, "2026-08-25 11:41");
    assert.equal(inputs.userSimulatorModel, "anthropic/claude-haiku-4-5-20251001");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("a run that recorded none is null, even though .env names a model right now", async () => {
  const dataRoot = await dataRootWith(null);
  try {
    const inputs = await loadRunInputs(dataRoot, RUN, "2026-08-25 11:41");
    // Not the current environment's model, and not an empty string: unknown.
    assert.equal(inputs.userSimulatorModel, null);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("the report a reader sees says unrecorded, never blank and never the current .env", async () => {
  const dataRoot = await dataRootWith(null);
  try {
    const report = buildRunReport(await loadRunInputs(dataRoot, RUN, "2026-08-25 11:41"));
    assert.equal(report.provenance.userSimulatorModel, null);
    const html = renderReportHtml([report]);
    assert.match(html, /unrecorded/i, "the provenance row must state the gap");
    assert.ok(
      report.warnings.some((w) => /did not record/i.test(w) && /unrecorded/i.test(w)),
      "the comparability warning must say the simulator is unrecorded, not stay silent",
    );
    assert.ok(!html.includes(MISATTRIBUTED_MODEL), "the live .env must not appear anywhere on the page");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
