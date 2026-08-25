import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AutopsyError,
  createPsqlQuery,
  loadRuntimeManifestForRun,
  parseAutopsyArgs,
  renderAutopsyHtml,
  resolveGatedOutput,
  runAutopsy,
  unmeasuredRefusal,
} from "../src/autopsy-cli.js";
import { readOnlySelect } from "../src/autopsy-goldgap.js";
import { CliUsageError } from "../src/cli-usage.js";
import { esc } from "../src/report-html.js";
import { GATED_GROUND_TRUTH_NOTICE } from "../src/report-model.js";
import { RUNTIME_DIRECTORY, prepareManifestSchema } from "../src/runtime-layout.js";

test("exactly one run is required", () => {
  const parsed = parseAutopsyArgs(["alien-5"]);
  assert.equal(parsed.kind, "run");
  if (parsed.kind !== "run") return;
  assert.equal(parsed.config.run, "alien-5");
  assert.throws(() => parseAutopsyArgs([]), CliUsageError);
  assert.throws(() => parseAutopsyArgs(["a", "b"]), CliUsageError);
});

test("an unreachable database fails loudly, naming container and port", async () => {
  await assert.rejects(
    runAutopsy({
      run: "alien-5",
      container: "warble_bird_interact_postgresql",
      port: 55432,
      tasks: [],
      probe: async () => false,
      query: async () => {
        throw new Error("unreachable");
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("warble_bird_interact_postgresql") &&
      error.message.includes("55432"),
  );
});

test("a reachable database degrades per task, never per section", async () => {
  const result = await runAutopsy({
    run: "alien-5",
    container: "c",
    port: 55432,
    tasks: [
      { taskId: "ok", goldSql: "SELECT 1", agentSql: "SELECT 1", ambiguous: "a", clear: "b", category: "Query" },
      { taskId: "bad", goldSql: "SELECT 1", agentSql: "BOOM", ambiguous: "a", clear: "b", category: "Query" },
    ],
    probe: async () => true,
    query: async (sql: string) => {
      if (sql.includes("BOOM")) throw new Error('syntax error at or near "BOOM"');
      return [[1]];
    },
  });
  assert.equal(result.tolerant.ok, true);
  assert.equal(result.tasks.find((t) => t.taskId === "bad")?.unmeasured, 'syntax error at or near "BOOM"');
  assert.equal(result.tolerant.bad, undefined);
});

test("a Management task is skipped for the gap, with a stated reason", async () => {
  const result = await runAutopsy({
    run: "alien-5",
    container: "c",
    port: 55432,
    tasks: [
      {
        taskId: "m",
        goldSql: "UPDATE t SET x = 1",
        agentSql: "UPDATE t SET x = 1",
        ambiguous: "a",
        clear: "b",
        category: "Management",
      },
    ],
    probe: async () => true,
    query: async () => [[1]],
  });
  assert.match(result.tasks[0]?.unmeasured ?? "", /management/i);
});

/* -------------------------------------------------------------------------- */
/* The run must have run against the tree this autopsy replays                */
/* -------------------------------------------------------------------------- */

/** A prepared tree as `prepare-cli` records one, parsed through the package's own schema. */
function manifest(overrides: Record<string, unknown> = {}): unknown {
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
      repoDigests: [],
    },
    wren: { version: "wrenai 0.8.1" },
    taskIds: ["alien_1", "alien_2", "alien_3", "alien_4", "alien_5"],
    ...overrides,
  });
}

/** A data tree holding one run's manifest and the runtime manifest it will be checked against. */
async function dataRootWith(run: string, recorded: unknown, runtime: unknown): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "warble-autopsy-"));
  await mkdir(join(dataRoot, "runs", run), { recursive: true });
  await mkdir(join(dataRoot, RUNTIME_DIRECTORY), { recursive: true });
  if (recorded !== null) {
    await writeFile(join(dataRoot, "runs", run, "manifest.json"), JSON.stringify(recorded), "utf8");
  }
  if (runtime !== null) {
    await writeFile(join(dataRoot, RUNTIME_DIRECTORY, "manifest.json"), JSON.stringify(runtime), "utf8");
  }
  return dataRoot;
}

/**
 * The state this branch is in: `data/runs/alien-3` recorded a three-task tree and `data/runtime/`
 * now holds the five-task one. Without this check the autopsy replays the RE-PREPARED dataset's
 * gold against the current database and writes those verdicts into alien-3's directory, where the
 * report reads them beside alien-3's own manifest and presents the pair as one run.
 */
