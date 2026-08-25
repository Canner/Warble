#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { parse as parseDotenv } from "dotenv";
import { z } from "zod";

import { CliUsageError } from "./cli-usage.js";
import {
  GT_FILENAME,
  PROFILE_DIRECTORY,
  PUBLIC_CACHE_DIRECTORY,
  RUNTIME_DIRECTORY,
  SMOKE_DATABASE,
  SMOKE_FILENAME,
  SMOKE_TASK_IDS,
  USER_SIMULATOR_FILENAME,
  readPrepareManifest,
  type PrepareManifest,
  type UserSimulatorRecord,
} from "./runtime-layout.js";
import { BIRD_SERVICE_PORTS } from "./protocol.js";
import { verifyPublicSnapshotOffline, type PublicSnapshotVerification } from "./source-cache.js";
import { ProcessWrenPlanner } from "./wren-planner.js";

const PACKAGE_VERSION = "0.1.0";

export { CliUsageError };

export const RUN_DIRECTORY = "runs/alien-5";
export const ADK_RELATIVE_PATH = "BIRD-Interact-ADK";
export const DEFAULT_SYSTEM_MODEL = "claude-sonnet-4-5-20250929";
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
const PROBE_TIMEOUT_MS = 30_000;

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
    },
  };
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
  readonly dataRoot: string;
  readonly adkDir: string;
  readonly runDir: string;
  readonly runtimeDir: string;
  readonly pythonBin: string;
  readonly wrenBin: string;
  readonly systemModel: string;
  readonly postgresPort: number;
  readonly oracleOnly: boolean;
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
  const smokeData = join(context.runtimeDir, SMOKE_FILENAME);
  const irPath = join(context.runDir, "agent-ir.json");

  const runnerArgv = (mode: "oracle" | "a-interact", output: string): string[] => [
    "-m", "orchestrator.runner",
    "--mode", mode,
    "--data", smokeData,
    "--concurrency", "1",
    "--output", output,
  ];

  const oracleOutput = join(context.runDir, "oracle.json");
  const interactOutput = join(context.runDir, "a-interact.json");
  // The profile ships inside this package; cargo runs from the Warble root, so pass it relatively.
  const profile = relative(context.warbleRoot, join(context.packageDir, PROFILE_DIRECTORY));

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

