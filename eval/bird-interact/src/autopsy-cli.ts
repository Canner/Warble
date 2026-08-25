#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

import {
  describeGap,
  questionDiff,
  readOnlySelect,
  type DiffSegment,
  type Gap,
} from "./autopsy-goldgap.js";
import { tolerantEx, TolerantSearchLimit } from "./autopsy-tolerant.js";
import { CliUsageError } from "./cli-usage.js";
import { esc } from "./report-html.js";
import { GATED_GROUND_TRUTH_NOTICE } from "./report-model.js";
import {
  COMBINED_FILENAME,
  RUNTIME_DIRECTORY,
  type PrepareManifest,
  checkGatedOutputPath,
  compareRunManifest,
  describeManifestMismatch,
  readPrepareManifest,
} from "./runtime-layout.js";

/**
 * The autopsy bin: the offline report's companion, and the only part of the report path that
 * reaches the database.
 *
 * `report-cli` answers "what did the run record?" from disk alone. This answers the question a
 * recorded run cannot: **were the agent's numbers right?** The official scorer's phase-1
 * comparison is strict about row order, extra columns and numeric representation, so an answer
 * whose values are gold's — sorted the other way, or one column wider — scores zero and reads in
 * the report as a wrong answer. Replaying both statements and comparing with `tolerantEx` names
 * that case; `describeGap` then says what is actually missing, and `questionDiff` shows what the
 * ambiguous question hid. The verdicts land in `tolerant.json`, which `report-cli` reads to fill
 * its tolerant column — the two bins meet on that file and nowhere else.
 *
 * Three rules shape everything below.
 *
 * **An unreachable database is a loud failure, not a degraded report.** `runAutopsy` probes first
 * and throws, naming the container and the port and how to start it. A report that quietly omits
 * a section is worse than one that refuses to run, because the reader cannot tell an absent
 * section from an empty one.
 *
 * **Inside a reachable run, degradation is per task and never per section.** A statement that
 * will not execute, or a `TolerantSearchLimit` that means the search never finished, makes that
 * one task say "could not measure" — it never becomes a `false` verdict, which would report a
 * confident wrong-answer finding for a task nothing actually judged. An unmeasured task is
 * absent from `tolerant.json` entirely, and `report-build` already reads absence as "not judged"
 * rather than "judged failing".
 *
 * **Nothing this bin runs can leave anything behind.** Every statement goes through
 * `readOnlySelect`, so it executes inside `BEGIN; SET TRANSACTION READ ONLY;` … `ROLLBACK;`.
 * `Management` tasks are skipped for exactly that reason: their submissions are mutations, which
 * a read-only transaction refuses by design.
 *
 * Like `report-cli`, it reads `readPrepareManifest` from `runtime-layout.js` rather than through
 * `prepare-cli.js`, which re-exports it. `prepare-cli` is a bin, and with `splitting: false`
 * importing a bin inlines its module — direct-execution guard and all — into this entry file,
 * where the guard would match on THIS file's `import.meta.url` and run `prepare-cli`'s `main()`.
 */

const PACKAGE_VERSION = "0.1.0";

export { CliUsageError };

export const USAGE = "usage: warble-bird-autopsy <run> [--out <file>]";

/** A run's recorded inputs could not be read; the message never quotes file contents. */
export class AutopsyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutopsyError";
  }
}

/* -------------------------------------------------------------------------- */
/* CLI contract                                                               */
/* -------------------------------------------------------------------------- */

export interface AutopsyArgs {
  /** One run directory name under `data/runs/`. */
  readonly run: string;
  /** The HTML file to write, or `null` for `<run>/autopsy.html`. */
  readonly out: string | null;
}

export type AutopsyParseResult =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; config: AutopsyArgs };

/**
 * Exactly one run, named positionally.
 *
 * `report-cli` takes many because comparing runs on one page is the point of a report. An
 * autopsy is not comparative — it replays one run's SQL against one database — so a second
 * positional is a usage error rather than a silently ignored argument.
 */
export function parseAutopsyArgs(argv: readonly string[]): AutopsyParseResult {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      strict: true,
      // The subject of an autopsy is a run, so it is named positionally, exactly as in the report.
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
        out: { type: "string" },
      },
    }));
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }

  if (values.help === true) return { kind: "help" };
  if (values.version === true) return { kind: "version" };

  if (positionals.length === 0) throw new CliUsageError(USAGE);
  if (positionals.length > 1) {
    throw new CliUsageError(`an autopsy covers exactly one run; got ${positionals.length}. ${USAGE}`);
  }
  const run = positionals[0];
  if (run === undefined || run === "") throw new CliUsageError(USAGE);

  const out = values.out;
  if (out !== undefined && (typeof out !== "string" || out.length === 0)) {
    throw new CliUsageError("--out requires a value");
  }

  return { kind: "run", config: { run, out: out ?? null } };
}

