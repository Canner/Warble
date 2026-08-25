#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { CliUsageError } from "./cli-usage.js";
import {
  buildRunReport,
  type DatasetRow,
  type OfficialResultFile,
  type RunInputs,
  type TolerantVerdicts,
  type WarbleTrace,
} from "./report-build.js";
import { renderReportHtml } from "./report-html.js";
import { parseRunReport, type RunReportIR } from "./report-model.js";
import {
  COMBINED_FILENAME,
  RUNTIME_DIRECTORY,
  type PrepareManifest,
  checkGatedOutputPath,
  compareRunManifest,
  describeManifestMismatch,
  readPrepareManifest,
  readUserSimulatorRecord,
} from "./runtime-layout.js";

/**
 * The offline report bin: read one finished run off disk, build its IR, write `report.json` and
 * `report.html`.
 *
 * **This is the only module in the report path allowed to touch the filesystem.** `report-build`,
 * `report-diagnose`, `report-simulator`, `report-html` and `report-model` are pure by construction,
 * which is what lets a test assert against the same document a reader sees; every read, every
 * write, and the one clock reading all live here. `generatedAt` is stamped once in `main` and
 * passed down, so a single invocation over several runs dates them together and the renderer never
 * reads a clock of its own.
 *
 * It reads `readPrepareManifest` from `runtime-layout.js` rather than through `prepare-cli.js`,
 * which re-exports it. That module's own doc says why: `prepare-cli` is a bin, and with
 * `splitting: false` importing a bin inlines its module — direct-execution guard and all — into
 * this entry file. The inlined guard would then compare THIS file's `import.meta.url` against
 * `process.argv[1]`, match, and run `prepare-cli`'s `main()` every time someone asks for a report.
 * `runtime-layout` holds the same symbols and no entry point.
 */

const PACKAGE_VERSION = "0.1.0";

export { CliUsageError };

export const USAGE =
  "usage: warble-bird-report <run> [<run> ...] [--out <file>] [--json <file>]";

/** A run's recorded inputs could not be read; the message never quotes file contents. */
export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

/* -------------------------------------------------------------------------- */
/* CLI contract                                                               */
/* -------------------------------------------------------------------------- */

export interface ReportArgs {
  /** Run directory names under `data/runs/`, in the order named. */
  readonly runs: readonly string[];
  /** One HTML file for every named run, or `null` for `<run>/report.html` per run. */
  readonly out: string | null;
  /** One JSON file, or `null` for `<run>/report.json` per run. */
  readonly json: string | null;
}

export type ReportParseResult =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; config: ReportArgs };

export function parseReportArgs(argv: readonly string[]): ReportParseResult {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      strict: true,
      // Unlike the other bins, this one names its subjects positionally: a report is about runs.
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
        out: { type: "string" },
        json: { type: "string" },
      },
    }));
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }

  if (values.help === true) return { kind: "help" };
  if (values.version === true) return { kind: "version" };

  // No run named is a usage error, never an empty report: a page with no run on it still looks
  // like an answer.
  if (positionals.length === 0) throw new CliUsageError(USAGE);

  const optional = (name: "out" | "json"): string | null => {
    const value = values[name];
    if (value === undefined) return null;
    if (typeof value !== "string" || value.length === 0) {
      throw new CliUsageError(`--${name} requires a value`);
    }
    return value;
  };

  return {
    kind: "run",
    config: { runs: [...positionals], out: optional("out"), json: optional("json") },
  };
}

/* -------------------------------------------------------------------------- */
/* Reading a finished run                                                     */
/* -------------------------------------------------------------------------- */

const A_INTERACT_FILE = "a-interact.json";
const PYTHON_ENVIRONMENT_FILE = "python-environment.json";
const SIMULATOR_LOG = join("logs", "user-simulator.log");
const TOLERANT_FILE = "tolerant.json";
const TRACES_DIRECTORY = "traces";
const TRACE_FILE = "trace.json";
const TRACE_METADATA_FILE = "metadata.json";

