import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ComponentInvocationRuntime,
  ComponentStepExecutionError,
  DispatchError,
  ModelConfig,
  dispatch,
  normalizeComponentRequest,
  normalizeComponentResult,
  parseIr,
  prepareDispatch,
  runDispatch,
  type ComponentNode,
  type ComponentStepRunner,
  type RenderBlock,
  type WarbleIr,
} from "../src/index.js";

const dir = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(dir, "..", "..", "conformance-fixtures", "component-composition-unsupported.json");
const analysisGoldenPath = join(dir, "..", "..", "..", "examples", "analysis-agent", "ir.golden.json");

function fixtureIr(): WarbleIr {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { ir: unknown };
  return parseIr(JSON.stringify(fixture.ir));
}

function analysisIr(): WarbleIr {
  return parseIr(readFileSync(analysisGoldenPath, "utf8"));
}

function fakeWarbleRenderer(): string {
  const rendererDir = mkdtempSync(join(tmpdir(), "warble-component-renderer-"));
  const script = join(rendererDir, "warble");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      'previous=""',
      'output=""',
      'for argument in "$@"; do',
      '  if [ "$previous" = "--out" ]; then output="$argument"; fi',
      '  previous="$argument"',
      "done",
      'echo "<!doctype html>canonical dashboard" > "$output"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return script;
}

function prepare(ir = fixtureIr()) {
  return prepareDispatch({ ir, componentId: "caller", question: "root question" });
}

function result(text: string, turns = 1, totalCostUsd = 0) {
  return { text, turns, totalCostUsd, usage: [], degradation: null };
}

test("request normalization accepts only the target-neutral request envelope", () => {
  assert.deepEqual(normalizeComponentRequest({ request: "answer", input: { panel: "revenue" } }), {
    value: { request: "answer", input: { panel: "revenue" } },
    bytes: 48,
  });
  for (const invalid of [
    { request: "" },
    { request: "answer", input: [] },
    { request: "answer", component: "forged" },
    { request: "answer", input: { invalid: undefined } },
    { request: "answer", input: { invalid: Number.NaN } },
  ]) {
    const normalized = normalizeComponentRequest(invalid);
    assert.ok("error" in normalized);
    if ("error" in normalized) assert.equal(normalized.error.status === "error" && normalized.error.code, "invalid_request");
  }
  const oversized = normalizeComponentRequest({ request: "x".repeat(70_000) });
  assert.ok("error" in oversized);
});

test("result normalization preserves values and lifts standard provenance", () => {
  const normalized = normalizeComponentResult(
    JSON.stringify({ rows: [[42]], verified: true, definition: { sql: "select 42" } }),
    [],
  );
  assert.equal(normalized.value.status, "ok");
  if (normalized.value.status === "ok") {
    assert.equal(normalized.value.output.kind, "value");
    assert.deepEqual(normalized.value.provenance, { verified: true, definition: { sql: "select 42" } });
  }
});

test("refusal remains a refusal and sanitizes paths or SQL from its public message", () => {
  const secret = "sk-test-SECRET";
  const normalized = normalizeComponentResult(
    `{"status":"refused","message":"provider token ${secret} at path=/private/key.txt after SELECT secret FROM keys"}`,
    [],
  );
  assert.equal(normalized.value.status, "refused");
  if (normalized.value.status === "refused") {
    assert.equal(normalized.value.code, "callee_refused");
    assert.equal(normalized.value.message, "The callee refused the request.");
    assert.ok(!normalized.value.message.includes(secret));
  }
});

test("callee render envelopes are validated against the callee contract without rendering", () => {
  const contract = [{ type: "card", fields: { label: "string", value: "number" } }];
  const ok = normalizeComponentResult('{"blocks":[{"type":"card","label":"Revenue","value":42}],"summary":"ok","verified":true}', contract);
  assert.equal(ok.value.status, "ok");
  if (ok.value.status === "ok") assert.equal(ok.value.output.kind, "render");
  const bad = normalizeComponentResult('{"blocks":[{"type":"card","label":"Revenue","value":"42"}]}', contract);
  assert.equal(bad.value.status === "error" && bad.value.code, "invalid_result");
});

