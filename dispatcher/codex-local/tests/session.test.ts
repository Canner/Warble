import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  CodexSessionRuntime,
  type CodexSessionEvent,
  type SessionIsolationOptions,
} from "../src/index.js";
import { buildIsolationConfig } from "../src/config.js";
import { FAKE_APP_SERVER, prepared } from "./helpers.js";

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `warble-codex-session-${label}-`));
  scratch.push(path);
  return path;
}

function options(
  codexHome: string,
  cwd: string,
  onEvent?: (event: CodexSessionEvent) => void,
  env: NodeJS.ProcessEnv = {},
): SessionIsolationOptions {
  return {
    codexHome,
    cwd,
    externalAuthentication: "provisioned",
    codexBin: process.execPath,
    codexArgsPrefix: [FAKE_APP_SERVER],
    timeoutMs: 500,
    terminationGraceMs: 30,
    env: { PATH: process.env.PATH, ...env },
    onEvent,
  };
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`process ${pid} remained alive after process-group cleanup`);
}

test("persists a stable thread across turns, process restart, resume, and history reads", async () => {
  const codexHome = temp("home");
  const cwd = temp("cwd");
  const events: CodexSessionEvent[] = [];
  const runtime = await CodexSessionRuntime.connect(
    prepared(),
    options(codexHome, cwd, (event) => events.push(event)),
  );

  const session = await runtime.start();
  const first = await runtime.turn(session, "first request user-history-must-not-leak");
  assert.equal((await runtime.waitForTurn(first)).status, "completed");
  const second = await runtime.turn(session, "second request");
  assert.equal((await runtime.waitForTurn(second)).status, "completed");
  await runtime.close();

  const resumedRuntime = await CodexSessionRuntime.connect(
    prepared(),
    options(codexHome, cwd, (event) => events.push(event)),
  );
  const resumed = await resumedRuntime.resume(session);
  assert.equal(resumed.threadId, session.threadId);
  const history = await resumedRuntime.read(resumed);
  assert.equal(history.session.threadId, session.threadId);
  assert.deepEqual(history.turns.map((turn) => turn.status), ["completed", "completed"]);
  assert.deepEqual(
    history.turns.map((turn) => turn.items.map((item) => item.type)),
    [
      ["user", "artifact", "assistant"],
      ["user", "artifact", "assistant"],
    ],
  );
  assert.ok(
    history.turns.every((turn) =>
      turn.items.every((item) => item.type === "artifact" || !("text" in item)),
    ),
  );

  const third = await resumedRuntime.turn(resumed, "after resume");
  assert.equal((await resumedRuntime.waitForTurn(third)).status, "completed");
  await resumedRuntime.close();

  const publicProjection = JSON.stringify({ events, history });
  assert.doesNotMatch(publicProjection, /must-not-leak/);
  assert.ok(events.some((event) => event.t === "artifact"));
  assert.ok(events.some((event) => event.t === "session_resumed"));
});

test("steers and interrupts active turns without replacing the thread", async () => {
  const codexHome = temp("home");
  const cwd = temp("cwd");
  let startedResolver: (() => void) | undefined;
  let started = new Promise<void>((resolve) => {
    startedResolver = resolve;
  });
  const runtime = await CodexSessionRuntime.connect(
    prepared(),
    options(codexHome, cwd, (event) => {
      if (event.t === "turn_started") startedResolver?.();
    }),
  );
  const session = await runtime.start();

  const steered = await runtime.turn(session, "hold for steer");
  await started;
  const steeredWait = runtime.waitForTurn(steered);
  assert.equal((await runtime.steer(session, steered.turnId, "continue now")).turnId, steered.turnId);
  assert.equal((await steeredWait).status, "completed");

  started = new Promise<void>((resolve) => {
    startedResolver = resolve;
  });
  const interrupted = await runtime.turn(session, "hold for interrupt");
  await started;
  const interruptedWait = runtime.waitForTurn(interrupted);
  await runtime.interrupt(session, interrupted.turnId);
  assert.equal((await interruptedWait).status, "interrupted");
  await runtime.close();
});

test("rejects session lifecycle switches while a session or turn is active", async () => {
  const codexHome = temp("home");
  const cwd = temp("cwd");
  let startedResolver: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolver = resolve;
  });
  const runtime = await CodexSessionRuntime.connect(
    prepared(),
    options(codexHome, cwd, (event) => {
      if (event.t === "turn_started") startedResolver?.();
    }),
  );
  const session = await runtime.start();
  await assert.rejects(runtime.start(), /session is already loaded/);

  const held = await runtime.turn(session, "hold for interrupt");
  const other = { ...session, threadId: "other-thread" };
  await assert.rejects(runtime.resume(other), /while a turn is active/);
  await assert.rejects(runtime.fork(session), /while a turn is active/);
  await started;
  const completed = runtime.waitForTurn(held);
  await runtime.interrupt(session, held.turnId);
  assert.equal((await completed).status, "interrupted");
  await assert.rejects(runtime.resume(other), /different session is already loaded/);
  await runtime.close();
});

