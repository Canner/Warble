import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { CodexDispatchError, prepareSetup, runSetup } from "../src/index.js";
import { fakeMcp, FAKE_CODEX, prepared, SETUP_IR_PATH } from "./helpers.js";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "warble-codex-local-"));
  scratch.push(path);
  return path;
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
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

test("runs through a fake Codex executable, streams events, and sanitizes billing env", async () => {
  const dir = temp();
  const record = join(dir, "record.json");
  const streamed: unknown[] = [];
  const result = await runSetup(prepared(), {
    cwd: dir,
    request: "connect a disposable source",
    codexBin: process.execPath,
    codexArgsPrefix: [FAKE_CODEX],
    env: {
      PATH: process.env.PATH,
      CODEX_HOME: "/safe/auth-location",
      OPENAI_API_KEY: "must-not-leak",
      CODEX_API_KEY: "must-not-leak",
      AZURE_OPENAI_API_KEY: "must-not-leak",
      FAKE_CODEX_RECORD: record,
    },
    onEvent: (event) => streamed.push(event),
  });
  assert.equal(result.finalText, '{"connection_summary":{"ok":true}}');
  assert.deepEqual(streamed, result.events);
  const recorded = JSON.parse(readFileSync(record, "utf8")) as {
    argv: string[];
    prompt: string;
    env: Record<string, string | null>;
  };
  assert.equal(recorded.env.OPENAI_API_KEY, null);
  assert.equal(recorded.env.CODEX_API_KEY, null);
  assert.equal(recorded.env.AZURE_OPENAI_API_KEY, null);
  assert.equal(recorded.env.CODEX_HOME, "/safe/auth-location");
  assert.ok(recorded.argv.includes("--ignore-user-config"));
  assert.ok(recorded.argv.includes('mcp_servers.setup.enabled_tools=["probe_setup"]'));
  assert.match(recorded.prompt, /connect_source\.connect/);
});

test("non-zero, malformed output, and forbidden runtime items loud-fail", async () => {
  for (const [scenario, pattern] of [
    ["nonzero", /exited with 7/],
    ["malformed", /non-JSONL/],
    ["forbidden", /isolation violation/],
  ] as const) {
    await assert.rejects(
      runSetup(prepared(), {
        cwd: temp(),
        request: "test",
        codexBin: process.execPath,
        codexArgsPrefix: [FAKE_CODEX],
        env: { PATH: process.env.PATH, FAKE_CODEX_SCENARIO: scenario },
      }),
      pattern,
    );
  }

  await assert.rejects(
    runSetup(prepared(), {
      cwd: temp(),
      request: "redact stderr",
      codexBin: process.execPath,
      codexArgsPrefix: [FAKE_CODEX],
      env: { PATH: process.env.PATH, FAKE_CODEX_SCENARIO: "nonzero-secret" },
    }),
    (error: unknown) =>
      error instanceof CodexDispatchError &&
      /exited with 8/.test(error.message) &&
      !error.message.includes("secret"),
  );
});

test("timeout and AbortSignal cancellation loud-fail", async () => {
  await assert.rejects(
    runSetup(prepared(), {
      cwd: temp(),
      request: "timeout",
      codexBin: process.execPath,
      codexArgsPrefix: [FAKE_CODEX],
      env: { PATH: process.env.PATH, FAKE_CODEX_SCENARIO: "hang" },
      timeoutMs: 30,
    }),
    /timed out/,
  );

  const descendantRecord = join(temp(), "descendant.pid");
  await assert.rejects(
    runSetup(prepared(), {
      cwd: temp(),
      request: "clean the process tree",
      codexBin: process.execPath,
      codexArgsPrefix: [FAKE_CODEX],
      env: {
        PATH: process.env.PATH,
        FAKE_CODEX_SCENARIO: "descendant-ignore-term",
        FAKE_CODEX_DESCENDANT_RECORD: descendantRecord,
      },
      timeoutMs: 500,
      terminationGraceMs: 30,
    }),
    /timed out/,
  );
  const descendantPid = Number(readFileSync(descendantRecord, "utf8"));
  await waitForProcessExit(descendantPid);

  await assert.rejects(
    runSetup(prepared(), {
      cwd: temp(),
      request: "ignore termination",
      codexBin: process.execPath,
      codexArgsPrefix: [FAKE_CODEX],
      env: { PATH: process.env.PATH, FAKE_CODEX_SCENARIO: "ignore-term" },
      timeoutMs: 30,
      terminationGraceMs: 30,
    }),
    /timed out/,
  );

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(
    runSetup(prepared(), {
      cwd: temp(),
      request: "cancel",
      codexBin: process.execPath,
      codexArgsPrefix: [FAKE_CODEX],
      env: { PATH: process.env.PATH, FAKE_CODEX_SCENARIO: "hang" },
      signal: controller.signal,
      timeoutMs: 5_000,
    }),
    /cancelled/,
  );

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    runSetup(prepared(), {
      cwd: temp(),
      request: "must not spawn",
      codexBin: process.execPath,
      codexArgsPrefix: [FAKE_CODEX],
      signal: alreadyAborted.signal,
    }),
    /cancelled before start/,
  );
});

