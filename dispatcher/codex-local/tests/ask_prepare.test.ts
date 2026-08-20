import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CodexDispatchError, prepareAsk, SUPPORTED_IR_VERSION } from "../src/index.js";
import { ASK_IR_PATH, fakeAskMcp } from "./helpers.js";

const raw = readFileSync(ASK_IR_PATH, "utf8");
const models = {
  orchestrator: "gpt-5.6",
  cheap: "gpt-5.6-terra",
  strong: "gpt-5.6-sol",
};

test("Ask preparation accepts the current IR version and loud-fails the prior one it was bumped from", () => {
  // Same lockstep guard as prepareSetup: this dispatcher's Ask path used to check against "0.3"
  // via an inline literal (independently of prepareSetup's), so a rebase or partial edit could
  // silently leave it accepting the pre-bump version while prepareSetup was fixed.
  assert.equal(SUPPORTED_IR_VERSION, "0.6");

  const current = JSON.parse(raw) as { warble_ir_version: string };
  assert.equal(current.warble_ir_version, "0.6");
  assert.doesNotThrow(() =>
    prepareAsk({ ir: raw, component: "answer_query", models, mcp: fakeAskMcp() }),
  );

  const stale = JSON.parse(raw) as { warble_ir_version: string };
  stale.warble_ir_version = "0.3";
  assert.throws(
    () =>
      prepareAsk({
        ir: JSON.stringify(stale),
        component: "answer_query",
        models,
        mcp: fakeAskMcp(),
      }),
    (error: unknown) =>
      error instanceof CodexDispatchError &&
      error.message.includes("0.3") &&
      error.message.includes(SUPPORTED_IR_VERSION),
  );
});

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

test("Ask preparation accepts a component named 'apply_enrichment' as long as its declared contract is honest", () => {
  // A component's id/verb carries no dispatch meaning (invariant #1) — including the literal
  // string "apply_enrichment", which used to be treated as reserved purely by name. A legitimately
  // Ask-shaped component that happens to share that name is dispatchable like any other.
  const renamed = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const node = renamed.components.find((candidate) => candidate["id"] === "answer_query")!;
  node["id"] = "apply_enrichment";
  node["verb"] = "apply_enrichment";

  const prepared = prepareAsk({
    ir: JSON.stringify(renamed),
    component: "apply_enrichment",
    models,
    mcp: fakeAskMcp(),
  });
  assert.equal(prepared.componentId, "apply_enrichment");
});

test("Ask loud-fails on unsupported tiers, broken data flow, or unbounded guard shape", () => {
  const mutations: Array<(node: Record<string, unknown>) => void> = [
    (node) => {
      // Tier order is no longer fixed per position (decision-58 loosening below proves that),
      // but the tier value itself must still be one of the two supported tiers.
      (node["llm_calls"] as Array<Record<string, unknown>>)[0]!["tier"] = "medium";
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
    (node) => {
      // Chain invariant: once a repair step appears, no later step may be unconditional — an
      // always-run step cannot honestly depend on a conditionally-produced value, and the
      // runtime's active.spawns[i] <-> steps[i] alignment has no gap-skipping support. Pinned by
      // reordering within the existing 3-step bound (no step added, so this cannot be satisfied by
      // the unrelated out-of-bounds MCP-allowlist wall instead): step 1 stays the unconditional
      // first step; step 2 becomes an on_failure repair of step 1; step 3 stays unconditional and
      // consumes step 2's output — the shape the `sawConditional` guard exists to reject.
      const calls = node["llm_calls"] as Array<Record<string, unknown>>;
      const first = calls[0]!;
      const second = calls[1]!;
      second["conditional"] = true;
      second["when"] = { guard: "on_failure", target: first["name"] };
      second["consumes"] = [first["produces"]];
      const third = calls[2]!;
      third["conditional"] = false;
      third["when"] = null;
      third["consumes"] = [second["produces"]];
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

test("Ask accepts any per-step tier assignment as long as the chain shape holds (decision-58 loosening)", () => {
  const swapped = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const node = swapped.components.find((candidate) => candidate["id"] === "answer_query")!;
  const calls = node["llm_calls"] as Array<Record<string, unknown>>;
  calls[0]!["tier"] = "strong";
  calls[1]!["tier"] = "cheap";
  calls[2]!["tier"] = "cheap";
  const prepared = prepareAsk({
    ir: JSON.stringify(swapped),
    component: "answer_query",
    models,
    mcp: fakeAskMcp(),
  });
  assert.deepEqual(
    prepared.steps.map((step) => step.tier),
    ["strong", "cheap", "cheap"],
  );
});

test("Ask loud-fails a chain-valid step beyond the declared MCP tool allowlist length", () => {
  const extended = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const node = extended.components.find((candidate) => candidate["id"] === "answer_query")!;
  const calls = node["llm_calls"] as Array<Record<string, unknown>>;
  // Insert a fourth, unconditional step ahead of the repair so the chain stays valid (no
  // unconditional step follows the repair), while still exceeding TOOLS_BY_EXECUTION_KIND's
  // three declared entries for answer_query.
  const second = calls[1]!;
  calls.splice(2, 0, {
    name: "extra_step",
    tier: "cheap",
    prompt: "extra step",
    consumes: [second["produces"]],
    produces: "extra_output",
    conditional: false,
    when: null,
  });
  const repair = calls[3] as Record<string, unknown>;
  repair["consumes"] = ["extra_output"];
  repair["when"] = { guard: "on_failure", target: "extra_step" };
  const mcp = fakeAskMcp();
  mcp.toolsByStep["extra_step"] = ["run_sql"];
  assert.throws(
    () =>
      prepareAsk({
        ir: JSON.stringify(extended),
        component: "answer_query",
        models,
        mcp,
      }),
    /no declared MCP tool allowlist/,
  );
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

test("Ask rejects the dispatcher-reserved request transport MCP server name", () => {
  assert.throws(
    () =>
      prepareAsk({
        ir: raw,
        component: "answer_query",
        models,
        mcp: { ...fakeAskMcp(), name: "warble_request_transport" },
      }),
    /reserved by the Ask request transport/,
  );
});
