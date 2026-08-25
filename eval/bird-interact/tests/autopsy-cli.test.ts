import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AutopsyError,
  READ_ONLY_CONNECTION,
  READ_ONLY_ROLE,
  SUPERUSER_CONNECTION,
  createPsqlQuery,
  loadAutopsyTasks,
  loadRuntimeManifestForRun,
  parseAutopsyArgs,
  renderAutopsyHtml,
  replayProbeRefusal,
  resolveGatedOutput,
  resolveReplayEnforcement,
  runAutopsy,
  unmeasuredRefusal,
  type ReplayEnforcement,
} from "../src/autopsy-cli.js";
import { CliUsageError } from "../src/cli-usage.js";
import {
  READ_ONLY_PASSWORD as PREPARED_READ_ONLY_PASSWORD,
  READ_ONLY_ROLE as PREPARED_READ_ONLY_ROLE,
} from "../src/prepare-cli.js";
import { SQL_RECORD_LIMIT } from "../src/preview-truncation.js";
import { esc } from "../src/report-html.js";
import { GATED_GROUND_TRUTH_NOTICE } from "../src/report-model.js";
import { COMBINED_FILENAME, RUNTIME_DIRECTORY, prepareManifestSchema } from "../src/runtime-layout.js";

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
    const query = createPsqlQuery(55432, "alien_template", READ_ONLY_CONNECTION);
    await assert.rejects(
      () => query(GOLD),
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
    const query = createPsqlQuery(55432, "alien_template", READ_ONLY_CONNECTION);
    await assert.rejects(
      () => query(GOLD),
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
      const query = createPsqlQuery(55432, "alien_template", READ_ONLY_CONNECTION);
      await assert.rejects(
        () => query(GOLD),
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
    enforcement: { connection: READ_ONLY_CONNECTION, caveat: null },
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

/* -------------------------------------------------------------------------- */
/* One replay, one result set, on every psql — and nothing left behind        */
/* -------------------------------------------------------------------------- */

/**
 * A `psql` that follows the six rules the replay depends on, so they can be tested without a
 * database. Every rule below was measured on real clients (psql 14.24 and 18.4) against real
 * servers (PostgreSQL 14.24 and 16.15) before being modelled here:
 *
 * - a `-c` argument whose FIRST CHARACTER is a backslash is a client-side META-COMMAND and is
 *   never sent to the server, and `\\!` runs its argument through the host shell — which is why
 *   this fake really does run it, so a test can prove nothing hands psql such a `-c`;
 * - any other `-c` argument is ONE batch sent to the server, and the client prints either every
 *   command's result (psql 15+, where `SHOW_ALL_RESULTS` defaults on) or only the LAST command's
 *   (psql 14, which has no such variable, and psql 15+ once it is turned off);
 * - a command that produces a RESULT SET prints, in unaligned mode with the footer on, a header
 *   record of column names, one record per row, and a `(N rows)` footer, joined by the record
 *   separator and terminated by a newline — `?column?\\x1e(0 rows)\\n` when the result set is empty;
 * - a command that produces NO result set prints nothing at all, because `-q` suppresses the
 *   command tag that is its only output;
 * - several `-c` arguments run in one session, so a transaction opened in one is still open in the
 *   next, and `ON_ERROR_STOP=1` stops at the first error and exits non-zero;
 * - the SERVER refuses a write while the transaction is read only — which
 *   `default_transaction_read_only` in `PGOPTIONS` makes true of the implicit transaction around
 *   every command, not only of the wrapper's explicit one.
 *
 * `marker` stands in for a table: the fake cannot create one, so a write that got through writes
 * that file instead, and a test asserts it is absent. `SELECT <list> WHERE false` is the one
 * modelled query shape that yields a result set of no rows, which is what tells the empty ANSWER
 * apart from the absent one.
 */
function fakePsql(options: { readonly printsAllResults: boolean; readonly marker: string }): string {
  // The interpreter is named absolutely: `withFakePsql` REPLACES PATH with the directory holding
  // this script, so `/usr/bin/env node` would have nowhere to look.
  return `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const { execSync } = require("node:child_process");
const FIELD = "\\u001f";
const RECORD = "\\u001e";
const PRINTS_ALL_RESULTS = ${options.printsAllResults ? "true" : "false"};
const MARKER = ${JSON.stringify(options.marker)};

const argv = process.argv.slice(2);
const batches = [];
let printsAllResults = PRINTS_ALL_RESULTS;
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "-c") {
    batches.push(argv[index + 1] ?? "");
    index += 1;
  } else if (PRINTS_ALL_RESULTS && argv[index] === "-v" && argv[index + 1] === "SHOW_ALL_RESULTS=off") {
    printsAllResults = false;
    index += 1;
  }
}

const readOnlyConnection = (process.env.PGOPTIONS ?? "").includes("default_transaction_read_only=on");
let readOnlyTransaction = false;
for (const batch of batches) {
  if (batch.startsWith("\\\\")) {
    if (batch.startsWith("\\\\!")) execSync(batch.slice(2), { stdio: "ignore" });
    const copy = /^\\\\copy\\b.*\\bTO\\s+'([^']*)'/i.exec(batch);
    if (copy !== null) writeFileSync(copy[1], "1\\n");
    continue;
  }
  const results = [];
  for (const command of batch.split(";").map((text) => text.trim()).filter((text) => text !== "")) {
    if (/^SET TRANSACTION READ ONLY$/i.test(command)) readOnlyTransaction = true;
    else if (/^(ROLLBACK|COMMIT)$/i.test(command)) readOnlyTransaction = false;
    if (/^SELECT /i.test(command)) {
      const empty = /\\s+WHERE false$/i.test(command);
      const fields = command.replace(/^SELECT /i, "").replace(/\\s+WHERE false$/i, "").split(",").map((field) => field.trim());
      results.push({ columns: fields.length, rows: empty ? [] : [fields] });
      continue;
    }
    if (/^(BEGIN|SET |ROLLBACK|COMMIT)/i.test(command)) {
      results.push(null);
      continue;
    }
    if (readOnlyConnection || readOnlyTransaction) {
      const kind = command.split(/\\s+/).slice(0, 2).join(" ");
      process.stderr.write("psql:<stdin>:1: ERROR:  cannot execute " + kind + " in a read-only transaction\\n");
      process.exit(1);
    }
    writeFileSync(MARKER, command);
    results.push(null);
  }
  for (const result of printsAllResults ? results : results.slice(-1)) {
    if (result === null) continue;
    const header = new Array(result.columns).fill("?column?").join(FIELD);
    const footer = "(" + result.rows.length + " row" + (result.rows.length === 1 ? "" : "s") + ")";
    const records = [header, ...result.rows.map((row) => row.join(FIELD)), footer];
    process.stdout.write(records.join(RECORD) + "\\n");
  }
}
`;
}

/** One task replayed through the real psql layer, with the fake `psql` above standing in for it. */
async function replayOneTask(
  script: string,
  task: { readonly goldSql: string; readonly agentSql: string },
): Promise<Awaited<ReturnType<typeof runAutopsy>>> {
  return await withFakePsql(script, async () =>
    runAutopsy({
      run: "alien-5",
      container: "c",
      port: 55432,
      tasks: [
        {
          taskId: "t",
          goldSql: task.goldSql,
          agentSql: task.agentSql,
          ambiguous: "a",
          clear: "b",
          category: "Query",
        },
      ],
      probe: async () => true,
      query: createPsqlQuery(55432, "alien_template", READ_ONLY_CONNECTION),
    }),
  );
}

/**
 * The defect this closes: on psql 14 — Ubuntu 22.04's stock client, and the autopsy uses the HOST
 * binary — the whole wrapper went to one `-c`, whose last command is `ROLLBACK`, so stdout was
 * empty. `parsePsqlRows("")` is `[]` for gold and for the agent, `tolerantEx([], [])` is true, and
 * every Query task published a tolerant pass over a comparison of nothing against nothing. The
 * probe never caught it: a bare `SELECT 1;` is a single command, so its result IS the last one.
 */
test("a client that prints only the last command's result cannot fabricate a tolerant pass", async () => {
  const marker = join(await mkdtemp(join(tmpdir(), "warble-replay-")), "written");
  const result = await replayOneTask(fakePsql({ printsAllResults: false, marker }), {
    goldSql: "SELECT 1, 2",
    agentSql: "SELECT 3, 4",
  });
  assert.equal(result.tasks[0]?.unmeasured, null, "the replay must produce a verdict at all");
  assert.equal(result.tolerant.t, false, "gold and the agent disagree, so this is not a pass");
});

/**
 * The defect this closes: gold's `sol_sql` is a LIST, joined into one `-c`, and on psql 15+ each
 * statement prints its own result set — separated by a plain newline, not by the configured record
 * separator. `1\x1f2\n3\x1f4\n` split on the record separator is ONE three-column row whose middle
 * cell is `2\n3`, so an agent whose answer matches gold's last statement was published as a
 * tolerant FAIL, breaking the invariant that tolerant is a superset of strict.
 */
test("a multi-statement gold is one result set, not rows merged across sets", async () => {
  const marker = join(await mkdtemp(join(tmpdir(), "warble-replay-")), "written");
  const script = fakePsql({ printsAllResults: true, marker });
  const rows = await withFakePsql(script, async () =>
    createPsqlQuery(55432, "alien_template", READ_ONLY_CONNECTION)("SELECT 1, 2;\nSELECT 3, 4"),
  );
  assert.deepEqual(rows, [[3, 4]], "the answer is the last statement's result set, whole and alone");

  const result = await replayOneTask(script, { goldSql: "SELECT 1, 2;\nSELECT 3, 4", agentSql: "SELECT 3, 4" });
  assert.equal(result.tasks[0]?.unmeasured, null);
  assert.equal(result.tolerant.t, true, "the agent's answer is gold's, so tolerant must not report a failure");
});

/**
 * The defect this closes: the read-only guarantee was a STRING wrapper, and a statement can end it.
 * Measured end to end before the fix, on a disposable PostgreSQL: replaying
 * `ROLLBACK; CREATE TABLE pwn AS SELECT 1; COMMIT` through the wrapper leaves `pwn` COMMITTED —
 * the embedded ROLLBACK ends the read-only transaction, the CREATE runs in the implicit one, the
 * embedded COMMIT commits it, and the wrapper's trailing ROLLBACK is a no-op warning. The target
 * is the template database every later replay reads, and the Management skip is by category, so a
 * mutation recorded under a Query task reaches it.
 */
test("a submission that ends the wrapper's transaction still cannot write", async () => {
  const marker = join(await mkdtemp(join(tmpdir(), "warble-replay-")), "written");
  const result = await replayOneTask(fakePsql({ printsAllResults: true, marker }), {
    goldSql: "SELECT 1, 2",
    agentSql: "ROLLBACK; CREATE TABLE pwn AS SELECT 1; COMMIT",
  });
  assert.equal(existsSync(marker), false, "the replay wrote to the database it was inspecting");
  assert.match(result.tasks[0]?.unmeasured ?? "", /read-only transaction/);
  assert.equal(result.tolerant.t, undefined, "a refused statement is unmeasured, never a verdict");
});

/**
 * The hole this closes, and the one the fix above opened.
 *
 * While the wrapper was ONE `-c` string, the recorded statement was never that string's first
 * character; putting it in a `-c` of its own — the fix that made every psql version print its rows
 * — also put it first, and psql decides what a `-c` IS from its first character. A leading
 * backslash makes the whole argument a client-side META-COMMAND that never reaches the server, and
 * `\\!` runs its argument through the host shell. Measured through the replay's own
 * `createPsqlQuery` against a real PostgreSQL 14.24 on psql 18.4: a statement of the form
 * `\\! id -un > /tmp/f` returned `[]` and left that file on the developer's machine holding the
 * name of whoever ran it; `\\copy (SELECT 1) TO '/tmp/f.csv'` wrote a host file the same way. None
 * of the three read-only layers can see it — the role, the setting and the wrapper are all
 * server-side, and this never reaches a server.
 *
 * The statement is dataset gold or recorded agent text, so BOTH sides are tested; the fake psql
 * really does run a leading `\\!` through the shell, so what is asserted is that nothing hands psql
 * such a `-c` at all.
 */
test("a statement psql would run as a host meta-command is refused, not executed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warble-meta-"));
  const marker = join(dir, "written");
  const fromAgent = join(dir, "agent-shell-ran");
  const fromGold = join(dir, "gold-shell-ran");
  const script = fakePsql({ printsAllResults: true, marker });

  // `echo` and `>` are shell builtins, so this proves a HOST SHELL ran without depending on a
  // PATH that `withFakePsql` has replaced with the fake's own directory.
  const agent = await replayOneTask(script, {
    goldSql: "SELECT 1, 2",
    agentSql: `\\! echo host psql executed this > ${fromAgent}`,
  });
  assert.equal(existsSync(fromAgent), false, "the replayed submission ran a command on the host");
  assert.equal(agent.tolerant.t, undefined, "a refused statement is unmeasured, never a verdict");
  assert.match(agent.tasks[0]?.unmeasured ?? "", /meta-command/);
  assert.ok(
    !(agent.tasks[0]?.unmeasured ?? "").includes(fromAgent),
    "the reason may say the shape of the statement, never the statement",
  );

  const gold = await replayOneTask(script, {
    goldSql: `\\copy (SELECT 1) TO '${fromGold}'`,
    agentSql: "SELECT 1, 2",
  });
  assert.equal(existsSync(fromGold), false, "the replayed gold wrote a file on the host");
  assert.equal(gold.tolerant.t, undefined);
  assert.match(gold.tasks[0]?.unmeasured ?? "", /meta-command/);
});