test("table and chart render contracts accept positional rows and reject object rows", () => {
  const contract: RenderBlock[] = [
    { type: "table", fields: { columns: "string[]", rows: "row[]" } },
    { type: "chart", fields: { chart_type: "bar|line", x: "string", series: "string[]", rows: "row[]" } },
  ];
  const ok = normalizeComponentResult(JSON.stringify({ blocks: [
    { type: "table", columns: ["month", "revenue"], rows: [["2026-08", 42]] },
    { type: "chart", chart_type: "bar", x: "month", series: ["revenue"], rows: [["2026-08", 42]] },
  ] }), contract);
  assert.equal(ok.value.status, "ok");
  const bad = normalizeComponentResult(JSON.stringify({ blocks: [
    { type: "table", columns: ["month", "revenue"], rows: [{ month: "2026-08", revenue: 42 }] },
  ] }), contract);
  assert.equal(bad.value.status === "error" && bad.value.code, "invalid_result");
});

test("only aliases declared on the trusted active step are exposed and arbitrary targets cannot redirect", async () => {
  const seen: string[][] = [];
  const runner: ComponentStepRunner = async (run) => {
    seen.push([...run.aliases]);
    if (run.component.id === "caller") {
      const injected = await run.invoke("answer", { request: "bounded", component: "forged" });
      assert.equal(injected.status === "error" && injected.code, "invalid_request");
      const child = await run.invoke("answer", { request: "bounded", input: {} });
      return result(JSON.stringify(child));
    }
    assert.deepEqual(run.aliases, []);
    return result('{"answer":42,"verified":true}');
  };
  const runtime = new ComponentInvocationRuntime({ prepared: prepare(), runStep: runner, newId: (() => { let id = 0; return () => `id-${++id}`; })() });
  const root = await runtime.runRoot("caller", { request: "root" });
  assert.deepEqual(seen, [["answer"], []]);
  assert.equal(root.componentCalls.length, 1);
  assert.equal(root.componentCalls[0]!.callee_mount, "callee");
});

test("an unauthorized alias is a terminal security failure even when a runner tries to catch it", async () => {
  const runner: ComponentStepRunner = async (run) => {
    if (run.component.id === "caller") {
      await assert.rejects(() => run.invoke("forged", { request: "bounded" }), /unauthorized_call/);
      return result('{"tried_to_continue":true}');
    }
    return result('{"unexpected":true}');
  };
  const runtime = new ComponentInvocationRuntime({ prepared: prepare(), runStep: runner });
  await assert.rejects(() => runtime.runRoot("caller", { request: "root" }), /cancelled/);
});

test("completed callees may be called repeatedly as fresh attempts", async () => {
  let childRuns = 0;
  const runner: ComponentStepRunner = async (run) => {
    if (run.component.id === "caller") {
      const first = await run.invoke("answer", { request: "one" });
      const second = await run.invoke("answer", { request: "two" });
      return result(JSON.stringify({ first, second }));
    }
    childRuns += 1;
    return result(JSON.stringify({ childRuns }));
  };
  const runtime = new ComponentInvocationRuntime({ prepared: prepare(), runStep: runner });
  const root = await runtime.runRoot("caller", { request: "root" });
  assert.equal(childRuns, 2);
  assert.equal(root.componentCalls.length, 2);
  assert.ok(root.componentCalls.every((call) => call.status === "ok"));
});

