import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  CodexAskRuntime,
  buildAskDriverPrompt,
  type CodexAskEvent,
  type CodexAskRuntimeOptions,
} from "../src/index.js";
import { FAKE_APP_SERVER, preparedAsk, preparedDashboard } from "./helpers.js";

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `warble-codex-ask-${label}-`));
  scratch.push(path);
  return path;
}

function options(
  codexHome: string,
  cwd: string,
  onAskEvent?: (event: CodexAskEvent) => void,
  turnTimeoutMs = 1_000,
): CodexAskRuntimeOptions {
  return {
    codexHome,
    cwd,
    externalAuthentication: "provisioned",
    codexBin: process.execPath,
    codexArgsPrefix: [FAKE_APP_SERVER],
    timeoutMs: 500,
    turnTimeoutMs,
    terminationGraceMs: 30,
    env: {
      PATH: process.env.PATH,
      OPENAI_API_KEY: "must-not-leak",
      CODEX_API_KEY: "must-not-leak",
    },
    onAskEvent,
  };
}

test("driver prompt requires named ordered delegation and forbids parent flattening", () => {
  const prompt = buildAskDriverPrompt(preparedAsk(), "top customers");
  assert.match(prompt, /named child-agent delegation only/);
  assert.match(prompt, /Do not perform any IR step in the parent/);
  assert.match(prompt, /agent_type=warble_resolve_intent/);
  assert.match(prompt, /agent_type=warble_generate_sql/);
  assert.match(prompt, /agent_type=warble_repair_sql/);
  assert.match(prompt, /Wait for it before any later spawn/);
  assert.match(prompt, /If 'generate_sql' returns ok=true, do not spawn 'warble_repair_sql'/);
  assert.match(prompt, /exactly once/);
  assert.match(prompt, /warble_final_step/);
  assert.match(prompt, /Do not copy the final child value/);
});

test("validates success path named agents, tier models, state marshalling, and artifacts", async () => {
  const codexHome = temp("success-home");
  const cwd = temp("success-cwd");
  const events: CodexAskEvent[] = [];
  const runtime = await CodexAskRuntime.connect(
    preparedAsk(),
    options(codexHome, cwd, (event) => events.push(event)),
  );
  const session = await runtime.start();
  const result = await runtime.run(session, "ask-success");
  assert.deepEqual(
    result.steps.map((step) => [step.step, step.agentRole, step.model, step.ok]),
    [
      ["resolve_intent", "warble_resolve_intent", "gpt-5.6-terra", true],
      ["generate_sql", "warble_generate_sql", "gpt-5.6-sol", true],
    ],
  );
  assert.deepEqual(result.value, { columns: ["orders"], rows: [[42]], verified: true });
  assert.equal(result.steps[0]!.artifacts.length, 0);
  assert.equal(result.steps[1]!.artifacts.length, 1);
  assert.equal(result.steps[1]!.artifacts[0]!.tool, "run_sql");
  assert.equal(events.filter((event) => event.t === "agent_started").length, 2);
  assert.equal(events.filter((event) => event.t === "step_finished").length, 2);
  assert.doesNotMatch(JSON.stringify({ result, events }), /must-not-leak/);
  await runtime.close();

  const state = JSON.parse(readFileSync(join(codexHome, "fake-app-state.json"), "utf8")) as {
    argv: string[];
    billingEnvPresent: boolean;
    requests: Array<{ method: string; params: Record<string, unknown> }>;
  };
  assert.equal(state.billingEnvPresent, false);
  assert.ok(state.argv.includes("features.multi_agent=true"));
  for (const role of ["warble_resolve_intent", "warble_generate_sql", "warble_repair_sql"]) {
    assert.ok(state.argv.some((arg) => arg.startsWith(`agents.${role}.config_file=`)));
  }
  const start = state.requests.find((request) => request.method === "thread/start");
  assert.ok(start);
  assert.equal(start.params.model, "gpt-5.6");
  assert.equal(start.params.sandbox, "read-only");
  const config = start.params.config as Record<string, unknown>;
  assert.equal(config["features.multi_agent"], true);
  assert.equal(config["features.shell_tool"], false);
  assert.equal(config["mcp_servers.wren.command"], undefined);
  for (const role of ["warble_resolve_intent", "warble_generate_sql", "warble_repair_sql"]) {
    assert.equal(typeof config[`agents.${role}.config_file`], "string");
  }
});