/* -------------------------------------------------------------------------- */
/* The autopsy itself                                                         */
/* -------------------------------------------------------------------------- */

/** One task's two statements and the two questions behind them. */
export interface AutopsyTaskInput {
  readonly taskId: string;
  readonly goldSql: string;
  readonly agentSql: string;
  readonly ambiguous: string;
  readonly clear: string;
  readonly category: string;
}

export interface TaskAutopsy {
  readonly taskId: string;
  /** The reason this task could not be measured, or `null` when it was. */
  readonly unmeasured: string | null;
  readonly gap: Gap | null;
  readonly question: { readonly left: DiffSegment[]; readonly right: DiffSegment[] };
}

export interface AutopsyDeps {
  readonly run: string;
  readonly container: string;
  readonly port: number;
  readonly tasks: readonly AutopsyTaskInput[];
  readonly probe: () => Promise<boolean>;
  readonly query: (sql: string) => Promise<unknown[][]>;
}

export interface AutopsyResult {
  /** Only the tasks that produced a verdict; an unmeasured task is absent, never `false`. */
  readonly tolerant: Readonly<Record<string, boolean>>;
  readonly tasks: readonly TaskAutopsy[];
}

/** Why a `Management` submission cannot be replayed; stated, never silently skipped. */
export const MANAGEMENT_REASON =
  "management submissions are mutations and cannot be a read-only CTE";

/**
 * Terminate a statement so `readOnlySelect` can append `ROLLBACK;` after it.
 *
 * Wren's planner emits native SQL with no trailing semicolon, which turns the wrapper into
 * `... ORDER BY x ROLLBACK;` — a syntax error that would report every planned submission as
 * unmeasurable. The terminator goes on its own line so a statement ending in a `--` comment does
 * not swallow it.
 */
function terminated(sql: string): string {
  return `${sql.trim().replace(/;+\s*$/, "")}\n;`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Replay every task against the prepared database and judge it tolerantly.
 *
 * `probe` and `query` are injected so this stays testable without a database, and so the one
 * place that knows how to reach PostgreSQL is `main`.
 */
export async function runAutopsy(deps: AutopsyDeps): Promise<AutopsyResult> {
  if (!(await deps.probe())) {
    throw new AutopsyError(
      `the autopsy for run ${deps.run} needs the prepared PostgreSQL, and nothing answered at ` +
        `127.0.0.1:${deps.port}. Start container '${deps.container}' with ` +
        `\`docker start ${deps.container}\` (it must publish ${deps.port}), or re-create it with ` +
        `\`just prepare-bird-eval\`, then run this again. Refusing to write an autopsy whose ` +
        `every verdict would be missing.`,
    );
  }

  const tolerant: Record<string, boolean> = {};
  const tasks: TaskAutopsy[] = [];

  for (const task of deps.tasks) {
    // The diff is dataset text, so it survives every failure below and is always reported.
    const question = questionDiff(task.ambiguous, task.clear);
    const record = (unmeasured: string | null, gap: Gap | null): void => {
      tasks.push({ taskId: task.taskId, unmeasured, gap, question });
    };

    if (task.category === "Management") {
      record(MANAGEMENT_REASON, null);
      continue;
    }
    if (task.goldSql.trim() === "") {
      record("the dataset records no gold SQL for this task", null);
      continue;
    }
    if (task.agentSql.trim() === "") {
      record("the agent submitted no SQL in phase 1, so there is nothing to replay", null);
      continue;
    }

    try {
      const goldRows = await deps.query(readOnlySelect(terminated(task.goldSql)));
      const agentRows = await deps.query(readOnlySelect(terminated(task.agentSql)));
      // Compute the verdict BEFORE recording it: a `TolerantSearchLimit` thrown here must leave
      // the task with no verdict at all rather than a `false` nothing finished judging.
      const passed = tolerantEx(agentRows, goldRows);
      tolerant[task.taskId] = passed;
      record(null, describeGap(agentRows, goldRows));
    } catch (error) {
      record(
        error instanceof TolerantSearchLimit
          ? `${error.message}; the verdict is withheld rather than reported as a failure`
          : messageOf(error),
        null,
      );
    }
  }

  return { tolerant, tasks };
}

/* -------------------------------------------------------------------------- */
/* Reaching the prepared PostgreSQL                                           */
/* -------------------------------------------------------------------------- */

const execFileAsync = promisify(execFile);

/**
 * The official image's credentials, as `prepare-cli` sets them when it creates the container.
 *
 * They are restated rather than imported: `prepare-cli` is a bin, and importing it here would
 * inline its `main()` guard into this entry file (see the module doc comment).
 */
const POSTGRES_USER = "root";
const POSTGRES_PASSWORD = "123123";

/**
 * Field, record and NULL markers for psql's unaligned output.
 *
 * The defaults are `|`, newline and the empty string — all three of which occur inside real
 * cell values, so a value containing a pipe would silently become two columns and a NULL would
 * be indistinguishable from an empty string. ASCII's separator controls cannot appear in
 * PostgreSQL text output that this eval produces, so the split is unambiguous.
 */
const FIELD_SEPARATOR = "\u001f";
const RECORD_SEPARATOR = "\u001e";
const NULL_MARKER = "\u001d";

const PSQL_TIMEOUT_MS = 120_000;
const PSQL_MAX_BUFFER = 32 * 1024 * 1024;

/** A number as PostgreSQL writes it: no leading `+`, no thousands separators, optional exponent. */
const NUMERIC_FIELD = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Turn one psql field back into a value `normalizeCell` can compare across representations.
 *
 * psql hands back text, and text comparison is exactly what tolerant exists to avoid: gold's
 * `numeric` average prints `2.0000000000000000` where an agent's `double precision` prints `2`,
 * and as strings those are a mismatch while as numbers they are the same answer. Integers past
 * double precision stay text, because parsing them would merge neighbouring ids into one value.
 */
function coerceCell(field: string): unknown {
  if (field === NULL_MARKER) return null;
  if (!NUMERIC_FIELD.test(field)) return field;
  const value = Number(field);
  if (!Number.isFinite(value)) return field;
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) return field;
  return value;
}