test("forks with explicit lineage and inherited isolation overrides", async () => {
  const codexHome = temp("home");
  const cwd = temp("cwd");
  const component = prepared();
  const runtime = await CodexSessionRuntime.connect(
    component,
    options(codexHome, cwd, undefined, {
      OPENAI_API_KEY: "must-not-leak",
      CODEX_API_KEY: "must-not-leak",
      AZURE_OPENAI_API_KEY: "must-not-leak",
    }),
  );
  const session = await runtime.start();
  const completed = await runtime.waitForTurn(await runtime.turn(session, "before fork"));
  const forked = await runtime.fork(session, completed.turnId);
  assert.equal(forked.forkedFromThreadId, session.threadId);
  assert.notEqual(forked.threadId, session.threadId);
  assert.equal((await runtime.read(forked)).turns.length, 1);
  await runtime.close();

  const resumedRuntime = await CodexSessionRuntime.connect(
    component,
    options(codexHome, cwd),
  );
  assert.equal((await resumedRuntime.resume(session)).threadId, session.threadId);
  await resumedRuntime.close();

  const state = JSON.parse(readFileSync(join(codexHome, "fake-app-state.json"), "utf8")) as {
    argv: string[];
    billingEnvPresent: boolean;
    initializeCapabilities: Record<string, unknown>;
    requests: Array<{ method: string; params: Record<string, unknown> }>;
  };
  assert.equal(state.billingEnvPresent, false);
  assert.deepEqual(state.initializeCapabilities, {
    experimentalApi: true,
    requestAttestation: false,
  });
  assert.ok(state.argv.includes("--strict-config"));
  assert.ok(state.argv.includes('mcp_servers.setup.enabled_tools=["probe_setup"]'));
  const expectedConfig = buildIsolationConfig(component);
  for (const method of ["thread/start", "thread/fork", "thread/resume"]) {
    const request = state.requests.find((candidate) => candidate.method === method);
    assert.ok(request, `missing ${method} request`);
    assert.equal(request.params.approvalPolicy, "never");
    assert.equal(request.params.sandbox, "read-only");
    assert.deepEqual(request.params.runtimeWorkspaceRoots, []);
    assert.deepEqual(request.params.config, expectedConfig);
  }
  const turnRequest = state.requests.find((candidate) => candidate.method === "turn/start");
  assert.ok(turnRequest, "missing turn/start request");
  assert.deepEqual(turnRequest.params.environments, []);
  assert.deepEqual(turnRequest.params.runtimeWorkspaceRoots, []);
});

test("crash becomes recoverable and restart resumes the same thread", async () => {
  const codexHome = temp("home");
  const cwd = temp("cwd");
  const events: CodexSessionEvent[] = [];
  const runtime = await CodexSessionRuntime.connect(
    prepared(),
    options(codexHome, cwd, (event) => events.push(event)),
  );
  const session = await runtime.start();
  const crashed = await runtime.turn(session, "crash after start");
  await assert.rejects(runtime.waitForTurn(crashed), /disconnected/);
  assert.ok(
    events.some(
      (event) => event.t === "session_recoverable" && event.reason === "app_server_crash",
    ),
  );

  const resumed = await runtime.restartAndResume(session);
  assert.equal(resumed.threadId, session.threadId);
  const recovered = await runtime.turn(resumed, "recovered request");
  assert.equal((await runtime.waitForTurn(recovered)).status, "completed");
  await runtime.close();
});

test("request timeout terminates the app-server process", async () => {
  const codexHome = temp("home");
  const cwd = temp("cwd");
  await assert.rejects(
    CodexSessionRuntime.connect(
      prepared(),
      {
        ...options(codexHome, cwd, undefined, { WARBLE_FAKE_APP_HANG_INIT: "1" }),
        timeoutMs: 200,
      },
    ),
    /initialize.*timed out/,
  );
  const state = JSON.parse(readFileSync(join(codexHome, "fake-app-state.json"), "utf8")) as {
    pid: number;
  };
  await waitForProcessExit(state.pid);
});