test("accepts turn notifications that arrive before the turn/start response", async () => {
  const codexHome = temp("early-notify-home");
  const cwd = temp("early-notify-cwd");
  const runtime = await CodexAskRuntime.connect(preparedAsk(), options(codexHome, cwd));
  const session = await runtime.start();
  const result = await runtime.run(session, "ask-early-notify");
  assert.deepEqual(
    result.steps.map((step) => [step.step, step.model, step.ok]),
    [
      ["resolve_intent", "gpt-5.6-terra", true],
      ["generate_sql", "gpt-5.6-sol", true],
    ],
  );
  assert.deepEqual(result.value, { columns: ["orders"], rows: [[42]], verified: true });
  await runtime.close();
});

test("ignores passive config warnings outside an active Ask turn", async () => {
  const codexHome = temp("config-warning-home");
  const cwd = temp("config-warning-cwd");
  const runtime = await CodexAskRuntime.connect(preparedAsk(), options(codexHome, cwd));
  const session = await runtime.start();
  const result = await runtime.run(session, "ask-config-warning");
  assert.equal(result.steps.length, 2);
  assert.deepEqual(result.value, { columns: ["orders"], rows: [[42]], verified: true });
  await runtime.close();
});

test("runs exactly one strong repair agent only after generate failure", async () => {
  const codexHome = temp("repair-home");
  const cwd = temp("repair-cwd");
  const runtime = await CodexAskRuntime.connect(preparedAsk(), options(codexHome, cwd));
  const session = await runtime.start();
  const result = await runtime.run(session, "ask-repair");
  assert.deepEqual(result.steps.map((step) => [step.step, step.ok]), [
    ["resolve_intent", true],
    ["generate_sql", false],
    ["repair_sql", true],
  ]);
  assert.deepEqual(result.value, { columns: ["orders"], rows: [[42]], verified: true });
  assert.equal(result.steps.filter((step) => step.step === "repair_sql").length, 1);
  await runtime.close();
});

test("loud-fails exhausted repair and every attribution or isolation mismatch", async () => {
  const cases: Array<[string, RegExp]> = [
    ["ask-repair-fails", /repair attempt did not recover/],
    ["ask-wrong-model", /wrong model/],
    ["ask-wrong-role", /attribution failed/],
    ["ask-wrong-input", /was not marshalled exactly/],
    ["ask-wrong-tool", /non-allowlisted MCP tool/],
    ["ask-child-fails", /before the child agent succeeded/],
    ["ask-wait-error", /collaboration 'wait' failed/],
    ["ask-unknown-child-event", /unknown thread/],
    ["ask-wrong-receipt", /final child receipt/],
  ];
  for (const [scenario, message] of cases) {
    const codexHome = temp(`${scenario}-home`);
    const cwd = temp(`${scenario}-cwd`);
    const events: CodexAskEvent[] = [];
    const runtime = await CodexAskRuntime.connect(
      preparedAsk(),
      options(codexHome, cwd, (event) => events.push(event)),
    );
    const session = await runtime.start();
    await assert.rejects(runtime.run(session, scenario), message, scenario);
    if (scenario === "ask-wrong-role") {
      assert.equal(events.filter((event) => event.t === "agent_started").length, 0);
    }
    await runtime.close();
  }
});