/** Stands in for provenance a run did not record; never invented, never silently blank. */
const UNKNOWN = "unknown";

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Read a JSON file, or `null` when it is absent or unparseable.
 *
 * The error path deliberately carries the PATH and never the TEXT: a run's files quote dialogue,
 * SQL and whatever the models emitted, and a parser error that echoed its input would paste that
 * into a log. This bin no longer reads `data/private/.env` at all — see
 * `readRunUserSimulatorModel` — but the rule that made that safe stands for everything else.
 */
async function readOptionalJson(path: string): Promise<unknown> {
  const text = await readTextFile(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    process.stderr.write(`skipped ${path}: not valid JSON\n`);
    return null;
  }
}

async function readRequiredJson(path: string, label: string): Promise<unknown> {
  const text = await readTextFile(path);
  if (text === null) throw new ReportError(`${label} is missing or unreadable: ${path}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ReportError(`${label} is not valid JSON: ${path}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function officialResults(value: unknown, path: string): OfficialResultFile {
  if (!isRecord(value) || !Array.isArray(value.results) || !isRecord(value.metrics)) {
    throw new ReportError(`${path} is not an a-interact result file (needs metrics and results)`);
  }
  return value as unknown as OfficialResultFile;
}

/**
 * Every `traces/<task>/trace.json`, keyed by the directory that holds it.
 *
 * A missing traces directory yields none rather than throwing: `buildRunReport` already names an
 * absent trace as a defect against the official row, which says more than a crash would.
 */
async function readTraces(runDir: string): Promise<Record<string, WarbleTrace>> {
  const tracesDir = join(runDir, TRACES_DIRECTORY);
  const entries = await readdir(tracesDir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return {};
  const traces: Record<string, WarbleTrace> = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(tracesDir, entry.name, TRACE_FILE);
    const value = await readOptionalJson(path);
    if (!isRecord(value)) {
      if (value !== null) process.stderr.write(`skipped ${path}: not a trace object\n`);
      continue;
    }
    traces[entry.name] = value as unknown as WarbleTrace;
  }
  return traces;
}

/**
 * The system-agent model, read from the traces' own `metadata.json`.
 *
 * There is no other recorded source: the flag that chose the model lives in `smoke-cli`, and
 * importing that bin here would inline its `main()` guard into this entry file. Every distinct
 * value is reported rather than one being picked — a run whose tasks used different models is a
 * fact a reader has to see, not a discrepancy for this reader to resolve.
 */
async function readSystemModel(runDir: string): Promise<string> {
  const tracesDir = join(runDir, TRACES_DIRECTORY);
  const entries = await readdir(tracesDir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return UNKNOWN;
  const models = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const value = await readOptionalJson(join(tracesDir, entry.name, TRACE_METADATA_FILE));
    if (!isRecord(value)) continue;
    const model = value.model;
    if (typeof model === "string" && model.length > 0) models.add(model);
  }
  return models.size === 0 ? UNKNOWN : [...models].sort().join(", ");
}

/** The interpreter the official processes actually ran on, as `smoke-cli` recorded it. */
async function readPythonVersion(runDir: string): Promise<string> {
  const value = await readOptionalJson(join(runDir, PYTHON_ENVIRONMENT_FILE));
  if (!isRecord(value)) return UNKNOWN;
  for (const key of ["venvVersion", "requestedVersion"] as const) {
    const version = value[key];
    if (typeof version === "string" && version.length > 0) return version;
  }
  return UNKNOWN;
}

/** Names a value's type for an error message without ever quoting the value itself. */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  // `object` and `undefined` are the vowel-initial names `typeof` can return; the rest take "a".
  return `${/^[aeiou]/.test(type) ? "an" : "a"} ${type}`;
}

/**
 * The autopsy's tolerant phase-1 verdicts.
 *
 * Absent and malformed are different states and must read differently, because `buildRunReport`
 * scores the tolerant column whenever this is not `null`:
 *
 * - **Absent** → `null`. A normal state: no autopsy has run, and the report says the column was not
 *   computed rather than claiming a tolerant score.
 * - **Present but malformed** — not JSON, not a JSON object, or holding any value that is not a
 *   boolean → **throw**. Whatever wrote the file produced something wrong, and a loud failure is
 *   the only honest response. Nothing here coerces, filters, or falls back to `null`: filtering
 *   would turn `{"alien_1":{"passed":true}}` into a confident `tolerant 0/N` block describing
 *   nothing, and falling back to `null` would quietly downgrade a BROKEN autopsy to "not
 *   computed", which reads as if no autopsy had been run. Inventing a score is precisely the
 *   failure this feature exists to prevent.
 * - **Present, valid and empty (`{}`)** → **throw**. An autopsy that ran and judged nothing IS a
 *   real state, distinct from one that never ran — but the IR has no way to say so. `tolerant` is
 *   a `TolerantScoreIR | null`: a score, or "not computed", and nothing else. Handed `{}` the
 *   builder scores the column anyway, and since a strict pass counts as a tolerant pass the result
 *   is a tolerant score BYTE-IDENTICAL to strict, computed from nothing measured — a reader sees
 *   "tolerant found nothing extra" where the truth is "nothing was measured". That is the same
 *   invented verdict the malformed cases above refuse, so it is refused the same way. `autopsy-cli`
 *   no longer writes such a file; this refusal covers the ones older builds already wrote.
 */
export async function readTolerant(runDir: string): Promise<TolerantVerdicts | null> {
  const path = join(runDir, TOLERANT_FILE);
  const text = await readTextFile(path);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ReportError(`${path} is not valid JSON`);
  }
  if (!isRecord(value)) {
    throw new ReportError(
      `${path} is ${describeType(value)}, not a JSON object of task id to boolean verdict`,
    );
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new ReportError(
      `${path} records no tolerant verdicts: the autopsy ran and measured nothing. There is no way ` +
        `to report that — an empty verdict map scores every strict pass as a tolerant pass, so the ` +
        `tolerant column would render identical to strict from nothing measured. Re-run ` +
        `\`just autopsy-bird-eval\` once the tasks can be replayed, or remove the file to render ` +
        `the run with its tolerant column stated as not computed.`,
    );
  }
  const verdicts: Record<string, boolean> = {};
  for (const [taskId, passed] of entries) {
    if (typeof passed !== "boolean") {
      throw new ReportError(
        `${path}: verdict for ${taskId} is ${describeType(passed)}, not a boolean`,
      );
    }
    verdicts[taskId] = passed;
  }
  return verdicts;
}

