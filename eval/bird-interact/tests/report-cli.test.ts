import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CliUsageError } from "../src/cli-usage.js";
import { buildRunReport } from "../src/report-build.js";
import {
  loadRunInputs,
  parseReportArgs,
  readTolerant,
  ReportError,
  resolveGatedOutputs,
} from "../src/report-cli.js";
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

/**
 * An autopsy that ran and judged nothing IS a real state, distinct from one that never ran — and
 * the IR has no way to say so: `tolerant` is a score or "not computed". Handed `{}` the builder
 * scores the column anyway, and because a strict pass counts as a tolerant pass the result is a
 * tolerant score byte-identical to strict computed from nothing measured. That reads as "tolerant
 * found nothing extra" where the truth is "nothing was measured", so it is refused exactly like
 * the malformed files below rather than rendered.
 */
test("an empty tolerant.json is refused rather than scored as a full tolerant column", async () => {
  const dir = await runDirWith("{}");
  try {
    await assert.rejects(
      () => readTolerant(dir),
      (error: unknown) => {
        assert.ok(error instanceof ReportError, "must be a ReportError");
        assert.match(error.message, /tolerant\.json/, "the message must name the file");
        assert.match(error.message, /measured nothing/i, "the message must say what actually happened");
        assert.match(error.message, /identical to strict/i, "and why rendering it would mislead");
        return true;
      },
    );
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

/**
 * A finished run on disk: recorded simulator model or not, and a `.env` that disagrees.
 *
 * The run's manifest is written into `data/runtime/` as well, because that is the state a report
 * requires: the provenance comes from the run and the gold from the runtime tree, so the two have
 * to be the same preparation or the page attributes one to the other.
 */
async function dataRootWith(
  recordedModel: string | null,
  runtimeManifest: unknown = PREPARE_MANIFEST,
): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "warble-provenance-"));
  const runDir = join(dataRoot, "runs", RUN);
  await mkdir(runDir, { recursive: true });
  await mkdir(join(dataRoot, RUNTIME_DIRECTORY), { recursive: true });
  await mkdir(join(dataRoot, "private"), { recursive: true });
  await writeFile(join(dataRoot, RUNTIME_DIRECTORY, COMBINED_FILENAME), "", "utf8");
  await writeFile(join(runDir, "manifest.json"), JSON.stringify(PREPARE_MANIFEST), "utf8");
  if (runtimeManifest !== null) {
    await writeFile(
      join(dataRoot, RUNTIME_DIRECTORY, "manifest.json"),
      JSON.stringify(runtimeManifest),
      "utf8",
    );
  }
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

/* -------------------------------------------------------------------------- */
/* The run must have run against the tree this report reads                   */
/* -------------------------------------------------------------------------- */

/**
 * Provenance comes from the RUN's manifest; gold SQL, ambiguity snippets and difficulty labels come
 * from the CURRENT `data/runtime/` dataset. Re-prepare that tree for another subset and the two
 * describe different things, with nothing to notice: the page prints the run's commits above gold
 * the run never faced. `data/runs/alien-3` against the five-task runtime on this branch is exactly
 * that state, and it is the same misattribution class as the `.env` defect above, one directory
 * over.
 */
test("a run prepared against another runtime tree is refused, naming what differs", async () => {
  const dataRoot = await dataRootWith(null, {
    ...PREPARE_MANIFEST,
    createdAt: "2026-08-25T09:00:00.000Z",
    taskIds: ["alien_1", "alien_2", "alien_3"],
  });
  try {
    await assert.rejects(
      () => loadRunInputs(dataRoot, RUN, "2026-08-25 11:41"),
      (error: unknown) => {
        assert.ok(error instanceof ReportError, "must be a ReportError");
        assert.match(error.message, /taskIds/, "the refusal must name the field that differs");
        assert.match(error.message, /alien_1, alien_2, alien_3/, "and the value the tree carries now");
        assert.match(error.message, new RegExp(RUN), "and the run it refused");
        return true;
      },
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

/** A re-preparation of identical inputs writes a new timestamp and nothing else; that is not a mismatch. */
test("a runtime manifest differing only in its timestamp still reports", async () => {
  const dataRoot = await dataRootWith(null, { ...PREPARE_MANIFEST, createdAt: "2026-08-25T09:00:00.000Z" });
  try {
    const inputs = await loadRunInputs(dataRoot, RUN, "2026-08-25 11:41");
    assert.equal(inputs.run, RUN);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

/** With nothing to check against, the dataset cannot be shown to be the run's — and it is read anyway. */
test("a missing runtime manifest is a refusal, not an unchecked report", async () => {
  const dataRoot = await dataRootWith(null, null);
  try {
    await assert.rejects(
      () => loadRunInputs(dataRoot, RUN, "2026-08-25 11:41"),
      (error: unknown) =>
        error instanceof ReportError &&
        /runtime[/\\]manifest\.json/.test(error.message) &&
        /prepare-bird-eval/.test(error.message),
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* --out and --json write gated ground truth, so they may not leave data/      */
/* -------------------------------------------------------------------------- */

/**
 * `report.json` and `report.html` both embed the dataset's `sol_sql`. The recipes make the hazard
 * concrete: `just report-bird-eval` runs from `eval/bird-interact`, so `--out report.html` resolved
 * into a Git-tracked directory, one `git add -A` from committing gated benchmark material.
 */
test("an --out or --json path outside the data tree is refused before anything is read", async () => {
  const dataRoot = await dataRootWith(null);
  const outside = join(dataRoot, "..", "escaped-report.html");
  try {
    await assert.rejects(
      () => resolveGatedOutputs(dataRoot, { runs: [RUN], out: outside, json: null }),
      (error: unknown) => {
        assert.ok(error instanceof ReportError, "must be a ReportError");
        assert.match(error.message, /--out/, "the refusal must name the flag");
        assert.match(error.message, /escaped-report\.html/, "and the path");
        assert.match(error.message, /ground-truth SQL/, "and why the path matters");
        return true;
      },
    );
    await assert.rejects(
      () => resolveGatedOutputs(dataRoot, { runs: [RUN], out: null, json: join(dataRoot, "..", "r.json") }),
      (error: unknown) => error instanceof ReportError && /--json/.test(error.message),
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("paths inside the data tree resolve to what will be written", async () => {
  const dataRoot = await dataRootWith(null);
  try {
    const resolved = await resolveGatedOutputs(dataRoot, {
      runs: [RUN],
      out: join(dataRoot, "runs", RUN, "custom.html"),
      json: join(dataRoot, "runs", RUN, "custom.json"),
    });
    assert.ok(resolved.out?.endsWith("custom.html"));
    assert.ok(resolved.json?.endsWith("custom.json"));
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("no explicit path is nothing to check: the defaults live under the run directory", async () => {
  const dataRoot = await dataRootWith(null);
  try {
    assert.deepEqual(await resolveGatedOutputs(dataRoot, { runs: [RUN], out: null, json: null }), {
      out: null,
      json: null,
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