/**
 * Parse psql's unaligned, tuples-only output into rows.
 *
 * psql separates records with `RECORD_SEPARATOR` and terminates the whole result with a newline;
 * that one trailing newline is dropped, and an empty result yields no rows at all.
 */
export function parsePsqlRows(stdout: string): unknown[][] {
  const body = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (body === "") return [];
  return body.split(RECORD_SEPARATOR).map((record) => record.split(FIELD_SEPARATOR).map(coerceCell));
}

/**
 * What went wrong with the psql PROCESS, said without replaying what it was asked to run.
 *
 * Node builds an `execFile` rejection's `message` out of the whole argv, and this command's argv
 * ends in `-c BEGIN; SET TRANSACTION READ ONLY; <the gold statement> ROLLBACK;`. A statement
 * timeout rejects with an EMPTY stderr, so that message used to become the task's stated "could
 * not measure" reason and was escaped straight into `autopsy.html`: the benchmark's ground-truth
 * SQL, on a page that never said it carried any. Only the structural facts are reported here —
 * what failed, never what was sent.
 */
function describePsqlFailure(error: unknown): string {
  const failed = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    signal?: unknown;
    killed?: unknown;
  };
  if (failed.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return `psql produced more than ${PSQL_MAX_BUFFER} bytes of output and was stopped`;
  }
  if (typeof failed.signal === "string" || failed.killed === true) {
    const signal = typeof failed.signal === "string" ? failed.signal : "SIGKILL";
    return `psql was killed (${signal}), which is what the ${PSQL_TIMEOUT_MS / 1000}s statement timeout does`;
  }
  if (typeof failed.code === "number") {
    return `psql exited with status ${failed.code} and wrote nothing to stderr`;
  }
  if (typeof failed.code === "string") return `psql could not be started (${failed.code})`;
  return "psql failed without writing anything to stderr";
}

/**
 * The first line of psql's complaint, without its `psql:<source>:<line>:` prefix.
 *
 * The reader wants `syntax error at or near "ROLLBACK"`, not three lines of caret art, and the
 * message becomes a task's stated "could not measure" reason. When psql said nothing at all, the
 * fallback describes the FAILURE and never the statement — see `describePsqlFailure`.
 */
function psqlErrorMessage(stderr: string, fallback: string): string {
  for (const raw of stderr.split("\n")) {
    const line = raw.replace(/^psql:[^:]*:\d+:\s*/, "").trim();
    if (line.startsWith("ERROR:")) return line.replace(/^ERROR:\s*/, "");
  }
  const first = stderr.split("\n").find((line) => line.trim() !== "");
  return first === undefined ? fallback : first.trim();
}

