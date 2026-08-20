import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Offline turnkey acceptance (G7): the genbi-default flagship profile, from raw golden IR JSON to a
// fully legalized dispatch plan, with no live SDK call — proves the whole profile "just works" out of
// the box on this back-end without needing a running agent or a network.
import { parseIr, prepareDispatch, type PreparedComponent } from "../src/index.js";

const GENBI_DEFAULT_IR_PATH = fileURLToPath(
  new URL("../../../genbi-default/ir.golden.json", import.meta.url),
);
const GENBI_DEFAULT_IR_RAW = readFileSync(GENBI_DEFAULT_IR_PATH, "utf8");

function byVerb(components: PreparedComponent[], verb: string): PreparedComponent {
  const c = components.find((c) => c.node.verb === verb);
  assert.ok(c, `component '${verb}' must be prepared`);
  return c!;
}

test("turnkey: genbi-default golden IR carries no profile-level config", () => {
  const ir = parseIr(GENBI_DEFAULT_IR_RAW);
  assert.equal(ir.profile, "genbi-default");
  // IR 0.6 emptied `config` when `tier_policy` was removed. Asserting the block is empty is the
  // guard against re-introducing a field the back-ends carry but nothing reads.
  assert.deepEqual(ir.config, {});
});

test("turnkey: all four genbi-default components legalize with no failing capability", () => {
  const p = prepareDispatch({
    ir: GENBI_DEFAULT_IR_RAW,
    question: "give me an overview",
    irPath: GENBI_DEFAULT_IR_PATH,
  });
  assert.deepEqual(
    p.components.map((c) => c.node.verb).sort(),
    ["answer_query", "explain_change", "explore_model", "generate_dashboard"],
  );
  for (const c of p.components) {
    assert.ok(
      !c.report.some((r) => r.outcome === "fail"),
      `${c.node.verb} must have no failing capability`,
    );
  }
});

test("turnkey: generate_dashboard resolves to a realize render gate carrying the definition block + verified facet instruction", () => {
  const p = prepareDispatch({
    ir: GENBI_DEFAULT_IR_RAW,
    question: "give me an overview",
    irPath: GENBI_DEFAULT_IR_PATH,
  });
  const c = byVerb(p.components, "generate_dashboard");
  assert.equal(c.plan.meta.render.kind, "realize");

  const def = c.node.effect.render_blocks.find((b) => b.type === "definition");
  assert.ok(def, "generate_dashboard must carry a `definition` render block");

  const sp = c.plan.options.systemPrompt as string;
  assert.match(sp, /"verified": true/, "system prompt must show the verified facet in the envelope example");
});

test("turnkey: answer_query carries the locked deterministic_gate guardrail and its prompt makes verify explicit", () => {
  const p = prepareDispatch({
    ir: GENBI_DEFAULT_IR_RAW,
    question: "give me an overview",
    irPath: GENBI_DEFAULT_IR_PATH,
  });
  const c = byVerb(p.components, "answer_query");
  const gate = c.node.guardrails.find((g) => g.name === "deterministic_gate");
  assert.ok(gate, "answer_query must carry the deterministic_gate guardrail");
  assert.equal(gate!.locked, true, "deterministic_gate must be locked (non-overridable)");

  // The split path folds each step's prompt into the driver's delegation instructions — the
  // deterministic-gate wording lives in the step prompts (generate_sql/repair_sql), which the
  // driver's system prompt must reference in the course of delegating to its subagents.
  assert.equal(c.plan.meta.split, true, "two tiers (cheap + strong) → per-step-tier split");
  const agents = c.plan.options.agents;
  assert.ok(agents, "split path must produce an SDK agents map");
  const generateSql = agents!["answer_query__generate_sql"];
  const repairSql = agents!["answer_query__repair_sql"];
  assert.ok(generateSql, "generate_sql subagent must be present");
  assert.ok(repairSql, "repair_sql subagent must be present");
  assert.match(generateSql!.prompt as string, /[Vv]erify the result set/, "generate_sql prompt makes verify explicit");
  assert.match(generateSql!.prompt as string, /deterministic gate/, "generate_sql prompt names the deterministic gate");
  assert.match(repairSql!.prompt as string, /REFUSE/, "repair_sql prompt carries the refuse-on-unvalidated-result path");
});

test("turnkey: every genbi-default component packages an eval template_ref", () => {
  const p = prepareDispatch({
    ir: GENBI_DEFAULT_IR_RAW,
    question: "give me an overview",
    irPath: GENBI_DEFAULT_IR_PATH,
  });
  for (const c of p.components) {
    assert.ok(c.node.eval, `${c.node.verb} must carry an eval spec`);
    assert.ok(
      typeof c.node.eval!.template_ref === "string" && c.node.eval!.template_ref.length > 0,
      `${c.node.verb}'s eval.template_ref must be a non-empty string`,
    );
  }
});
