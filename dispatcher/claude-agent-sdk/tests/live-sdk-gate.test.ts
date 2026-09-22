import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assertLiveSdkOptIn, runLiveReadGuardTest, type TestQuery } from "./live-sdk-harness.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const syntheticAuth = { ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_API_KEY: "synthetic-only", CLAUDE_CODE_OAUTH_TOKEN: "synthetic-only" };

test("auth or proxy inheritance cannot opt in, including truthy-looking flag values", async () => {
  let calls = 0;
  const never: TestQuery = async function* () { calls++; throw new Error("must not call SDK"); };
  for (const flag of [undefined, "", "0", "true", "yes", " 1", "1 "]) {
    await assert.rejects(runLiveReadGuardTest({ ...syntheticAuth, WARBLE_RUN_LIVE_SDK_TESTS: flag }, new AbortController().signal, never), /explicit WARBLE_RUN_LIVE_SDK_TESTS=1/);
  }
  await assert.rejects(runLiveReadGuardTest({ WARBLE_RUN_LIVE_SDK_TESTS: "1", ANTHROPIC_API_KEY: "  " }, new AbortController().signal, never), /saved user-home login is not used/);
  assert.equal(calls, 0);
  for (const [name, value] of Object.entries(syntheticAuth)) assertLiveSdkOptIn({ WARBLE_RUN_LIVE_SDK_TESTS: "1", [name]: value });
});

test("default test glob excludes the live entry even when explicit opt-in is inherited", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.test, /tests\/\*\.test\.ts$/);
  assert.match(pkg.scripts.prepublishOnly, /npm test$/);
  assert.match(pkg.scripts["test:live"], /tests\/\*\.live\.ts$/);
  const child = spawnSync(process.execPath, ["--import", "tsx", "--experimental-test-module-mocks", "--import", "./tests/fixtures/deny-live-sdk.ts", "--test", "tests/guardrails.test.ts"], {
    cwd: packageDir, encoding: "utf8", timeout: 15_000,
    env: { PATH: process.env.PATH, ...syntheticAuth, WARBLE_RUN_LIVE_SDK_TESTS: "1" },
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.doesNotMatch(child.stdout + child.stderr, /UNEXPECTED_LIVE_QUERY|\[live SDK\]/);
});

test("direct live command fails closed without opt-in before SDK query", () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--experimental-test-module-mocks", "--import", "./tests/fixtures/deny-live-sdk.ts", "--test", "tests/guardrails.live.ts"], {
    cwd: packageDir, encoding: "utf8", timeout: 15_000,
    env: { PATH: process.env.PATH, ...syntheticAuth },
  });
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.match(child.stdout + child.stderr, /explicit WARBLE_RUN_LIVE_SDK_TESTS=1/);
  assert.doesNotMatch(child.stdout + child.stderr, /UNEXPECTED_LIVE_QUERY/);
});

test("explicit live harness uses synthetic home, exact environment and observed hook denial", async () => {
  let root = "";
  let signal: AbortSignal | undefined;
  const fake: TestQuery = async function* ({ options }) {
    root = dirname(options.cwd!);
    signal = options.abortController!.signal;
    assert.equal(options.env!.HOME, `${root}/home`);
    assert.equal(options.env!.CLAUDE_CONFIG_DIR, `${root}/home/.claude`);
    assert.equal(options.env!.ZDOTDIR, `${root}/home`);
    for (const name of ["NODE_OPTIONS", "BASH_ENV", "OPENAI_API_KEY", "SSH_AUTH_SOCK", "DEBUG", "WARBLE_RUN_LIVE_SDK_TESTS"]) assert.equal(options.env![name], undefined);
    assert.equal(options.env!.ANTHROPIC_API_KEY, "synthetic-only");
    assert.deepEqual(options.settingSources, []);
    assert.deepEqual(options.mcpServers, {});
    assert.equal(options.strictMcpConfig, true);
    assert.equal(options.persistSession, false);
    assert.equal(readFileSync(`${options.cwd}/.env`, "utf8"), "FEATURE_FLAG_PROBE=synthetic_value_zzz42\n");
    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
    await hook({ hook_event_name: "PreToolUse", session_id: "synthetic", transcript_path: "", cwd: options.cwd!, tool_name: "Read", tool_input: { file_path: ".env" }, tool_use_id: "read-1" }, "read-1", { signal });
    yield { type: "result", subtype: "success", result: "Read denied" } as SDKMessage;
  };
  await runLiveReadGuardTest({ ...syntheticAuth, WARBLE_RUN_LIVE_SDK_TESTS: "1", HOME: "/real-home", CLAUDE_CONFIG_DIR: "/real-config", NODE_OPTIONS: "unsafe", BASH_ENV: "/real-shell", OPENAI_API_KEY: "unrelated", SSH_AUTH_SOCK: "/agent", DEBUG: "1" }, new AbortController().signal, fake);
  assert.equal(signal!.aborted, true);
  assert.equal(existsSync(root), false);
});

test("cancellation aborts the query and removes its synthetic home and fixture", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let root = "";
  let closed = false;
  const fake: TestQuery = async function* ({ options }) {
    root = dirname(options.cwd!);
    try {
      await new Promise<void>((_resolve, reject) => {
        options.abortController!.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        started();
      });
    } finally { closed = true; }
  };
  const running = runLiveReadGuardTest({ ...syntheticAuth, WARBLE_RUN_LIVE_SDK_TESTS: "1" }, controller.signal, fake);
  await ready;
  controller.abort();
  await assert.rejects(running, /cancelled/);
  assert.equal(closed, true);
  assert.equal(existsSync(root), false);
});

test("an already cancelled test refuses before query startup", async () => {
  let calls = 0;
  const never: TestQuery = () => { calls++; throw new Error("must not start"); };
  const signal = AbortSignal.abort(new Error("already cancelled"));
  await assert.rejects(runLiveReadGuardTest({ ...syntheticAuth, WARBLE_RUN_LIVE_SDK_TESTS: "1" }, signal, never), /already cancelled/);
  assert.equal(calls, 0);
});

test("node:test timeout propagates cancellation and completes fixture cleanup", () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=tap", "tests/fixtures/live-sdk-timeout.ts"], {
    cwd: packageDir, encoding: "utf8", timeout: 15_000,
    env: { PATH: process.env.PATH },
  });
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.match(child.stdout + child.stderr, /testTimeoutFailure/);
  assert.match(child.stdout + child.stderr, /TIMEOUT_CLEANUP \{"aborted":true,"removed":true\}/);
});

test("SDK startup failure and missing success/denial fail and clean up", async () => {
  for (const mode of ["startup", "no-result", "no-denial"]) {
    let root = "";
    const fake: TestQuery = ({ options }) => {
      root = dirname(options.cwd!);
      if (mode === "startup") throw new Error("startup failed");
      return (async function* () {
        if (mode === "no-denial") yield { type: "result", subtype: "success", result: "nothing happened" } as SDKMessage;
      })();
    };
    await assert.rejects(runLiveReadGuardTest({ ...syntheticAuth, WARBLE_RUN_LIVE_SDK_TESTS: "1" }, new AbortController().signal, fake));
    assert.equal(existsSync(root), false);
  }
});