test("canonical dashboard composes repeated verified answer_query values under isolated authority", async () => {
  const ir = analysisIr();
  let runs = 0;
  const prepared = prepareDispatch({
    ir,
    componentId: "generate_dashboard",
    question: "Build a revenue dashboard",
  });
  assert.equal(runs, 0, "the complete transitive closure is prepared before any step runs");
  assert.deepEqual(prepared.dependencies, [{
    caller: "generate_dashboard",
    step: "compose_layout",
    alias: "answer",
    component: "answer_query",
  }]);
  assert.deepEqual(prepared.components.map((component) => component.id), ["generate_dashboard"]);
  assert.deepEqual(prepared.preparedCallees.map((component) => component.id), ["answer_query"]);

  const stepRuns: string[] = [];
  const tools: Record<string, unknown> = {};
  const runner: ComponentStepRunner = async (run) => {
    runs += 1;
    stepRuns.push(`${run.component.id}.${run.step.name}`);
    tools[run.component.id] = run.component.plan.options.tools;
    if (run.component.id === "generate_dashboard" && run.step.name === "plan_dashboard") {
      assert.deepEqual(run.aliases, []);
      return result(JSON.stringify({ panels: [
        { title: "Revenue", type: "kpi_card", question: "What is total revenue?" },
        { title: "Revenue by month", type: "table", question: "What is monthly revenue?" },
      ] }));
    }
    if (run.component.id === "generate_dashboard" && run.step.name === "compose_layout") {
      assert.deepEqual(run.aliases, ["answer"]);
      assert.match(run.artifacts.dashboard_plan!, /Revenue by month/);
      const revenue = await run.invoke("answer", {
        request: "What is total revenue?",
        input: { title: "Revenue", type: "kpi_card" },
      });
      const monthly = await run.invoke("answer", {
        request: "What is monthly revenue?",
        input: { title: "Revenue by month", type: "table" },
      });
      for (const answer of [revenue, monthly]) {
        assert.equal(answer.status, "ok");
        if (answer.status !== "ok") throw new Error("expected a successful answer result");
        assert.equal(answer.output.kind, "value");
        if (answer.output.kind !== "value") throw new Error("expected a normalized value result");
        const value = answer.output.value as Record<string, unknown>;
        assert.equal(value.verified, true);
        for (const field of ["columns", "rows", "summary", "definition"]) {
          assert.ok(field in value, `verified answer must contain ${field}`);
        }
      }
      return result(JSON.stringify({
        blocks: [
          { type: "kpi_card", label: "Revenue", value: 42000 },
          { type: "table", columns: ["month", "revenue"], rows: [["2026-08", 42000]] },
          { type: "definition", sql: "SELECT month, revenue", source_tables: ["orders"], filters: [] },
        ],
        summary: "Revenue was 42,000 in August 2026.",
      }));
    }
    assert.equal(run.component.id, "answer_query");
    assert.deepEqual(run.aliases, []);
    if (run.step.name === "resolve_intent") return result(JSON.stringify({ question: run.request.request }));
    const monthly = run.request.request.includes("monthly");
    return result(JSON.stringify({
      columns: monthly ? ["month", "revenue"] : ["revenue"],
      rows: monthly ? [["2026-08", 42000]] : [[42000]],
      summary: monthly ? "Revenue was 42,000 in August 2026." : "Total revenue was 42,000.",
      verified: true,
      definition: { sql: monthly ? "SELECT month, revenue" : "SELECT revenue", source_tables: ["orders"], filters: [] },
    }));
  };

  const outDir = mkdtempSync(join(tmpdir(), "warble-canonical-dashboard-"));
  const outcome = await dispatch(
    { ir, componentId: "generate_dashboard", question: "Build a revenue dashboard" },
    { outDir, warbleBin: fakeWarbleRenderer(), componentStepRunner: runner },
  );
  assert.equal(runs, 6);
  assert.deepEqual(stepRuns, [
    "generate_dashboard.plan_dashboard",
    "generate_dashboard.compose_layout",
    "answer_query.resolve_intent",
    "answer_query.generate_sql",
    "answer_query.resolve_intent",
    "answer_query.generate_sql",
  ]);
  assert.deepEqual(tools.generate_dashboard, ["Task", "Read"]);
  assert.deepEqual(tools.answer_query, ["Task", "Read", "Bash"]);
  const dashboardOutcome = outcome.components[0];
  assert.ok(dashboardOutcome);
  const componentCalls = dashboardOutcome.result.trace.componentCalls ?? [];
  assert.equal(componentCalls.length, 2);
  assert.equal(new Set(componentCalls.map((call) => call.call_id)).size, 2);
  assert.ok(componentCalls.every((call) =>
    call.caller_mount === "generate_dashboard" &&
    call.trusted_step_id === "compose_layout" &&
    call.alias === "answer" &&
    call.callee_mount === "answer_query" &&
    call.status === "ok"
  ));
  assert.deepEqual(readdirSync(outDir).sort(), ["dashboard.html", "result.txt", "trace.json"]);
  const rootText = readFileSync(join(outDir, "result.txt"), "utf8");
  const dashboard = ir.components.find((component) => component.id === "generate_dashboard")!;
  const normalized = normalizeComponentResult(rootText, dashboard.effect.render_blocks);
  assert.equal(normalized.value.status, "ok");
  if (normalized.value.status === "ok") assert.equal(normalized.value.output.kind, "render");
});