/**
 * The boundary, measured rather than reasoned about: psql looks at the RAW first character of the
 * `-c`, so leading whitespace, a leading comment and a backslash after a complete statement all
 * reach the server and fail there with `syntax error at or near "\\"` — identical on psql 14.24 and
 * 18.4. Those forms are refused here too, because a bare backslash is not valid PostgreSQL in any
 * position either, so widening the rule costs no measurable task while keeping it off the exact
 * character psql happens to look at today.
 */
test("the refusal covers a leading backslash however it is reached, and nothing else", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warble-meta-"));
  const script = fakePsql({ printsAllResults: true, marker: join(dir, "written") });
  for (const agentSql of ["\\! true", "   \\! true", "\n\\! true", "\t\\echo hi", "\\copy x TO 'y'"]) {
    const result = await replayOneTask(script, { goldSql: "SELECT 1, 2", agentSql });
    assert.match(result.tasks[0]?.unmeasured ?? "", /meta-command/, `not refused: ${JSON.stringify(agentSql)}`);
  }
  // A backslash the server does see is the server's business: it is inside a string literal, and
  // refusing it here would cost a measurement psql runs perfectly well.
  const inString = await replayOneTask(script, {
    goldSql: "SELECT 1, 2",
    agentSql: "SELECT 'a \\! not a meta-command'",
  });
  assert.equal(inString.tasks[0]?.unmeasured, null, "a backslash inside SQL must still be replayed");
});