/**
 * The dataset rows, keyed by `instance_id`.
 *
 * A run interrupted mid-write leaves a truncated final line; that line is named on stderr and
 * skipped rather than failing the whole report, and a parsed record this reader does not recognise
 * — no `instance_id` to key it by — is named and skipped for the same reason. Silence about either
 * would leave the report quietly missing dataset facts for some tasks.
 */
async function readDataset(dataRoot: string): Promise<Record<string, DatasetRow>> {
  const path = join(dataRoot, RUNTIME_DIRECTORY, COMBINED_FILENAME);
  const text = await readTextFile(path);
  if (text === null) {
    process.stderr.write(`no dataset at ${path}; per-task dataset facts will be missing\n`);
    return {};
  }
  const rows: Record<string, DatasetRow> = {};
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
    rows[value.instance_id] = value as unknown as DatasetRow;
  }
  return rows;
}

/**
 * The user-simulator model **the run itself recorded**, or `null` when it recorded none.
 *
 * This used to read `USER_SIM_MODEL` out of the current `data/private/.env`, which is not a fact
 * about the run: that file is edited between runs, so a report regenerated afterwards printed
 * today's model as the provenance of a run that used a different one — a false statement in the
 * one section a reader is least likely to question. There is deliberately no fallback to that
 * file. `smoke-cli` writes the model into the run directory as it resolves it, and a run with no
 * such record is `null` here and *unrecorded* on the page: an oracle-only run, which never called
 * a simulator, or any run finished before Warble began recording one. A stated gap is worth more
 * than a guess wearing the word provenance.
 */
async function readRunUserSimulatorModel(runDir: string): Promise<string | null> {
  return (await readUserSimulatorRecord(runDir))?.model ?? null;
}