test("canonical dashboard rejects an invalid answer result before root persistence", async () => {
  const ir = analysisIr();
  const outDir = mkdtempSync(join(tmpdir(), "warble-canonical-dashboard-invalid-"));
  const runner: ComponentStepRunner = async (run) => {
    if (run.component.id === "generate_dashboard" && run.step.name === "plan_dashboard") {
      return result('{"panels":[{"question":"What is revenue?"}]}');
    }
    if (run.component.id === "generate_dashboard") {
      const answer = await run.invoke("answer", { request: "What is revenue?" });
      assert.equal(answer.status === "error" && answer.code, "invalid_result");
      throw new DispatchError("invalid_result: dashboard refused an invalid panel answer");
    }
    if (run.step.name === "resolve_intent") return result('{"question":"revenue"}');
    return result("not json");
  };
  await assert.rejects(
    () => dispatch(
      { ir, componentId: "generate_dashboard", question: "Build a revenue dashboard" },
      { outDir, componentStepRunner: runner },
    ),
    /invalid_result: dashboard refused an invalid panel answer/,
  );
  assert.deepEqual(readdirSync(outDir), []);
});

test("sibling component calls are serialized in runtime event order", async () => {
  let active = 0;
  let maxActive = 0;
  const runner: ComponentStepRunner = async (run) => {
    if (run.component.id === "caller") {
      const calls = await Promise.all([
        run.invoke("answer", { request: "one" }),
        run.invoke("answer", { request: "two" }),
      ]);
      return result(JSON.stringify(calls));
    }
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    return result('{"ok":true}');
  };
  const runtime = new ComponentInvocationRuntime({ prepared: prepare(), runStep: runner });
  await runtime.runRoot("caller", { request: "root" });
  assert.equal(maxActive, 1);
});

function transitiveIr(): WarbleIr {
  const ir = fixtureIr();
  const leaf = structuredClone(ir.components[1]!) as ComponentNode;
  leaf.id = "leaf";
  leaf.verb = "leaf";
  ir.components[1]!.llm_calls[0]!.component_calls = [{ alias: "leaf", component: "leaf" }];
  ir.components[1]!.required_capabilities.push("component_invocation");
  ir.components.push(leaf);
  return ir;
}

test("transitive calls use the same ledger and record parent-child identity", async () => {
  const runner: ComponentStepRunner = async (run) => {
    if (run.component.id === "caller") return result(JSON.stringify(await run.invoke("answer", { request: "middle" })));
    if (run.component.id === "callee") return result(JSON.stringify(await run.invoke("leaf", { request: "leaf" })));
    return result('{"value":"leaf"}');
  };
  const runtime = new ComponentInvocationRuntime({ prepared: prepare(transitiveIr()), runStep: runner, newId: (() => { let id = 0; return () => `id-${++id}`; })() });
  const root = await runtime.runRoot("caller", { request: "root" });
  assert.equal(root.componentCalls.length, 2);
  assert.equal(root.componentCalls[1]!.parent_call_id, root.componentCalls[0]!.call_id);
  assert.deepEqual(root.componentCalls.map((call) => call.depth), [1, 2]);
});

test("runtime ancestry rejects forged recursive re-entry", async () => {
  const original = prepare();
  const forged = {
    ...original,
    dependencies: [
      ...original.dependencies,
      { caller: "callee", step: "answer", alias: "again", component: "caller" },
    ],
  };
  const runner: ComponentStepRunner = async (run) => {
    if (run.component.id === "caller") return result(JSON.stringify(await run.invoke("answer", { request: "child" })));
    await assert.rejects(() => run.invoke("again", { request: "cycle" }), /recursive re-entry/);
    return result('{"safe":true}');
  };
  const runtime = new ComponentInvocationRuntime({ prepared: forged, runStep: runner });
  await assert.rejects(() => runtime.runRoot("caller", { request: "root" }), /cancelled/);
});