/* -------------------------------------------------------------------------- */
/* Zero rows is an answer; no result set at all is not                        */
/* -------------------------------------------------------------------------- */

/**
 * The fabrication this closes, which survived the run-level probe because that probe is one
 * `SELECT 1` for the whole run rather than a question about each task.
 *
 * `sol_sql` is a LIST, and the replay reads the LAST statement's result set. When that last entry
 * produces no result set at all — a `SET`, a DDL, an `UPDATE` — psql prints nothing, gold parses
 * as `[]`, and `tolerantEx([], [])` is `true` against any submission that also produced nothing.
 * Measured through `createPsqlQuery` against PostgreSQL 14.24 before the fix, with
 * `agentSql = "SELECT 1 WHERE false"`: gold rows `[]`, verdict `{"answer_not_last": true}`,
 * unmeasured `null` — a published pass over a comparison of nothing against nothing.
 *
 * The two cases are told apart in psql's own output: under `-A` with the footer on, a result set
 * of zero rows still prints its header and `(0 rows)`, while a command with no result set prints
 * not one byte. Measured byte-identical on psql 14.24 and 18.4.
 */
test("a gold whose last statement produces no result set is not a nothing-vs-nothing pass", async () => {
  const marker = join(await mkdtemp(join(tmpdir(), "warble-replay-")), "written");
  const script = fakePsql({ printsAllResults: true, marker });

  const absent = await replayOneTask(script, {
    goldSql: "SELECT 1, 2;\nSET work_mem = '4MB'",
    agentSql: "SELECT 1 WHERE false",
  });
  assert.equal(absent.tolerant.t, undefined, "nothing was compared, so no verdict may be published");
  assert.match(absent.tasks[0]?.unmeasured ?? "", /no result set/);
  assert.match(absent.tasks[0]?.unmeasured ?? "", /gold/, "and it says which side produced none");

  // The distinction is the point: an EMPTY answer is still an answer, and is still measured.
  const empty = await replayOneTask(script, {
    goldSql: "SELECT 1 WHERE false",
    agentSql: "SELECT 1 WHERE false",
  });
  assert.equal(empty.tasks[0]?.unmeasured, null, "zero rows is a result set, and comparable");
  assert.equal(empty.tolerant.t, true, "and two zero-row answers agree");

  const submission = await replayOneTask(script, {
    goldSql: "SELECT 1, 2",
    agentSql: "SET work_mem = '4MB'",
  });
  assert.equal(submission.tolerant.t, undefined, "and the same holds when it is the submission");
  assert.match(submission.tasks[0]?.unmeasured ?? "", /no result set/);
});