function summarizeResult(value: unknown, label: "oracle" | "a-interact"): {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly summary: ResultSummary;
} {
  const parsed = resultFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new SmokeError(`The official ${label} result is not a supported BIRD-Interact result file`);
  }
  const rows = parsed.data.results as Array<Record<string, unknown>>;
  if (rows.length !== SMOKE_TASK_IDS.length || parsed.data.metrics.total_tasks !== SMOKE_TASK_IDS.length) {
    throw new SmokeError(
      `The official ${label} result must contain exactly ${SMOKE_TASK_IDS.length} tasks`,
    );
  }
  const taskIds = rows.map((row) => String(row.task_id));
  if (taskIds.join(",") !== SMOKE_TASK_IDS.join(",")) {
    throw new SmokeError(
      `The official ${label} result must cover exactly ${SMOKE_TASK_IDS.join(", ")} in order`,
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
export function summarizeOracleResult(value: unknown): ResultSummary {
  const { rows, summary } = summarizeResult(value, "oracle");
  for (const row of rows) {
    if (row.phase1_passed !== true || row.phase2_passed !== true) {
      throw new SmokeError(`The official oracle did not pass both phases for task ${String(row.task_id)}`);
    }
  }
  return summary;
}

/** Requires one error-free a-interact row per smoke task; a zero reward is an acceptable smoke outcome. */
export function summarizeInteractResult(value: unknown): ResultSummary {
  return summarizeResult(value, "a-interact").summary;
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

async function openLog(path: string): Promise<import("node:fs").WriteStream> {
  await mkdir(dirname(path), { recursive: true });
  return createWriteStream(path, { flags: "a" });
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
  readonly dataRoot: string;
  readonly warbleRoot: string;
  readonly packageDir: string;
  readonly runtimeDir: string;
  readonly cacheDir: string;
  readonly checkoutDir: string;
  readonly adkDir: string;
  readonly runDir: string;
}

export function smokePaths(packageDir: string): SmokePaths {
  const dataRoot = join(packageDir, "data");
  const cacheDir = join(dataRoot, "cache");
  const checkoutDir = join(cacheDir, "BIRD-Interact");
  return {
    dataRoot,
    warbleRoot: resolve(packageDir, "..", ".."),
    packageDir,
    runtimeDir: join(dataRoot, RUNTIME_DIRECTORY),
    cacheDir,
    checkoutDir,
    adkDir: join(checkoutDir, ADK_RELATIVE_PATH),
    runDir: join(dataRoot, RUN_DIRECTORY),
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
  const manifest = await readPrepareManifest(paths.runtimeDir);
  if (manifest === null) {
    throw new SmokeError("data/runtime/manifest.json is missing or invalid; run the preparation command first");
  }

  const smokeText = await requireFileWithHash(
    join(paths.runtimeDir, SMOKE_FILENAME),
    manifest.outputs.smoke.sha256,
    SMOKE_FILENAME,
  );
  if (smokeText.split("\n").filter((line) => line !== "").length !== SMOKE_TASK_IDS.length) {
    throw new SmokeError(
      `Prepared ${SMOKE_FILENAME} must contain exactly ${SMOKE_TASK_IDS.length} tasks`,
    );
  }
  await requireFileWithHash(
    join(paths.runtimeDir, "identity-projects", SMOKE_DATABASE, "target", "mdl.json"),
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
      await planner.plan(SMOKE_DATABASE, `SELECT 1`);
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

const DOTENV_PROBE =
  "import os,dotenv;dotenv.load_dotenv();print('LOADED' if os.environ.get('WARBLE_DOTENV_PROBE') else 'DISABLED')";
const IMPORT_PROBE =
  "import uvicorn, httpx, litellm, psycopg2, db_environment.server, user_simulator.server, orchestrator.runner";

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

  const dotenv = await capture(venvPython, ["-c", DOTENV_PROBE], {
    cwd: adkDir,
    env: { ...officialEnv, WARBLE_DOTENV_PROBE: "" },
  });
  if (dotenv.code !== 0 || dotenv.stdout.trim() !== "DISABLED") {
    throw new SmokeError(
      "The installed python-dotenv does not honor PYTHON_DOTENV_DISABLED; upgrade it before running the smoke",
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
  readonly oracleOnly: boolean;
  readonly oracle: ResultSummary;
  readonly interact: ResultSummary | null;
}

async function defaultReadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function defaultListTraceTasks(traceDir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
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

    // 2. Verify or build the official virtualenv and record its provenance.
    await (deps.pythonEnvironment ?? preparePythonEnvironment)({
      config,
      paths,
      baseEnv,
      postgresPort,
    });

    const plan = buildProcessPlan({
      warbleRoot: paths.warbleRoot,
      packageDir: paths.packageDir,
      dataRoot: paths.dataRoot,
      adkDir: paths.adkDir,
      runDir: paths.runDir,
      runtimeDir: paths.runtimeDir,
      pythonBin: config.pythonBin,
      wrenBin: config.wrenBin,
      systemModel: config.systemModel,
      postgresPort,
      oracleOnly: config.oracleOnly,
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

    // 3. Compile the Warble profile and build the adapter this run will serve.
    for (const id of ["compile", "adapter-build"] as const) {
      const item = step(id);
      if ((await deps.supervisor.run(item)) !== 0) {
        throw new SmokeError(`${id} failed; see ${item.log}`);
      }
    }

    // 4. Start only the official services this launcher owns.
    for (const [id, port] of [
      ["db-environment", BIRD_SERVICE_PORTS.db_environment],
      ["user-simulator", BIRD_SERVICE_PORTS.user_simulator],
    ] as const) {
      const item = step(id);
      started.push(await deps.supervisor.start(item));
      await wait(port, item.log);
    }

    // 5. The official oracle gates everything that follows.
    const oracleStep = step("oracle");
    if ((await deps.supervisor.run(oracleStep)) !== 0) {
      throw new SmokeError(`The official oracle run failed; see ${oracleStep.log}`);
    }
    const oracle = summarizeOracleResult(await readJson(oracleStep.output ?? ""));

    await mkdir(paths.runDir, { recursive: true });
    await writeFile(
      join(paths.runDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    // 6. Oracle-only stops here without ever inspecting the system-agent port. It replays official
    //    ground truth and never calls the user simulator, so it records no simulator model at all:
    //    the file is absent, never present and empty.
    if (config.oracleOnly) {
      return { runDir: paths.runDir, oracleOnly: true, oracle, interact: null };
    }

    // Every other run does call it, so it records the model that answered — beside the manifest,
    // as part of the run's own record. `selectUserSimulatorAuth` already refused to get this far
    // without one; the guard is the type's, not a fallback.
    if (userSimulator !== null) await writeUserSimulatorRecord(paths.runDir, userSimulator.model);

    // 7-8. Serve Warble's system agent and let the official runner drive it.
    const agentStep = step("system-agent");
    started.push(await deps.supervisor.start(agentStep));
    await wait(BIRD_SERVICE_PORTS.system_agent, agentStep.log);

    const interactStep = step("a-interact");
    if ((await deps.supervisor.run(interactStep)) !== 0) {
      throw new SmokeError(`The official a-interact run failed; see ${interactStep.log}`);
    }
    const interact = summarizeInteractResult(await readJson(interactStep.output ?? ""));

    // 9. Zero rewards are acceptable; missing traces are not.
    const traces = await listTraceTasks(join(paths.runDir, "traces"));
    if (traces.join(",") !== [...SMOKE_TASK_IDS].sort().join(",")) {
      throw new SmokeError(
        `Expected one Warble trace directory per task (${SMOKE_TASK_IDS.join(", ")}) under ${join(paths.runDir, "traces")}`,
      );
    }

    return { runDir: paths.runDir, oracleOnly: false, oracle, interact };
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

Runs the official BIRD-Interact oracle over ${SMOKE_TASK_IDS.join(", ")} and, unless --oracle-only,
the official a-interact run against Warble's system agent. The PostgreSQL container and port come
from data/runtime/manifest.json, never from a flag.

Options:
  --oracle-only                  Stop after a passing oracle; never inspect or start port ${BIRD_SERVICE_PORTS.system_agent}
  --wren-bin <path>              Wren executable (default: wren)
  --python-bin <path>            Python >= 3.10 and < 3.13 (default: ${DEFAULT_PYTHON_BIN})
  --system-model <name>          Warble system-agent model (default: ${DEFAULT_SYSTEM_MODEL})
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
  const paths = smokePaths(packageDirectory());
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

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