/**
 * Refuse a report whose run did not run against the tree this command is reading.
 *
 * A report's provenance block comes from the RUN's `manifest.json`, while gold SQL, ambiguity
 * snippets and difficulty labels come from the CURRENT `data/runtime/` dataset. Those are two
 * different objects the moment preparation is re-run for another subset, and nothing here could
 * notice: the page would print the run's commits above gold the run never faced. `data/runs/alien-3`
 * against a five-task runtime is exactly that state today.
 *
 * The runtime manifest missing is the same refusal rather than a lesser one: with nothing to check
 * against, the dataset under `data/runtime/` cannot be shown to be the one the run used, and this
 * command reads it either way.
 *
 * See `compareRunManifest` for which fields are compared and why the timestamp is not one of them.
 */
function assertRunMatchesRuntime(
  manifest: PrepareManifest,
  runtime: PrepareManifest | null,
  run: string,
  dataRoot: string,
): void {
  const runtimePath = join(dataRoot, RUNTIME_DIRECTORY, "manifest.json");
  if (runtime === null) {
    throw new ReportError(
      `run ${run}: ${runtimePath} is missing or not a prepare manifest, so the dataset this report ` +
        `would read its gold SQL, ambiguity snippets and difficulty labels from cannot be shown to ` +
        `be the one the run faced. Run \`just prepare-bird-eval\` first.`,
    );
  }
  const differences = compareRunManifest(manifest, runtime);
  if (differences.length === 0) return;
  throw new ReportError(
    describeManifestMismatch(
      run,
      differences,
      `The report would print this run's own manifest as the provenance of gold SQL, ambiguity ` +
        `snippets and difficulty labels it read out of that other tree.`,
    ),
  );
}