test("timeout closes the transport and restart resumes the same parent thread", async () => {
  const codexHome = temp("restart-home");
  const cwd = temp("restart-cwd");
  const events: CodexAskEvent[] = [];
  const runtimeOptions = options(codexHome, cwd, (event) => events.push(event), 40);
  const runtime = await CodexAskRuntime.connect(
    preparedAsk(),
    runtimeOptions,
  );
  const session = await runtime.start();
  await assert.rejects(runtime.run(session, "ask-hold"), /timed out/);
  assert.ok(
    events.some(
      (event) => event.t === "session_recoverable" && event.reason === "turn_timeout",
    ),
  );
  runtimeOptions.turnTimeoutMs = 1_000;
  const resumed = await runtime.restartAndResume(session);
  assert.equal(resumed.threadId, session.threadId);
  const result = await runtime.run(resumed, "ask-success after restart");
  assert.equal(result.steps.length, 2);
  await runtime.close();
});

test("AbortSignal cancels an active turn and restart resumes the same parent thread", async () => {
  const codexHome = temp("cancel-home");
  const cwd = temp("cancel-cwd");
  const events: CodexAskEvent[] = [];
  const runtime = await CodexAskRuntime.connect(
    preparedAsk(),
    options(codexHome, cwd, (event) => events.push(event)),
  );
  const session = await runtime.start();
  const controller = new AbortController();
  const run = runtime.run(session, "ask-hold", controller.signal);
  controller.abort();
  await assert.rejects(run, /cancelled/);
  assert.ok(
    events.some(
      (event) => event.t === "session_recoverable" && event.reason === "turn_cancelled",
    ),
  );
  const resumed = await runtime.restartAndResume(session);
  assert.equal(resumed.threadId, session.threadId);
  const result = await runtime.run(resumed, "ask-success after cancellation");
  assert.equal(result.steps.length, 2);
  await runtime.close();
});

test("dashboard runs strong planning then cheap composition and emits a stable render artifact", async () => {
  const codexHome = temp("dashboard-success-home");
  const cwd = temp("dashboard-success-cwd");
  const events: CodexAskEvent[] = [];
  const runtime = await CodexAskRuntime.connect(
    preparedDashboard(),
    options(codexHome, cwd, (event) => events.push(event)),
  );
  const session = await runtime.start();
  const result = await runtime.run(session, "dashboard-success");
  assert.deepEqual(
    result.steps.map((step) => [step.step, step.model, step.ok, step.artifacts.map((item) => item.tool)]),
    [
      ["plan_dashboard", "gpt-5.6-sol", true, ["get_context"]],
      ["compose_layout", "gpt-5.6-terra", true, ["run_sql"]],
    ],
  );
  assert.equal((result.value as { verified: boolean }).verified, true);
  assert.equal(result.renderDegraded, false);
  assert.deepEqual(result.artifact, {
    version: "0.1",
    kind: "render_envelope",
    parentThreadId: result.turn.threadId,
    parentTurnId: result.turn.turnId,
    agentThreadId: result.steps[1]!.agentThreadId,
    step: "compose_layout",
    agentRole: "warble_compose_layout",
    verified: true,
    blockTypes: ["kpi_card", "chart", "table", "definition"],
  });
  assert.equal(events.filter((event) => event.t === "render_artifact").length, 1);
  assert.deepEqual(
    events.flatMap((event) => {
      if (event.t === "artifact") return [[event.t, event.reference.step]];
      if (event.t === "agent_started" || event.t === "step_finished") {
        return [[event.t, event.step]];
      }
      return [];
    }),
    [
      ["agent_started", "plan_dashboard"],
      ["artifact", "plan_dashboard"],
      ["step_finished", "plan_dashboard"],
      ["agent_started", "compose_layout"],
      ["artifact", "compose_layout"],
      ["step_finished", "compose_layout"],
    ],
  );
  assert.doesNotMatch(JSON.stringify({ result, events }), /must-not-leak/);
  await runtime.close();
});