test("resume failure loud-fails and restart cleanup leaves no app-server process", async () => {
  const codexHome = temp("home");
  const cwd = temp("cwd");
  const runtime = await CodexSessionRuntime.connect(prepared(), options(codexHome, cwd));
  const session = await runtime.start();
  const statePath = join(codexHome, "fake-app-state.json");
  const before = JSON.parse(readFileSync(statePath, "utf8")) as {
    threads: Record<string, unknown>;
  };
  delete before.threads[session.threadId];
  writeFileSync(statePath, `${JSON.stringify(before, null, 2)}\n`);
  await assert.rejects(
    runtime.restartAndResume(session),
    /thread\/resume.*failed/,
  );
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    pid: number;
  };
  await waitForProcessExit(state.pid);
  await assert.rejects(runtime.turn(session, "must reconnect"), /resume required/);
});

test("turn timeout interrupts, closes, and leaves an explicit resume-required state", async () => {
  const codexHome = temp("home");
  const cwd = temp("cwd");
  const events: CodexSessionEvent[] = [];
  const runtime = await CodexSessionRuntime.connect(
    prepared(),
    options(codexHome, cwd, (event) => events.push(event)),
  );
  const session = await runtime.start();
  const held = await runtime.turn(session, "hold for interrupt");
  await assert.rejects(runtime.waitForTurn(held, 20), /timed out/);
  assert.ok(
    events.some(
      (event) => event.t === "session_recoverable" && event.reason === "turn_timeout",
    ),
  );
  await assert.rejects(runtime.turn(session, "must resume first"), /resume required/);
  const state = JSON.parse(readFileSync(join(codexHome, "fake-app-state.json"), "utf8")) as {
    pid: number;
  };
  await waitForProcessExit(state.pid);
});

test("rejects unsafe persistent CODEX_HOME layouts before spawning", async () => {
  const cwd = temp("cwd");
  const unauthenticated = temp("unauthenticated");
  await assert.rejects(
    CodexSessionRuntime.connect(prepared(), {
      ...options(unauthenticated, cwd),
      externalAuthentication: undefined as never,
    }),
    /authentication must be provisioned externally/,
  );

  const missing = join(temp("missing-parent"), "not-created");
  await assert.rejects(
    CodexSessionRuntime.connect(prepared(), options(missing, cwd)),
    /must be provisioned/,
  );

  const configured = temp("configured-home");
  writeFileSync(join(configured, "config.toml"), "model = 'unsafe'\n");
  await assert.rejects(
    CodexSessionRuntime.connect(prepared(), options(configured, cwd)),
    /must not contain config\.toml/,
  );

  const nested = join(cwd, "nested-home");
  mkdirSync(nested);
  await assert.rejects(
    CodexSessionRuntime.connect(prepared(), options(nested, cwd)),
    /must not overlap/,
  );

  const parentHome = temp("parent-home");
  const nestedCwd = join(parentHome, "nested-project");
  mkdirSync(nestedCwd);
  await assert.rejects(
    CodexSessionRuntime.connect(prepared(), options(parentHome, nestedCwd)),
    /must not overlap/,
  );

  await assert.rejects(
    CodexSessionRuntime.connect(prepared(), options("relative-home", cwd)),
    /must be absolute/,
  );

  const inheritedDefault = temp("inherited-default");
  await assert.rejects(
    CodexSessionRuntime.connect(
      prepared(),
      options(inheritedDefault, cwd, undefined, { CODEX_HOME: inheritedDefault }),
    ),
    /non-default codexHome/,
  );
});

test("protocol, item, and MCP status violations fail closed without leaking details", async () => {
  for (const scenario of [
    "completed-with-error",
    "invalid-status",
    "forbidden-item",
    "unknown-item",
    "nonallowlisted",
    "terminal-error-notification",
    "malformed-retry-error",
    "unknown-notification",
  ]) {
    const codexHome = temp(`${scenario}-home`);
    const cwd = temp(`${scenario}-cwd`);
    const emitted: CodexSessionEvent[] = [];
    const runtime = await CodexSessionRuntime.connect(
      prepared(),
      options(codexHome, cwd, (event) => emitted.push(event)),
    );
    const session = await runtime.start();
    const turn = await runtime.turn(session, scenario);
    await assert.rejects(
      runtime.waitForTurn(turn),
      (error: unknown) =>
        error instanceof Error &&
        /notification violated|successful allowlisted tool/.test(error.message) &&
        !error.message.includes("must-not-leak"),
      scenario,
    );
    assert.doesNotMatch(JSON.stringify(emitted), /must-not-leak/);
    await runtime.close();
  }
});
