import { test } from "node:test";
import assert from "node:assert/strict";

// hybrid-tool realization: the orchestrator drives the sequence by calling `dispatch_step`, and the
// driver prompt must stay PROVIDER-AGNOSTIC (binding lives in the handler, not the prompt) so the same
// prompt shape holds whether the binding is all-cloud or hybrid. Offline (no SDK, no network).
import { buildToolDriverPrompt } from "../src/hybridTool.js";
import type { StagedStep } from "../src/route.js";

function step(name: string, over: Partial<StagedStep> = {}): StagedStep {
  return {
    name,
    tier: over.tier ?? "strong",
    provider: over.provider ?? "anthropic",
    endpoint: over.endpoint ?? null,
    model: over.model ?? "opus",
    consumes: over.consumes ?? [],
    produces: over.produces ?? null,
    prompt: over.prompt ?? "do it",
    conditional: over.conditional ?? false,
  };
}

const ANSWER_QUERY: StagedStep[] = [
  step("resolve_intent", { tier: "cheap", provider: "openai_compat", endpoint: "http://localhost:11434/v1", model: "qwen2.5", produces: "query_intent" }),
  step("generate_sql", { consumes: ["query_intent"], produces: "query_result" }),
  step("repair_sql", { consumes: ["query_result"], conditional: true }),
];

test("driver prompt lists steps in order and names the dispatch_step tool", () => {
  const p = buildToolDriverPrompt(ANSWER_QUERY);
  assert.match(p, /dispatch_step/);
  const iResolve = p.indexOf("resolve_intent");
  const iGen = p.indexOf("generate_sql");
  const iRepair = p.indexOf("repair_sql");
  assert.ok(iResolve < iGen && iGen < iRepair, "steps appear in IR order");
});

test("driver prompt carries the produces→consumes marshaling instruction", () => {
  const p = buildToolDriverPrompt(ANSWER_QUERY);
  // generate_sql consumes query_intent (produced by resolve_intent) → the prompt should point at it.
  assert.match(p, /step "resolve_intent" returned/);
  assert.match(p, /inputs/);
});

test("driver prompt is PROVIDER-AGNOSTIC — no provider/endpoint/model leaks in", () => {
  const p = buildToolDriverPrompt(ANSWER_QUERY);
  for (const leak of ["openai_compat", "anthropic", "ollama", "qwen2.5", "opus", "localhost:11434", "local", "cloud"]) {
    assert.ok(!p.includes(leak), `driver prompt must not mention '${leak}' (binding stays in the handler)`);
  }
});

test("conditional step is flagged as conditional, not unconditional", () => {
  const p = buildToolDriverPrompt(ANSWER_QUERY);
  assert.match(p, /Only if.*needs repair/i);
});