/* -------------------------------------------------------------------------- */
/* A recorded submission that may be a prefix is not replayed                 */
/* -------------------------------------------------------------------------- */

/**
 * The defect this closes: only `native_sql` was checked against the statement limit. `artifacts.ts`
 * cuts `semantic_sql` and `args` at the same 2000 characters, and the fallbacks were replayed
 * VERBATIM — so a submission of that length reached psql as a PREFIX, and the syntax error the cut
 * caused was published as that task's "could not measure", or a prefix that happened to parse wrote
 * a fabricated verdict into `tolerant.json`.
 */
test("a submission cut at the trace statement limit is unmeasurable, not a replayed prefix", async () => {
  let replays = 0;
  const result = await runAutopsy({
    run: "alien-5",
    container: "c",
    port: 55432,
    tasks: [
      {
        taskId: "t",
        goldSql: "SELECT 1",
        agentSql: `SELECT ${"x".repeat(SQL_RECORD_LIMIT)}`.slice(0, SQL_RECORD_LIMIT),
        ambiguous: "a",
        clear: "b",
        category: "Query",
      },
    ],
    probe: async () => true,
    query: async () => {
      replays += 1;
      return [[1]];
    },
  });
  assert.equal(replays, 0, "a prefix must never reach psql");
  assert.equal(result.tolerant.t, undefined, "no verdict may be published from a prefix");
  assert.match(result.tasks[0]?.unmeasured ?? "", /statement limit/);
});