test("dashboard keeps a large child render value authoritative without parent re-copying", async () => {
  const codexHome = temp("dashboard-large-home");
  const cwd = temp("dashboard-large-cwd");
  const runtime = await CodexAskRuntime.connect(preparedDashboard(), options(codexHome, cwd));
  const session = await runtime.start();
  const result = await runtime.run(session, "dashboard-large-value");
  const chart = (result.value as { blocks: Array<{ type: string; rows?: unknown[] }> }).blocks
    .find((block) => block.type === "chart");
  assert.equal(chart?.rows?.length, 200);
  assert.equal(result.artifact?.verified, true);
  await runtime.close();
});

test("dashboard required-step failure loud-fails while best-effort render failure degrades", async () => {
  const failureHome = temp("dashboard-step-fails-home");
  const failureCwd = temp("dashboard-step-fails-cwd");
  const failureEvents: CodexAskEvent[] = [];
  const failing = await CodexAskRuntime.connect(
    preparedDashboard(),
    options(failureHome, failureCwd, (event) => failureEvents.push(event)),
  );
  const failureSession = await failing.start();
  await assert.rejects(
    failing.run(failureSession, "dashboard-step-fails"),
    /required step 'compose_layout' failed/,
  );
  assert.deepEqual(
    failureEvents
      .filter((event) => event.t === "agent_started")
      .map((event) => event.agentRole),
    ["warble_plan_dashboard", "warble_compose_layout"],
  );
  await failing.close();

  for (const scenario of ["dashboard-no-plan-tool", "dashboard-no-compose-tool"]) {
    const codexHome = temp(`${scenario}-home`);
    const cwd = temp(`${scenario}-cwd`);
    const runtime = await CodexAskRuntime.connect(preparedDashboard(), options(codexHome, cwd));
    const session = await runtime.start();
    await assert.rejects(runtime.run(session, scenario), /required MCP tool attempt/);
    await runtime.close();
  }

  const degradeHome = temp("dashboard-invalid-envelope-home");
  const degradeCwd = temp("dashboard-invalid-envelope-cwd");
  const events: CodexAskEvent[] = [];
  const degrading = await CodexAskRuntime.connect(
    preparedDashboard(),
    options(degradeHome, degradeCwd, (event) => events.push(event)),
  );
  const degradeSession = await degrading.start();
  const degraded = await degrading.run(degradeSession, "dashboard-invalid-envelope");
  assert.equal(degraded.artifact, null);
  assert.equal(degraded.renderDegraded, true);
  assert.ok(events.some((event) => event.t === "render_degraded"));
  await degrading.close();
});

test("dashboard timeout and cancellation cleanly recover without fallback", async () => {
  for (const mode of ["timeout", "cancel"] as const) {
    const codexHome = temp(`dashboard-${mode}-home`);
    const cwd = temp(`dashboard-${mode}-cwd`);
    const events: CodexAskEvent[] = [];
    const runtimeOptions = options(
      codexHome,
      cwd,
      (event) => events.push(event),
      mode === "timeout" ? 40 : 1_000,
    );
    const runtime = await CodexAskRuntime.connect(preparedDashboard(), runtimeOptions);
    const session = await runtime.start();
    if (mode === "timeout") {
      await assert.rejects(runtime.run(session, "ask-hold"), /timed out/);
      runtimeOptions.turnTimeoutMs = 1_000;
    } else {
      const controller = new AbortController();
      const run = runtime.run(session, "ask-hold", controller.signal);
      controller.abort();
      await assert.rejects(run, /cancelled/);
    }
    assert.ok(
      events.some(
        (event) =>
          event.t === "session_recoverable" &&
          event.reason === (mode === "timeout" ? "turn_timeout" : "turn_cancelled"),
      ),
    );
    assert.equal(events.filter((event) => event.t === "agent_started").length, 0);
    const resumed = await runtime.restartAndResume(session);
    const result = await runtime.run(resumed, "dashboard-success");
    assert.equal(result.artifact?.kind, "render_envelope");
    assert.equal(result.steps.length, 2);
    await runtime.close();
  }
});