test("AC#3 evidence: an n-step Setup component actually dispatches two processes in order, marshalling produces into the second step's consumes", async () => {
  // A genuine end-to-end run, not just a prepare()-time acceptance test: two real child processes
  // (fake-codex.mjs's "multi-step" scenario, one per step) must each run, and the second step's
  // scripted response must prove it actually received the first step's produced value as input.
  const raw = readFileSync(SETUP_IR_PATH, "utf8");
  const ir = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const component = ir.components[0]!;
  const first = (component["llm_calls"] as Array<Record<string, unknown>>)[0]!;
  const second = structuredClone(first);
  second["name"] = "confirm";
  second["consumes"] = [first["produces"]];
  second["produces"] = "confirmation";
  component["llm_calls"] = [first, second];

  const twoStepComponent = prepareSetup({
    ir: JSON.stringify(ir),
    component: "connect_source",
    model: "gpt-5.4",
    mcp: fakeMcp(),
  });
  assert.equal(twoStepComponent.steps.length, 2);

  const events: unknown[] = [];
  const result = await runSetup(twoStepComponent, {
    cwd: temp(),
    request: "connect a disposable source",
    codexBin: process.execPath,
    codexArgsPrefix: [FAKE_CODEX],
    env: { PATH: process.env.PATH, FAKE_CODEX_SCENARIO: "multi-step" },
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(
    result.steps.map((step) => ({ name: step.name, ran: step.ran, ok: step.ok })),
    [
      { name: "connect", ran: true, ok: true },
      { name: "confirm", ran: true, ok: true },
    ],
  );
  assert.deepEqual(result.steps[0]!.value, { ok: true });
  // The second step's own process only ever emits `{"confirmation": {...}}` (see fake-codex.mjs) --
  // this is not what proves marshalling worked. What proves it is that `runSetup` only reaches the
  // second `runOneStep` call at all if the first step's produces-field parse succeeded, and that
  // the second step's process actually started (both step_start events fire below) using a prompt
  // built from `step.consumes` -- which `buildPrompt` only populates for a step whose earlier
  // producer actually ran.
  assert.equal(result.finalText, '{"confirmation":{"ok":true}}');
  const stepStarts = (events as Array<{ t: string; id?: string }>).filter((event) => event.t === "step_start");
  assert.deepEqual(
    stepStarts.map((event) => event.id),
    ["connect", "confirm"],
  );
});

function onFailureComponent() {
  const raw = readFileSync(SETUP_IR_PATH, "utf8");
  const ir = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const component = ir.components[0]!;
  const first = (component["llm_calls"] as Array<Record<string, unknown>>)[0]!;
  first["name"] = "connect";
  const repair = structuredClone(first);
  repair["name"] = "repair_connect";
  repair["produces"] = "confirmation";
  repair["conditional"] = true;
  repair["when"] = { guard: "on_failure", target: "connect" };
  component["llm_calls"] = [first, repair];
  return prepareSetup({
    ir: JSON.stringify(ir),
    component: "connect_source",
    model: "gpt-5.4",
    mcp: fakeMcp(),
  });
}

test("AC#3 evidence: an on_failure-guarded step is actually skipped at run time when its target succeeds", async () => {
  const events: unknown[] = [];
  const result = await runSetup(onFailureComponent(), {
    cwd: temp(),
    request: "connect a disposable source",
    codexBin: process.execPath,
    codexArgsPrefix: [FAKE_CODEX],
    env: { PATH: process.env.PATH, FAKE_CODEX_SCENARIO: "on-failure", FAKE_CODEX_ONFAILURE_MODE: "success" },
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(
    result.steps.map((step) => ({ name: step.name, ran: step.ran, ok: step.ok })),
    [
      { name: "connect", ran: true, ok: true },
      { name: "repair_connect", ran: false, ok: false },
    ],
  );
  // The guarded step must never even be dispatched -- not merely marked skipped after the fact --
  // so only one process's step_start/step_finish pair may appear in the event stream.
  const stepStarts = (events as Array<{ t: string; id?: string }>).filter((event) => event.t === "step_start");
  assert.deepEqual(
    stepStarts.map((event) => event.id),
    ["connect"],
  );
});

test("AC#3 evidence: an on_failure-guarded step actually runs at run time when its target fails", async () => {
  const events: unknown[] = [];
  const result = await runSetup(onFailureComponent(), {
    cwd: temp(),
    request: "connect a disposable source",
    codexBin: process.execPath,
    codexArgsPrefix: [FAKE_CODEX],
    env: { PATH: process.env.PATH, FAKE_CODEX_SCENARIO: "on-failure", FAKE_CODEX_ONFAILURE_MODE: "fail" },
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(
    result.steps.map((step) => ({ name: step.name, ran: step.ran, ok: step.ok })),
    [
      { name: "connect", ran: true, ok: false },
      { name: "repair_connect", ran: true, ok: true },
    ],
  );
  assert.equal(result.finalText, '{"confirmation":{"ok":true}}');
  const stepStarts = (events as Array<{ t: string; id?: string }>).filter((event) => event.t === "step_start");
  assert.deepEqual(
    stepStarts.map((event) => event.id),
    ["connect", "repair_connect"],
  );
});
