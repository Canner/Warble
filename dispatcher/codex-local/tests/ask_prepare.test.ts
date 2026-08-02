import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CodexDispatchError, prepareAsk } from "../src/index.js";
import { ASK_IR_PATH, fakeAskMcp } from "./helpers.js";

const raw = readFileSync(ASK_IR_PATH, "utf8");
const models = {
  orchestrator: "gpt-5.6",
  cheap: "gpt-5.6-terra",
  strong: "gpt-5.6-sol",
};

test("prepares three named Ask agents with per-step tier models and minimum tools", () => {
  const prepared = prepareAsk({
    ir: raw,
    component: "answer_query",
    models,
    mcp: fakeAskMcp(),
  });
  assert.deepEqual(
    prepared.steps.map((step) => ({
      name: step.name,
      role: step.role,
      tier: step.tier,
      model: step.model,
      consumes: step.consumes,
      produces: step.produces,
      conditional: step.conditional,
      when: step.when,
      tools: step.enabledTools,
    })),
    [
      {
        name: "resolve_intent",
        role: "warble_resolve_intent",
        tier: "cheap",
        model: "gpt-5.6-terra",
        consumes: [],
        produces: "query_intent",
        conditional: false,
        when: null,
        tools: ["get_context"],
      },
      {
        name: "generate_sql",
        role: "warble_generate_sql",
        tier: "strong",
        model: "gpt-5.6-sol",
        consumes: ["query_intent"],
        produces: "query_result",
        conditional: false,
        when: null,
        tools: ["run_sql"],
      },
      {
        name: "repair_sql",
        role: "warble_repair_sql",
        tier: "strong",
        model: "gpt-5.6-sol",
        consumes: ["query_result"],
        produces: "repaired_result",
        conditional: true,
        when: { guard: "on_failure", target: "generate_sql" },
        tools: ["run_sql"],
      },
    ],
  );
  assert.equal(prepared.maxRepairAttempts, 1);
});

test("Ask legality is structural and does not branch on component identity", () => {
  const renamed = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const node = renamed.components.find((candidate) => candidate["id"] === "answer_query")!;
  node["id"] = "custom_read_only_question";
  node["verb"] = "custom_read_only_question";
  const prepared = prepareAsk({
    ir: JSON.stringify(renamed),
    component: "custom_read_only_question",
    models,
    mcp: fakeAskMcp(),
  });
  assert.equal(prepared.componentId, "custom_read_only_question");
  assert.deepEqual(prepared.steps.map((step) => step.name), [
    "resolve_intent",
    "generate_sql",
    "repair_sql",
  ]);
});

test("Ask loud-fails on flattened tiers, broken data flow, or unbounded guard shape", () => {
  const mutations: Array<(node: Record<string, unknown>) => void> = [
    (node) => {
      (node["llm_calls"] as Array<Record<string, unknown>>)[0]!["tier"] = "strong";
    },
    (node) => {
      (node["llm_calls"] as Array<Record<string, unknown>>)[1]!["consumes"] = [];
    },
    (node) => {
      (node["llm_calls"] as Array<Record<string, unknown>>)[2]!["when"] = {
        guard: "on_flag",
        target: "query_result.failed",
      };
    },
  ];
  for (const mutate of mutations) {
    const changed = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
    const node = changed.components.find((candidate) => candidate["id"] === "answer_query")!;
    mutate(node);
    assert.throws(
      () =>
        prepareAsk({
          ir: JSON.stringify(changed),
          component: "answer_query",
          models,
          mcp: fakeAskMcp(),
        }),
      CodexDispatchError,
    );
  }
});

test("Ask loud-fails on extra capabilities, changed safety bounds, or non-exact step tools", () => {
  const extraCapability = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const extraNode = extraCapability.components.find((candidate) => candidate["id"] === "answer_query")!;
  (extraNode["required_capabilities"] as string[]).push("human_approval");
  assert.throws(
    () =>
      prepareAsk({
        ir: JSON.stringify(extraCapability),
        component: "answer_query",
        models,
        mcp: fakeAskMcp(),
      }),
    /capability set/,
  );

  const changedBound = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const boundNode = changedBound.components.find((candidate) => candidate["id"] === "answer_query")!;
  const rowLimit = (boundNode["guardrails"] as Array<Record<string, unknown>>).find(
    (guard) => guard["name"] === "row_limit",
  )!;
  rowLimit["threshold"] = 10_000;
  assert.throws(
    () =>
      prepareAsk({
        ir: JSON.stringify(changedBound),
        component: "answer_query",
        models,
        mcp: fakeAskMcp(),
      }),
    /guardrails/,
  );

  for (const [step, tools] of [
    ["resolve_intent", []],
    ["resolve_intent", ["run_sql"]],
    ["resolve_intent", ["get_context", "list_models"]],
    ["generate_sql", []],
    ["generate_sql", ["dry_run"]],
    ["generate_sql", ["run_sql", "dry_run"]],
    ["repair_sql", []],
    ["repair_sql", ["get_context"]],
    ["repair_sql", ["run_sql", "dry_run"]],
  ] as Array<[string, string[]]>) {
    const changedTools = fakeAskMcp();
    changedTools.toolsByStep[step] = tools;
    assert.throws(
      () => prepareAsk({ ir: raw, component: "answer_query", models, mcp: changedTools }),
      /requires exact MCP tools/,
      `${step}: ${tools.join(",")}`,
    );
  }
});