/** Run one statement through the host's `psql` against the container's published port. */
export function createPsqlQuery(port: number, database: string): (sql: string) => Promise<unknown[][]> {
  return async (sql: string): Promise<unknown[][]> => {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        "psql",
        [
          "-X",
          "-A",
          "-t",
          // Quiet suppresses the BEGIN/SET/ROLLBACK command tags, leaving only the result rows.
          "-q",
          // Never prompt: a missing password must fail fast, not hang a report waiting on a tty.
          "-w",
          "-v",
          "ON_ERROR_STOP=1",
          "-F",
          FIELD_SEPARATOR,
          "-R",
          RECORD_SEPARATOR,
          "-P",
          `null=${NULL_MARKER}`,
          "-h",
          "127.0.0.1",
          "-p",
          String(port),
          "-U",
          POSTGRES_USER,
          "-d",
          database,
          "-c",
          sql,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, PGPASSWORD: POSTGRES_PASSWORD, PGCLIENTENCODING: "UTF8" },
          maxBuffer: PSQL_MAX_BUFFER,
          timeout: PSQL_TIMEOUT_MS,
          killSignal: "SIGKILL",
        },
      ));
    } catch (error) {
      // One path for every failure: nothing below may reach for the error's own message, which is
      // the argv — the gold statement included.
      const reported = (typeof error === "object" && error !== null ? error : {}) as {
        stderr?: unknown;
      };
      const stderr = typeof reported.stderr === "string" ? reported.stderr : "";
      throw new Error(psqlErrorMessage(stderr, describePsqlFailure(error)));
    }
    return parsePsqlRows(stdout);
  };
}

/* -------------------------------------------------------------------------- */
/* Reading a finished run                                                     */
/* -------------------------------------------------------------------------- */

const A_INTERACT_FILE = "a-interact.json";
const TRACES_DIRECTORY = "traces";
const TRACE_FILE = "trace.json";
const PHASE_ONE_PASSED = "Phase 1 correct";

/**
 * `artifacts.ts`'s `PREVIEW_LIMIT`: every string it records is cut to this length.
 *
 * A trace is a preview, not a transcript, so a `native_sql` this long is a PREFIX of the statement
 * that ran — Wren's planner expands one page of semantic SQL into several thousand characters of
 * nested projections, and replaying the prefix yields `syntax error at or near ...` for a
 * submission that was perfectly valid. That is a recording limit, not a fact about the answer, so
 * it must not be reported as one.
 */
const TRACE_PREVIEW_LIMIT = 2_000;

/** One dataset row, narrowed to what an autopsy replays. */
interface AutopsyDatasetRow {
  readonly instance_id: string;
  readonly category?: string;
  readonly amb_user_query?: string;
  readonly query?: string;
  readonly sol_sql?: readonly unknown[];
  readonly preprocess_sql?: readonly unknown[];
}

/** A task named in the run but left out of the replay, with the reason. */
export interface SkippedTask {
  readonly taskId: string;
  readonly reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  const text = await readTextFile(path);
  if (text === null) throw new AutopsyError(`${label} is missing or unreadable: ${path}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AutopsyError(`${label} is not valid JSON: ${path}`);
  }
}

/** The dataset rows an autopsy replays, keyed by `instance_id`. */
async function readDataset(dataRoot: string): Promise<Record<string, AutopsyDatasetRow>> {
  const path = join(dataRoot, RUNTIME_DIRECTORY, COMBINED_FILENAME);
  const text = await readTextFile(path);
  if (text === null) {
    throw new AutopsyError(
      `no prepared dataset at ${path}; there is no gold SQL to replay. Run \`just prepare-bird-eval\` first.`,
    );
  }
  const rows: Record<string, AutopsyDatasetRow> = {};
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      const truncated = index === lines.length - 1;
      process.stderr.write(
        `skipped ${truncated ? "truncated final " : ""}line ${index + 1} of ${path}: not valid JSON\n`,
      );
      continue;
    }
    if (!isRecord(value) || typeof value.instance_id !== "string" || value.instance_id === "") {
      process.stderr.write(`skipped line ${index + 1} of ${path}: unknown record, no instance_id\n`);
      continue;
    }
    rows[value.instance_id] = value as unknown as AutopsyDatasetRow;
  }
  return rows;
}

/**
 * The SQL that answered PHASE 1, as it actually reached PostgreSQL.
 *
 * Three choices matter here. The submission is the LAST of phase 1 — earlier attempts are drafts,
 * and the phase ends at the first submission the harness accepted, so a task that went on to
 * phase 2 must not be judged on the follow-up query, which answers a different question.
 * `native_sql` is preferred over `semantic_sql` because it is what Wren planned and what the
 * database ran; the semantic form is the fallback for a submission that bypassed planning. And a
 * `native_sql` sitting on `TRACE_PREVIEW_LIMIT` is a truncated prefix, so the semantic form is
 * used instead — the MDL under this adapter is an identity projection of the physical tables, so
 * what the agent wrote executes against the same PostgreSQL and answers the same question. The
 * alternative, replaying a prefix, reports a syntax error the agent never made.
 */
