import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  ADK_RELATIVE_PATH,
  CliUsageError,
  DEFAULT_SYSTEM_MODEL,
  DEFAULT_RUN_DIRECTORY,
  DOTENV_PROBE,
  SmokeError,
  DEFAULT_CONCURRENCY,
  buildProcessPlan,
  buildSafeOfficialEnv,
  createProcessSupervisor,
  defaultCapture,
  loadPrivateEnv,
  optionalUserSimulatorAuth,
  parsePrivateEnv,
  parsePythonVersion,
  parseSmokeArgs,
  preflight,
  preparePythonEnvironment,
  probeDotenv,
  requireSupportedPython,
  runBirdSmoke,
  selectSystemAgentAuth,
  selectUserSimulatorAuth,
  smokePaths,
  summarizeOracleResult,
  summarizeInteractResult,
  verifyFreePorts,
  waitForService,
  type CommandCapture,
  type EnvRecord,
  type ProcessRecord,
  type ProcessSupervisor,
  type SmokePlanContext,
  baselineProfile,
  resolveProfile,
} from "../src/smoke-cli.js";
import {
  DEFAULT_SMOKE_DATABASE,
  GT_FILENAME,
  PROFILE_DIRECTORY,
  SMOKE_TASK_COUNT,
  USER_SIMULATOR_FILENAME,
  readUserSimulatorRecord,
  smokeFilename,
  smokeTaskIds,
} from "../src/runtime-layout.js";

const RUN_DIRECTORY = DEFAULT_RUN_DIRECTORY;
const SMOKE_FILENAME = smokeFilename(DEFAULT_SMOKE_DATABASE);
const SMOKE_TASK_IDS = smokeTaskIds(DEFAULT_SMOKE_DATABASE);
import { BIRD_SERVICE_PORTS } from "../src/protocol.js";

const execFileAsync = promisify(execFile);

const BASE_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/warble",
  TMPDIR: "/tmp",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  NO_PROXY: "127.0.0.1",
  no_proxy: "127.0.0.1",
  // Warble-owned children need this for a Keychain-backed claude.ai login; official ones must not
  // see it, so every SAFE_OFFICIAL_KEYS assertion below doubles as an isolation-boundary check.
  USER: "warble",
} as const;

const SAFE_OFFICIAL_KEYS = [
  "DATASET",
  "DB_ENV_PORT",
  "HOME",
  "LANG",
  "LC_ALL",
  "NO_PROXY",
  "PATH",
  "PATIENCE",
  "PG_HOST",
  "PG_PASSWORD",
  "PG_PORT",
  "PG_USER",
  "PYTHONDONTWRITEBYTECODE",
  "PYTHONPATH",
  "PYTHON_DOTENV_DISABLED",
  "SYSTEM_AGENT_PORT",
  "TMPDIR",
  "USER_SIM_PORT",
  "no_proxy",
].sort();

const SECRET_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "LITELLM_API_KEY",
  "USER_SIM_MODEL",
] as const;

async function makeTempRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "warble-bird-smoke-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function planContext(overrides: Partial<SmokePlanContext> = {}): SmokePlanContext {
  return {
    warbleRoot: "/repo",
    packageDir: "/repo/eval/bird-interact",
    profileDir: `/repo/eval/bird-interact/${PROFILE_DIRECTORY}`,
    dataRoot: "/repo/eval/bird-interact/data",
    adkDir: `/repo/eval/bird-interact/data/cache/BIRD-Interact/${ADK_RELATIVE_PATH}`,
    runDir: `/repo/eval/bird-interact/data/${RUN_DIRECTORY}`,
    runtimeDir: "/repo/eval/bird-interact/data/runtime",
    smokeFile: SMOKE_FILENAME,
    pythonBin: "/usr/bin/python3.11",
    wrenBin: "/opt/wren/bin/wren",
    systemModel: DEFAULT_SYSTEM_MODEL,
    postgresPort: 55_432,
    oracleOnly: false,
    concurrency: DEFAULT_CONCURRENCY,
    baseEnv: { ...BASE_ENV },
    userSimulatorEnv: { USER_SIM_MODEL: "anthropic/claude-sonnet-4-5-20250929", ANTHROPIC_API_KEY: "sk-user" },
    systemAgentEnv: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret" },
    ...overrides,
  };
}

function planById(context: SmokePlanContext): Map<string, ReturnType<typeof buildProcessPlan>[number]> {
  return new Map(buildProcessPlan(context).map((record) => [record.id, record]));
}

/* -------------------------------------------------------------------------- */

test("parses the exact smoke CLI contract with documented defaults", () => {
  const parsed = parseSmokeArgs([]);
  assert.equal(parsed.kind, "run");
  assert.deepEqual(parsed.kind === "run" ? parsed.config : null, {
    oracleOnly: false,
    wrenBin: "wren",
    pythonBin: "python3.11",
    systemModel: DEFAULT_SYSTEM_MODEL,
    concurrency: DEFAULT_CONCURRENCY,
    profile: PROFILE_DIRECTORY,
  });
  assert.equal(DEFAULT_SYSTEM_MODEL, "claude-sonnet-4-5-20250929");
  assert.equal(DEFAULT_CONCURRENCY, 1);

  const explicit = parseSmokeArgs([
    "--oracle-only",
    "--wren-bin", "/opt/wren/bin/wren",
    "--python-bin", "/usr/bin/python3.12",
    "--system-model", "claude-opus-4-1",
    "--concurrency", String(SMOKE_TASK_COUNT),
    "--profile", "agents/greedy",
  ]);
  assert.deepEqual(explicit.kind === "run" ? explicit.config : null, {
    oracleOnly: true,
    wrenBin: "/opt/wren/bin/wren",
    pythonBin: "/usr/bin/python3.12",
    systemModel: "claude-opus-4-1",
    concurrency: SMOKE_TASK_COUNT,
    profile: "agents/greedy",
  });

  assert.equal(parseSmokeArgs(["--help"]).kind, "help");
  assert.equal(parseSmokeArgs(["--version"]).kind, "version");

  // The container and PostgreSQL port come from the verified manifest, never a second flag.
  assert.throws(() => parseSmokeArgs(["--postgres-port", "55432"]), CliUsageError);
  assert.throws(() => parseSmokeArgs(["--postgres-container", "x"]), CliUsageError);
  assert.throws(() => parseSmokeArgs(["--data-root", "/tmp"]), CliUsageError);
  assert.throws(() => parseSmokeArgs(["--wren-bin", ""]), CliUsageError);
  assert.throws(() => parseSmokeArgs(["positional"]), CliUsageError);

  // A task count this run cannot place is a refusal, never a silently clamped one.
  for (const value of ["0", "-1", "1.5", "many", "", String(SMOKE_TASK_COUNT + 1)]) {
    assert.throws(
      () => parseSmokeArgs(["--concurrency", value]),
      CliUsageError,
      `--concurrency ${value} must be refused`,
    );
  }
});

/**
 * The flag reaches BOTH official runs, because both of them clone databases.
 *
 * The oracle is the cheaper half and the one that gates the model run, so a `--concurrency` that
 * applied only to `a-interact` would leave the pass that proves the environment untested at the
 * concurrency the measurement actually uses.
 */
test("--concurrency is what the official runner is given, for oracle and a-interact alike", () => {
  const byId = planById(planContext({ concurrency: 3 }));
  for (const id of ["oracle", "a-interact"] as const) {
    const argv = byId.get(id)?.argv ?? [];
    assert.equal(argv[argv.indexOf("--concurrency") + 1], "3", `${id} runs at the asked concurrency`);
  }

  const serial = planById(planContext({ concurrency: DEFAULT_CONCURRENCY }));
  for (const id of ["oracle", "a-interact"] as const) {
    const argv = serial.get(id)?.argv ?? [];
    assert.equal(argv[argv.indexOf("--concurrency") + 1], "1");
  }
});

test("parses the private env file without shell evaluation and lets the process env win", async (t) => {
  const root = await makeTempRoot(t);
  const dataRoot = join(root, "data");
  await mkdir(join(dataRoot, "private"), { recursive: true });

  // No file at all is valid.
  assert.deepEqual(await loadPrivateEnv(dataRoot, { USER_SIM_MODEL: "openai/gpt-4o" }), {
    USER_SIM_MODEL: "openai/gpt-4o",
  });

  await writeFile(
    join(dataRoot, "private", ".env"),
    [
      "USER_SIM_MODEL=anthropic/claude-sonnet-4-5-20250929",
      "ANTHROPIC_API_KEY=file-key",
      "SHELLY=$(id -u)`whoami`${HOME}",
      "# comment",
      "",
      'QUOTED="spaced value"',
    ].join("\n"),
    "utf8",
  );

  const merged = await loadPrivateEnv(dataRoot, { ANTHROPIC_API_KEY: "process-key" });
  assert.equal(merged.ANTHROPIC_API_KEY, "process-key", "explicit process values win");
  assert.equal(merged.USER_SIM_MODEL, "anthropic/claude-sonnet-4-5-20250929");
  assert.equal(merged.SHELLY, "$(id -u)`whoami`${HOME}", "no shell or variable expansion");
  assert.equal(merged.QUOTED, "spaced value");

  assert.deepEqual(parsePrivateEnv("A=1\nB=2\n"), { A: "1", B: "2" });
});

