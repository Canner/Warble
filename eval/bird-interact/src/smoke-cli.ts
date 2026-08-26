#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { parse as parseDotenv } from "dotenv";
import { z } from "zod";

import { isDirectExecution } from "./bin-entry.js";
import { CliUsageError } from "./cli-usage.js";
import {
  GT_FILENAME,
  PROFILE_DIRECTORY,
  assertProfileLabel,
  PUBLIC_CACHE_DIRECTORY,
  RUNTIME_DIRECTORY,
  DEFAULT_SMOKE_DATABASE,
  SMOKE_TASK_COUNT,
  USER_SIMULATOR_FILENAME,
  readPrepareManifest,
  realPathOfNearestExisting,
  runDirectory,
  smokeFilename,
  smokeTaskIds,
  type PrepareManifest,
  type UserSimulatorRecord,
} from "./runtime-layout.js";
import { BIRD_SERVICE_PORTS } from "./protocol.js";
import { verifyPublicSnapshotOffline, type PublicSnapshotVerification } from "./source-cache.js";
import { ProcessWrenPlanner } from "./wren-planner.js";

const PACKAGE_VERSION = "0.1.0";

export { CliUsageError };

/** Where the default database's run lands; every other database gets its own sibling directory. */
export const DEFAULT_RUN_DIRECTORY = runDirectory(DEFAULT_SMOKE_DATABASE);
export const ADK_RELATIVE_PATH = "BIRD-Interact-ADK";
export const DEFAULT_SYSTEM_MODEL = "claude-sonnet-4-5-20250929";
/**
 * One task at a time, unless asked otherwise.
 *
 * The official runner is safe to fan out — every task gets its own cloned database, simulator state
 * and Warble session — but concurrency multiplies what a single run costs: N database copies alive
 * at once, N Warble agents and N simulator calls against one account's rate limit. A default of 1
 * keeps the documented run reproducible and cheap; the flag is for a host that has been sized.
 */
export const DEFAULT_CONCURRENCY = 1;
export const DEFAULT_PYTHON_BIN = "python3.11";
export const PATIENCE = 3;
export const MINIMUM_PYTHON = { major: 3, minor: 10 } as const;
export const MAXIMUM_PYTHON = { major: 3, minor: 12 } as const;

const BASE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "NO_PROXY", "no_proxy"] as const;
/**
 * Warble's own children need `USER` on top of the official allowlist: the Claude Agent SDK resolves
 * a claude.ai login through the macOS Keychain, and that lookup reports "not logged in" without it.
 * Official BIRD processes deliberately never receive it — their allowlist is unchanged.
 */
const WARBLE_ENV_KEYS = [...BASE_ENV_KEYS, "USER"] as const;
const SYSTEM_AGENT_AUTH_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
const SERVICE_READY_TIMEOUT_MS = 120_000;
const SERVICE_POLL_INTERVAL_MS = 500;
const STOP_GRACE_MS = 10_000;

export class SmokeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeError";
  }
}

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* CLI contract                                                               */
/* -------------------------------------------------------------------------- */

export interface SmokeConfig {
  readonly oracleOnly: boolean;
  readonly wrenBin: string;
  readonly pythonBin: string;
  readonly systemModel: string;
  /** Tasks the official runner keeps in flight at once; see `--concurrency`. */
  readonly concurrency: number;
  /** `--profile` as typed; `resolveProfile` turns it into a directory and a run-scoping label. */
  readonly profile: string;
}

export type SmokeParseResult =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; config: SmokeConfig };

export function parseSmokeArgs(argv: readonly string[]): SmokeParseResult {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
        "oracle-only": { type: "boolean", default: false },
        "wren-bin": { type: "string", default: "wren" },
        "python-bin": { type: "string", default: DEFAULT_PYTHON_BIN },
        "system-model": { type: "string", default: DEFAULT_SYSTEM_MODEL },
        concurrency: { type: "string", default: String(DEFAULT_CONCURRENCY) },
        profile: { type: "string", default: PROFILE_DIRECTORY },
      },
    }));
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }

  if (values.help === true) return { kind: "help" };
  if (values.version === true) return { kind: "version" };

  const requireText = (name: string): string => {
    const value = values[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new CliUsageError(`--${name} requires a value`);
    }
    return value;
  };

  return {
    kind: "run",
    config: {
      oracleOnly: values["oracle-only"] === true,
      wrenBin: requireText("wren-bin"),
      pythonBin: requireText("python-bin"),
      systemModel: requireText("system-model"),
      concurrency: parseConcurrency(requireText("concurrency")),
      profile: requireText("profile"),
    },
  };
}

/**
 * `--concurrency`, held to a whole task count this run can actually place.
 *
 * The ceiling is the smoke's own row count rather than a machine size: the official runner takes
 * its tasks from a semaphore, so anything above the number of rows admits the same five tasks and
 * only makes the flag lie about what ran. The floor is 1 because 0 would start the services, admit
 * nothing, and write a result file with no rows — a silent empty measurement rather than a refusal.
 *
 * The digits are matched before `Number` is let near them, because `Number` accepts a good deal
 * more than this flag documents: `Number("0x3")` is 3 and `Number(" 3 ")` is 3, so either would
 * quietly run three tasks in flight under a flag whose own refusal message says an integer. What
 * this number multiplies is the cost of a run — N database clones, N agents, N simulator calls
 * against one account — so it is read exactly as written or refused.
 */
function parseConcurrency(value: string): number {
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > SMOKE_TASK_COUNT) {
    throw new CliUsageError(
      `--concurrency must be an integer between 1 and ${SMOKE_TASK_COUNT}`,
    );
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Environment selection                                                      */
/* -------------------------------------------------------------------------- */

export type EnvRecord = Readonly<Record<string, string>>;

function definedEntries(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

/** Keeps only the non-model process variables every child is allowed to inherit. */
export function selectBaseEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return pick(env, BASE_ENV_KEYS);
}

/** The environment for Warble-owned children only; never reaches an official BIRD process. */
export function selectWarbleEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return pick(env, WARBLE_ENV_KEYS);
}

function pick(
  env: Readonly<Record<string, string | undefined>>,
  keys: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

/** Parses a private `.env` file with no shell evaluation and no variable expansion. */
export function parsePrivateEnv(text: string): Record<string, string> {
  return { ...parseDotenv(text) };
}

/** Merges `data/private/.env` under the explicit process environment, which always wins. */
export async function loadPrivateEnv(
  dataRoot: string,
  processEnv: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, string>> {
  let fileVariables: Record<string, string> = {};
  try {
    fileVariables = parsePrivateEnv(await readFile(join(dataRoot, "private", ".env"), "utf8"));
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code !== "ENOENT") {
      throw new SmokeError("data/private/.env could not be read");
    }
  }
  return { ...fileVariables, ...definedEntries(processEnv) };
}

export type UserSimulatorProvider = "anthropic" | "openai" | "google" | "litellm" | "ollama";

export interface UserSimulatorAuth {
  readonly provider: UserSimulatorProvider;
  /**
   * The resolved `USER_SIM_MODEL`, lifted out of `variables` so the run can record it by name.
   *
   * `variables` is credential-bearing and is only ever handed to a child process; this field is
   * the one part of it a run directory may hold. See `writeUserSimulatorRecord`.
   */
  readonly model: string;
  readonly variables: EnvRecord;
}

function collect(env: EnvRecord, keys: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) result[key] = value;
  }
  return result;
}