function phaseOneAgentSql(trace: unknown): string {
  if (!isRecord(trace) || !Array.isArray(trace.tool_trajectory)) return "";
  let chosen = "";
  for (const entry of trace.tool_trajectory) {
    if (!isRecord(entry) || entry.tool !== "submit_sql") continue;
    const recorded = typeof entry.native_sql === "string" ? entry.native_sql : "";
    const native = recorded.length >= TRACE_PREVIEW_LIMIT ? "" : recorded;
    const semantic = typeof entry.semantic_sql === "string" ? entry.semantic_sql : "";
    const args = isRecord(entry.args) && typeof entry.args.sql === "string" ? entry.args.sql : "";
    chosen = native !== "" ? native : semantic !== "" ? semantic : args;
    const result = typeof entry.result === "string" ? entry.result : "";
    if (result.includes(PHASE_ONE_PASSED)) break;
  }
  return chosen;
}

/** Task ids the run covered, in the order the official file lists them. */
async function readRunTaskIds(runDir: string, run: string): Promise<string[]> {
  const path = join(runDir, A_INTERACT_FILE);
  const official = await readJsonFile(path, `run ${run}: ${A_INTERACT_FILE}`);
  if (isRecord(official) && Array.isArray(official.results)) {
    const ids: string[] = [];
    for (const row of official.results) {
      if (isRecord(row) && typeof row.task_id === "string" && row.task_id !== "") ids.push(row.task_id);
    }
    if (ids.length > 0) return ids;
  }
  // A result file with no rows still leaves traces behind; naming those tasks says more than
  // reporting an empty autopsy would.
  const entries = await readdir(join(runDir, TRACES_DIRECTORY), { withFileTypes: true }).catch(() => null);
  return (entries ?? []).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function statements(value: readonly unknown[] | undefined): string {
  return (value ?? []).filter((entry): entry is string => typeof entry === "string").join(";\n");
}

/** Everything `runAutopsy` replays for one run, plus the tasks it will not attempt at all. */
export async function loadAutopsyTasks(
  dataRoot: string,
  run: string,
): Promise<{ tasks: AutopsyTaskInput[]; skipped: SkippedTask[] }> {
  const runDir = join(dataRoot, "runs", run);
  const taskIds = await readRunTaskIds(runDir, run);
  const dataset = await readDataset(dataRoot);

  const tasks: AutopsyTaskInput[] = [];
  const skipped: SkippedTask[] = [];
  for (const taskId of taskIds) {
    const row = dataset[taskId];
    if (row === undefined) {
      skipped.push({ taskId, reason: "no dataset row carries this instance_id, so gold is unknown" });
      continue;
    }
    // `preprocess_sql` is setup the official scorer runs before gold, and it mutates. A read-only
    // replay cannot reproduce it, and gold computed without it would be a different answer — so
    // the task is named as not attempted rather than measured against the wrong baseline.
    if (statements(row.preprocess_sql) !== "") {
      skipped.push({
        taskId,
        reason: "gold needs preprocess_sql, which mutates and cannot run in a read-only replay",
      });
      continue;
    }
    tasks.push({
      taskId,
      goldSql: statements(row.sol_sql),
      agentSql: phaseOneAgentSql(await readOptionalTrace(runDir, taskId)),
      ambiguous: typeof row.amb_user_query === "string" ? row.amb_user_query : "",
      clear: typeof row.query === "string" ? row.query : "",
      category: typeof row.category === "string" ? row.category : "unknown",
    });
  }
  return { tasks, skipped };
}

async function readOptionalTrace(runDir: string, taskId: string): Promise<unknown> {
  const text = await readTextFile(join(runDir, TRACES_DIRECTORY, taskId, TRACE_FILE));
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    process.stderr.write(`skipped the trace for ${taskId}: not valid JSON\n`);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* The page                                                                   */
/* -------------------------------------------------------------------------- */

/** One English sentence per gap shape; the reader never has to decode a discriminant. */
export function describeGapText(gap: Gap): string {
  if (gap.kind === "match") {
    return "every gold column is present in the agent's result, by value.";
  }
  if (gap.kind === "row-count") {
    return `the agent returned ${gap.agentRows} row${gap.agentRows === 1 ? "" : "s"} where gold returns ${gap.goldRows}; with different heights no per-column comparison is meaningful.`;
  }
  const columns = gap.missing.map((index) => `#${index + 1}`).join(", ");
  return `gold column${gap.missing.length === 1 ? "" : "s"} ${columns} ${gap.missing.length === 1 ? "has" : "have"} no counterpart in the agent's result. Columns are matched by VALUE, never by name: the agent names its columns after the user's words and gold after the schema, and the official scorer compares values too.`;
}

function renderQuestion(segments: readonly DiffSegment[]): string {
  return segments
    .map((segment) => (segment.changed ? `<mark>${esc(segment.text)}</mark>` : esc(segment.text)))
    .join("");
}

interface PageInputs {
  readonly run: string;
  readonly container: string;
  readonly port: number;
  readonly database: string;
  readonly generatedAt: string;
  readonly result: AutopsyResult;
  readonly skipped: readonly SkippedTask[];
}

/**
 * The gated-material notice, immediately under the title — the same sentence `report.html` renders.
 *
 * This page carries gated benchmark material too, and until now said nothing about it. Gold SQL
 * reaches it directly whenever psql refuses a statement (the error names the fragment it choked
 * on), and the question diff beside every task is the dataset's own text. `report.html` states the
 * constraint because it is a single self-contained file someone forwards without opening a task
 * block first; an autopsy is exactly the same kind of file.
 *
 * The wording is the constant `report-model` pins and `report.json` carries verbatim, so the two
 * artifacts state one constraint rather than two that drifted apart.
 */
function gatedNotice(): string {
  return `<p class="gated"><strong>Gated benchmark material.</strong> ${esc(GATED_GROUND_TRUTH_NOTICE)}</p>`;
}

/** The autopsy as one self-contained page; pure, so the same inputs render byte-identically. */
export function renderAutopsyHtml(inputs: PageInputs): string {
  const { result } = inputs;
  const measured = result.tasks.filter((task) => task.unmeasured === null);
  const passes = measured.filter((task) => result.tolerant[task.taskId] === true).length;

  const rows = result.tasks
    .map((task) => {
      const verdict =
        task.unmeasured !== null
          ? `<span class="warn">could not measure</span>`
          : result.tolerant[task.taskId] === true
            ? `<span class="pass">tolerant pass</span>`
            : `<span class="fail">tolerant fail</span>`;
      const finding =
        task.unmeasured !== null
          ? esc(task.unmeasured)
          : task.gap === null
            ? "no gap was computed."
            : esc(describeGapText(task.gap));
      return `<section>
  <h2>${esc(task.taskId)} — ${verdict}</h2>
  <p class="finding">${finding}</p>
  <div class="diff">
    <div><h3>what the agent was asked</h3><p>${renderQuestion(task.question.left)}</p></div>
    <div><h3>what the task actually meant</h3><p>${renderQuestion(task.question.right)}</p></div>
  </div>
</section>`;
    })
    .join("\n");

  const skippedRows =
    inputs.skipped.length === 0
      ? ""
      : `<section class="skipped">
  <h2>not attempted</h2>
  <ul>${inputs.skipped.map((entry) => `<li><b>${esc(entry.taskId)}</b>: ${esc(entry.reason)}</li>`).join("")}</ul>
</section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BIRD-Interact autopsy — ${esc(inputs.run)}</title>
<style>
:root { color-scheme: light dark; }
body { font: 16px/1.55 system-ui, sans-serif; margin: 0 auto; max-width: 60rem; padding: 2rem 1rem; }
h1 { font-size: 1.5rem; margin-bottom: .25rem; }
h2 { font-size: 1.05rem; margin: 0 0 .35rem; }
h3 { font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; opacity: .65; margin: 0 0 .25rem; }
.provenance { opacity: .7; font-size: .85rem; margin-top: 0; }
section { border: 1px solid rgba(128,128,128,.35); border-radius: .5rem; padding: 1rem; margin: 1rem 0; }
.finding { margin: 0 0 .9rem; }
.diff { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); }
.diff p { margin: 0; }
mark { background: rgba(255, 196, 0, .35); color: inherit; padding: 0 .1em; }
.pass { color: #157f3b; font-weight: 600; }
.fail { color: #b3261e; font-weight: 600; }
.warn { color: #8a6100; font-weight: 600; }
.skipped ul { margin: 0; padding-left: 1.1rem; }
.gated { border: 1px solid #b3261e; border-left: 5px solid #b3261e; border-radius: .3rem; padding: .7rem .9rem; margin: 1rem 0 1.6rem; font-size: .92rem; }
.gated strong { color: #b3261e; }
</style>
</head>
<body>
<h1>BIRD-Interact autopsy — ${esc(inputs.run)}</h1>
<p class="provenance">${esc(inputs.database)} in container ${esc(inputs.container)} on 127.0.0.1:${esc(inputs.port)} · generated ${esc(inputs.generatedAt)}</p>
${gatedNotice()}
<p>Tolerant phase 1: <b>${passes}/${measured.length}</b> measured task${measured.length === 1 ? "" : "s"} pass; ${result.tasks.length - measured.length} could not be measured. Tolerant absorbs row order, extra columns, extra rows and numeric representation — it asks whether the agent computed gold's numbers, not whether it shaped them gold's way. Only the measured passes reach <code>tolerant.json</code>; a task that could not be measured is absent from it, never recorded as a failure.</p>
${rows}
${skippedRows}
</body>
</html>
`;
}

/* -------------------------------------------------------------------------- */
/* The run-versus-runtime cross-check, and what the run may write             */
/* -------------------------------------------------------------------------- */

/**
 * The runtime manifest to work from, once the run is shown to have run against this very tree.
 *
 * An autopsy takes its container, port and database from `data/runtime/manifest.json` and its GOLD
 * SQL from the dataset beside it, and it writes its verdicts into `data/runs/<run>/`. Nothing tied
 * those two ends together: preparation re-run for a different subset leaves `data/runs/alien-3`
 * describing a three-task tree while the runtime tree holds five, and `warble-bird-autopsy alien-3`
 * would then replay a re-prepared dataset's gold and write those verdicts into alien-3's directory
 * — where the report reads them beside alien-3's own manifest and presents the pair as one run.
 *
 * A run that recorded no manifest is refused for the same reason: with nothing to compare, the
 * gold about to be replayed cannot be shown to be the gold the run faced.
 *
 * See `compareRunManifest` for the fields this compares and the ones it deliberately ignores.
 */
export async function loadRuntimeManifestForRun(
  dataRoot: string,
  run: string,
): Promise<PrepareManifest> {
  const runtimeDir = join(dataRoot, RUNTIME_DIRECTORY);
  const runtime = await readPrepareManifest(runtimeDir);
  if (runtime === null) {
    throw new AutopsyError(
      `${join(runtimeDir, "manifest.json")} is missing or not a prepare manifest, so the container ` +
        `and port to reach are unknown. Run \`just prepare-bird-eval\` first.`,
    );
  }
  const runDir = join(dataRoot, "runs", run);
  const recorded = await readPrepareManifest(runDir);
  if (recorded === null) {
    throw new AutopsyError(
      `run ${run}: ${join(runDir, "manifest.json")} is missing or not a prepare manifest, so the ` +
        `dataset and database this autopsy would replay against cannot be shown to be the ones the ` +
        `run used. Refusing to write verdicts into a run whose tree cannot be identified.`,
    );
  }
  const differences = compareRunManifest(recorded, runtime);
  if (differences.length > 0) {
    throw new AutopsyError(
      describeManifestMismatch(
        run,
        differences,
        `The autopsy would replay that other tree's gold SQL against that other tree's database and ` +
          `write the verdicts into data/runs/${run}/tolerant.json, where the report reads them ` +
          `beside this run's own manifest.`,
      ),
    );
  }
  return runtime;
}

/**
 * The refusal for an autopsy that measured nothing at all, or `null` when it measured something.
 *
 * `tolerant.json` used to be written unconditionally, so an autopsy in which every task was
 * unmeasured — all `Management`, every statement in error, or a container that died after the probe
 * — wrote `{}`. The report then scores the tolerant column from that empty map, and because a
 * strict pass counts as a tolerant pass the column renders BYTE-IDENTICAL to strict: a reader sees
 * "tolerant found nothing extra" where the truth is "nothing was measured". The page still gets
 * written, because its per-task reasons are the useful part of a run like this; the verdict file
 * does not, because there is no verdict.
 */
export function unmeasuredRefusal(run: string, result: AutopsyResult): string | null {
  if (Object.keys(result.tolerant).length > 0) return null;
  return (
    `${run}: the autopsy measured no task — ${result.tasks.length} task` +
    `${result.tasks.length === 1 ? "" : "s"} were replayed and every one is "could not measure". ` +
    `Refusing to write tolerant.json: an empty verdict map is scored as a full tolerant column, ` +
    `which renders identical to strict from nothing measured. autopsy.html names the reason for ` +
    `each task; any tolerant.json already in the run directory was left untouched, because this ` +
    `autopsy has nothing to replace it with.`
  );
}

/**
 * The path `--out` may actually write to, resolved and checked.
 *
 * `autopsy.html` carries gated benchmark material — see `gatedNotice` — so an explicit output path
 * is a gated-material question, not a convenience. `just autopsy-bird-eval` runs from
 * `eval/bird-interact`, so a bare `--out autopsy.html` used to land it in a tracked directory.
 */
export async function resolveGatedOutput(dataRoot: string, out: string | null): Promise<string | null> {
  if (out === null) return null;
  const checked = await checkGatedOutputPath({
    dataRoot,
    path: out,
    flag: "--out",
    artifact: "autopsy.html",
  });
  if (checked.refusal !== null) throw new AutopsyError(checked.refusal);
  return checked.resolved;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

const HELP = `Usage: warble-bird-autopsy <run> [options]

Replays one finished run's phase-1 SQL and gold SQL against the prepared PostgreSQL, and writes
data/runs/<run>/tolerant.json plus data/runs/<run>/autopsy.html.

Every statement runs inside BEGIN; SET TRANSACTION READ ONLY; ... ROLLBACK;, so nothing is left
behind. Management tasks are skipped with a stated reason: their submissions are mutations. The
container and port come from data/runtime/manifest.json; an unreachable database is a refusal,
not a report with a section quietly missing.

The run's own manifest.json must match data/runtime/manifest.json. A run prepared against another
tree is refused rather than replayed against this one's gold and database.

autopsy.html carries gated ground-truth SQL, so its path must stay inside this package's
gitignored data/ tree; a path outside it is refused, not written.

tolerant.json is what \`warble-bird-report\` reads to fill its tolerant column, so run this first
and the report second. An autopsy in which no task could be measured writes no tolerant.json: an
empty one is scored as a tolerant column identical to strict.

Options:
  --out <file>                   Write the HTML here — contains gated ground-truth SQL, so it must
                                 be inside data/ (default: data/runs/<run>/autopsy.html)
  -h, --help                     Show help
  -V, --version                  Show version`;

/** The installed package root; `data/` and `dist/` both live directly beneath it. */
export function packageDirectory(): string {
  return resolve(import.meta.dirname, "..");
}

function display(base: string, path: string): string {
  const shown = relative(base, path);
  return shown === "" || shown.startsWith("..") ? path : shown;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseAutopsyArgs(argv);
  if (parsed.kind === "help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (parsed.kind === "version") {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }

  const packageDir = packageDirectory();
  const dataRoot = join(packageDir, "data");
  const config = parsed.config;

  // Two refusals before any work: a run prepared against another tree, and an output path that
  // would put gated ground truth outside data/.
  const manifest = await loadRuntimeManifestForRun(dataRoot, config.run);
  const outPath = await resolveGatedOutput(dataRoot, config.out);

  // The template holds the physical schema: the official DB environment clones each task database
  // from `<base>_template`, so the template is the one database guaranteed to carry the tables.
  const database = manifest.database.template;
  const port = manifest.database.hostPort;
  const container = manifest.database.container;
  const query = createPsqlQuery(port, database);

  const { tasks, skipped } = await loadAutopsyTasks(dataRoot, config.run);

  const result = await runAutopsy({
    run: config.run,
    container,
    port,
    tasks,
    // The probe is one trivial statement: it answers "can this command do its job at all?", and
    // its failure text is surfaced here so the refusal below is not the reader's only clue.
    probe: async () => {
      try {
        await query("SELECT 1;");
        return true;
      } catch (error) {
        process.stderr.write(`psql could not reach the database: ${messageOf(error)}\n`);
        return false;
      }
    },
    query,
  });

  const runDir = join(dataRoot, "runs", config.run);
  const htmlPath = outPath ?? join(runDir, "autopsy.html");
  await writeFile(
    htmlPath,
    renderAutopsyHtml({
      run: config.run,
      container,
      port,
      database,
      generatedAt: new Date().toISOString(),
      result,
      skipped,
    }),
    "utf8",
  );

  for (const entry of skipped) {
    process.stderr.write(`${config.run}: ${entry.taskId} not attempted — ${entry.reason}\n`);
  }

  // The page is written either way — its per-task reasons ARE the finding when nothing measured —
  // but a verdict file with no verdicts in it is not written at all.
  const refusal = unmeasuredRefusal(config.run, result);
  if (refusal !== null) {
    process.stderr.write(`${config.run}: wrote ${display(packageDir, htmlPath)}\n`);
    throw new AutopsyError(refusal);
  }
  const tolerantPath = join(runDir, "tolerant.json");
  await writeFile(tolerantPath, `${JSON.stringify(result.tolerant, null, 2)}\n`, "utf8");

  const measured = result.tasks.filter((task) => task.unmeasured === null);
  const passes = measured.filter((task) => result.tolerant[task.taskId] === true).length;
  process.stderr.write(
    `${config.run}: tolerant phase 1 ${passes}/${measured.length} measured, ` +
      `${result.tasks.length - measured.length} unmeasured, ${skipped.length} not attempted -> ` +
      `${display(packageDir, tolerantPath)}, ${display(packageDir, htmlPath)}\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
