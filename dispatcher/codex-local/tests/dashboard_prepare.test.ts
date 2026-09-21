import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CodexDispatchError, prepareOrchestrate } from "../src/index.js";
import { ASK_IR_PATH, fakeOrchestrateMcp, uncomposedDashboardIr } from "./helpers.js";

const canonicalRaw = readFileSync(ASK_IR_PATH, "utf8");
const raw = uncomposedDashboardIr();
const models = {
  orchestrator: "gpt-5.6",
  cheap: "gpt-5.6-terra",
  strong: "gpt-5.6-sol",
};

test("canonical composed dashboard wall-hits before Codex preparation", () => {
  assert.throws(
    () => prepareOrchestrate({
      ir: canonicalRaw,
      component: "generate_dashboard",
      models,
      mcp: fakeOrchestrateMcp(),
    }),
    (error: unknown) =>
      error instanceof CodexDispatchError &&
      /component_invocation.*codex:local.*wall-hit/.test(error.message),
  );
});

test("prepares the two dashboard agents from the existing IR contract", () => {
  const prepared = prepareOrchestrate({
    ir: raw,
    component: "generate_dashboard",
    models,
    mcp: fakeOrchestrateMcp(),
  });
  assert.equal(prepared.executionKind, "render_envelope");
  assert.equal(prepared.maxRepairAttempts, 0);
  assert.deepEqual(
    prepared.steps.map((step) => ({
      name: step.name,
      role: step.role,
      tier: step.tier,
      model: step.model,
      consumes: step.consumes,
      produces: step.produces,
      tools: step.enabledTools,
      requireSuccessfulTool: step.requireSuccessfulTool,
    })),
    [
      {
        name: "plan_dashboard",
        role: "warble_plan_dashboard",
        tier: "strong",
        model: "gpt-5.6-sol",
        consumes: [],
        produces: "dashboard_plan",
        tools: ["get_context"],
        requireSuccessfulTool: true,
      },
      {
        name: "compose_layout",
        role: "warble_compose_layout",
        tier: "cheap",
        model: "gpt-5.6-terra",
        consumes: ["dashboard_plan"],
        produces: "dashboard",
        tools: ["run_sql"],
        requireSuccessfulTool: true,
      },
    ],
  );
  assert.deepEqual(prepared.capabilities, [
    { capability: "sql_execution:read_only", outcome: "realize-via", via: "mcp:wren" },
    { capability: "genbi_build", outcome: "native", via: "validated-render-envelope" },
    { capability: "render_contract", outcome: "native", via: "validated-render-envelope" },
    { capability: "artifact_write", outcome: "realize-via", via: "consumer-persisted-render-envelope" },
    { capability: "llm:per_step_tier", outcome: "native", via: null },
    { capability: "llm:strong", outcome: "native", via: null },
    { capability: "llm:cheap", outcome: "native", via: null },
  ]);
});

test("dashboard legality is structural and does not branch on component identity", () => {
  const changed = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const node = changed.components.find((candidate) => candidate["id"] === "generate_dashboard")!;
  node["id"] = "custom_dashboard";
  node["verb"] = "custom_dashboard";
  const prepared = prepareOrchestrate({
    ir: JSON.stringify(changed),
    component: "custom_dashboard",
    models,
    mcp: fakeOrchestrateMcp(),
  });
  assert.equal(prepared.componentId, "custom_dashboard");
  assert.equal(prepared.executionKind, "render_envelope");
});

test("dashboard prepare accepts a render contract that differs from genbi's own", () => {
  const changed = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const node = changed.components.find((candidate) => candidate["id"] === "generate_dashboard")!;
  const customRenderBlocks = [
    { type: "metric_tile", fields: { title: "string", amount: "number" } },
    { type: "notes", fields: { text: "string" } },
  ];
  (node["effect"] as Record<string, unknown>)["render_blocks"] = customRenderBlocks;
  const prepared = prepareOrchestrate({
    ir: JSON.stringify(changed),
    component: "generate_dashboard",
    models,
    mcp: fakeOrchestrateMcp(),
  });
  assert.equal(prepared.executionKind, "render_envelope");
  assert.deepEqual(prepared.node.effect.render_blocks, customRenderBlocks);
});