function requireAny(env: EnvRecord, provider: UserSimulatorProvider, keys: readonly string[]): void {
  if (keys.some((key) => typeof env[key] === "string" && env[key] !== "")) return;
  throw new SmokeError(
    `The selected user-simulator provider '${provider}' requires ${keys.join(" or ")} in data/private/.env or the process environment`,
  );
}

function providerFor(model: string): Exclude<UserSimulatorProvider, "litellm"> | null {
  const lowered = model.toLowerCase();
  const prefix = lowered.includes("/") ? lowered.slice(0, lowered.indexOf("/")) : "";
  if (prefix === "ollama" || prefix === "ollama_chat") return "ollama";
  if (prefix === "anthropic" || lowered.startsWith("claude")) return "anthropic";
  if (prefix === "openai" || prefix === "azure" || /^(gpt|o[134])/.test(lowered)) return "openai";
  if (prefix === "gemini" || prefix === "vertex_ai" || lowered.startsWith("gemini")) return "google";
  return null;
}

/**
 * Resolves the exact model variables the official user simulator may receive. Missing credentials
 * fail here, before any service is spawned, and no present value ever appears in the message.
 */
export function selectUserSimulatorAuth(env: Readonly<Record<string, string | undefined>>): UserSimulatorAuth {
  const defined = definedEntries(env);
  const model = defined.USER_SIM_MODEL;
  if (typeof model !== "string" || model.length === 0) {
    throw new SmokeError("USER_SIM_MODEL is required in data/private/.env or the process environment");
  }

  if (typeof defined.LITELLM_BASE_URL === "string" || typeof defined.LITELLM_API_BASE === "string") {
    requireAny(defined, "litellm", ["LITELLM_API_KEY"]);
    return {
      provider: "litellm",
      model,
      variables: collect(defined, ["USER_SIM_MODEL", "LITELLM_BASE_URL", "LITELLM_API_BASE", "LITELLM_API_KEY"]),
    };
  }

  const provider = providerFor(model);
  if (provider === null) {
    throw new SmokeError(
      "USER_SIM_MODEL does not name a supported provider (anthropic, openai, google, litellm, ollama)",
    );
  }

  switch (provider) {
    case "anthropic":
      requireAny(defined, provider, ["ANTHROPIC_API_KEY"]);
      return { provider, model, variables: collect(defined, ["USER_SIM_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]) };
    case "openai":
      requireAny(defined, provider, ["OPENAI_API_KEY"]);
      return { provider, model, variables: collect(defined, ["USER_SIM_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) };
    case "google":
      requireAny(defined, provider, ["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
      return { provider, model, variables: collect(defined, ["USER_SIM_MODEL", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) };
    case "ollama":
      return { provider, model, variables: collect(defined, ["USER_SIM_MODEL", "OLLAMA_API_BASE", "OLLAMA_HOST"]) };
  }
}

/**
 * The oracle replays official ground truth and never calls the user simulator, so `--oracle-only`
 * stays credential-free: missing model configuration yields no variables instead of failing.
 */
export function optionalUserSimulatorAuth(
  env: Readonly<Record<string, string | undefined>>,
): UserSimulatorAuth | null {
  try {
    return selectUserSimulatorAuth(env);
  } catch (error) {
    if (error instanceof SmokeError) return null;
    throw error;
  }
}

/**
 * Returns the Claude Agent SDK authentication variables the Warble system agent may receive, or
 * null when the caller must fall back to a silent `claude auth status` probe.
 */
export function selectSystemAgentAuth(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> | null {
  const selected = collect(definedEntries(env), SYSTEM_AGENT_AUTH_KEYS);
  return Object.keys(selected).length === 0 ? null : selected;
}

export interface SafeOfficialEnvOptions {
  readonly adkDir: string;
  readonly postgresPort: number;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
}

/** The only environment any official Python process receives; it holds no model variable at all. */
export function buildSafeOfficialEnv(options: SafeOfficialEnvOptions): Record<string, string> {
  return {
    ...selectBaseEnv(options.baseEnv),
    PYTHONPATH: options.adkDir,
    PYTHON_DOTENV_DISABLED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    DATASET: "lite",
    PG_HOST: "127.0.0.1",
    PG_PORT: String(options.postgresPort),
    PG_USER: "root",
    PG_PASSWORD: "123123",
    SYSTEM_AGENT_PORT: String(BIRD_SERVICE_PORTS.system_agent),
    USER_SIM_PORT: String(BIRD_SERVICE_PORTS.user_simulator),
    DB_ENV_PORT: String(BIRD_SERVICE_PORTS.db_environment),
    PATIENCE: String(PATIENCE),
  };
}

/* -------------------------------------------------------------------------- */
/* Process plan                                                               */
/* -------------------------------------------------------------------------- */

export type ProcessId =
  | "compile"
  | "adapter-build"
  | "db-environment"
  | "user-simulator"
  | "oracle"
  | "system-agent"
  | "a-interact";

export interface ProcessRecord {
  readonly id: ProcessId;
  readonly exe: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: EnvRecord;
  readonly envKeys: readonly string[];
  readonly log: string;
  readonly output?: string;
}

export interface SmokePlanContext {
  readonly warbleRoot: string;
  readonly packageDir: string;
  /** The profile directory to compile: the baseline, or whatever `--profile` resolved to. */
  readonly profileDir: string;
  readonly dataRoot: string;
  readonly adkDir: string;
  readonly runDir: string;
  readonly runtimeDir: string;
  /** The promoted subset file inside `runtimeDir`, named for the prepared database. */
  readonly smokeFile: string;
  readonly pythonBin: string;
  readonly wrenBin: string;
  readonly systemModel: string;
  readonly postgresPort: number;
  readonly oracleOnly: boolean;
  readonly concurrency: number;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly userSimulatorEnv: EnvRecord;
  readonly systemAgentEnv: EnvRecord;
}

function record(
  id: ProcessId,
  exe: string,
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  log: string,
  output?: string,
): ProcessRecord {
  return {
    id,
    exe,
    argv,
    cwd,
    env,
    envKeys: Object.keys(env).sort(),
    log,
    ...(output === undefined ? {} : { output }),
  };
}

/** Builds every child process as an argument array; no step ever composes a shell string. */
export function buildProcessPlan(context: SmokePlanContext): ProcessRecord[] {
  const warble = selectWarbleEnv(context.baseEnv);
  const official = buildSafeOfficialEnv({
    adkDir: context.adkDir,
    postgresPort: context.postgresPort,
    baseEnv: context.baseEnv,
  });
  const venvPython = join(context.adkDir, ".venv", "bin", "python");
  const logs = join(context.runDir, "logs");
  const smokeData = join(context.runtimeDir, context.smokeFile);
  const irPath = join(context.runDir, "agent-ir.json");

  const runnerArgv = (mode: "oracle" | "a-interact", output: string): string[] => [
    "-m", "orchestrator.runner",
    "--mode", mode,
    "--data", smokeData,
    "--concurrency", String(context.concurrency),
    "--output", output,
  ];

  const oracleOutput = join(context.runDir, "oracle.json");
  const interactOutput = join(context.runDir, "a-interact.json");
  // The baseline ships inside this package and `--profile` names a sibling; either way cargo runs
  // from the Warble root, so the path is passed relative to it.
  const profile = relative(context.warbleRoot, context.profileDir);

  const plan: ProcessRecord[] = [
    record(
      "compile",
      "cargo",
      ["run", "--locked", "-p", "warble-cli", "--", "compile", profile, "-o", irPath],
      context.warbleRoot,
      warble,
      join(logs, "compile.log"),
      irPath,
    ),
    record("adapter-build", "npm", ["run", "build"], context.packageDir, warble, join(logs, "adapter-build.log")),
    record(
      "db-environment",
      venvPython,
      ["-m", "uvicorn", "db_environment.server:app", "--host", "127.0.0.1", "--port", String(BIRD_SERVICE_PORTS.db_environment), "--log-level", "warning"],
      context.adkDir,
      official,
      join(logs, "db-environment.log"),
    ),
    record(
      "user-simulator",
      venvPython,
      ["-m", "uvicorn", "user_simulator.server:app", "--host", "127.0.0.1", "--port", String(BIRD_SERVICE_PORTS.user_simulator), "--log-level", "warning"],
      context.adkDir,
      { ...official, ...context.userSimulatorEnv },
      join(logs, "user-simulator.log"),
    ),
    record("oracle", venvPython, runnerArgv("oracle", oracleOutput), context.adkDir, official, join(logs, "oracle.log"), oracleOutput),
  ];

  if (context.oracleOnly) return plan;

  plan.push(
    record(
      "system-agent",
      "node",
      [
        join(context.packageDir, "dist", "cli.js"),
        "--ir", irPath,
        "--wren-project-root", join(context.runtimeDir, "identity-projects"),
        "--model", context.systemModel,
        "--user-simulator-url", `http://127.0.0.1:${BIRD_SERVICE_PORTS.user_simulator}`,
        "--db-environment-url", `http://127.0.0.1:${BIRD_SERVICE_PORTS.db_environment}`,
        "--out", join(context.runDir, "traces"),
        "--port", String(BIRD_SERVICE_PORTS.system_agent),
        "--wren-bin", context.wrenBin,
      ],
      context.warbleRoot,
      { ...warble, ...context.systemAgentEnv },
      join(logs, "system-agent.log"),
    ),
    record(
      "a-interact",
      venvPython,
      runnerArgv("a-interact", interactOutput),
      context.adkDir,
      official,
      join(logs, "a-interact.log"),
      interactOutput,
    ),
  );
  return plan;
}

/* -------------------------------------------------------------------------- */
/* Python and result validation                                               */
/* -------------------------------------------------------------------------- */

export interface PythonVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export function parsePythonVersion(text: string): PythonVersion {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (match === null) throw new SmokeError("Could not read a Python version from the interpreter output");
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function requireSupportedPython(version: PythonVersion, label: string): PythonVersion {
  const supported =
    version.major === MINIMUM_PYTHON.major &&
    version.minor >= MINIMUM_PYTHON.minor &&
    version.minor <= MAXIMUM_PYTHON.minor;
  if (!supported) {
    throw new SmokeError(
      `${label} reports Python ${version.major}.${version.minor}.${version.patch}; the official ADK requires >= 3.10 and < 3.13`,
    );
  }
  return version;
}

const resultRowSchema = z.object({ task_id: z.string().min(1) }).passthrough();
const resultFileSchema = z
  .object({
    metrics: z.object({ total_tasks: z.number() }).passthrough(),
    results: z.array(resultRowSchema),
  })
  .passthrough();

export interface ResultSummary {
  readonly taskIds: readonly string[];
  readonly totalTasks: number;
}

function summarizeResult(
  value: unknown,
  label: "oracle" | "a-interact",
  expected: readonly string[],
): {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly summary: ResultSummary;
} {
  const parsed = resultFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new SmokeError(`The official ${label} result is not a supported BIRD-Interact result file`);
  }
  const rows = parsed.data.results as Array<Record<string, unknown>>;
  if (rows.length !== expected.length || parsed.data.metrics.total_tasks !== expected.length) {
    throw new SmokeError(
      `The official ${label} result must contain exactly ${expected.length} tasks`,
    );
  }
  const taskIds = rows.map((row) => String(row.task_id));
  if ([...taskIds].sort().join(",") !== [...expected].sort().join(",")) {
    throw new SmokeError(
      `The official ${label} result must cover exactly ${expected.join(", ")}, once each`,
    );
  }
  for (const row of rows) {
    if (row.error !== undefined && row.error !== null && row.error !== false && row.error !== "") {
      throw new SmokeError(`The official ${label} result reports an error for task ${String(row.task_id)}`);
    }
  }
  return { rows, summary: { taskIds, totalTasks: parsed.data.metrics.total_tasks } };
}

/** Requires one error-free oracle row per smoke task, both phases passing; anything else blocks the model run. */
export function summarizeOracleResult(value: unknown, expected: readonly string[]): ResultSummary {
  const { rows, summary } = summarizeResult(value, "oracle", expected);
  for (const row of rows) {
    if (row.phase1_passed !== true || row.phase2_passed !== true) {
      throw new SmokeError(`The official oracle did not pass both phases for task ${String(row.task_id)}`);
    }
  }
  return summary;
}

/** Requires one error-free a-interact row per smoke task; a zero reward is an acceptable smoke outcome. */
export function summarizeInteractResult(value: unknown, expected: readonly string[]): ResultSummary {
  return summarizeResult(value, "a-interact", expected).summary;
}

/* -------------------------------------------------------------------------- */
/* Port and readiness checks                                                  */
/* -------------------------------------------------------------------------- */

/** Proves each port is free by binding it; an occupied port fails and its owner is never killed. */
export async function verifyFreePorts(ports: readonly number[]): Promise<void> {
  for (const port of ports) {
    await new Promise<void>((accept, reject) => {
      const probe = createServer();
      probe.once("error", () => {
        probe.close();
        reject(new SmokeError(`Port ${port} is already in use; stop its owner yourself and retry`));
      });
      probe.listen(port, "127.0.0.1", () => probe.close(() => accept()));
    });
  }
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise<boolean>((accept) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const finish = (result: boolean): void => {
      socket.destroy();
      accept(result);
    };
    socket.setTimeout(SERVICE_POLL_INTERVAL_MS * 4);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Waits for a service to accept connections, naming its log file when the deadline passes. */
export async function waitForService(
  port: number,
  logPath: string,
  options: { readonly timeoutMs?: number; readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? SERVICE_READY_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((wake) => setTimeout(wake, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await canConnect(port)) return;
    if (Date.now() >= deadline) {
      throw new SmokeError(`Service on port ${port} was not ready within ${timeoutMs}ms; see ${logPath}`);
    }
    await sleep(SERVICE_POLL_INTERVAL_MS);
  }
}

/* -------------------------------------------------------------------------- */
/* Process supervision                                                        */
/* -------------------------------------------------------------------------- */

export interface ProcessHandle {
  readonly id: ProcessId;
  stop(): Promise<void>;
}

export interface ProcessSupervisor {
  /** Starts a long-lived child in its own process group and returns a stop handle. */
  start(record: ProcessRecord): Promise<ProcessHandle>;
  /** Runs a child to completion and resolves with its exit code. */
  run(record: ProcessRecord): Promise<number>;
}

/**
 * A log file is the record of one process of one run, so it is truncated rather than appended to.
 *
 * `report-simulator` counts every `LLM call failed` in `logs/user-simulator.log` and withholds a
 * run's scores entirely when that count is not zero. Appending made the count cumulative across
 * runs: one run against a simulator model that rejects the official hardcoded `temperature=0`
 * voided every run that followed it, until someone deleted the file by hand.
 */
async function openLog(path: string): Promise<import("node:fs").WriteStream> {
  await mkdir(dirname(path), { recursive: true });
  return createWriteStream(path, { flags: "w" });
}

/** Real supervisor: detached process groups so uvicorn's descendants are cleaned up too. */
export function createProcessSupervisor(): ProcessSupervisor {
  return {
    async start(item: ProcessRecord): Promise<ProcessHandle> {
      const log = await openLog(item.log);
      const child = spawn(item.exe, [...item.argv], {
        cwd: item.cwd,
        env: { ...item.env },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.pipe(log);
      child.stderr?.pipe(log);
      let exited = false;
      child.once("exit", () => {
        exited = true;
      });
      /**
       * A child that never starts emits `error`, and an `error` event with no listener is thrown
       * from a tick nothing awaits: the launcher died past `runBirdSmoke`'s cleanup, leaving every
       * official service it had already started detached on its port. Waiting for the spawn to be
       * confirmed makes that an ordinary failed step instead, and a listener outlives the wait
       * because `error` can arrive after `spawn` too.
       */
      child.on("error", () => {
        /* `stop()` already reads a child with no pid as nothing to signal */
      });
      try {
        await new Promise<void>((accept, reject) => {
          child.once("spawn", () => accept());
          child.once("error", () => reject(new SmokeError(`Could not start ${item.id}; see ${item.log}`)));
        });
      } catch (error) {
        log.close();
        throw error;
      }
      return {
        id: item.id,
        async stop(): Promise<void> {
          if (exited || child.pid === undefined) return;
          const done = new Promise<void>((accept) => child.once("exit", () => accept()));
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            return;
          }
          const timer = setTimeout(() => {
            try {
              if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
            } catch {
              /* the group is already gone */
            }
          }, STOP_GRACE_MS);
          await done;
          clearTimeout(timer);
        },
      };
    },

    async run(item: ProcessRecord): Promise<number> {
      const log = await openLog(item.log);
      const child = spawn(item.exe, [...item.argv], {
        cwd: item.cwd,
        env: { ...item.env },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.pipe(log);
      child.stderr?.pipe(log);
      return new Promise<number>((accept, reject) => {
        child.once("error", () => reject(new SmokeError(`Could not run ${item.id}; see ${item.log}`)));
        child.once("exit", (code) => accept(code ?? 1));
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Preflight                                                                  */
/* -------------------------------------------------------------------------- */

export interface SmokePaths {
  /** The prepared database this run is scoped to; preflight refuses a runtime that holds another. */
  readonly database: string;
  /** The profile directory `warble-cli compile` is pointed at; the baseline unless `--profile`. */
  readonly profileDir: string;
  readonly dataRoot: string;
  readonly warbleRoot: string;
  readonly packageDir: string;
  readonly runtimeDir: string;
  readonly cacheDir: string;
  readonly checkoutDir: string;
  readonly adkDir: string;
  readonly runDir: string;
}

export interface ResolvedProfile {
  /** Absolute path to the profile directory this run compiles. */
  readonly dir: string;
  /** `null` for the shipped baseline; otherwise what scopes this run's own directory. */
  readonly label: string | null;
}

/** The profile a run uses when `--profile` is not given: the baseline, unlabelled. */
export function baselineProfile(packageDir: string): ResolvedProfile {
  return { dir: join(packageDir, PROFILE_DIRECTORY), label: null };
}

/**
 * Turns `--profile` into a directory to compile and a label to scope the run by.
 *
 * The path is resolved against the package, so `--profile agents/greedy` means what it looks like
 * from the runbook, and an absolute path still works. Two refusals: a directory outside the Warble
 * repository, because a run has to stay reproducible from the tree that produced it and this
 * package promises to read no project outside it; and a directory name that cannot also be a run
 * directory's name, because that name is the only thing distinguishing your run from the
 * baseline's on disk.
 *
 * Containment is decided on the REAL path, through the same `realPathOfNearestExisting` that
 * decides where a gold-bearing artifact may be written. `resolve` collapses `..` textually and
 * does nothing else, so an `agents/elsewhere` symlink pointing at `/somewhere/outside/agent` reads
 * as inside the repository to a lexical `startsWith`, and the source a finished run would have to
 * be reproduced from sits outside the tree that run records the commit of. The nearest-existing
 * variant rather than a plain `realpath` because a profile directory that is simply missing is
 * preflight's refusal to make — it names the directory and says it does not exist — and a
 * `realpath` here would replace that with an ENOENT raised while the flags are still being parsed.
 *
 * The repository ROOT is refused by that same check, exactly as the data root is refused as an
 * output path: it is a directory, not a profile. Permitting `--profile ../..` bought nothing but a
 * later, vaguer complaint about a missing profile.yml in place of the containment message.
 *
 * What is RETURNED is the path as the runbook names it, not its real path: the label that scopes
 * the run directory is the name that was typed, and `warble-cli compile` is handed this directory
 * relative to the Warble root. So a link that resolves INSIDE the tree clears containment here and
 * is refused one step later by preflight's `lstat`, which wants real source rather than a name
 * pointing at it.
 */
export async function resolveProfile(packageDir: string, requested: string): Promise<ResolvedProfile> {
  const baseline = baselineProfile(packageDir);
  const dir = resolve(packageDir, requested);
  const warbleRoot = resolve(packageDir, "..", "..");
  // Resolved on both sides of every comparison. The baseline short-circuit has to see through the
  // same symlinks containment now sees through, or a checkout reached by one would give the
  // baseline a label and move its runs out of the `runs/<database>-5` directory that every run
  // recorded before profiles had names is still addressed by.
  const [realDir, realBaseline, realRoot] = await Promise.all([
    realPathOfNearestExisting(dir),
    realPathOfNearestExisting(baseline.dir),
    realPathOfNearestExisting(warbleRoot),
  ]);
  if (realDir === realBaseline) return baseline;

  if (!realDir.startsWith(`${realRoot}${sep}`)) {
    throw new CliUsageError(
      `--profile must name a directory inside the Warble repository, so the run stays reproducible from it: ${requested}`,
    );
  }
  try {
    return { dir, label: assertProfileLabel(basename(dir)) };
  } catch (error) {
    throw new CliUsageError(
      `${error instanceof Error ? error.message : String(error)} -- the name becomes this run's directory under data/runs/`,
    );
  }
}

export function smokePaths(
  packageDir: string,
  database = DEFAULT_SMOKE_DATABASE,
  profile: ResolvedProfile = baselineProfile(packageDir),
): SmokePaths {
  const dataRoot = join(packageDir, "data");
  const cacheDir = join(dataRoot, "cache");
  const checkoutDir = join(cacheDir, "BIRD-Interact");
  return {
    database,
    profileDir: profile.dir,
    dataRoot,
    warbleRoot: resolve(packageDir, "..", ".."),
    packageDir,
    runtimeDir: join(dataRoot, RUNTIME_DIRECTORY),
    cacheDir,
    checkoutDir,
    adkDir: join(checkoutDir, ADK_RELATIVE_PATH),
    runDir: join(dataRoot, runDirectory(database, profile.label)),
  };
}

async function requireFileWithHash(path: string, expected: string, label: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new SmokeError(`Prepared ${label} is missing; run the preparation command first`);
  }
  if (sha256(text) !== expected) {
    throw new SmokeError(`Prepared ${label} does not match the recorded manifest hash; re-run preparation`);
  }
  return text;
}

export interface PreflightOptions {
  readonly paths: SmokePaths;
  readonly config: SmokeConfig;
  readonly verifySnapshot?: (cacheDir: string) => Promise<PublicSnapshotVerification>;
  readonly checkPorts?: (ports: readonly number[]) => Promise<void>;
  readonly dryPlan?: (runtimeDir: string, wrenBin: string) => Promise<void>;
}

export interface PreflightResult {
  readonly manifest: PrepareManifest;
  readonly smokeText: string;
}

/**
 * Proves every local input is the one preparation validated — offline — before a service starts.
 */
export async function preflight(options: PreflightOptions): Promise<PreflightResult> {
  const { paths, config } = options;

  // The profile is checked before anything else: a typo in `--profile` is the likeliest failure
  // here and the cheapest to prove, and compiling is several steps too late to learn about it.
  const profileStats = await lstat(paths.profileDir).catch(() => null);
  if (profileStats === null) {
    throw new SmokeError(`Profile directory ${paths.profileDir} does not exist`);
  }
  // lstat, not stat: a symlink out of the tree would satisfy `--profile`'s containment check while
  // the profile itself lived somewhere a finished run could never be reproduced from.
  if (!profileStats.isDirectory()) {
    throw new SmokeError(
      `${paths.profileDir} is not a directory -- a symlink is refused too, since the profile has to be real source inside the repository`,
    );
  }
  if ((await lstat(join(paths.profileDir, "profile.yml")).catch(() => null)) === null) {
    throw new SmokeError(
      `${paths.profileDir} is not a Warble profile: it has no profile.yml`,
    );
  }

  const manifest = await readPrepareManifest(paths.runtimeDir);
  if (manifest === null) {
    throw new SmokeError("data/runtime/manifest.json is missing or invalid; run the preparation command first");
  }

  // The run directory is named before the manifest is read, so the two must be made to agree here:
  // a runtime prepared for another database would otherwise be measured into this one's directory.
  if (manifest.database.name !== paths.database) {
    throw new SmokeError(
      `data/runtime holds the ${manifest.database.name} database, not ${paths.database}; re-run preparation with --database ${paths.database}`,
    );
  }
  const expectedTaskIds = smokeTaskIds(paths.database);
  if (manifest.taskIds.join(",") !== expectedTaskIds.join(",")) {
    throw new SmokeError(
      `data/runtime is scoped to ${manifest.taskIds.join(", ")}, not ${expectedTaskIds.join(", ")}; re-run preparation`,
    );
  }

  const smokeFile = smokeFilename(paths.database);
  const smokeText = await requireFileWithHash(
    join(paths.runtimeDir, smokeFile),
    manifest.outputs.smoke.sha256,
    smokeFile,
  );
  if (smokeText.split("\n").filter((line) => line !== "").length !== SMOKE_TASK_COUNT) {
    throw new SmokeError(
      `Prepared ${smokeFile} must contain exactly ${SMOKE_TASK_COUNT} tasks`,
    );
  }
  await requireFileWithHash(
    join(paths.runtimeDir, "identity-projects", paths.database, "target", "mdl.json"),
    manifest.outputs.mdl.sha256,
    "identity MDL",
  );

  const gtStats = await lstat(join(paths.dataRoot, "private", GT_FILENAME)).catch(() => null);
  if (gtStats === null || !gtStats.isFile()) {
    throw new SmokeError(`Private ground truth private/${GT_FILENAME} is missing; re-run preparation`);
  }

  const adkStats = await lstat(paths.adkDir).catch(() => null);
  if (adkStats === null || !adkStats.isDirectory()) {
    throw new SmokeError("The pinned official checkout is missing its ADK directory; re-run preparation");
  }
  if ((await lstat(join(paths.adkDir, ".env")).catch(() => null)) !== null) {
    throw new SmokeError(
      "An .env file inside the official checkout is not allowed; move its settings to data/private/.env",
    );
  }

  const publicCache = join(paths.cacheDir, PUBLIC_CACHE_DIRECTORY);
  const link = join(paths.adkDir, PUBLIC_CACHE_DIRECTORY);
  const linkStats = await lstat(link).catch(() => null);
  if (linkStats === null || !linkStats.isSymbolicLink() || resolve(paths.adkDir, await readlink(link)) !== publicCache) {
    throw new SmokeError(
      "The official ADK public-data link no longer points at the Warble-local snapshot; re-run preparation",
    );
  }

  const verifySnapshot = options.verifySnapshot ?? verifyPublicSnapshotOffline;
  const snapshot = await verifySnapshot(publicCache);
  if (
    snapshot.commit !== manifest.publicSnapshot.commit ||
    snapshot.fileCount !== manifest.publicSnapshot.fileCount ||
    snapshot.manifestSha256 !== manifest.publicSnapshot.manifestSha256
  ) {
    throw new SmokeError(
      "The local public snapshot changed after preparation; re-run preparation before measuring anything",
    );
  }

  const ports: number[] = [BIRD_SERVICE_PORTS.user_simulator, BIRD_SERVICE_PORTS.db_environment];
  if (!config.oracleOnly) ports.push(BIRD_SERVICE_PORTS.system_agent);
  await (options.checkPorts ?? verifyFreePorts)(ports);

  const dryPlan =
    options.dryPlan ??
    (async (runtimeDir: string, wrenBin: string): Promise<void> => {
      const planner = new ProcessWrenPlanner({ projectRoot: join(runtimeDir, "identity-projects"), wrenBin });
      await planner.plan(paths.database, `SELECT 1`);
    });
  await dryPlan(paths.runtimeDir, config.wrenBin);

  return { manifest, smokeText };
}


/* -------------------------------------------------------------------------- */
/* Python environment                                                         */
/* -------------------------------------------------------------------------- */

export interface CaptureResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandCapture = (
  exe: string,
  argv: readonly string[],
  options: { readonly cwd?: string; readonly env: EnvRecord },
) => Promise<CaptureResult>;

export const defaultCapture: CommandCapture = async (exe, argv, options) =>
  new Promise<CaptureResult>((accept, reject) => {
    const child = spawn(exe, [...argv], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", () => reject(new SmokeError(`Could not run '${exe}'`)));
    child.once("close", (code) => accept({ code: code ?? 1, stdout, stderr }));
  });

export interface PythonEnvironmentRecord {
  readonly pythonBin: string;
  readonly requestedVersion: string;
  readonly venv: string;
  readonly venvPython: string;
  readonly venvVersion: string;
  readonly requirementsSha256: string;
  readonly pipFreezeSha256: string;
}

const IMPORT_PROBE =
  "import uvicorn, httpx, litellm, psycopg2, db_environment.server, user_simulator.server, orchestrator.runner";
const PROBE_KEY = "WARBLE_DOTENV_PROBE";
const PROBE_ABSENT = "<absent>";

/** The question the probe asks the pinned interpreter, and the two answers that can come back. */
export const DOTENV_PROBE = {
  script: `import os,dotenv;dotenv.load_dotenv();print(os.environ.get('${PROBE_KEY}','${PROBE_ABSENT}'))`,
  key: PROBE_KEY,
  /** What the probe's `.env` defines; only an interpreter that loaded it can print this. */
  leaked: "leaked",
  /** What an interpreter that honored PYTHON_DOTENV_DISABLED prints. */
  absent: PROBE_ABSENT,
} as const;

/**
 * Asks the pinned interpreter whether its python-dotenv still honors PYTHON_DOTENV_DISABLED.
 *
 * `load_dotenv()` reads the first `.env` it finds walking UP from the interpreter's directory, so
 * the leak that flag prevents is an ancestor `.env` — one in the package directory, the repository
 * root, or the developer's home — being read into an official process the allowlist deliberately
 * handed no credential at all. The probe reproduces exactly that: a real `.env` one level above the
 * directory the interpreter runs from, defining a key that is NOT already in the environment.
 *
 * Both halves are what make the probe able to fail, and the probe this replaces had neither. With
 * no `.env` anywhere on the search path there is nothing to load; and `load_dotenv` defaults to
 * `override=False`, which skips every key already present in `os.environ`, so pre-setting the key —
 * even to "" — answers the question before python-dotenv is asked. That probe printed its passing
 * value against every python-dotenv ever released, including versions predating the flag.
 *
 * The tree is temporary and outside the checkout: preflight refuses to run when a `.env` exists
 * inside the pinned ADK, so this may not leave one there, even for the length of a probe.
 */
export async function probeDotenv(
  python: string,
  officialEnv: EnvRecord,
  capture: CommandCapture,
): Promise<CaptureResult> {
  const root = await mkdtemp(join(tmpdir(), "warble-dotenv-probe-"));
  try {
    const cwd = join(root, "official");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(root, ".env"), `${DOTENV_PROBE.key}=${DOTENV_PROBE.leaked}\n`, "utf8");
    return await capture(python, ["-c", DOTENV_PROBE.script], { cwd, env: officialEnv });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Verifies the requested interpreter, reuses or creates the ADK virtualenv, and records provenance.
 * A mismatched existing venv is reported, never deleted or silently rebuilt.
 */
export async function preparePythonEnvironment(options: {
  readonly config: SmokeConfig;
  readonly paths: SmokePaths;
  readonly baseEnv: EnvRecord;
  readonly postgresPort: number;
  readonly capture?: CommandCapture;
}): Promise<PythonEnvironmentRecord> {
  const capture = options.capture ?? defaultCapture;
  const { adkDir } = options.paths;
  const venv = join(adkDir, ".venv");
  const venvPython = join(venv, "bin", "python");
  const officialEnv = buildSafeOfficialEnv({
    adkDir,
    postgresPort: options.postgresPort,
    baseEnv: options.baseEnv,
  });

  const requested = await capture(options.config.pythonBin, ["--version"], { env: options.baseEnv });
  if (requested.code !== 0) {
    throw new SmokeError(`Could not run '${options.config.pythonBin} --version'; pass --python-bin`);
  }
  const requestedVersion = requireSupportedPython(
    parsePythonVersion(`${requested.stdout}${requested.stderr}`),
    "--python-bin",
  );

  const venvExists = (await lstat(venvPython).catch(() => null)) !== null;
  if (venvExists) {
    const found = await capture(venvPython, ["--version"], { env: options.baseEnv });
    if (found.code !== 0) {
      throw new SmokeError(`The existing ADK virtualenv interpreter at ${venvPython} could not be run`);
    }
    const venvVersion = requireSupportedPython(
      parsePythonVersion(`${found.stdout}${found.stderr}`),
      "the existing ADK virtualenv",
    );
    if (venvVersion.major !== requestedVersion.major || venvVersion.minor !== requestedVersion.minor) {
      throw new SmokeError(
        `The existing ADK virtualenv reports Python ${venvVersion.major}.${venvVersion.minor} but --python-bin reports ` +
          `${requestedVersion.major}.${requestedVersion.minor}; move or rebuild ${venv} yourself, Warble will not delete it`,
      );
    }
  } else {
    const created = await capture(options.config.pythonBin, ["-m", "venv", venv], { env: options.baseEnv });
    if (created.code !== 0) throw new SmokeError(`Could not create the ADK virtualenv at ${venv}`);
    const installed = await capture(
      venvPython,
      ["-m", "pip", "install", "--disable-pip-version-check", "-r", join(adkDir, "requirements.txt")],
      { cwd: adkDir, env: officialEnv },
    );
    if (installed.code !== 0) {
      throw new SmokeError(`Installing the pinned checkout's requirements.txt into ${venv} failed`);
    }
  }

  const imports = await capture(venvPython, ["-c", IMPORT_PROBE], { cwd: adkDir, env: officialEnv });
  if (imports.code !== 0) {
    throw new SmokeError(
      `The ADK virtualenv cannot import uvicorn, httpx, litellm, psycopg2, and the official modules`,
    );
  }

  const dotenv = await probeDotenv(venvPython, officialEnv, capture);
  if (dotenv.code !== 0) {
    throw new SmokeError(`Could not run the python-dotenv probe in ${venv}; the official code imports it`);
  }
  if (dotenv.stdout.trim() !== DOTENV_PROBE.absent) {
    throw new SmokeError(
      "The installed python-dotenv read an ancestor .env despite PYTHON_DOTENV_DISABLED=1; upgrade it " +
        "before running the smoke, or every official process can load one holding real credentials",
    );
  }

  const freeze = await capture(venvPython, ["-m", "pip", "freeze", "--all"], { cwd: adkDir, env: officialEnv });
  if (freeze.code !== 0) throw new SmokeError("Could not record 'pip freeze --all' for the ADK virtualenv");
  const venvReport = await capture(venvPython, ["--version"], { env: options.baseEnv });
  const requirements = await readFile(join(adkDir, "requirements.txt"), "utf8");

  const runDir = options.paths.runDir;
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "python-freeze.txt"), freeze.stdout, "utf8");
  const version = parsePythonVersion(`${venvReport.stdout}${venvReport.stderr}`);
  const record: PythonEnvironmentRecord = {
    pythonBin: options.config.pythonBin,
    requestedVersion: `${requestedVersion.major}.${requestedVersion.minor}.${requestedVersion.patch}`,
    venv,
    venvPython,
    venvVersion: `${version.major}.${version.minor}.${version.patch}`,
    requirementsSha256: sha256(requirements),
    pipFreezeSha256: sha256(freeze.stdout),
  };
  await writeFile(join(runDir, "python-environment.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

/**
 * Record which model drove the official user simulator, into the run's own directory.
 *
 * Provenance that lives outside the run is not provenance: `report-cli` used to read
 * `USER_SIM_MODEL` out of the current `data/private/.env`, so editing that file re-attributed
 * every finished run on disk. This file is written once, from the value this run actually
 * resolved, and the report reads it from here or says the model is unrecorded.
 *
 * The NAME and nothing else. `data/private/.env` also holds the key that model authenticates
 * with, and a run directory is copied, diffed and attached to reports; `UserSimulatorAuth.model`
 * is the only field of it that may be written here, never `variables`.
 */
async function writeUserSimulatorRecord(runDir: string, model: string): Promise<void> {
  const record: UserSimulatorRecord = { version: 1, model };
  await writeFile(
    join(runDir, USER_SIMULATOR_FILENAME),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */

export interface SmokeRunnerDependencies {
  readonly paths: SmokePaths;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly supervisor: ProcessSupervisor;
  readonly preflight?: (options: PreflightOptions) => Promise<PreflightResult>;
  readonly pythonEnvironment?: (options: {
    config: SmokeConfig;
    paths: SmokePaths;
    baseEnv: EnvRecord;
    postgresPort: number;
  }) => Promise<PythonEnvironmentRecord>;
  readonly waitForService?: (port: number, logPath: string) => Promise<void>;
  readonly probeSystemAgentAuth?: () => Promise<boolean>;
  readonly readJson?: (path: string) => Promise<unknown>;
  readonly listTraceTasks?: (traceDir: string) => Promise<string[]>;
  readonly onPlan?: (plan: readonly ProcessRecord[]) => void;
}

export interface SmokeSummary {
  readonly runDir: string;
  /** Where the run that was in `runDir` was moved, or null when there was none to move. */
  readonly archived: string | null;
  readonly oracleOnly: boolean;
  readonly oracle: ResultSummary;
  readonly interact: ResultSummary | null;
}

async function defaultReadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function defaultListTraceTasks(traceDir: string): Promise<string[]> {
  const entries = await readdir(traceDir, { withFileTypes: true }).catch(() => []);
  const tasks: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if ((await lstat(join(traceDir, entry.name, "trace.json")).catch(() => null)) !== null) {
      tasks.push(entry.name);
    }
  }
  return tasks.sort();
}

/**
 * Moves a previous run out of the run directory so this one starts in an empty one.
 *
 * The run directory is a constant and everything under it is keyed by the constant task ids, so a
 * rerun that only overwrote its own outputs left the previous run's beside them. `report-cli` fills
 * its tolerant column with `tolerant[task_id]`, so a previous autopsy's verdicts scored the new
 * submissions; an `--oracle-only` rerun, which writes no `a-interact.json`, no `traces/` and no
 * `user-simulator.json` at all, reported the previous run's. Nothing downstream can notice: a rerun
 * over the same runtime tree writes a byte-identical `manifest.json`, so the run-versus-runtime
 * cross-check compares a run against itself and passes.
 *
 * **Nothing in a run directory is ever an input to a later run, in any mode.** Everything a run does
 * reuse — the pinned checkout, the ADK virtualenv, `data/runtime/`, the PostgreSQL container — lives
 * outside it and carries its own reuse rule. `--oracle-only` is not a partial run over the last
 * one's directory: it is a whole run that writes fewer files, and every file it did not write would
 * describe a run that is no longer there. So the rule is the same for every mode, and it is this
 * one: the directory starts empty.
 *
 * The displaced run is MOVED, never deleted. It is a measurement Warble did not make and someone may
 * still be reading it, exactly as a mismatched virtualenv is reported rather than rebuilt and an
 * occupied port is refused rather than cleared. Both commands that read a run name it by its
 * directory name under `data/runs/`, so the archive stays reportable where it lands, and the stamp
 * is the directory's own last-written time: a name that says which run it holds.
 */
async function archivePreviousRun(runDir: string): Promise<string | null> {
  const entries = await readdir(runDir).catch(() => null);
  if (entries === null || entries.length === 0) return null;

  const stamp = (await stat(runDir)).mtime.toISOString().replace(/[:.]/g, "-");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const archive = `${runDir}.${stamp}${attempt === 0 ? "" : `-${attempt}`}`;
    // Never onto an existing directory: that would overwrite the very thing this is preserving.
    if ((await lstat(archive).catch(() => null)) !== null) continue;
    await rename(runDir, archive);
    // Said as it happens, not in the summary: a run that then fails still has to leave the reader
    // able to find the run it moved.
    process.stderr.write(`Moved the previous run in ${runDir} to ${archive}\n`);
    return archive;
  }
  throw new SmokeError(`Could not move the previous run out of ${runDir}; move it yourself and retry`);
}

/**
 * Runs the oracle-gated fixed-task smoke. Only processes this launcher started are ever stopped, and
 * a failed oracle blocks the model run entirely.
 */
export async function runBirdSmoke(
  config: SmokeConfig,
  deps: SmokeRunnerDependencies,
): Promise<SmokeSummary> {
  const { paths } = deps;
  const started: ProcessHandle[] = [];
  const readJson = deps.readJson ?? defaultReadJson;
  const listTraceTasks = deps.listTraceTasks ?? defaultListTraceTasks;
  const wait = deps.waitForService ?? ((port, logPath) => waitForService(port, logPath));

  const shutdown = async (): Promise<void> => {
    for (const handle of [...started].reverse()) await handle.stop();
    started.length = 0;
  };
  const onSignal = (): void => {
    void shutdown().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    // 1. Every local input must be exactly what preparation validated, offline.
    const { manifest } = await (deps.preflight ?? preflight)({ paths, config });
    const postgresPort = manifest.database.hostPort;
    const baseEnv = selectBaseEnv(deps.processEnv);

    // Model credentials are resolved before any service starts; the oracle never needs them.
    const modelEnv = await loadPrivateEnv(paths.dataRoot, deps.processEnv);
    const userSimulator = config.oracleOnly
      ? optionalUserSimulatorAuth(modelEnv)
      : selectUserSimulatorAuth(modelEnv);
    let systemAgentEnv: EnvRecord = {};
    if (!config.oracleOnly) {
      const selected = selectSystemAgentAuth(modelEnv);
      if (selected === null) {
        const probe = deps.probeSystemAgentAuth ?? (async () => false);
        if (!(await probe())) {
          throw new SmokeError(
            "The Warble system agent has no ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN and 'claude auth status' failed",
          );
        }
      } else {
        systemAgentEnv = selected;
      }
    }

    // 2. A run directory holds exactly one run; from here on, everything writes into it.
    const archived = await archivePreviousRun(paths.runDir);

    // 3. Verify or build the official virtualenv and record its provenance.
    await (deps.pythonEnvironment ?? preparePythonEnvironment)({
      config,
      paths,
      baseEnv,
      postgresPort,
    });

    const plan = buildProcessPlan({
      warbleRoot: paths.warbleRoot,
      packageDir: paths.packageDir,
      profileDir: paths.profileDir,
      dataRoot: paths.dataRoot,
      adkDir: paths.adkDir,
      runDir: paths.runDir,
      runtimeDir: paths.runtimeDir,
      smokeFile: smokeFilename(paths.database),
      pythonBin: config.pythonBin,
      wrenBin: config.wrenBin,
      systemModel: config.systemModel,
      postgresPort,
      oracleOnly: config.oracleOnly,
      concurrency: config.concurrency,
      baseEnv: deps.processEnv,
      userSimulatorEnv: userSimulator?.variables ?? {},
      systemAgentEnv,
    });
    deps.onPlan?.(plan);
    const byId = new Map(plan.map((item) => [item.id, item] as const));
    const step = (id: ProcessId): ProcessRecord => {
      const found = byId.get(id);
      if (found === undefined) throw new SmokeError(`Process plan is missing ${id}`);
      return found;
    };

    await mkdir(join(paths.runDir, "logs"), { recursive: true });

    // 4. Compile the Warble profile and build the adapter this run will serve.
    for (const id of ["compile", "adapter-build"] as const) {
      const item = step(id);
      if ((await deps.supervisor.run(item)) !== 0) {
        throw new SmokeError(`${id} failed; see ${item.log}`);
      }
    }

    // 5. Start only the official services this launcher owns.
    for (const [id, port] of [
      ["db-environment", BIRD_SERVICE_PORTS.db_environment],
      ["user-simulator", BIRD_SERVICE_PORTS.user_simulator],
    ] as const) {
      const item = step(id);
      started.push(await deps.supervisor.start(item));
      await wait(port, item.log);
    }

    // 6. The official oracle gates everything that follows.
    const oracleStep = step("oracle");
    if ((await deps.supervisor.run(oracleStep)) !== 0) {
      throw new SmokeError(`The official oracle run failed; see ${oracleStep.log}`);
    }
    const oracle = summarizeOracleResult(await readJson(oracleStep.output ?? ""), manifest.taskIds);

    await mkdir(paths.runDir, { recursive: true });
    await writeFile(
      join(paths.runDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    // 7. Oracle-only stops here without ever inspecting the system-agent port. It replays official
    //    ground truth and never calls the user simulator, so it records no simulator model at all:
    //    the file is absent, never present and empty.
    if (config.oracleOnly) {
      return { runDir: paths.runDir, archived, oracleOnly: true, oracle, interact: null };
    }

    // Every other run does call it, so it records the model that answered — beside the manifest,
    // as part of the run's own record. `selectUserSimulatorAuth` already refused to get this far
    // without one; the guard is the type's, not a fallback.
    if (userSimulator !== null) await writeUserSimulatorRecord(paths.runDir, userSimulator.model);

    // 8-9. Serve Warble's system agent and let the official runner drive it.
    const agentStep = step("system-agent");
    started.push(await deps.supervisor.start(agentStep));
    await wait(BIRD_SERVICE_PORTS.system_agent, agentStep.log);

    const interactStep = step("a-interact");
    if ((await deps.supervisor.run(interactStep)) !== 0) {
      throw new SmokeError(`The official a-interact run failed; see ${interactStep.log}`);
    }
    const interact = summarizeInteractResult(await readJson(interactStep.output ?? ""), manifest.taskIds);

    // 10. Zero rewards are acceptable; missing traces are not.
    const traces = await listTraceTasks(join(paths.runDir, "traces"));
    if (traces.join(",") !== [...manifest.taskIds].sort().join(",")) {
      throw new SmokeError(
        `Expected one Warble trace directory per task (${manifest.taskIds.join(", ")}) under ${join(paths.runDir, "traces")}`,
      );
    }

    return { runDir: paths.runDir, archived, oracleOnly: false, oracle, interact };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await shutdown();
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

const HELP = `Usage: warble-bird-smoke [options]

Runs the official BIRD-Interact oracle over the prepared database's ${SMOKE_TASK_COUNT} Query tasks
and, unless --oracle-only, the official a-interact run against Warble's system agent. The database,
its PostgreSQL container and its port all come from data/runtime/manifest.json, never from a flag:
run the preparation command with --database to change which one is measured.

A run directory holds exactly one run. Whatever data/runs/<database>-${SMOKE_TASK_COUNT} already
holds is moved beside it, under the time it was last written, before this run starts; nothing is
deleted. A --profile other than the baseline gets its own directory, so measuring your own agent
never displaces the baseline run you are comparing it against.

Options:
  --oracle-only                  Stop after a passing oracle; never inspect or start port ${BIRD_SERVICE_PORTS.system_agent}
  --concurrency <n>              Tasks in flight, 1 to ${SMOKE_TASK_COUNT} (default: ${DEFAULT_CONCURRENCY})
  --wren-bin <path>              Wren executable (default: wren)
  --python-bin <path>            Python >= 3.10 and < 3.13 (default: ${DEFAULT_PYTHON_BIN})
  --system-model <name>          Warble system-agent model (default: ${DEFAULT_SYSTEM_MODEL})
  --profile <dir>                Warble profile to compile, resolved against this package
                                 (default: ${PROFILE_DIRECTORY}, the baseline). Anything else runs in
                                 data/runs/<database>-${SMOKE_TASK_COUNT}-<directory name>
  -h, --help                     Show help
  -V, --version                  Show version`;

/** The installed package root; `data/` and `dist/` both live directly beneath it. */
export function packageDirectory(): string {
  return resolve(import.meta.dirname, "..");
}

async function probeClaudeAuth(baseEnv: EnvRecord): Promise<boolean> {
  const probe = await defaultCapture("claude", ["auth", "status"], { env: baseEnv }).catch(() => null);
  return probe !== null && probe.code === 0;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseSmokeArgs(argv);
  if (parsed.kind === "help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (parsed.kind === "version") {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }
  // The run directory is named for the prepared database, so the manifest is read before the paths
  // exist. preflight reads it again and cross-checks it; this read only chooses a directory name.
  const packageDir = packageDirectory();
  const profile = await resolveProfile(packageDir, parsed.config.profile);
  const manifest = await readPrepareManifest(join(packageDir, "data", RUNTIME_DIRECTORY));
  if (manifest === null) {
    throw new SmokeError(
      "data/runtime/manifest.json is missing or invalid; run the preparation command first",
    );
  }
  const paths = smokePaths(packageDir, manifest.database.name, profile);
  const summary = await runBirdSmoke(parsed.config, {
    paths,
    processEnv: process.env,
    supervisor: createProcessSupervisor(),
    probeSystemAgentAuth: () => probeClaudeAuth(selectWarbleEnv(process.env)),
  });
  process.stdout.write(
    `${summary.oracleOnly ? "Oracle" : "a-interact"} smoke complete over ${summary.oracle.taskIds.join(", ")}: ${summary.runDir}\n`,
  );
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