test("selects provider-aware user-simulator authentication and rejects missing credentials", () => {
  const cases: ReadonlyArray<readonly [string, Record<string, string>, string, readonly string[]]> = [
    [
      "anthropic",
      { USER_SIM_MODEL: "anthropic/claude-sonnet-4-5-20250929", ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://x" },
      "anthropic",
      ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "USER_SIM_MODEL"],
    ],
    ["openai", { USER_SIM_MODEL: "openai/gpt-4o", OPENAI_API_KEY: "k" }, "openai", ["OPENAI_API_KEY", "USER_SIM_MODEL"]],
    [
      "google",
      { USER_SIM_MODEL: "gemini/gemini-2.5-pro", GEMINI_API_KEY: "k" },
      "google",
      ["GEMINI_API_KEY", "USER_SIM_MODEL"],
    ],
    [
      "litellm",
      { USER_SIM_MODEL: "proxy/any", LITELLM_BASE_URL: "http://127.0.0.1:4000", LITELLM_API_KEY: "k" },
      "litellm",
      ["LITELLM_API_KEY", "LITELLM_BASE_URL", "USER_SIM_MODEL"],
    ],
    [
      "ollama",
      { USER_SIM_MODEL: "ollama/llama3.1", OLLAMA_API_BASE: "http://127.0.0.1:11434" },
      "ollama",
      ["OLLAMA_API_BASE", "USER_SIM_MODEL"],
    ],
  ];

  for (const [, env, provider, keys] of cases) {
    const auth = selectUserSimulatorAuth(env);
    assert.equal(auth.provider, provider);
    assert.deepEqual(Object.keys(auth.variables).sort(), [...keys].sort());
  }

  assert.throws(() => selectUserSimulatorAuth({}), SmokeError);
  assert.throws(() => selectUserSimulatorAuth({ USER_SIM_MODEL: "anthropic/claude-x" }), /ANTHROPIC_API_KEY/);
  assert.throws(() => selectUserSimulatorAuth({ USER_SIM_MODEL: "openai/gpt-4o" }), /OPENAI_API_KEY/);
  assert.throws(() => selectUserSimulatorAuth({ USER_SIM_MODEL: "gemini/x" }), /GEMINI_API_KEY|GOOGLE_API_KEY/);
  assert.throws(
    () => selectUserSimulatorAuth({ USER_SIM_MODEL: "proxy/any", LITELLM_BASE_URL: "http://x" }),
    /LITELLM_API_KEY/,
  );
  assert.throws(() => selectUserSimulatorAuth({ USER_SIM_MODEL: "mystery/model" }), /provider/i);

  // The error names the missing variable but never a value that is present.
  assert.throws(
    () => selectUserSimulatorAuth({ USER_SIM_MODEL: "anthropic/claude-x", OPENAI_API_KEY: "leak-me" }),
    (error: unknown) => error instanceof SmokeError && !error.message.includes("leak-me"),
  );
});