test("call and depth budgets fail deterministically without starting an unadmitted child", async () => {
  let children = 0;
  const runner: ComponentStepRunner = async (run) => {
    if (run.component.id === "caller") {
      const first = await run.invoke("answer", { request: "one" });
      const second = await run.invoke("answer", { request: "two" });
      assert.equal(first.status, "ok");
      assert.equal(second.status === "error" && second.code, "budget_exhausted");
      return result(JSON.stringify({ first, second }));
    }
    children += 1;
    return result('{"ok":true}');
  };
  const runtime = new ComponentInvocationRuntime({ prepared: prepare(), runStep: runner, limits: { maxAttempts: 1 } });
  await runtime.runRoot("caller", { request: "root" });
  assert.equal(children, 1);
});

test("child turn exhaustion returns the stable non-retryable budget error", async () => {
  const runner: ComponentStepRunner = async (run) => {
    if (run.component.id === "caller") {
      const child = await run.invoke("answer", { request: "too many turns" });
      assert.equal(child.status === "error" && child.code, "budget_exhausted");
      if (child.status === "error") assert.equal(child.retryable, false);
      return result(JSON.stringify(child));
    }
    return result('{"ok":true}', 5);
  };
  const runtime = new ComponentInvocationRuntime({ prepared: prepare(), runStep: runner, limits: { maxTurnsPerChild: 4 } });
  await runtime.runRoot("caller", { request: "root" });
});

test("root cancellation propagates and late child completion is discarded", async () => {
  const controller = new AbortController();
  let runtime!: ComponentInvocationRuntime;
  const runner: ComponentStepRunner = async (run) => {
    if (run.component.id === "caller") return result(JSON.stringify(await run.invoke("answer", { request: "child" })));
    controller.abort();
    assert.equal(run.signal.aborted, true);
    return result('{"late":true}');
  };
  runtime = new ComponentInvocationRuntime({ prepared: prepare(), runStep: runner, signal: controller.signal, now: () => 100 });
  await assert.rejects(() => runtime.runRoot("caller", { request: "root" }), /cancelled/);
  assert.equal(runtime.componentCalls[0]!.status, "late_discarded");
});

test("an elapsed root deadline closes admission before any model step starts", async () => {
  let runs = 0;
  const runtime = new ComponentInvocationRuntime({
    prepared: prepare(),
    runStep: async () => { runs += 1; return result('{"unexpected":true}'); },
    limits: { deadlineAt: 99 },
    now: () => 100,
  });
  await assert.rejects(() => runtime.runRoot("caller", { request: "root" }), /deadline|cancelled/);
  assert.equal(runs, 0);
});

test("turn and cost telemetry are shared across root and children", async () => {
  const runner: ComponentStepRunner = async (run) => {
    if (run.component.id === "caller") return { ...result(JSON.stringify(await run.invoke("answer", { request: "child" })), 2, 0.2) };
    return result('{"ok":true}', 3, 0.3);
  };
  const runtime = new ComponentInvocationRuntime({ prepared: prepare(), runStep: runner, limits: { maxTurns: 6, maxTurnsPerChild: 4 } });
  const root = await runtime.runRoot("caller", { request: "root" });
  assert.equal(root.turns, 5);
  assert.equal(root.totalCostUsd, 0.5);
  assert.equal(root.componentCalls[0]!.model_turns, 3);
});

test("active parent and child reservations cannot promise more than the shared turn cap", async () => {
  const allowances: number[] = [];
  const runner: ComponentStepRunner = async (run) => {
    allowances.push(run.maxTurns);
    if (run.component.id === "caller") {
      const child = await run.invoke("answer", { request: "child" });
      return result(JSON.stringify(child), 1);
    }
    return result('{"ok":true}', 1);
  };
  const runtime = new ComponentInvocationRuntime({
    prepared: prepare(),
    runStep: runner,
    limits: { maxTurns: 2, maxTurnsPerChild: 2 },
  });
  const root = await runtime.runRoot("caller", { request: "root" });
  assert.deepEqual(allowances, [1, 1]);
  assert.equal(root.turns, 2);
});