test("a run prepared against another runtime tree is refused, naming what differs", async () => {
  const dataRoot = await dataRootWith(
    "alien-3",
    manifest({ taskIds: ["alien_1", "alien_2", "alien_3"], createdAt: "2026-08-24T18:15:22.007Z" }),
    manifest(),
  );
  try {
    await assert.rejects(
      () => loadRuntimeManifestForRun(dataRoot, "alien-3"),
      (error: unknown) => {
        assert.ok(error instanceof AutopsyError, "must be an AutopsyError");
        assert.match(error.message, /alien-3/, "the refusal must name the run");
        assert.match(error.message, /taskIds/, "and the field that differs");
        assert.match(error.message, /alien_1, alien_2, alien_3;/, "and what the run recorded");
        assert.match(error.message, /tolerant\.json/, "and what it would otherwise have written");
        return true;
      },
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("a run prepared against this very tree is accepted, timestamp aside", async () => {
  const dataRoot = await dataRootWith(
    "alien-5",
    manifest({ createdAt: "2026-08-24T18:15:22.007Z" }),
    manifest(),
  );
  try {
    const runtime = await loadRuntimeManifestForRun(dataRoot, "alien-5");
    assert.equal(runtime.database.container, "warble_bird_interact_postgresql");
    assert.equal(runtime.database.hostPort, 55432);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("a run that recorded no manifest is refused rather than replayed unchecked", async () => {
  const dataRoot = await dataRootWith("alien-5", null, manifest());
  try {
    await assert.rejects(
      () => loadRuntimeManifestForRun(dataRoot, "alien-5"),
      (error: unknown) => error instanceof AutopsyError && /cannot be shown to be the ones/.test(error.message),
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("a missing runtime manifest still names the preparation command", async () => {
  const dataRoot = await dataRootWith("alien-5", manifest(), null);
  try {
    await assert.rejects(
      () => loadRuntimeManifestForRun(dataRoot, "alien-5"),
      (error: unknown) => error instanceof AutopsyError && /prepare-bird-eval/.test(error.message),
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* An autopsy that measured nothing writes no verdict file                    */
/* -------------------------------------------------------------------------- */

/**
 * `tolerant.json` used to be written unconditionally, so a run in which every task was unmeasured
 * — all Management, every statement in error, a container that died after the probe — wrote `{}`.
 * The report scores the tolerant column from that empty map, and because a strict pass counts as a
 * tolerant pass the column comes out BYTE-IDENTICAL to strict: "tolerant found nothing extra",
 * where the truth is that nothing was measured.
 */
test("an autopsy in which nothing could be measured refuses to write a verdict file", async () => {
  const result = await runAutopsy({
    run: "alien-5",
    container: "c",
    port: 55432,
    tasks: [
      { taskId: "m", goldSql: "UPDATE t SET x = 1", agentSql: "UPDATE t SET x = 1", ambiguous: "a", clear: "b", category: "Management" },
      { taskId: "bad", goldSql: "SELECT 1", agentSql: "BOOM", ambiguous: "a", clear: "b", category: "Query" },
    ],
    probe: async () => true,
    query: async (sql: string) => {
      if (sql.includes("BOOM")) throw new Error("boom");
      return [[1]];
    },
  });
  assert.deepEqual(result.tolerant, {}, "the fixture must leave every task unmeasured");
  const refusal = unmeasuredRefusal("alien-5", result);
  assert.ok(refusal !== null, "an empty verdict map must not be written");
  assert.match(refusal, /measured no task/i);
  assert.match(refusal, /identical to strict/i);
  assert.match(refusal, /autopsy\.html/, "the page that names each reason is still written");
});

test("an autopsy with even one verdict writes the file as before", async () => {
  const result = await runAutopsy({
    run: "alien-5",
    container: "c",
    port: 55432,
    tasks: [
      { taskId: "ok", goldSql: "SELECT 1", agentSql: "SELECT 1", ambiguous: "a", clear: "b", category: "Query" },
      { taskId: "bad", goldSql: "SELECT 1", agentSql: "BOOM", ambiguous: "a", clear: "b", category: "Query" },
    ],
    probe: async () => true,
    query: async (sql: string) => {
      if (sql.includes("BOOM")) throw new Error("boom");
      return [[1]];
    },
  });
  assert.equal(unmeasuredRefusal("alien-5", result), null);
});

/* -------------------------------------------------------------------------- */
/* A psql failure reports what failed, never what it was asked to run         */
/* -------------------------------------------------------------------------- */

/** Recognisable stand-in for gold: if it ever reaches a message, the assertion says so by name. */
const GOLD = "SELECT patient_id, secret_gold_column FROM gated_gold_table WHERE x = 1";

/** A `psql` that behaves as the test says, first on PATH for the duration of one call. */
async function withFakePsql<T>(script: string, body: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "warble-fake-psql-"));
  const path = join(dir, "psql");
  await writeFile(path, script, { encoding: "utf8", mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = dir;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The leak this closes: `execFile`'s rejection `message` is the whole argv, and this command's argv
 * ends in `-c BEGIN; SET TRANSACTION READ ONLY; <the gold statement> ROLLBACK;`. A statement
 * timeout rejects with an EMPTY stderr, so that message became the task's stated "could not
 * measure" reason and was escaped into `autopsy.html` — gated ground truth on a page that said
 * nothing about carrying any. The fake psql below reproduces the same shape without a 120s wait:
 * a non-zero exit and not one byte of stderr.
 */
test("a psql failure with no stderr never replays the statement it was given", async () => {
  await withFakePsql("#!/bin/sh\nexit 1\n", async () => {
    const query = createPsqlQuery(55432, "alien_template");
    await assert.rejects(
      () => query(readOnlySelect(GOLD)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes("secret_gold_column"), `the statement leaked: ${error.message}`);
        assert.ok(!error.message.includes("gated_gold_table"), `the statement leaked: ${error.message}`);
        assert.ok(!/Command failed/.test(error.message), "the argv must never be the message");
        assert.match(error.message, /psql exited with status 1/, "it must say what failed instead");
        return true;
      },
    );
  });
});

test("a psql that cannot be started says so without an argv", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warble-no-psql-"));
  const previous = process.env.PATH;
  process.env.PATH = dir;
  try {
    const query = createPsqlQuery(55432, "alien_template");
    await assert.rejects(
      () => query(readOnlySelect(GOLD)),
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes("secret_gold_column") &&
        /could not be started \(ENOENT\)/.test(error.message),
    );
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

/** The useful half stays useful: PostgreSQL's own complaint is still what the task reports. */
test("psql's own ERROR line is still what a measurable failure reports", async () => {
  await withFakePsql(
    '#!/bin/sh\necho \'psql:<stdin>:1: ERROR:  syntax error at or near "ROLLBACK"\' >&2\nexit 1\n',
    async () => {
      const query = createPsqlQuery(55432, "alien_template");
      await assert.rejects(
        () => query(readOnlySelect(GOLD)),
        (error: unknown) =>
          error instanceof Error && error.message === 'syntax error at or near "ROLLBACK"',
      );
    },
  );
});

/* -------------------------------------------------------------------------- */
/* The page says what it carries, and may only be written inside data/        */
/* -------------------------------------------------------------------------- */

/**
 * `report.html` states the gated constraint because it is one self-contained file someone forwards
 * without opening a task block first. An autopsy is the same kind of file and carries the same kind
 * of material — the psql error above is one route, the dataset's own question text another — and it
 * said nothing at all.
 */
test("autopsy.html carries the same gated notice report.html does", async () => {
  const result = await runAutopsy({
    run: "alien-5",
    container: "c",
    port: 55432,
    tasks: [{ taskId: "ok", goldSql: "SELECT 1", agentSql: "SELECT 1", ambiguous: "a", clear: "b", category: "Query" }],
    probe: async () => true,
    query: async () => [[1]],
  });
  const html = renderAutopsyHtml({
    run: "alien-5",
    container: "c",
    port: 55432,
    database: "alien_template",
    generatedAt: "2026-08-25T00:00:00.000Z",
    result,
    skipped: [],
  });
  // The sentence the IR pins, escaped exactly as `report.html` escapes it: one constraint, stated
  // identically on both artifacts rather than two wordings that drift apart.
  assert.ok(html.includes(esc(GATED_GROUND_TRUTH_NOTICE)), "the notice must be the one the IR pins");
  assert.match(html, /Gated benchmark material/);
  // Above the tasks, not inside one: it is read before anything is decided about the page.
  assert.ok(html.indexOf("Gated benchmark material") < html.indexOf("<section>"));
});

test("an --out path outside the data tree is refused before the database is touched", async () => {
  const dataRoot = await dataRootWith("alien-5", manifest(), manifest());
  try {
    await assert.rejects(
      () => resolveGatedOutput(dataRoot, join(dataRoot, "..", "escaped-autopsy.html")),
      (error: unknown) => {
        assert.ok(error instanceof AutopsyError, "must be an AutopsyError");
        assert.match(error.message, /--out/);
        assert.match(error.message, /escaped-autopsy\.html/);
        assert.match(error.message, /ground-truth SQL/);
        return true;
      },
    );
    const inside = await resolveGatedOutput(dataRoot, join(dataRoot, "runs", "alien-5", "custom.html"));
    assert.ok(inside?.endsWith("custom.html"));
    assert.equal(await resolveGatedOutput(dataRoot, null), null);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
