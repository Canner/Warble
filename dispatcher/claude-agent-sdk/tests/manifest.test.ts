import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The `manifest` command's display output for the genbi-default flagship profile: a structural
// snapshot (agents/steps/tiers/capabilities/guardrails) for the claude-agent-sdk:local target, shaped
// like the vercel back-end's bundle so a consumer can source a display from whichever back-end
// actually runs. Proves the same golden IR the Rust bundle target consumes also produces a
// structurally equivalent manifest here — no `query()` call involved (prepareDispatch is called with
// no `question`, exactly as `emit` does).
import { prepareDispatch } from "../src/dispatch.js";
import { buildManifest, buildAgentManifest, type AgentManifest } from "../src/manifest.js";

const GENBI_DEFAULT_IR = fileURLToPath(
  new URL("../../../genbi-default/ir.golden.json", import.meta.url),
);

function manifest() {
  const raw = readFileSync(GENBI_DEFAULT_IR, "utf8");
  const prepared = prepareDispatch({ ir: raw, irPath: GENBI_DEFAULT_IR });
  return buildManifest(prepared, raw);
}

function byId(agents: AgentManifest[], id: string): AgentManifest {
  const a = agents.find((a) => a.id === id);
  assert.ok(a, `agent '${id}' must be present in the manifest`);
  return a!;
}

test("manifest top-level shape: manifest_version, compat, profile, target", () => {
  const m = manifest();
  assert.equal(m.manifest_version, "0.1");
  assert.deepEqual(m.compat, { min_ir_version: "0.3", max_ir_version: "0.3" });
  assert.equal(m.profile, "genbi-default");
  assert.equal(m.target, "claude-agent-sdk:local");
  assert.deepEqual(
    m.agents.map((a) => a.id),
    ["explore_model", "answer_query", "generate_dashboard", "explain_change"],
  );
});

test("each agent carries the full AgentManifest key set", () => {
  const m = manifest();
  const expectedKeys = [
    "id",
    "verb",
    "component_type",
    "realization_kind",
    "trigger",
    "outcome",
    "steps",
    "guardrails",
    "tools",
    "output_schema",
    "capabilities",
  ].sort();
  for (const agent of m.agents) {
    assert.deepEqual(Object.keys(agent).sort(), expectedKeys, `agent '${agent.id}' key set`);
    for (const step of agent.steps) {
      assert.ok(typeof step.name === "string" && step.name.length > 0);
      assert.ok(typeof step.tier === "string" && step.tier.length > 0);
      assert.ok(Array.isArray(step.consumes));
      assert.ok(typeof step.prompt === "string" && step.prompt.length > 0);
      assert.ok(["independent", "repair_fold", "guarded_skip"].includes(step.realization.kind));
    }
  }
});

test("generate_dashboard: enum spellings match the vercel bundle's serialization", () => {
  const agent = byId(manifest().agents, "generate_dashboard");
  assert.equal(agent.component_type, "analytical");
  assert.equal(agent.realization_kind, "skill");
  assert.equal(agent.trigger, "one_shot");
  assert.equal(agent.outcome, "none");
  assert.deepEqual(
    agent.steps.map((s) => s.name),
    ["plan_dashboard", "compose_layout"],
  );
});

test("generate_dashboard: guardrails, tools, output_schema, capabilities are all populated", () => {
  const agent = byId(manifest().agents, "generate_dashboard");

  assert.deepEqual(agent.guardrails, {
    artifact_write: { enforcement: "scoped_write", locked: true, scope: "." },
    read_only_execution: { enforcement: "read_only", locked: true },
  });

  assert.ok(agent.tools.length > 0, "must derive at least one tool ref");
  for (const tool of agent.tools) {
    assert.ok(typeof tool.name === "string" && tool.name.length > 0);
    assert.ok(typeof tool.source === "string" && tool.source.length > 0);
  }
  // Non-callable capabilities (LLM tiers, render contract, authz, …) must never surface as tools.
  assert.ok(!agent.tools.some((t) => t.name.startsWith("llm")));

  const schema = agent.output_schema as { type: string; required: string[] };
  assert.equal(schema.type, "object");
  assert.ok(schema.required.includes("blocks"));

  assert.ok(agent.capabilities.length > 0);
  assert.ok(!agent.capabilities.some((c) => c.outcome === "fail"), "no capability may resolve to fail");
});

test("a conditional step (answer_query's repair_sql) classifies as repair_fold, not independent", () => {
  const agent = byId(manifest().agents, "answer_query");
  const conditional = agent.steps.filter((s) => s.when !== undefined);
  assert.ok(conditional.length > 0, "answer_query must have at least one guarded step");
  for (const step of conditional) {
    assert.notEqual(step.realization.kind, "independent");
  }
  const repairSql = agent.steps.find((s) => s.name === "repair_sql");
  assert.ok(repairSql, "repair_sql step must be present");
  assert.deepEqual(repairSql!.realization, {
    kind: "repair_fold",
    fold_into: "generate_sql",
    max_attempts: 1,
  });
});

test("buildAgentManifest matches the per-agent entry buildManifest produces for the same component", () => {
  const raw = readFileSync(GENBI_DEFAULT_IR, "utf8");
  const prepared = prepareDispatch({ ir: raw, irPath: GENBI_DEFAULT_IR });
  const component = prepared.components.find((c) => c.id === "answer_query")!;
  assert.deepEqual(buildAgentManifest(component), byId(manifest().agents, "answer_query"));
});