test("hard dollar caps are rejected before a composed run starts", async () => {
  assert.throws(
    () => new ComponentInvocationRuntime({
      prepared: prepare(),
      runStep: async () => result('{"unexpected":true}'),
      limits: { maxCostUsd: 1 },
    }),
    /unsupported_component_budget.*maxCostUsd/,
  );
  const outDir = mkdtempSync(join(tmpdir(), "warble-component-cost-preflight-"));
  let runs = 0;
  await assert.rejects(
    () => dispatch(
      { ir: fixtureIr(), componentId: "caller", question: "root" },
      {
        outDir,
        componentLimits: { maxCostUsd: 1 },
        componentStepRunner: async () => { runs += 1; return result('{"unexpected":true}'); },
      },
    ),
    /unsupported_component_budget.*maxCostUsd/,
  );
  assert.equal(runs, 0);
  assert.deepEqual(readdirSync(outDir), []);
});

test("transient transport failures are retryable but redacted, and traces contain no payload", async () => {
  const secret = "DO_NOT_PERSIST_PAYLOAD";
  const runner: ComponentStepRunner = async (run) => {
    if (run.component.id === "caller") return result(JSON.stringify(await run.invoke("answer", { request: secret })));
    throw new Error(`/private/path provider raw failure ${secret}`);
  };
  const runtime = new ComponentInvocationRuntime({ prepared: prepare(), runStep: runner });
  const root = await runtime.runRoot("caller", { request: "root" });
  assert.match(root.finalText, /transient_transport/);
  assert.match(root.finalText, /"retryable":true/);
  const trace = JSON.stringify(root.componentCalls);
  assert.ok(!trace.includes(secret));
  assert.ok(!trace.includes("/private/path"));
});