/** Everything `buildRunReport` needs about one finished run, read off disk. */
export async function loadRunInputs(
  dataRoot: string,
  run: string,
  generatedAt: string,
): Promise<RunInputs> {
  const runDir = join(dataRoot, "runs", run);
  const officialPath = join(runDir, A_INTERACT_FILE);
  const official = officialResults(
    await readRequiredJson(officialPath, `run ${run}: ${A_INTERACT_FILE}`),
    officialPath,
  );
  const manifest = await readPrepareManifest(runDir);
  if (manifest === null) {
    throw new ReportError(
      `run ${run}: manifest.json is missing or not a prepare manifest: ${join(runDir, "manifest.json")}`,
    );
  }
  assertRunMatchesRuntime(manifest, await readPrepareManifest(join(dataRoot, RUNTIME_DIRECTORY)), run, dataRoot);

  return {
    run,
    generatedAt,
    manifest,
    pythonVersion: await readPythonVersion(runDir),
    systemModel: await readSystemModel(runDir),
    userSimulatorModel: await readRunUserSimulatorModel(runDir),
    official,
    traces: await readTraces(runDir),
    dataset: await readDataset(dataRoot),
    simulatorLog: (await readTextFile(join(runDir, SIMULATOR_LOG))) ?? "",
    tolerant: await readTolerant(runDir),
  };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

const HELP = `Usage: warble-bird-report <run> [<run> ...] [options]

Renders finished runs under data/runs/ as report.json and report.html. It reads only what a run
already recorded — nothing is re-executed, no service is contacted, and no score is recomputed
from the database.

Naming more than one run and passing --out renders a single comparison page.

Both artifacts EMBED the benchmark's ground-truth SQL, which is gated material. Every output path
must therefore stay inside this package's gitignored data/ tree; a path outside it is refused,
not written.

A run whose manifest.json disagrees with data/runtime/manifest.json is refused too: the gold and
difficulty labels come from the runtime tree, so a report over a re-prepared tree would describe a
dataset the run never faced.

Options:
  --out <file>                   Write one HTML file for every named run — contains gated
                                 ground-truth SQL, so it must be inside data/
                                 (default: data/runs/<run>/report.html per run)
  --json <file>                  Write one JSON file: the report for a single run, or an array
                                 of them — contains gated ground-truth SQL, so it must be inside
                                 data/ (default: data/runs/<run>/report.json per run)
  -h, --help                     Show help
  -V, --version                  Show version`;

/**
 * The paths `--out` and `--json` may actually write to, resolved and checked.
 *
 * `report.json` and `report.html` both carry the dataset's `sol_sql`, so an explicit output path is
 * a gated-material question and not a convenience. The recipes make that concrete: `just
 * report-bird-eval` runs from `eval/bird-interact`, so `--out report.html` used to land gold SQL in
 * a tracked directory. The check runs before a single run is read, so a refusal costs nothing and
 * arrives before any work.
 */
export async function resolveGatedOutputs(
  dataRoot: string,
  config: ReportArgs,
): Promise<{ readonly out: string | null; readonly json: string | null }> {
  const resolveOne = async (flag: "--out" | "--json", artifact: string, path: string | null) => {
    if (path === null) return null;
    const checked = await checkGatedOutputPath({ dataRoot, path, flag, artifact });
    if (checked.refusal !== null) throw new ReportError(checked.refusal);
    return checked.resolved;
  };
  return {
    out: await resolveOne("--out", "report.html", config.out),
    json: await resolveOne("--json", "report.json", config.json),
  };
}

/** The installed package root; `data/` and `dist/` both live directly beneath it. */
export function packageDirectory(): string {
  return resolve(import.meta.dirname, "..");
}

function display(base: string, path: string): string {
  const shown = relative(base, path);
  return shown === "" || shown.startsWith("..") ? path : shown;
}

/** One line per run, on stderr so a piped `--json -`-style stdout stays a document. */
function summaryLine(report: RunReportIR, written: readonly string[]): string {
  const strict = report.strict;
  const outcome =
    strict === null
      ? `scores withheld (user simulator ${report.simulator.verdict})`
      : `${strict.totalTasks} tasks, phase 1 ${strict.phase1Count}/${strict.totalTasks}, ` +
        `phase 2 ${strict.phase2Count}/${strict.totalTasks}, reward ${strict.totalReward}`;
  return `${report.provenance.run}: ${outcome} -> ${written.join(", ")}`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseReportArgs(argv);
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
  // The one clock reading in the report path: stamped once so several runs rendered together are
  // dated together, and passed down so nothing below here can read a clock of its own.
  const generatedAt = new Date().toISOString();

  const config = parsed.config;
  // Before anything is read: a gold-bearing artifact aimed outside data/ is a refusal, not a write.
  const outputs = await resolveGatedOutputs(dataRoot, config);
  const reports: RunReportIR[] = [];
  const written: string[][] = [];
  for (const run of config.runs) {
    const inputs = await loadRunInputs(dataRoot, run, generatedAt);
    // Validate before writing: a schema violation must fail here, loudly, rather than land on
    // disk as an artifact someone later quotes.
    reports.push(parseRunReport(buildRunReport(inputs)));
    written.push([]);
  }

  for (const [index, report] of reports.entries()) {
    const runDir = join(dataRoot, "runs", report.provenance.run);
    const paths = written[index];
    if (paths === undefined) continue;
    if (outputs.json === null) {
      const path = join(runDir, "report.json");
      await writeJson(path, report);
      paths.push(display(packageDir, path));
    }
    if (outputs.out === null) {
      const path = join(runDir, "report.html");
      await writeFile(path, renderReportHtml([report]), "utf8");
      paths.push(display(packageDir, path));
    }
  }

  // An explicit path names ONE file, so it covers every run at once: --out becomes the comparison
  // page the renderer already knows how to draw, and --json holds a single report or an array of
  // them. A single-run --json stays the same document the default writes.
  if (outputs.json !== null) {
    const single = reports[0];
    await writeJson(outputs.json, reports.length === 1 && single !== undefined ? single : reports);
  }
  if (outputs.out !== null) {
    await writeFile(outputs.out, renderReportHtml(reports), "utf8");
  }
  const shared = [
    ...(outputs.json === null ? [] : [display(packageDir, outputs.json)]),
    ...(outputs.out === null ? [] : [display(packageDir, outputs.out)]),
  ];

  for (const [index, report] of reports.entries()) {
    process.stderr.write(`${summaryLine(report, [...(written[index] ?? []), ...shared])}\n`);
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