test("dashboard loud-fails changed graph, capabilities, guardrails, malformed/empty render blocks, and tools", () => {
  const mutations: Array<(node: Record<string, unknown>) => void> = [
    (node) => {
      // Tier order is not fixed per position (a dedicated positive test below covers that), but
      // the tier value itself must still be supported.
      (node["llm_calls"] as Array<Record<string, unknown>>)[0]!["tier"] = "medium";
    },
    (node) => {
      (node["llm_calls"] as Array<Record<string, unknown>>)[1]!["consumes"] = [];
    },
    (node) => {
      (node["required_capabilities"] as string[]).push("human_approval");
    },
    (node) => {
      const artifact = (node["guardrails"] as Array<Record<string, unknown>>).find(
        (guard) => guard["name"] === "artifact_write",
      )!;
      artifact["scope"] = "../outside";
    },
    (node) => {
      const effect = node["effect"] as Record<string, unknown>;
      effect["render_blocks"] = "not-an-array";
    },
    (node) => {
      const effect = node["effect"] as Record<string, unknown>;
      const blocks = effect["render_blocks"] as Array<unknown>;
      blocks[0] = "not-an-object";
    },
    (node) => {
      const effect = node["effect"] as Record<string, unknown>;
      const blocks = effect["render_blocks"] as Array<Record<string, unknown>>;
      delete blocks[0]!["type"];
    },
    (node) => {
      const effect = node["effect"] as Record<string, unknown>;
      const blocks = effect["render_blocks"] as Array<Record<string, unknown>>;
      blocks[0]!["type"] = 42;
    },
    (node) => {
      const effect = node["effect"] as Record<string, unknown>;
      const blocks = effect["render_blocks"] as Array<Record<string, unknown>>;
      blocks[0]!["fields"] = "not-an-object";
    },
    (node) => {
      const effect = node["effect"] as Record<string, unknown>;
      const blocks = effect["render_blocks"] as Array<Record<string, unknown>>;
      (blocks[0]!["fields"] as Record<string, unknown>)["label"] = 42;
    },
    (node) => {
      const effect = node["effect"] as Record<string, unknown>;
      effect["render_blocks"] = [];
    },
  ];
  for (const mutate of mutations) {
    const changed = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
    const node = changed.components.find((candidate) => candidate["id"] === "generate_dashboard")!;
    mutate(node);
    assert.throws(
      () =>
        prepareOrchestrate({
          ir: JSON.stringify(changed),
          component: "generate_dashboard",
          models,
          mcp: fakeOrchestrateMcp(),
        }),
      CodexDispatchError,
    );
  }

  for (const [step, tools] of [
    ["plan_dashboard", []],
    ["plan_dashboard", ["run_sql"]],
    ["compose_layout", []],
    ["compose_layout", ["get_context"]],
    ["compose_layout", ["run_sql", "write_artifact"]],
  ] as Array<[string, string[]]>) {
    const mcp = fakeOrchestrateMcp();
    mcp.toolsByStep[step] = tools;
    if (tools.length === 0) {
      assert.throws(() => prepareOrchestrate({ ir: raw, component: "generate_dashboard", models, mcp }), /no allowlisted MCP tools/);
    } else {
      assert.deepEqual(prepareOrchestrate({ ir: raw, component: "generate_dashboard", models, mcp }).steps.find((candidate) => candidate.name === step)!.enabledTools, tools);
    }
  }
});

test("dashboard accepts any per-step tier assignment as long as the chain shape holds", () => {
  const swapped = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const node = swapped.components.find((candidate) => candidate["id"] === "generate_dashboard")!;
  const calls = node["llm_calls"] as Array<Record<string, unknown>>;
  calls[0]!["tier"] = "cheap";
  calls[1]!["tier"] = "strong";
  const prepared = prepareOrchestrate({
    ir: JSON.stringify(swapped),
    component: "generate_dashboard",
    models,
    mcp: fakeOrchestrateMcp(),
  });
  assert.deepEqual(
    prepared.steps.map((step) => step.tier),
    ["cheap", "strong"],
  );
});

test("render-envelope orchestration accepts a further step without granting it tools", () => {
  const extended = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const node = extended.components.find((candidate) => candidate["id"] === "generate_dashboard")!;
  const calls = node["llm_calls"] as Array<Record<string, unknown>>;
  const last = calls[calls.length - 1]!;
  calls.push({
    name: "extra_step",
    tier: "cheap",
    prompt: "extra step",
    consumes: [last["produces"]],
    produces: "extra_output",
    conditional: false,
    when: null,
  });
  const prepared = prepareOrchestrate({
        ir: JSON.stringify(extended),
        component: "generate_dashboard",
        models,
        mcp: fakeOrchestrateMcp(),
      });
  assert.equal(prepared.steps.length, 3);
  assert.deepEqual(prepared.steps[2]!.enabledTools, []);
  assert.equal(prepared.steps[2]!.requireSuccessfulTool, false);
});