/** A run whose trace records one submission per task, in the forms `artifacts.ts` writes. */
async function dataRootWithTraces(
  run: string,
  traces: Readonly<Record<string, unknown>>,
): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "warble-traces-"));
  const runDir = join(dataRoot, "runs", run);
  await mkdir(join(dataRoot, RUNTIME_DIRECTORY), { recursive: true });
  const taskIds = Object.keys(traces);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(dataRoot, RUNTIME_DIRECTORY, COMBINED_FILENAME),
    `${taskIds
      .map((taskId) =>
        JSON.stringify({
          instance_id: taskId,
          category: "Query",
          amb_user_query: "a",
          query: "b",
          sol_sql: ["SELECT 1"],
        }),
      )
      .join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    join(runDir, "a-interact.json"),
    JSON.stringify({ results: taskIds.map((taskId) => ({ task_id: taskId })) }),
    "utf8",
  );
  for (const [taskId, trace] of Object.entries(traces)) {
    await mkdir(join(runDir, "traces", taskId), { recursive: true });
    await writeFile(join(runDir, "traces", taskId, "trace.json"), JSON.stringify(trace), "utf8");
  }
  return dataRoot;
}

/**
 * The rule the truncation check must not cost: a `native_sql` that was cut still falls back to the
 * form the agent wrote, because the MDL under this adapter is an identity projection and that form
 * answers the same question against the same PostgreSQL. What changes is that the fallback is
 * checked too — the FIRST form that survived recording intact is the one replayed, whichever it is.
 */
test("the first submission form that survived recording is the one replayed", async () => {
  const cut = "SELECT ".padEnd(SQL_RECORD_LIMIT, "x");
  const dataRoot = await dataRootWithTraces("alien-5", {
    alien_1: {
      tool_trajectory: [{ tool: "submit_sql", native_sql: cut, semantic_sql: "SELECT semantic" }],
    },
    alien_2: {
      tool_trajectory: [
        { tool: "submit_sql", native_sql: cut, semantic_sql: cut, args: { sql: "SELECT args" } },
      ],
    },
  });
  try {
    const { tasks } = await loadAutopsyTasks(dataRoot, "alien-5");
    assert.equal(tasks.find((task) => task.taskId === "alien_1")?.agentSql, "SELECT semantic");
    assert.equal(tasks.find((task) => task.taskId === "alien_2")?.agentSql, "SELECT args");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

/**
 * The masking half of the same defect: the old probe ran a bare `SELECT 1;`, which is a SINGLE
 * command, so its result IS the last one and psql 14 printed it. The client that returned zero
 * rows for every wrapped replay therefore passed the one check that could have caught it, and the
 * run went on to publish a tolerant pass per task. The probe now replays through the same wrapper
 * and checks the row it asked for.
 */
test("a psql that connects but returns no rows is a refusal, not a run of empty comparisons", () => {
  assert.equal(replayProbeRefusal([[1]]), null);
  for (const answer of [[], [[]], [[1], [1]], [[0]]]) {
    assert.match(replayProbeRefusal(answer) ?? "", /psql --version/);
  }
  // A client that prints nothing at all for `SELECT 1` is the same refusal about the client — not
  // a database that has to be started, and not one task's "could not measure" repeated per task.
  assert.match(replayProbeRefusal(null) ?? "", /psql --version/);
});

/* -------------------------------------------------------------------------- */
/* Which role replays, and saying so when it is not the read-only one         */
/* -------------------------------------------------------------------------- */

/**
 * The gap this closes: `default_transaction_read_only` is a SETTING, and the connection was the
 * image's superuser. Measured against a real PostgreSQL 14: a replayed
 * `ROLLBACK; SET default_transaction_read_only = off; CREATE TABLE pwn AS SELECT 1; COMMIT` leaves
 * the table committed on the template every later replay reads, because a superuser may always set
 * the setting back. `prepare-cli` now provisions a role that holds `pg_read_all_data` and nothing
 * else, and cannot re-grant itself CREATE; this is what makes the autopsy use it.
 */
test("replays connect as the read-only role the prepared runtime carries", async () => {
  const asked: { readonly user: string; readonly sql: string }[] = [];
  const enforcement = await resolveReplayEnforcement((connection) => async (sql) => {
    asked.push({ user: connection.user, sql });
    return [[1]];
  });
  assert.equal(asked[0]?.user, SUPERUSER_CONNECTION.user, "only a superuser can ask about roles");
  assert.match(asked[0]?.sql ?? "", new RegExp(`pg_roles.*${READ_ONLY_ROLE}`));
  assert.equal(enforcement.connection.user, READ_ONLY_ROLE);
  assert.equal(enforcement.caveat, null, "with the role in place there is nothing to warn about");
});

/**
 * The misdiagnosis this closes. A role whose password has drifted from the one preparation sets
 * still answers `SELECT count(*) FROM pg_roles` — asked as the superuser — so the enforcement came
 * back `caveat: null`, and the FIRST thing that noticed was the probe, which fails for every
 * reason at once. The run then refused with `nothing answered at 127.0.0.1:55491. Start container
 * '…' with docker start …`, one line under a stderr line reading `FATAL: password authentication
 * failed for user "warble_autopsy_readonly"`. The container was running the whole time.
 *
 * The cluster has already answered by the time the role is known to exist, so a login that then
 * fails is a fact about the ROLE. It is a refusal rather than a quiet fall back to the superuser:
 * a tree that HAS the role must not silently replay on the connection whose read-only-ness is only
 * a setting.
 */
test("a role that cannot be logged into is refused by name, not as an unreachable database", async () => {
  await assert.rejects(
    resolveReplayEnforcement((connection) => async () => {
      if (connection.user === SUPERUSER_CONNECTION.user) return [[1]];
      throw new Error(
        `connection to server at "127.0.0.1", port 55432 failed: FATAL:  password ` +
          `authentication failed for user "${READ_ONLY_ROLE}"`,
      );
    }),
    (error: unknown) => {
      assert.ok(error instanceof AutopsyError);
      assert.match(error.message, /password/, "the refusal must name the actual problem");
      assert.match(error.message, /prepare-bird-eval/, "and the command that fixes it");
      assert.ok(!/docker start/.test(error.message), "the container is not the problem");
      return true;
    },
  );
});

/**
 * A runtime prepared before the role existed must keep working — refusing every older tree would be
 * its own kind of damage — but it must not be reported as if the guarantee were in force. The
 * fallback is therefore stated, not silent, and it names the command that fixes it.
 */
test("a runtime without the role replays as the superuser and says so", async () => {
  const missing = await resolveReplayEnforcement(() => async () => [[0]]);
  assert.notEqual(missing.connection.user, READ_ONLY_ROLE);
  assert.match(missing.caveat ?? "", /prepare-bird-eval/);
  assert.match(missing.caveat ?? "", /superuser/);

  // A database that cannot even be asked must not be reported as one that answered "no role".
  const unknown = await resolveReplayEnforcement(() => async () => {
    throw new Error("connection refused");
  });
  assert.notEqual(unknown.connection.user, READ_ONLY_ROLE);
  assert.match(unknown.caveat ?? "", /could not be asked|connection refused/);

  // Nor may a psql that answers with no result set at all be read as an answer of "no role".
  const silent = await resolveReplayEnforcement(() => async () => null);
  assert.notEqual(silent.connection.user, READ_ONLY_ROLE);
  assert.match(silent.caveat ?? "", /could not be asked/);
});

/** The page is the artifact someone forwards, so the role it replayed as is on it either way. */
test("autopsy.html names the role that replayed, and warns when it is the superuser", async () => {
  const result = await runAutopsy({
    run: "alien-5",
    container: "c",
    port: 55432,
    tasks: [{ taskId: "ok", goldSql: "SELECT 1", agentSql: "SELECT 1", ambiguous: "a", clear: "b", category: "Query" }],
    probe: async () => true,
    query: async () => [[1]],
  });
  const page = (enforcement: ReplayEnforcement): string =>
    renderAutopsyHtml({
      run: "alien-5",
      container: "c",
      port: 55432,
      database: "alien_template",
      generatedAt: "2026-08-25T00:00:00.000Z",
      enforcement,
      result,
      skipped: [],
    });

  const enforced = page({ connection: READ_ONLY_CONNECTION, caveat: null });
  assert.ok(enforced.includes(esc(READ_ONLY_ROLE)), "the page must name the role it replayed as");
  assert.ok(!/Read-only is not enforced/.test(enforced), "nothing to warn about when it is enforced");

  const fallback = page({ connection: SUPERUSER_CONNECTION, caveat: "no read-only role; re-run prepare" });
  assert.ok(fallback.includes(esc("no read-only role; re-run prepare")));
  assert.ok(fallback.includes(esc(SUPERUSER_CONNECTION.user)), "and names what it replayed as instead");
  assert.ok(
    fallback.indexOf("Read-only is not enforced") < fallback.indexOf("<section>"),
    "the caveat is read before any verdict is",
  );
});

/**
 * The two bins cannot import each other — `prepare-cli` is a bin, and importing it into the autopsy
 * would inline its `main()` guard — so the autopsy restates the role the way it already restates
 * the superuser. Restated is not the same as agreed, and a role named two ways is a role the
 * autopsy cannot log in as, so the agreement is asserted here rather than assumed.
 */
test("the autopsy replays as exactly the role preparation provisions", () => {
  assert.equal(READ_ONLY_CONNECTION.user, PREPARED_READ_ONLY_ROLE);
  assert.equal(READ_ONLY_CONNECTION.password, PREPARED_READ_ONLY_PASSWORD);
});