test("accepts system-agent authentication from the environment or a silent probe", async () => {
  assert.deepEqual(selectSystemAgentAuth({ ...BASE_ENV, ANTHROPIC_API_KEY: "k" }), { ANTHROPIC_API_KEY: "k" });
  assert.deepEqual(selectSystemAgentAuth({ CLAUDE_CODE_OAUTH_TOKEN: "t" }), { CLAUDE_CODE_OAUTH_TOKEN: "t" });
  assert.deepEqual(
    selectSystemAgentAuth({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t", OPENAI_API_KEY: "no" }),
    { ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t" },
  );
  assert.equal(selectSystemAgentAuth({ OPENAI_API_KEY: "no" }), null);
});

test("builds the safe official environment without any model variable", () => {
  const env = buildSafeOfficialEnv({
    adkDir: "/adk",
    postgresPort: 55_432,
    baseEnv: { ...BASE_ENV, ANTHROPIC_API_KEY: "leak", USER_SIM_MODEL: "leak", OPENAI_BASE_URL: "leak" },
  });

  assert.deepEqual(Object.keys(env).sort(), SAFE_OFFICIAL_KEYS);
  assert.deepEqual(
    { ...env, PATH: undefined, HOME: undefined, TMPDIR: undefined, LANG: undefined, LC_ALL: undefined, NO_PROXY: undefined, no_proxy: undefined },
    {
      PATH: undefined, HOME: undefined, TMPDIR: undefined, LANG: undefined, LC_ALL: undefined,
      NO_PROXY: undefined, no_proxy: undefined,
      PYTHONPATH: "/adk",
      PYTHON_DOTENV_DISABLED: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      DATASET: "lite",
      PG_HOST: "127.0.0.1",
      PG_PORT: "55432",
      PG_USER: "root",
      PG_PASSWORD: "123123",
      SYSTEM_AGENT_PORT: String(BIRD_SERVICE_PORTS.system_agent),
      USER_SIM_PORT: String(BIRD_SERVICE_PORTS.user_simulator),
      DB_ENV_PORT: String(BIRD_SERVICE_PORTS.db_environment),
      PATIENCE: "3",
    },
  );
  for (const key of SECRET_KEYS) assert.equal(env[key], undefined);
});

test("snapshots the complete official and Warble process plan", () => {
  const context = planContext();
  const plan = buildProcessPlan(context);
  assert.deepEqual(plan.map((record) => record.id), [
    "compile",
    "adapter-build",
    "db-environment",
    "user-simulator",
    "oracle",
    "system-agent",
    "a-interact",
  ]);

  const byId = planById(context);
  const adk = context.adkDir;
  const venvPython = `${adk}/.venv/bin/python`;
  const run = context.runDir;

  assert.deepEqual(byId.get("compile"), {
    id: "compile",
    exe: "cargo",
    argv: ["run", "--locked", "-p", "warble-cli", "--", "compile", "eval/bird-interact/agents/baseline", "-o", `${run}/agent-ir.json`],
    cwd: "/repo",
    env: { ...BASE_ENV },
    envKeys: Object.keys(BASE_ENV).sort(),
    log: `${run}/logs/compile.log`,
    output: `${run}/agent-ir.json`,
  });

  assert.deepEqual(byId.get("adapter-build")?.argv, ["run", "build"]);
  assert.equal(byId.get("adapter-build")?.exe, "npm");
  assert.equal(byId.get("adapter-build")?.cwd, "/repo/eval/bird-interact");
  assert.deepEqual(byId.get("adapter-build")?.envKeys, Object.keys(BASE_ENV).sort());

  assert.deepEqual(byId.get("db-environment"), {
    id: "db-environment",
    exe: venvPython,
    argv: ["-m", "uvicorn", "db_environment.server:app", "--host", "127.0.0.1", "--port", "6002", "--log-level", "warning"],
    cwd: adk,
    env: buildSafeOfficialEnv({ adkDir: adk, postgresPort: 55_432, baseEnv: { ...BASE_ENV } }),
    envKeys: SAFE_OFFICIAL_KEYS,
    log: `${run}/logs/db-environment.log`,
  });

  const userSimulator = byId.get("user-simulator");
  assert.equal(userSimulator?.exe, venvPython);
  assert.deepEqual(userSimulator?.argv, [
    "-m", "uvicorn", "user_simulator.server:app", "--host", "127.0.0.1", "--port", "6001", "--log-level", "warning",
  ]);
  assert.deepEqual(userSimulator?.envKeys, [...SAFE_OFFICIAL_KEYS, "ANTHROPIC_API_KEY", "USER_SIM_MODEL"].sort());
  assert.equal(userSimulator?.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(userSimulator?.log, `${run}/logs/user-simulator.log`);

  assert.deepEqual(byId.get("oracle"), {
    id: "oracle",
    exe: venvPython,
    argv: [
      "-m", "orchestrator.runner",
      "--mode", "oracle",
      "--data", `/repo/eval/bird-interact/data/runtime/${SMOKE_FILENAME}`,
      "--concurrency", "1",
      "--output", `${run}/oracle.json`,
    ],
    cwd: adk,
    env: buildSafeOfficialEnv({ adkDir: adk, postgresPort: 55_432, baseEnv: { ...BASE_ENV } }),
    envKeys: SAFE_OFFICIAL_KEYS,
    log: `${run}/logs/oracle.log`,
    output: `${run}/oracle.json`,
  });

  const systemAgent = byId.get("system-agent");
  assert.equal(systemAgent?.exe, "node");
  assert.deepEqual(systemAgent?.argv, [
    "/repo/eval/bird-interact/dist/cli.js",
    "--ir", `${run}/agent-ir.json`,
    "--wren-project-root", "/repo/eval/bird-interact/data/runtime/identity-projects",
    "--model", DEFAULT_SYSTEM_MODEL,
    "--user-simulator-url", "http://127.0.0.1:6001",
    "--db-environment-url", "http://127.0.0.1:6002",
    "--out", `${run}/traces`,
    "--port", "6000",
    "--wren-bin", "/opt/wren/bin/wren",
  ]);
  assert.equal(systemAgent?.cwd, "/repo");
  assert.deepEqual(systemAgent?.envKeys, [...Object.keys(BASE_ENV), "CLAUDE_CODE_OAUTH_TOKEN"].sort());
  assert.equal(systemAgent?.env.USER_SIM_MODEL, undefined);
  assert.equal(systemAgent?.env.PG_PASSWORD, undefined);

  const interact = byId.get("a-interact");
  assert.deepEqual(interact?.argv, [
    "-m", "orchestrator.runner",
    "--mode", "a-interact",
    "--data", `/repo/eval/bird-interact/data/runtime/${SMOKE_FILENAME}`,
    "--concurrency", "1",
    "--output", `${run}/a-interact.json`,
  ]);
  assert.deepEqual(interact?.envKeys, SAFE_OFFICIAL_KEYS);
  assert.equal(interact?.output, `${run}/a-interact.json`);

  // Only the user simulator and system agent ever see model credentials.
  for (const record of buildProcessPlan(context)) {
    if (record.id === "user-simulator" || record.id === "system-agent") continue;
    for (const key of SECRET_KEYS) assert.equal(record.env[key], undefined, `${record.id} must not receive ${key}`);
  }
});

test("omits the port-6000 processes entirely in oracle-only mode", () => {
  const plan = buildProcessPlan(planContext({ oracleOnly: true, systemAgentEnv: {} }));
  assert.deepEqual(plan.map((record) => record.id), [
    "compile",
    "adapter-build",
    "db-environment",
    "user-simulator",
    "oracle",
  ]);
  for (const record of plan) {
    assert.ok(!record.argv.includes("a-interact"));
    assert.ok(!record.argv.includes(String(BIRD_SERVICE_PORTS.system_agent)));
  }
});

test("accepts only Python 3.10 through 3.12", () => {
  assert.deepEqual(parsePythonVersion("Python 3.11.15\n"), { major: 3, minor: 11, patch: 15 });
  assert.deepEqual(parsePythonVersion("3.10.14"), { major: 3, minor: 10, patch: 14 });
  assert.throws(() => parsePythonVersion("not a version"), SmokeError);

  for (const supported of ["3.10.0", "3.11.15", "3.12.7"]) {
    assert.equal(requireSupportedPython(parsePythonVersion(supported), "--python-bin").minor >= 10, true);
  }
  for (const unsupported of ["3.9.18", "3.13.0", "3.14.0", "2.7.18"]) {
    assert.throws(() => requireSupportedPython(parsePythonVersion(unsupported), "--python-bin"), /3\.10/);
  }
});

test("rejects an oracle result that is incomplete, misidentified, or failed", () => {
  const passing = {
    metrics: { total_tasks: SMOKE_TASK_IDS.length },
    results: SMOKE_TASK_IDS.map((id: string) => ({ task_id: id, phase1_passed: true, phase2_passed: true })),
  };
  assert.deepEqual(summarizeOracleResult(passing, SMOKE_TASK_IDS).taskIds, [...SMOKE_TASK_IDS]);

  /** Replaces the first row so every rejection keeps the official row count intact. */
  const withFirst = (patch: Record<string, unknown>) =>
    ({ ...passing, results: [{ ...passing.results[0], ...patch }, ...passing.results.slice(1)] });

  const broken: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ["error field", withFirst({ error: "boom" }), /error/i],
    ["wrong count", { metrics: { total_tasks: 2 }, results: passing.results.slice(0, 2) }, /exactly \d+ tasks/i],
    ["wrong ids", withFirst({ task_id: "alien_99" }), /alien_1/],
    ["failed phase 1", withFirst({ phase1_passed: false }), /phase/i],
    ["failed phase 2", withFirst({ phase2_passed: false }), /phase/i],
    ["not an object", [], /oracle/i],
  ];
  for (const [, value, expected] of broken) {
    assert.throws(() => summarizeOracleResult(value, SMOKE_TASK_IDS), expected);
  }
});

/**
 * Completion order is not task order, and above `--concurrency 1` it is not even stable.
 *
 * The official runner appends each result as its task finishes, so a concurrent run writes the same
 * five rows in whatever order they landed. Reading that as "the wrong tasks" would fail a healthy
 * measurement and, worse, blame the task ids for a scheduling detail. What still has to hold is
 * membership: exactly the expected tasks, once each — a duplicated row is one task measured twice
 * and another never measured at all, which no ordering explains.
 */
test("a result file is read by membership, not by the order tasks happened to finish in", () => {
  const row = (id: string) => ({ task_id: id, phase1_passed: true, phase2_passed: true });
  const shuffled = [...SMOKE_TASK_IDS].reverse();
  assert.deepEqual(
    summarizeOracleResult(
      { metrics: { total_tasks: SMOKE_TASK_IDS.length }, results: shuffled.map(row) },
      SMOKE_TASK_IDS,
    ).taskIds,
    shuffled,
  );

  // The same five rows, except one task is measured twice and another never at all.
  const duplicated = [...SMOKE_TASK_IDS.slice(1), ...SMOKE_TASK_IDS.slice(1, 2)];
  assert.throws(
    () =>
      summarizeOracleResult(
        { metrics: { total_tasks: SMOKE_TASK_IDS.length }, results: duplicated.map(row) },
        SMOKE_TASK_IDS,
      ),
    /once each/,
  );
});

test("accepts zero-reward a-interact results but requires one error-free row per task", () => {
  const zeroReward = {
    metrics: { total_tasks: SMOKE_TASK_IDS.length },
    results: SMOKE_TASK_IDS.map((id: string) => ({ task_id: id, reward: 0 })),
  };
  assert.deepEqual(summarizeInteractResult(zeroReward, SMOKE_TASK_IDS).taskIds, [...SMOKE_TASK_IDS]);

  assert.throws(
    () => summarizeInteractResult({
      ...zeroReward,
      results: [{ task_id: SMOKE_TASK_IDS[0], error: "x" }, ...zeroReward.results.slice(1)],
    }, SMOKE_TASK_IDS),
    /error/i,
  );
  assert.throws(
    () => summarizeInteractResult({
      metrics: { total_tasks: SMOKE_TASK_IDS.length },
      results: zeroReward.results.slice(0, 2),
    }, SMOKE_TASK_IDS),
    /exactly \d+ tasks/i,
  );
});

test("fails on an occupied port without touching its owner", async (t) => {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const port = address.port;
  t.after(() => new Promise<void>((closed) => server.close(() => closed())));

  await assert.rejects(verifyFreePorts([port]), (error: unknown) =>
    error instanceof SmokeError && error.message.includes(String(port)));
  assert.ok(server.listening, "the existing listener must never be killed");

  // A free port passes.
  const free = createServer();
  await new Promise<void>((ready) => free.listen(0, "127.0.0.1", ready));
  const freeAddress = free.address();
  assert.ok(freeAddress !== null && typeof freeAddress === "object");
  const freePort = freeAddress.port;
  await new Promise<void>((closed) => free.close(() => closed()));
  await verifyFreePorts([freePort]);
});

test("PYTHONDONTWRITEBYTECODE keeps the official source tree free of bytecode", async (t) => {
  const python = await findSystemPython();
  if (python === null) {
    t.skip("no python3 interpreter on PATH");
    return;
  }
  const root = await makeTempRoot(t);
  const adk = join(root, "BIRD-Interact-ADK");
  await mkdir(join(adk, "shared"), { recursive: true });
  await writeFile(join(adk, "shared", "__init__.py"), "", "utf8");
  await writeFile(join(adk, "shared", "config.py"), "VALUE = 1\n", "utf8");

  const env = buildSafeOfficialEnv({ adkDir: adk, postgresPort: 55_432, baseEnv: { ...BASE_ENV, PATH: process.env.PATH ?? "" } });
  await execFileAsync(python, ["-c", "import shared.config; assert shared.config.VALUE == 1"], { cwd: adk, env });

  const shared = await readdir(join(adk, "shared"));
  assert.ok(!shared.includes("__pycache__"), `unexpected bytecode: ${shared.join(", ")}`);
});

test("PYTHON_DOTENV_DISABLED stops ancestor .env discovery from a nested cwd", async (t) => {
  const python = await findSystemPython();
  if (python === null) {
    t.skip("no python3 interpreter on PATH");
    return;
  }
  if (!(await hasDotenv(python))) {
    t.skip("python-dotenv is not installed for the probe interpreter");
    return;
  }

  const root = await makeTempRoot(t);
  const adk = join(root, "BIRD-Interact-ADK");
  const nested = join(adk, "orchestrator");
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, ".env"), "WARBLE_SENTINEL=leaked\n", "utf8");

  const probe = "import os,dotenv;dotenv.load_dotenv();print(os.environ.get('WARBLE_SENTINEL','<absent>'))";
  const env = buildSafeOfficialEnv({ adkDir: adk, postgresPort: 55_432, baseEnv: { ...BASE_ENV, PATH: process.env.PATH ?? "" } });
  const disabled = await execFileAsync(python, ["-c", probe], { cwd: nested, env });
  assert.equal(disabled.stdout.trim(), "<absent>");

  const withoutGuard = { ...env };
  delete withoutGuard.PYTHON_DOTENV_DISABLED;
  const enabled = await execFileAsync(python, ["-c", probe], { cwd: nested, env: withoutGuard });
  assert.equal(enabled.stdout.trim(), "leaked", "the sentinel proves the probe would otherwise load it");
});

/**
 * `PYTHON_DOTENV_DISABLED` is all that stands between an official process — launched with an
 * allowlisted environment holding no credential at all — and an ancestor `.env` holding real ones,
 * so startup refuses to run against a python-dotenv that ignores it. That refusal is worth exactly
 * as much as the probe's ability to report a leak, and this asserts the probe can report one: the
 * second call IS the leak, and a probe that cannot produce it proves nothing about the first.
 *
 * This drives the launcher's own `probeDotenv` rather than a copy of it, because the two defects it
 * replaces both lived in how the launcher CALLED the probe, not in the script it ran.
 */
test("the dotenv probe can print the leak it exists to catch", async (t) => {
  const python = await findSystemPython();
  if (python === null) {
    t.skip("no python3 interpreter on PATH");
    return;
  }
  if (!(await hasDotenv(python))) {
    t.skip("python-dotenv is not installed for the probe interpreter");
    return;
  }

  const root = await makeTempRoot(t);
  const env = buildSafeOfficialEnv({
    adkDir: join(root, ADK_RELATIVE_PATH),
    postgresPort: 55_432,
    baseEnv: { ...BASE_ENV, PATH: process.env.PATH ?? "" },
  });

  const guarded = await probeDotenv(python, env, defaultCapture);
  assert.equal(guarded.code, 0, guarded.stderr);
  assert.equal(guarded.stdout.trim(), DOTENV_PROBE.absent);

  const unguarded = { ...env };
  delete unguarded.PYTHON_DOTENV_DISABLED;
  const leaked = await probeDotenv(python, unguarded, defaultCapture);
  assert.equal(leaked.code, 0, leaked.stderr);
  assert.equal(
    leaked.stdout.trim(),
    DOTENV_PROBE.leaked,
    "a probe that cannot print the leaked value can only ever report a pass",
  );
});

/**
 * The two halves the probe needs to be able to fail at all, asserted where the launcher builds them.
 *
 * `load_dotenv` reads the first `.env` it finds walking UP from the interpreter's directory, and
 * `override=False` — its default — skips every key already in `os.environ`. So a probe with no
 * `.env` on that path, or one whose key the launcher pre-set (even to ""), reports "not loaded"
 * against any python-dotenv ever released, including one predating the flag entirely.
 *
 * The `.env` is a temporary tree the probe owns: preflight refuses to run at all if one exists
 * inside the pinned checkout, so the check may not create one there even for a moment.
 */
test("the launcher probes the pinned interpreter against a real .env it then removes", async (t) => {
  const root = await makeTempRoot(t);
  const paths = smokePaths(join(root, "pkg"));
  const venvPython = join(paths.adkDir, ".venv", "bin", "python");
  await mkdir(join(paths.adkDir, ".venv", "bin"), { recursive: true });
  await writeFile(venvPython, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
  await writeFile(join(paths.adkDir, "requirements.txt"), "uvicorn\n", "utf8");

  const calls: Array<{ readonly cwd: string; readonly env: EnvRecord; readonly dotenvFile: string | null }> = [];
  const capture = (printed: string): CommandCapture => async (_exe, argv, options) => {
    if (argv[0] !== "-c") return { code: 0, stdout: "Python 3.11.15\n", stderr: "" };
    if (argv[1] !== DOTENV_PROBE.script) return { code: 0, stdout: "", stderr: "" };
    const cwd = options.cwd ?? "";
    calls.push({
      cwd,
      env: options.env,
      dotenvFile: await readFile(join(dirname(cwd), ".env"), "utf8").catch(() => null),
    });
    return { code: 0, stdout: `${printed}\n`, stderr: "" };
  };
  const config = { oracleOnly: true, wrenBin: "wren", pythonBin: "python3.11", systemModel: DEFAULT_SYSTEM_MODEL, concurrency: DEFAULT_CONCURRENCY, profile: PROFILE_DIRECTORY };

  await preparePythonEnvironment({
    config,
    paths,
    baseEnv: { ...BASE_ENV },
    postgresPort: 55_432,
    capture: capture(DOTENV_PROBE.absent),
  });

  const probe = calls[0];
  assert.ok(probe !== undefined, "the launcher must probe the interpreter the services will run on");
  assert.ok(
    !(DOTENV_PROBE.key in probe.env),
    "load_dotenv(override=False) skips a key already in os.environ, so the probe must not pre-set it",
  );
  assert.equal(
    probe.dotenvFile,
    `${DOTENV_PROBE.key}=${DOTENV_PROBE.leaked}\n`,
    "with nothing to load on the search path the probe reports a pass whatever python-dotenv does",
  );
  assert.ok(
    (await lstat(probe.cwd).catch(() => null)) === null,
    "the probe tree does not outlive the probe",
  );
  assert.ok(
    (await lstat(join(paths.adkDir, ".env")).catch(() => null)) === null,
    "and never lands inside the official checkout, where preflight forbids one",
  );

  await assert.rejects(
    preparePythonEnvironment({
      config,
      paths,
      baseEnv: { ...BASE_ENV },
      postgresPort: 55_432,
      capture: capture(DOTENV_PROBE.leaked),
    }),
    /python-dotenv/i,
  );
});

async function findSystemPython(): Promise<string | null> {
  for (const candidate of ["python3.11", "python3.12", "python3.10", "python3"]) {
    try {
      await execFileAsync(candidate, ["--version"]);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

async function hasDotenv(python: string): Promise<boolean> {
  try {
    await execFileAsync(python, ["-c", "import dotenv"]);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Preflight and orchestration                                                */
/* -------------------------------------------------------------------------- */

function manifestFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const smokeText = SMOKE_TASK_IDS.map((id: string) => JSON.stringify({ instance_id: id })).join("\n") + "\n";
  const mdlText = `${JSON.stringify({ catalog: "wren", schema: "public", models: [], relationships: [], views: [] }, null, 2)}\n`;
  return {
    version: 1,
    createdAt: "2026-08-24T12:00:00.000Z",
    official: { repository: "https://github.com/bird-bench/BIRD-Interact.git", commit: "4".repeat(40) },
    publicSnapshot: { repository: "https://huggingface.co/datasets/birdsql/bird-interact-lite", commit: "5".repeat(40), fileCount: 57, manifestSha256: "6".repeat(64) },
    groundTruth: { file: "private/gt.jsonl", sha256: "7".repeat(64) },
    outputs: {
      combined: { file: "runtime/bird_interact_data_with_gt.jsonl", rows: 300, sha256: "8".repeat(64) },
      smoke: { file: `runtime/${SMOKE_FILENAME}`, rows: SMOKE_TASK_IDS.length, sha256: sha256Text(smokeText) },
      mdl: { file: "runtime/identity-projects/alien/target/mdl.json", sha256: sha256Text(mdlText) },
    },
    database: { name: "alien", template: "alien_template", container: "warble_bird_interact_postgresql", hostPort: 55_432, imageReference: "docker.io/shawnxxh/bird-interact-postgresql:latest", imageId: `sha256:${"9".repeat(64)}`, repoDigests: [] },
    wren: { version: "0.8.1" },
    taskIds: [...SMOKE_TASK_IDS],
    ...overrides,
  };
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

interface PreparedRoot {
  readonly paths: ReturnType<typeof smokePaths>;
  readonly manifest: Record<string, unknown>;
}

async function makePreparedRoot(t: TestContext): Promise<PreparedRoot> {
  const root = await makeTempRoot(t);
  const packageDir = join(root, "pkg");
  const paths = smokePaths(packageDir);
  const manifest = manifestFor();
  const smokeText = SMOKE_TASK_IDS.map((id: string) => JSON.stringify({ instance_id: id })).join("\n") + "\n";
  const mdlText = `${JSON.stringify({ catalog: "wren", schema: "public", models: [], relationships: [], views: [] }, null, 2)}\n`;

  await mkdir(join(paths.runtimeDir, "identity-projects", "alien", "target"), { recursive: true });
  await writeFile(join(paths.runtimeDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(paths.runtimeDir, SMOKE_FILENAME), smokeText, "utf8");
  await writeFile(join(paths.runtimeDir, "identity-projects", "alien", "target", "mdl.json"), mdlText, "utf8");
  await mkdir(paths.profileDir, { recursive: true });
  await writeFile(join(paths.profileDir, "profile.yml"), "profile: bird-interact-a-interact\n", "utf8");
  await mkdir(join(paths.dataRoot, "private"), { recursive: true, mode: 0o700 });
  await writeFile(join(paths.dataRoot, "private", GT_FILENAME), "{}\n", { encoding: "utf8", mode: 0o600 });
  await mkdir(join(paths.cacheDir, "bird-interact-lite"), { recursive: true });
  await mkdir(paths.adkDir, { recursive: true });
  await symlink("../../bird-interact-lite", join(paths.adkDir, "bird-interact-lite"));
  return { paths, manifest };
}

function preflightOptions(prepared: PreparedRoot, overrides: Record<string, unknown> = {}): Parameters<typeof preflight>[0] {
  return {
    paths: prepared.paths,
    config: { oracleOnly: true, wrenBin: "wren", pythonBin: "python3.11", systemModel: DEFAULT_SYSTEM_MODEL, concurrency: DEFAULT_CONCURRENCY, profile: PROFILE_DIRECTORY },
    verifySnapshot: async () => ({
      path: join(prepared.paths.cacheDir, "bird-interact-lite"),
      repository: "https://huggingface.co/datasets/birdsql/bird-interact-lite" as never,
      commit: "5".repeat(40) as never,
      fileCount: 57 as never,
      manifestSha256: "6".repeat(64),
    }),
    checkPorts: async () => {},
    dryPlan: async () => {},
    ...overrides,
  } as Parameters<typeof preflight>[0];
}

test("preflight accepts an intact prepared tree and rejects every drifted input", async (t) => {
  const intact = await makePreparedRoot(t);
  const result = await preflight(preflightOptions(intact));
  assert.equal(result.manifest.database.hostPort, 55_432);

  await t.test("changed public metadata fails before any service starts", async (subtest) => {
    const prepared = await makePreparedRoot(subtest);
    let ports = 0;
    await assert.rejects(
      preflight(preflightOptions(prepared, {
        verifySnapshot: async () => ({
          path: "",
          repository: "https://huggingface.co/datasets/birdsql/bird-interact-lite",
          commit: "5".repeat(40),
          fileCount: 57,
          manifestSha256: "0".repeat(64),
        }),
        checkPorts: async () => { ports += 1; },
      })),
      /public snapshot changed/i,
    );
    assert.equal(ports, 0, "ports are only checked after the snapshot matches");
  });

  await t.test("an ADK-local .env is rejected before spawn", async (subtest) => {
    const prepared = await makePreparedRoot(subtest);
    await writeFile(join(prepared.paths.adkDir, ".env"), "SECRET=1\n", "utf8");
    await assert.rejects(preflight(preflightOptions(prepared)), /\.env file inside the official checkout/i);
  });

  await t.test("a missing manifest, drifted smoke file, or broken link fails", async (subtest) => {
    const noManifest = await makePreparedRoot(subtest);
    await rm(join(noManifest.paths.runtimeDir, "manifest.json"));
    await assert.rejects(preflight(preflightOptions(noManifest)), /manifest\.json is missing/i);

    const drifted = await makePreparedRoot(subtest);
    await writeFile(join(drifted.paths.runtimeDir, SMOKE_FILENAME), "{}\n{}\n{}\n", "utf8");
    await assert.rejects(preflight(preflightOptions(drifted)), /does not match the recorded manifest hash/i);

    const unlinked = await makePreparedRoot(subtest);
    await rm(join(unlinked.paths.adkDir, "bird-interact-lite"));
    await assert.rejects(preflight(preflightOptions(unlinked)), /public-data link/i);

    const noGt = await makePreparedRoot(subtest);
    await rm(join(noGt.paths.dataRoot, "private", GT_FILENAME));
    await assert.rejects(preflight(preflightOptions(noGt)), /ground truth/i);
  });

  // The run directory is named from a manifest read before preflight, so preflight has to prove the
  // tree it is about to measure is still the database that directory belongs to. Without this, a
  // runtime re-prepared for another database would be scored into the previous database's run.
  await t.test("a runtime prepared for another database is refused", async (subtest) => {
    const prepared = await makePreparedRoot(subtest);
    const polarPaths = { ...prepared.paths, database: "polar" };
    await assert.rejects(
      preflight(preflightOptions({ ...prepared, paths: polarPaths })),
      /holds the alien database, not polar/i,
    );

    // ...and a manifest naming the right database but the wrong task set is refused too.
    const wrongTasks = await makePreparedRoot(subtest);
    const manifest = { ...wrongTasks.manifest, taskIds: ["alien_1", "alien_2", "alien_3"] };
    await writeFile(
      join(wrongTasks.paths.runtimeDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await assert.rejects(preflight(preflightOptions(wrongTasks)), /scoped to alien_1, alien_2, alien_3/i);
  });
});

test("a profile other than the baseline is compiled from its own directory, into its own run", async (t) => {
  const packageDir = "/repo/eval/bird-interact";

  // The default and an explicit `--profile agent` are the same thing: the baseline, unlabelled, in
  // the run directory it has always used.
  for (const requested of [PROFILE_DIRECTORY, `${packageDir}/${PROFILE_DIRECTORY}`]) {
    const baseline = await resolveProfile(packageDir, requested);
    assert.deepEqual(baseline, baselineProfile(packageDir));
    assert.equal(baseline.label, null);
    assert.equal(smokePaths(packageDir, DEFAULT_SMOKE_DATABASE, baseline).runDir, `${packageDir}/data/runs/alien-5`);
  }

  const mine = await resolveProfile(packageDir, "agents/greedy");
  assert.deepEqual(mine, { dir: `${packageDir}/agents/greedy`, label: "greedy" });

  // Its run lands beside the baseline's rather than archiving it, which is what makes the two
  // readable together -- `just report-bird-eval alien-5 alien-5-greedy`.
  const paths = smokePaths(packageDir, DEFAULT_SMOKE_DATABASE, mine);
  assert.equal(paths.runDir, `${packageDir}/data/runs/alien-5-greedy`);
  assert.equal(paths.profileDir, `${packageDir}/agents/greedy`);
  assert.notEqual(paths.runDir, smokePaths(packageDir).runDir);

  // And it is that directory `warble-cli compile` is pointed at, relative to the Warble root.
  const compile = planById(planContext({ profileDir: `${packageDir}/agents/greedy` })).get("compile");
  assert.deepEqual(compile?.argv, [
    "run", "--locked", "-p", "warble-cli", "--", "compile", "eval/bird-interact/agents/greedy",
    "-o", `/repo/eval/bird-interact/data/${RUN_DIRECTORY}/agent-ir.json`,
  ]);

  // Two refusals, both about a run staying attributable. Outside the repository there is no tree a
  // run is reproducible from; a name that cannot be a directory name cannot distinguish the run.
  await assert.rejects(resolveProfile(packageDir, "/elsewhere/agent"), CliUsageError);
  await assert.rejects(resolveProfile(packageDir, "../../../outside"), CliUsageError);
  await assert.rejects(resolveProfile(packageDir, "agents/My_Agent"), CliUsageError);
  await assert.rejects(resolveProfile(packageDir, "agents/-leading"), CliUsageError);

  // The repository root is one of those outsides. It is a directory rather than a profile, so
  // permitting it only postponed the refusal to a vaguer complaint about a missing profile.yml.
  await assert.rejects(resolveProfile(packageDir, "../.."), /inside the Warble repository/);
  t.diagnostic("resolveProfile refuses outside-the-repo, the root itself and unnameable profiles");
});

/**
 * Containment is a claim about where the profile really lives, so it is checked on the real path.
 *
 * The refusal exists because a finished run has to be reproducible from the tree it records, and a
 * lexical `resolve` + `startsWith` cannot decide that: an `agents/` entry that is a symlink out of
 * the repository reads as inside it. This is the one containment check in the package that used to
 * be lexical while `checkGatedOutputPath` resolved; both now share `realPathOfNearestExisting`.
 *
 * On a real tree rather than the string paths above -- macOS puts the temporary root behind
 * `/var` -> `/private/var`, which is exactly the kind of link both sides of every comparison here
 * have to be resolved through before they mean anything.
 */
test("--profile containment sees through a symlink out of the repository", async (t) => {
  const root = await makeTempRoot(t);
  const packageDir = join(root, "repo", "eval", "bird-interact");
  await mkdir(join(packageDir, PROFILE_DIRECTORY), { recursive: true });
  await mkdir(join(packageDir, "agents", "greedy"), { recursive: true });
  await mkdir(join(root, "outside", "agent"), { recursive: true });

  // Lexically inside the repository, really outside it.
  await symlink(join(root, "outside", "agent"), join(packageDir, "agents", "elsewhere"));
  await assert.rejects(
    resolveProfile(packageDir, "agents/elsewhere"),
    /inside the Warble repository/,
    "a link pointing out of the tree is not a profile the run can be reproduced from",
  );

  // A link that resolves INSIDE the tree is not refused here: this check is about where the source
  // lives, not about links, and what comes back is the path as it was typed -- the label a run
  // directory is scoped by is the name the runbook names. preflight's `lstat` is what then insists
  // on real source, so the link is refused one step later and never compiles under another name.
  await symlink(join(packageDir, "agents", "greedy"), join(packageDir, "agents", "inside"));
  assert.deepEqual(await resolveProfile(packageDir, "agents/inside"), {
    dir: join(packageDir, "agents", "inside"),
    label: "inside",
  });

  // The short-circuit still holds through a real tree, by the resolved path on both sides: the
  // baseline keeps its null label, and with it the `runs/alien-5` directory every run recorded
  // before the baseline had a name of its own is still addressed by.
  for (const requested of [PROFILE_DIRECTORY, `agents/../${PROFILE_DIRECTORY}`, join(packageDir, PROFILE_DIRECTORY)]) {
    const baseline = await resolveProfile(packageDir, requested);
    assert.deepEqual(baseline, baselineProfile(packageDir));
    assert.equal(baseline.label, null);
  }

  // ...and an ordinary profile beside it still resolves to its own label.
  assert.deepEqual(await resolveProfile(packageDir, "agents/greedy"), {
    dir: join(packageDir, "agents", "greedy"),
    label: "greedy",
  });

  // The repository root, refused on a tree that exists as well as on the string paths above.
  await assert.rejects(resolveProfile(packageDir, "../.."), /inside the Warble repository/);
  t.diagnostic("containment is decided on the real path, and the baseline still carries no label");
});

test("preflight proves the profile exists before anything is started", async (t) => {
  const prepared = await makePreparedRoot(t);

  // The baseline the fixture wrote is accepted.
  await preflight(preflightOptions(prepared));

  const missing = { ...prepared, paths: { ...prepared.paths, profileDir: join(prepared.paths.packageDir, "agents", "absent") } };
  await assert.rejects(preflight(preflightOptions(missing)), /does not exist/i);

  // A directory that exists but is not a profile is the likelier mistake: a copied `components/`
  // without the `profile.yml` that mounts it.
  const notAProfile = join(prepared.paths.packageDir, "agents", "empty");
  await mkdir(notAProfile, { recursive: true });
  const unmounted = { ...prepared, paths: { ...prepared.paths, profileDir: notAProfile } };
  await assert.rejects(preflight(preflightOptions(unmounted)), /no profile\.yml/i);

  // resolveProfile now resolves a link before it decides containment, but a link that resolves
  // INSIDE the tree clears that check and a dangling one resolves to nothing at all. The profile
  // has to be real source, so the link itself is refused rather than whatever it points at.
  const linked = join(prepared.paths.packageDir, "agents", "linked");
  await symlink(prepared.paths.profileDir, linked);
  const viaLink = { ...prepared, paths: { ...prepared.paths, profileDir: linked } };
  await assert.rejects(preflight(preflightOptions(viaLink)), /is not a directory/i);
});

test("every path and file name a run writes is derived from its database", () => {
  const alien = smokePaths("/pkg");
  const polar = smokePaths("/pkg", "polar");

  assert.equal(alien.database, DEFAULT_SMOKE_DATABASE);
  assert.equal(alien.runDir, "/pkg/data/runs/alien-5");
  assert.equal(polar.runDir, "/pkg/data/runs/polar-5");
  assert.equal(smokeFilename("polar"), "smoke-polar-5.jsonl");
  assert.deepEqual(smokeTaskIds("polar"), ["polar_1", "polar_2", "polar_3", "polar_4", "polar_5"]);

  // Two databases never share a run directory, which is what keeps a finished run readable after
  // the runtime tree has been re-prepared for the other one.
  assert.notEqual(alien.runDir, polar.runDir);

  // The official runner is handed the subset file for the database being measured, not a constant.
  const plan = buildProcessPlan(planContext({
    smokeFile: smokeFilename("polar"),
    runDir: "/repo/eval/bird-interact/data/runs/polar-5",
  }));
  const oracle = plan.find((item) => item.id === "oracle");
  assert.ok(oracle !== undefined);
  assert.ok(oracle.argv.includes("/repo/eval/bird-interact/data/runtime/smoke-polar-5.jsonl"));
});

test("a service that never listens fails with a deadline and its log path", async () => {
  const free = createServer();
  await new Promise<void>((ready) => free.listen(0, "127.0.0.1", ready));
  const address = free.address();
  assert.ok(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise<void>((closed) => free.close(() => closed()));

  await assert.rejects(
    waitForService(port, "/runs/alien-5/logs/db-environment.log", { timeoutMs: 5, sleep: async () => {} }),
    (error: unknown) =>
      error instanceof SmokeError &&
      error.message.includes("/runs/alien-5/logs/db-environment.log") &&
      error.message.includes(String(port)),
  );
});

test("an existing ADK virtualenv must match --python-bin and is never deleted", async (t) => {
  const root = await makeTempRoot(t);
  const packageDir = join(root, "pkg");
  const paths = smokePaths(packageDir);
  const venvPython = join(paths.adkDir, ".venv", "bin", "python");
  await mkdir(join(paths.adkDir, ".venv", "bin"), { recursive: true });
  await writeFile(venvPython, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
  await writeFile(join(paths.adkDir, "requirements.txt"), "uvicorn\n", "utf8");

  const capture = (versions: Record<string, string>) =>
    async (exe: string, argv: readonly string[]) => {
      if (argv[0] === "--version") return { code: 0, stdout: `Python ${versions[exe] ?? "3.11.15"}\n`, stderr: "" };
      if (argv.includes("-m") && argv.includes("venv")) throw new Error("must not rebuild an existing venv");
      if (argv[1] === "-m" || argv[0] === "-m") return { code: 0, stdout: "", stderr: "" };
      if (argv[0] === "-c") return { code: 0, stdout: "DISABLED", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };

  await assert.rejects(
    preparePythonEnvironment({
      config: { oracleOnly: true, wrenBin: "wren", pythonBin: "python3.11", systemModel: DEFAULT_SYSTEM_MODEL, concurrency: DEFAULT_CONCURRENCY, profile: PROFILE_DIRECTORY },
      paths,
      baseEnv: { ...BASE_ENV },
      postgresPort: 55_432,
      capture: capture({ "python3.11": "3.11.15", [venvPython]: "3.10.14" }),
    }),
    /move or rebuild/i,
  );
  assert.ok((await readdir(join(paths.adkDir, ".venv", "bin"))).includes("python"), "the venv must survive");
});

interface FakeSupervisor {
  readonly events: string[];
  readonly stopped: string[];
  readonly plans: ProcessRecord[];
  start: ProcessSupervisor["start"];
  run: ProcessSupervisor["run"];
}

function fakeSupervisor(runCodes: Partial<Record<string, number>> = {}): FakeSupervisor {
  const events: string[] = [];
  const stopped: string[] = [];
  const plans: ProcessRecord[] = [];
  return {
    events,
    stopped,
    plans,
    async start(item: ProcessRecord) {
      events.push(`start:${item.id}`);
      plans.push(item);
      return { id: item.id, async stop() { stopped.push(item.id); } };
    },
    async run(item: ProcessRecord) {
      events.push(`run:${item.id}`);
      plans.push(item);
      return runCodes[item.id] ?? 0;
    },
  };
}

function oracleJson(overrides: Record<string, unknown> = {}): unknown {
  return {
    metrics: { total_tasks: SMOKE_TASK_IDS.length },
    results: SMOKE_TASK_IDS.map((id: string) => ({ task_id: id, phase1_passed: true, phase2_passed: true })),
    ...overrides,
  };
}

function interactJson(): unknown {
  return {
    metrics: { total_tasks: SMOKE_TASK_IDS.length },
    results: SMOKE_TASK_IDS.map((id: string) => ({ task_id: id, reward: 0 })),
  };
}

async function runnerDeps(t: TestContext, overrides: Partial<Parameters<typeof runBirdSmoke>[1]> = {}) {
  const root = await makeTempRoot(t);
  const paths = smokePaths(join(root, "pkg"));
  const supervisor = overrides.supervisor ?? fakeSupervisor();
  return {
    paths,
    processEnv: { ...BASE_ENV, USER_SIM_MODEL: "anthropic/claude-sonnet-4-5-20250929", ANTHROPIC_API_KEY: "sk-user" },
    supervisor,
    preflight: async () => ({ manifest: manifestFor() as never, smokeText: "" }),
    pythonEnvironment: async () => ({
      pythonBin: "python3.11", requestedVersion: "3.11.15", venv: "/venv", venvPython: "/venv/bin/python",
      venvVersion: "3.11.15", requirementsSha256: "a".repeat(64), pipFreezeSha256: "b".repeat(64),
    }),
    waitForService: async () => {},
    readJson: async (path: string) => (path.endsWith("oracle.json") ? oracleJson() : interactJson()),
    listTraceTasks: async () => [...SMOKE_TASK_IDS],
    ...overrides,
  } as Parameters<typeof runBirdSmoke>[1];
}

test("oracle-only stops after a passing oracle without system-agent credentials or port 6000", async (t) => {
  const supervisor = fakeSupervisor();
  let probes = 0;
  const deps = await runnerDeps(t, {
    supervisor,
    probeSystemAgentAuth: async () => { probes += 1; return false; },
  });
  const summary = await runBirdSmoke(
    { oracleOnly: true, wrenBin: "wren", pythonBin: "python3.11", systemModel: DEFAULT_SYSTEM_MODEL, concurrency: DEFAULT_CONCURRENCY, profile: PROFILE_DIRECTORY },
    deps,
  );

  assert.equal(summary.oracleOnly, true);
  assert.equal(summary.interact, null);
  assert.deepEqual(summary.oracle.taskIds, [...SMOKE_TASK_IDS]);
  assert.equal(probes, 0, "system-agent authentication is never checked in oracle-only mode");
  assert.deepEqual(supervisor.events, [
    "run:compile",
    "run:adapter-build",
    "start:db-environment",
    "start:user-simulator",
    "run:oracle",
  ]);
  assert.ok(!supervisor.plans.some((item) => item.id === "system-agent"));
  assert.deepEqual(supervisor.stopped, ["user-simulator", "db-environment"]);
  assert.equal(
    JSON.parse(await readFile(join(deps.paths.runDir, "manifest.json"), "utf8")).version,
    1,
  );
});

test("a failed oracle blocks the system agent and still stops only owned children", async (t) => {
  const exitFailure = fakeSupervisor({ oracle: 1 });
  await assert.rejects(
    runBirdSmoke(
      { oracleOnly: false, wrenBin: "wren", pythonBin: "python3.11", systemModel: DEFAULT_SYSTEM_MODEL, concurrency: DEFAULT_CONCURRENCY, profile: PROFILE_DIRECTORY },
      await runnerDeps(t, { supervisor: exitFailure }),
    ),
    /oracle run failed/i,
  );
  assert.ok(!exitFailure.events.includes("start:system-agent"));
  assert.deepEqual(exitFailure.stopped, ["user-simulator", "db-environment"]);

  const phaseFailure = fakeSupervisor();
  await assert.rejects(
    runBirdSmoke(
      { oracleOnly: false, wrenBin: "wren", pythonBin: "python3.11", systemModel: DEFAULT_SYSTEM_MODEL, concurrency: DEFAULT_CONCURRENCY, profile: PROFILE_DIRECTORY },
      await runnerDeps(t, {
        supervisor: phaseFailure,
        readJson: async () => oracleJson({
          results: SMOKE_TASK_IDS.map((id: string, index: number) => ({
            task_id: id,
            phase1_passed: true,
            phase2_passed: index !== 0,
          })),
        }),
      }),
    ),
    /phase/i,
  );
  assert.ok(!phaseFailure.events.includes("start:system-agent"));
});

test("a complete a-interact run requires one result and one Warble trace per task", async (t) => {
  const supervisor = fakeSupervisor();
  const summary = await runBirdSmoke(
    { oracleOnly: false, wrenBin: "wren", pythonBin: "python3.11", systemModel: DEFAULT_SYSTEM_MODEL, concurrency: DEFAULT_CONCURRENCY, profile: PROFILE_DIRECTORY },
    await runnerDeps(t, { supervisor, processEnv: {
      ...BASE_ENV,
      USER_SIM_MODEL: "anthropic/claude-sonnet-4-5-20250929",
      ANTHROPIC_API_KEY: "sk-both",
    } }),
  );
  assert.deepEqual(summary.interact?.taskIds, [...SMOKE_TASK_IDS]);
  assert.deepEqual(supervisor.events, [
    "run:compile",
    "run:adapter-build",
    "start:db-environment",
    "start:user-simulator",
    "run:oracle",
    "start:system-agent",
    "run:a-interact",
  ]);
  assert.deepEqual(supervisor.stopped, ["system-agent", "user-simulator", "db-environment"]);

  const missingTraces = fakeSupervisor();
  await assert.rejects(
    runBirdSmoke(
      { oracleOnly: false, wrenBin: "wren", pythonBin: "python3.11", systemModel: DEFAULT_SYSTEM_MODEL, concurrency: DEFAULT_CONCURRENCY, profile: PROFILE_DIRECTORY },
      await runnerDeps(t, { supervisor: missingTraces, listTraceTasks: async () => ["alien_1", "alien_2"] }),
    ),
    /trace directory per task/i,
  );
  assert.deepEqual(missingTraces.stopped, ["system-agent", "user-simulator", "db-environment"]);
});

test("a missing system-agent credential fails before the model run", async (t) => {
  await assert.rejects(
    runBirdSmoke(
      { oracleOnly: false, wrenBin: "wren", pythonBin: "python3.11", systemModel: DEFAULT_SYSTEM_MODEL, concurrency: DEFAULT_CONCURRENCY, profile: PROFILE_DIRECTORY },
      await runnerDeps(t, {
        processEnv: { ...BASE_ENV, USER_SIM_MODEL: "ollama/llama3.1" },
        probeSystemAgentAuth: async () => false,
      }),
    ),
    /claude auth status/i,
  );
});

test("stopping an owned service kills its whole process group and nothing else", async (t) => {
  const root = await makeTempRoot(t);
  const pidFile = join(root, "grandchild.pid");

  const bystander = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  t.after(() => {
    try {
      if (bystander.pid !== undefined) process.kill(-bystander.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  });

  const handle = await createProcessSupervisor().start({
    id: "db-environment",
    exe: "sh",
    argv: ["-c", `sleep 300 & echo $! > '${pidFile}'; wait`],
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    envKeys: ["PATH"],
    log: join(root, "logs", "db-environment.log"),
  });

  let grandchild = 0;
  for (let attempt = 0; attempt < 100 && grandchild === 0; attempt += 1) {
    grandchild = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
    if (grandchild === 0) await new Promise((wake) => setTimeout(wake, 20));
  }
  assert.ok(grandchild > 0, "the grandchild pid file must appear");
  assert.doesNotThrow(() => process.kill(grandchild, 0), "the grandchild starts alive");

  await handle.stop();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(grandchild, 0);
    } catch {
      break;
    }
    await new Promise((wake) => setTimeout(wake, 20));
  }
  assert.throws(() => process.kill(grandchild, 0), "the whole group must be gone");
  assert.doesNotThrow(
    () => process.kill(bystander.pid ?? 0, 0),
    "an unregistered process must never be signalled",
  );
});

/**
 * A child that never starts emits `error`, and an `error` event with no listener is thrown from a
 * tick nothing awaits: the launcher died past `runBirdSmoke`'s cleanup, leaving every official
 * service it had already started detached on its port. A start that fails has to fail like any
 * other step, so the shutdown that stops what this launcher owns still runs.
 */
test("a child that cannot be spawned fails its start instead of killing the launcher", async (t) => {
  const root = await makeTempRoot(t);
  const log = join(root, "logs", "db-environment.log");

  await assert.rejects(
    createProcessSupervisor().start({
      id: "db-environment",
      exe: join(root, "not-an-executable"),
      argv: [],
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      envKeys: ["PATH"],
      log,
    }),
    (error: unknown) =>
      error instanceof SmokeError && error.message.includes("db-environment") && error.message.includes(log),
  );
});

/**
 * `report-simulator` counts every `LLM call failed` in `logs/user-simulator.log` and withholds a
 * run's scores entirely when the count is not zero. The log was opened for APPEND, so one run
 * against the documented-broken GPT-5 `temperature=0` setup voided every run that followed it until
 * the file was deleted by hand. A log file is the record of the process this run started.
 */
test("a child's log file holds this run's output and no earlier run's", async (t) => {
  const root = await makeTempRoot(t);
  const log = join(root, "logs", "user-simulator.log");
  await mkdir(dirname(log), { recursive: true });
  await writeFile(log, "LLM call failed\n", "utf8");

  const code = await createProcessSupervisor().run({
    id: "user-simulator",
    exe: "sh",
    argv: ["-c", "echo listening"],
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    envKeys: ["PATH"],
    log,
  });
  assert.equal(code, 0);

  let text = "";
  for (let attempt = 0; attempt < 100 && !text.includes("listening"); attempt += 1) {
    text = await readFile(log, "utf8");
    if (!text.includes("listening")) await new Promise((wake) => setTimeout(wake, 20));
  }
  assert.match(text, /listening/);
  assert.ok(!text.includes("LLM call failed"), `an earlier run's log line survived: ${text}`);
});

test("oracle-only runs with no model configuration at all", async (t) => {
  const supervisor = fakeSupervisor();
  const summary = await runBirdSmoke(
    { oracleOnly: true, wrenBin: "wren", pythonBin: "python3.11", systemModel: DEFAULT_SYSTEM_MODEL, concurrency: DEFAULT_CONCURRENCY, profile: PROFILE_DIRECTORY },
    await runnerDeps(t, { supervisor, processEnv: { ...BASE_ENV } }),
  );

  assert.deepEqual(summary.oracle.taskIds, [...SMOKE_TASK_IDS]);
  assert.equal(optionalUserSimulatorAuth({}), null);
  const userSimulator = supervisor.plans.find((item) => item.id === "user-simulator");
  assert.deepEqual(userSimulator?.envKeys, SAFE_OFFICIAL_KEYS, "no model variable is invented");

  // A full run still refuses to start without user-simulator credentials.
  await assert.rejects(
    runBirdSmoke(
      { oracleOnly: false, wrenBin: "wren", pythonBin: "python3.11", systemModel: DEFAULT_SYSTEM_MODEL, concurrency: DEFAULT_CONCURRENCY, profile: PROFILE_DIRECTORY },
      await runnerDeps(t, { supervisor: fakeSupervisor(), processEnv: { ...BASE_ENV } }),
    ),
    /USER_SIM_MODEL is required/,
  );
});

/* -------------------------------------------------------------------------- */
/* The run records its own user-simulator model                               */
/* -------------------------------------------------------------------------- */

/**
 * `report-cli` used to name the simulator by reading the CURRENT `data/private/.env`, so editing
 * that file re-attributed every finished run on disk. A run has to record its own model, and only
 * its model: the same file holds the key it authenticates with.
 */
test("a full run records the user-simulator model it resolved, and nothing else from .env", async (t) => {
  const deps = await runnerDeps(t, {
    processEnv: { ...BASE_ENV, USER_SIM_MODEL: "openai/gpt-4o", OPENAI_API_KEY: "sk-secret-user-sim" },
    probeSystemAgentAuth: async () => true,
  });
  await runBirdSmoke(
    { oracleOnly: false, wrenBin: "wren", pythonBin: "python3.11", systemModel: DEFAULT_SYSTEM_MODEL, concurrency: DEFAULT_CONCURRENCY, profile: PROFILE_DIRECTORY },
    deps,
  );

  const path = join(deps.paths.runDir, USER_SIMULATOR_FILENAME);
  const text = await readFile(path, "utf8");
  assert.deepEqual(JSON.parse(text), { version: 1, model: "openai/gpt-4o" });
  // The whole point of writing the name rather than the environment: no credential may follow it
  // into a directory people copy, diff and attach to a report.
  assert.ok(!text.includes("sk-secret-user-sim"), "no credential may reach the run directory");
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["model", "version"]);
  assert.deepEqual(await readUserSimulatorRecord(deps.paths.runDir), { version: 1, model: "openai/gpt-4o" });
});

/* -------------------------------------------------------------------------- */
/* A run directory holds exactly one run                                      */
/* -------------------------------------------------------------------------- */

/**
 * The run directory is a constant and everything in it is keyed by the constant task ids, so a
 * rerun that merely overwrote its own outputs left the previous run's beside them. `report-cli`
 * fills its tolerant column with `tolerant[task_id]`, so a previous autopsy's verdicts scored the
 * new submissions; an `--oracle-only` rerun, which writes no `a-interact.json`, no `traces/` and no
 * `user-simulator.json` at all, reported the previous run's. Nothing catches it downstream: a rerun
 * over the same runtime tree writes a byte-identical `manifest.json`, so the run-versus-runtime
 * cross-check sees two runs it cannot tell apart.
 *
 * The displaced run is MOVED, not deleted. It is a measurement Warble did not make, someone may
 * still be reading it, and `report-cli` names runs by their directory name under `data/runs/` — so
 * the archive is itself a run directory that can still be reported.
 */
test("a rerun starts in an empty run directory and keeps the run it displaced", async (t) => {
  const deps = await runnerDeps(t);
  const runDir = deps.paths.runDir;
  await mkdir(join(runDir, "traces", "alien_1"), { recursive: true });
  await mkdir(join(runDir, "logs"), { recursive: true });
  await writeFile(join(runDir, "a-interact.json"), `${JSON.stringify(interactJson())}\n`, "utf8");
  await writeFile(join(runDir, "traces", "alien_1", "trace.json"), "{}\n", "utf8");
  await writeFile(join(runDir, "tolerant.json"), `{"alien_1":true}\n`, "utf8");
  await writeFile(join(runDir, USER_SIMULATOR_FILENAME), `{"version":1,"model":"openai/gpt-5"}\n`, "utf8");
  await writeFile(join(runDir, "logs", "user-simulator.log"), "LLM call failed\n", "utf8");

  const summary = await runBirdSmoke(
    { oracleOnly: true, wrenBin: "wren", pythonBin: "python3.11", systemModel: DEFAULT_SYSTEM_MODEL, concurrency: DEFAULT_CONCURRENCY, profile: PROFILE_DIRECTORY },
    deps,
  );

  // An oracle-only run writes its manifest and its logs directory. Every other name a reader could
  // find here would be the previous run's, reported as this one's.
  assert.deepEqual((await readdir(runDir)).sort(), ["logs", "manifest.json"]);

  const archived = summary.archived;
  assert.ok(archived !== null, "the displaced run is kept, never deleted");
  assert.equal(dirname(archived), dirname(runDir), "beside the run, as a run directory report-cli can name");
  assert.deepEqual(
    (await readdir(archived)).sort(),
    ["a-interact.json", "logs", "tolerant.json", "traces", USER_SIMULATOR_FILENAME].sort(),
  );
  assert.equal(
    await readFile(join(archived, "logs", "user-simulator.log"), "utf8"),
    "LLM call failed\n",
    "including the log the simulator verdict is read from",
  );

  // Nothing to displace, nothing displaced: a first run reports no archive.
  const first = await runnerDeps(t);
  const clean = await runBirdSmoke(
    { oracleOnly: true, wrenBin: "wren", pythonBin: "python3.11", systemModel: DEFAULT_SYSTEM_MODEL, concurrency: DEFAULT_CONCURRENCY, profile: PROFILE_DIRECTORY },
    first,
  );
  assert.equal(clean.archived, null);

  // Two runs last written in the same millisecond are still two runs, and the archive that is
  // already there is a measurement too: it may not be renamed over.
  const twin = await runnerDeps(t);
  const written = new Date("2026-08-24T12:00:00.000Z");
  const stamped = `${twin.paths.runDir}.2026-08-24T12-00-00-000Z`;
  for (const expected of [stamped, `${stamped}-1`]) {
    await mkdir(twin.paths.runDir, { recursive: true });
    await writeFile(join(twin.paths.runDir, "oracle.json"), "{}\n", "utf8");
    await utimes(twin.paths.runDir, written, written);
    const rerun = await runBirdSmoke(
      { oracleOnly: true, wrenBin: "wren", pythonBin: "python3.11", systemModel: DEFAULT_SYSTEM_MODEL, concurrency: DEFAULT_CONCURRENCY, profile: PROFILE_DIRECTORY },
      twin,
    );
    assert.equal(rerun.archived, expected);
  }
});

test("an oracle-only run records no simulator model at all, even with credentials present", async (t) => {
  // The credentials ARE resolvable here; the oracle simply never calls the simulator, so there is
  // nothing to record. Absent, never an empty string: the report reads absent as unrecorded.
  const deps = await runnerDeps(t);
  await runBirdSmoke(
    { oracleOnly: true, wrenBin: "wren", pythonBin: "python3.11", systemModel: DEFAULT_SYSTEM_MODEL, concurrency: DEFAULT_CONCURRENCY, profile: PROFILE_DIRECTORY },
    deps,
  );

  assert.ok(
    !(await readdir(deps.paths.runDir)).includes(USER_SIMULATOR_FILENAME),
    "an oracle-only run must write no user-simulator record",
  );
  assert.equal(await readUserSimulatorRecord(deps.paths.runDir), null);
});