test("failed child telemetry remains charged and visible in the redacted attempt trace", async () => {
  const runner: ComponentStepRunner = async (run) => {
    if (run.component.id === "caller") return result(JSON.stringify(await run.invoke("answer", { request: "child" })));
    throw new ComponentStepExecutionError(
      "provider failure with private details",
      {
        text: "",
        turns: 2,
        totalCostUsd: 0.25,
        usage: [{ model: "haiku", usage: { input_tokens: 3, output_tokens: 1 } }],
        degradation: null,
      },
      false,
    );
  };
  const runtime = new ComponentInvocationRuntime({ prepared: prepare(), runStep: runner });
  const root = await runtime.runRoot("caller", { request: "root" });
  assert.equal(root.turns, 3);
  assert.equal(root.totalCostUsd, 0.25);
  assert.equal(root.componentCalls[0]!.model_turns, 2);
  assert.equal(root.componentCalls[0]!.total_cost_usd, 0.25);
  assert.deepEqual(root.componentCalls[0]!.token_usage, {
    input_tokens: 3,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
  assert.ok(!JSON.stringify(root.componentCalls).includes("private details"));
});

test("budget exhaustion is terminal even inside a repair-tolerant step", async () => {
  const ir = fixtureIr();
  const caller = ir.components[0]!;
  caller.llm_calls.push({
    name: "repair",
    tier: "cheap",
    consumes: [],
    produces: null,
    conditional: true,
    when: { guard: "on_failure", target: "invoke" },
    component_calls: [],
    prompt: "repair",
  });
  let rootRuns = 0;
  const runner: ComponentStepRunner = async (run) => {
    if (run.component.id === "caller") {
      rootRuns += 1;
      throw new DispatchError("budget_exhausted: no model turns remain");
    }
    return result('{"unexpected":true}');
  };
  const runtime = new ComponentInvocationRuntime({ prepared: prepare(ir), runStep: runner });
  await assert.rejects(() => runtime.runRoot("caller", { request: "root" }), /budget_exhausted/);
  assert.equal(rootRuns, 1);
});

test("a callee guardrail denial is a redacted non-retryable failure", async () => {
  const runner: ComponentStepRunner = async (run) => {
    if (run.component.id === "caller") return result(JSON.stringify(await run.invoke("answer", { request: "write data" })));
    throw new DispatchError("guardrail denied Bash: provider details must not escape");
  };
  const runtime = new ComponentInvocationRuntime({ prepared: prepare(), runStep: runner });
  const root = await runtime.runRoot("caller", { request: "root" });
  assert.match(root.finalText, /callee_failed/);
  assert.match(root.finalText, /"retryable":false/);
  assert.ok(!root.finalText.includes("Bash"));
});

test("unsupported callee preflight is atomic and runs no step", () => {
  const ir = fixtureIr();
  ir.components[1]!.effect.outcome.kind = "mutation";
  assert.throws(
    () => prepare(ir),
    (error: unknown) => error instanceof DispatchError && /unsupported_callee.*outcome 'mutation'/.test(error.message),
  );
});

test("composed preflight rejects a caller with any effective Bash command surface", () => {
  const ir = fixtureIr();
  ir.components[0]!.required_capabilities.push("genbi_build");
  assert.throws(() => prepare(ir), /effective Bash command surface.*SQL directly/);
});

test("composed preflight rejects unsupported providers on non-calling root steps", () => {
  const ir = fixtureIr();
  ir.components[0]!.llm_calls.push({
    name: "local_followup",
    tier: "local",
    consumes: [],
    produces: null,
    conditional: false,
    when: null,
    component_calls: [],
    prompt: "Follow up locally.",
  });
  const models = ModelConfig.fromYaml(`tiers:\n  cheap: haiku\n  local:\n    provider: openai_compat\n    endpoint: http://localhost:11434/v1\n    model: local-model\n  orchestrator: sonnet\n`);
  assert.throws(
    () => prepareDispatch({ ir, componentId: "caller", question: "root", models }),
    /provider 'openai_compat' on executable step 'local_followup'/,
  );
});

test("composed preflight rejects prompt-render roots instead of silently removing writes", () => {
  const ir = fixtureIr();
  const caller = ir.components[0]!;
  caller.required_capabilities.push("artifact_write", "render_contract");
  caller.guardrails.push({ name: "artifact_write", locked: true, scope: "." });
  caller.effect.render_blocks = [{ type: "table", fields: { columns: "string[]", rows: "row[]" } }];
  assert.throws(
    () => prepareDispatch({ ir, componentId: "caller", question: "root", flavor: "prompt" }),
    /prompt-render roots require model-owned artifact writes/,
  );
});

test("caller and callee keep their own tool authority instead of unioning it", async () => {
  const ir = fixtureIr();
  ir.components[1]!.required_capabilities.push("sql_execution:read_only");
  const seen: Record<string, unknown> = {};
  const runner: ComponentStepRunner = async (run) => {
    seen[run.component.id] = run.component.plan.options.tools;
    if (run.component.id === "caller") return result(JSON.stringify(await run.invoke("answer", { request: "sql" })));
    return result('{"rows":[[42]]}');
  };
  const runtime = new ComponentInvocationRuntime({ prepared: prepare(ir), runStep: runner });
  await runtime.runRoot("caller", { request: "root" });
  assert.deepEqual(seen["caller"], ["Read"]);
  assert.deepEqual(seen["callee"], ["Read", "Bash"]);
});

test("high-level composed dispatch persists only the root result and aggregate trace", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "warble-component-runtime-"));
  const runner: ComponentStepRunner = async (run) => {
    if (run.component.id === "caller") return result(JSON.stringify(await run.invoke("answer", { request: "child" })));
    return result('{"answer":42}');
  };
  const outcome = await dispatch(
    { ir: fixtureIr(), componentId: "caller", question: "root" },
    { outDir, componentStepRunner: runner },
  );
  assert.equal(outcome.components.length, 1);
  assert.deepEqual(readdirSync(outDir).sort(), ["result.txt", "trace.json"]);
  const trace = JSON.parse(readFileSync(join(outDir, "trace.json"), "utf8")) as { componentCalls: unknown[] };
  assert.equal(trace.componentCalls.length, 1);
});

test("high-level composed dispatch preserves the existing maxTurns input", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "warble-component-max-turns-"));
  const seen: number[] = [];
  await dispatch(
    { ir: fixtureIr(), componentId: "caller", question: "root", maxTurns: 1 },
    {
      outDir,
      componentStepRunner: async (run) => {
        seen.push(run.maxTurns);
        return result('{"root":true}', 1);
      },
    },
  );
  assert.deepEqual(seen, [1]);
});

test("low-level runDispatch rejects a composition plan that lacks its prepared registry", async () => {
  const prepared = prepare();
  const outDir = mkdtempSync(join(tmpdir(), "warble-component-low-level-"));
  await assert.rejects(
    () => runDispatch(prepared.components[0]!.plan, { outDir, warbleBin: "warble" }),
    /immutable prepared registry/,
  );
  assert.deepEqual(readdirSync(outDir), []);
});
