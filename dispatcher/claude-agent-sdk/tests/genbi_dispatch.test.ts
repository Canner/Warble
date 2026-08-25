import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Dispatch smoke for the genbi-default flagship profile on the second back-end (Agent SDK / local).
// Proves the same golden IR the Rust file target consumes also legalizes here: four component plans,
// with the phase-1.2 additions (semantic_introspection → Bash on explore_model, narrative → realize
// render on explain_change) resolving without a fail.
import { prepareDispatch } from "../src/index.js";

const GENBI_DEFAULT_IR = fileURLToPath(
  new URL("../../../genbi-default/ir.golden.json", import.meta.url),
);

function prepared() {
  return prepareDispatch({
    ir: readFileSync(GENBI_DEFAULT_IR, "utf8"),
    question: "give me an overview",
    irPath: GENBI_DEFAULT_IR,
  });
}

function byVerb(p: ReturnType<typeof prepared>, verb: string) {
  const c = p.components.find((c) => c.node.verb === verb);
  assert.ok(c, `component '${verb}' must be prepared`);
  return c!;
}

test("prepareDispatch legalizes all four genbi-default components on claude-agent-sdk:local", () => {
  const p = prepared();
  assert.equal(p.target, "claude-agent-sdk:local");
  assert.deepEqual(
    p.components.map((c) => c.node.verb),
    ["explore_model", "answer_query", "generate_dashboard", "explain_change"],
  );
  // No component's capability resolution contains a fail (prepareDispatch would have thrown).
  for (const c of p.components) {
    assert.ok(!c.report.some((r) => r.outcome === "fail"), `${c.node.verb} has no failing capability`);
  }
});

test("explore_model: single cheap agent, semantic_introspection grants Bash, no render", () => {
  const c = byVerb(prepared(), "explore_model");
  assert.equal(c.plan.meta.split, false, "single tier → no split");
  assert.equal(c.plan.meta.model, "haiku", "cheap tier → haiku (default binding)");
  assert.equal(c.plan.meta.readOnly, true);
  assert.equal(c.plan.meta.render.kind, "none", "render_blocks [] → no render");
  assert.ok(
    ((c.plan.options.tools as string[] | undefined) ?? []).includes("Bash"),
    "semantic_introspection must grant the Bash (wren) tool",
  );
  assert.ok(c.report.some((r) => r.capability === "semantic_introspection" && r.outcome === "realize-via"));
});

test("answer_query: 3-step split, no render (table emitted as {columns,rows})", () => {
  const c = byVerb(prepared(), "answer_query");
  assert.equal(c.plan.meta.split, true, "two tiers → split");
  assert.equal(c.plan.meta.render.kind, "none", "no artifact_write → no render section");
  assert.equal(c.plan.meta.readOnly, true);
});

test("answer_query (split, data-access): driver session enables Bash but does not auto-allow it", () => {
  // Regression: the SDK clamps each Task subagent's tools to the tools enabled at the PARENT
  // session level. If the split driver's `tools` omitted Bash (as it used to, on the theory that
  // withholding it "forces" delegation), the wren-running subagents would never actually receive
  // Bash and every answer_query call would refuse with "no shell/bash tool available" — confirmed
  // by a parity spike (2026-07-15). Bash must be enabled here so subagents can inherit it, while
  // staying out of `allowedTools` so every call still routes through the canUseTool semantic gate.
  const c = byVerb(prepared(), "answer_query");
  const tools = (c.plan.options.tools as string[] | undefined) ?? [];
  const allowedTools = (c.plan.options.allowedTools as string[] | undefined) ?? [];
  assert.ok(tools.includes("Bash"), "driver session must enable Bash so Task subagents can inherit it");
  assert.ok(!allowedTools.includes("Bash"), "Bash must NOT be auto-allowed — canUseTool must gate every call");
});

test("generate_dashboard: split + realize render (locked contract)", () => {
  const c = byVerb(prepared(), "generate_dashboard");
  assert.equal(c.plan.meta.split, true);
  assert.equal(c.plan.meta.render.kind, "realize", "artifact_write + render_blocks → realize");
  assert.equal(c.plan.meta.readOnly, true);
});

test("explain_change: single strong agent, realize render (narrative)", () => {
  const c = byVerb(prepared(), "explain_change");
  assert.equal(c.plan.meta.split, false, "both steps strong → single tier, no split");
  assert.equal(c.plan.meta.model, "opus", "strong tier → opus");
  assert.equal(c.plan.meta.render.kind, "realize");
  assert.equal(c.plan.meta.readOnly, true);
});

// --- Phase 1.3: hero render contract (verified facet + definition block + explicit verify gate) ---

test("generate_dashboard: locked render_blocks include a definition block with sql/source_tables/filters fields", () => {
  const c = byVerb(prepared(), "generate_dashboard");
  const def = c.node.effect.render_blocks.find((b) => b.type === "definition");
  assert.ok(def, "a `definition` block must be in the locked render contract");
  assert.deepEqual(
    Object.keys(def!.fields).sort(),
    ["filters", "source_tables", "sql"],
    "definition block must declare sql/source_tables/filters fields",
  );
});

test("generate_dashboard: driver system prompt carries the verify+definition contract and the verified facet", () => {
  const c = byVerb(prepared(), "generate_dashboard");
  const sp = c.plan.options.systemPrompt as string;
  assert.match(sp, /per-answer verify/, "must state the per-answer verify requirement");
  assert.match(sp, /REFUSE/, "must carry the refuse-on-unvalidated-result path");
  assert.match(sp, /"verified": true/, "envelope example must show the verified facet");
});
