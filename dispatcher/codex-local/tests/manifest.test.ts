import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildAskManifest,
  buildManifest,
  describeAskTarget,
  describeTarget,
  prepareAllSetup,
} from "../src/index.js";
import { fakeMcp, preparedAsk, preparedDashboard, SETUP_IR_PATH } from "./helpers.js";

const GOLDEN = fileURLToPath(
  new URL("./fixtures/provision-agent.manifest.golden.json", import.meta.url),
);

function prepared() {
  return prepareAllSetup(readFileSync(SETUP_IR_PATH, "utf8"), {
    model: "gpt-5.4",
    mcp: fakeMcp(),
  });
}

test("target-resolved Setup manifest matches the committed golden", () => {
  const actual = buildManifest(prepared());
  const expected = JSON.parse(readFileSync(GOLDEN, "utf8"));
  assert.deepEqual(actual, expected);
});

test("describe exposes target, steps' tier surface, capabilities, tools, and guardrails", () => {
  assert.deepEqual(describeTarget(prepared()), {
    target: "codex:local",
    phase: "setup-only",
    execution_modes: ["one_shot", "persistent_session"],
    session_persistence: "codex_thread_history",
    lifecycle_operations: ["start", "resume", "read", "turn", "steer", "interrupt", "fork"],
    supported_components: ["attach_source", "compose_context"],
    tiers: ["strong"],
    capabilities: ["source_connect", "llm:strong", "context_build"],
    tools: ["probe_setup"],
    guardrails: ["setup_execution", "isolated_codex_config"],
  });
});

test("Ask manifest golden declares named agents, tier bindings, tools, and repair semantics", () => {
  const actual = buildAskManifest(preparedAsk());
  const golden = fileURLToPath(
    new URL("./fixtures/genbi-ask.manifest.golden.json", import.meta.url),
  );
  assert.deepEqual(actual, JSON.parse(readFileSync(golden, "utf8")));
  assert.deepEqual(
    actual.agents[0]!.steps.map((step) => [step.agent_role, step.tier, step.model]),
    [
      ["warble_resolve_intent", "cheap", "gpt-5.6-terra"],
      ["warble_generate_sql", "strong", "gpt-5.6-sol"],
      ["warble_repair_sql", "strong", "gpt-5.6-sol"],
    ],
  );
  assert.deepEqual(actual.agents[0]!.guardrails["conditional_repair"], {
    guard: { guard: "on_failure", target: "generate_sql" },
    max_attempts: 1,
    exhaustion: "loud_fail",
  });
});

test("Ask target description stays distinct from GenBI product enablement", () => {
  assert.deepEqual(describeAskTarget(preparedAsk()), {
    target: "codex:local",
    phase: "setup-and-ask-parity",
    execution_modes: ["persistent_session"],
    session_persistence: "codex_thread_history",
    lifecycle_operations: ["start", "resume", "read", "turn", "steer", "interrupt", "fork"],
    supported_components: ["answer_query"],
    tiers: ["cheap", "strong"],
    capabilities: ["sql_execution:read_only", "llm:per_step_tier", "llm:strong", "llm:cheap"],
    tools: ["get_context", "run_sql"],
    guardrails: [
      "read_only_execution",
      "deterministic_gate",
      "row_limit",
      "statement_timeout",
      "ordered_delegation",
      "conditional_repair",
      "isolated_codex_config",
    ],
  });
});

test("dashboard manifest and description expose render and consumer-persisted artifact parity", () => {
  const prepared = preparedDashboard();
  const manifest = buildAskManifest(prepared);
  const golden = fileURLToPath(
    new URL("./fixtures/genbi-dashboard.manifest.golden.json", import.meta.url),
  );
  assert.deepEqual(manifest, JSON.parse(readFileSync(golden, "utf8")));
  assert.equal(manifest.session.artifact_reference, "allowlisted_mcp_tool_result_or_render_envelope");
  assert.deepEqual(manifest.agents[0]!.artifact_output, {
    kind: "render_envelope",
    persistence: "consumer",
    block_types: ["kpi_card", "table", "chart", "definition"],
  });
  assert.deepEqual(
    manifest.agents[0]!.steps.map((step) => [step.name, step.agent_role, step.tier, step.model, step.tools]),
    [
      ["plan_dashboard", "warble_plan_dashboard", "strong", "gpt-5.6-sol", ["get_context"]],
      ["compose_layout", "warble_compose_layout", "cheap", "gpt-5.6-terra", ["run_sql"]],
    ],
  );
  assert.deepEqual(describeAskTarget(prepared), {
    target: "codex:local",
    phase: "setup-ask-and-dashboard-parity",
    execution_modes: ["persistent_session"],
    session_persistence: "codex_thread_history",
    lifecycle_operations: ["start", "resume", "read", "turn", "steer", "interrupt", "fork"],
    supported_components: ["generate_dashboard"],
    tiers: ["strong", "cheap"],
    capabilities: [
      "sql_execution:read_only",
      "genbi_build",
      "render_contract",
      "artifact_write",
      "llm:per_step_tier",
      "llm:strong",
      "llm:cheap",
    ],
    tools: ["get_context", "run_sql"],
    guardrails: [
      "read_only_execution",
      "artifact_write",
      "render_contract",
      "ordered_delegation",
      "isolated_codex_config",
    ],
  });
});
