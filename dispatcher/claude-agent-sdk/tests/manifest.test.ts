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
import { prepareDispatch, prepareDisplayManifest, UNAVAILABLE_COMPONENT_REASON } from "../src/dispatch.js";
import { parseIr } from "../src/ir.js";
import { buildManifest, buildAgentManifest, type AgentManifest, type AvailableAgentManifest } from "../src/manifest.js";

const GENBI_DEFAULT_IR = fileURLToPath(
  new URL("../../../genbi-default/ir.golden.json", import.meta.url),
);
const ENRICH_IR = fileURLToPath(
  new URL("../../../genbi-enrich-context/ir.golden.json", import.meta.url),
);

function manifest() {
  const raw = readFileSync(GENBI_DEFAULT_IR, "utf8");
  const prepared = prepareDispatch({ ir: raw, irPath: GENBI_DEFAULT_IR });
  return buildManifest(prepared, raw);
}

/** genbi-default's golden IR with `brief` injected onto the named component — none of the
 * shipping goldens author one, so this is the only way to exercise the manifest's brief
 * pass-through without touching a shipping profile's fixture. */
function manifestWithBrief(verb: string, brief: string) {
  const parsed = JSON.parse(readFileSync(GENBI_DEFAULT_IR, "utf8"));
  const target = parsed.components.find((c: { verb: string }) => c.verb === verb);
  assert.ok(target, `component with verb '${verb}' must exist in genbi-default's golden IR`);
  target.brief = brief;
  const raw = JSON.stringify(parsed);
  const prepared = prepareDispatch({ ir: raw, irPath: GENBI_DEFAULT_IR });
  return buildManifest(prepared, raw);
}

function byId(agents: AgentManifest[], id: string): AvailableAgentManifest {
  const a = agents.find((a) => a.id === id);
  assert.ok(a, `agent '${id}' must be present in the manifest`);
  assert.ok(!("availability" in a), `agent '${id}' must be available in the default manifest`);
  return a!;
}

test("manifest top-level shape: manifest_version, compat, profile, target", () => {
  const m = manifest();
  assert.equal(m.manifest_version, "0.1");
  assert.deepEqual(m.compat, { min_ir_version: "0.5", max_ir_version: "0.5" });
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
  for (const declaredAgent of m.agents) {
    assert.ok(!("availability" in declaredAgent), `agent '${declaredAgent.id}' must be available in the default manifest`);
    const agent = declaredAgent as AvailableAgentManifest;
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

test("brief is absent from the manifest key set when the component authors none", () => {
  const agent = byId(manifest().agents, "generate_dashboard");
  assert.ok(!("brief" in agent), "genbi-default's golden IR authors no brief; the key must be absent, not null/empty");
});

test("brief carries through into the manifest verbatim when the IR node has one", () => {
  const m = manifestWithBrief("generate_dashboard", "Shared framing for this agent's steps.");
  const agent = byId(m.agents, "generate_dashboard");
  assert.equal(agent.brief, "Shared framing for this agent's steps.");
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

test("raw_material_read is exposed as the native SDK Read binding in the manifest", () => {
  const raw = readFileSync(GENBI_DEFAULT_IR, "utf8");
  const ir = parseIr(raw);
  const first = ir.components[0]!;
  const prepared = prepareDispatch({
    ir: {
      ...ir,
      components: [
        {
          ...first,
          required_capabilities: [...first.required_capabilities, "raw_material_read"],
        },
      ],
    },
  });
  const agent = buildAgentManifest(prepared.components[0]!);
  assert.ok(agent.tools.some((tool) => tool.name === "read_raw_material" && tool.source === "sdk-read"));
  const capability = agent.capabilities.find((entry) => entry.capability === "raw_material_read");
  assert.equal(capability?.outcome, "native");
});

test("display preparation includes every enrichment component but exposes an unavailable component without a plan or capabilities", () => {
  const raw = readFileSync(ENRICH_IR, "utf8");
  const prepared = prepareDisplayManifest({ ir: raw, irPath: ENRICH_IR });
  const manifest = buildManifest(prepared, raw);
  assert.deepEqual(manifest.agents.map((agent) => agent.id), ["inspect_context", "draft_enrichment", "apply_enrichment"]);

  const unavailable = manifest.agents.find((agent) => agent.id === "apply_enrichment");
  assert.deepEqual(unavailable, {
    id: "apply_enrichment",
    verb: "apply_enrichment",
    component_type: "constitutive",
    realization_kind: "gated-tool",
    trigger: "one_shot",
    outcome: "mutation",
    steps: [],
    guardrails: {},
    tools: [],
    output_schema: {},
    capabilities: [],
    availability: { status: "unavailable", reason: UNAVAILABLE_COMPONENT_REASON },
  });
  assert.ok(!("plan" in prepared.components.find((component) => component.id === "apply_enrichment")!));
  assert.deepEqual(unavailable!.capabilities, []);
});
