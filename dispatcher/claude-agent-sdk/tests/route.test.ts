import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Per-step provider routing (hybrid-LLM spike, §9.2 layer 3 / D4). Proves: the SAME compiled IR that
// splits all-cloud into SDK subagents routes into the hybrid-staged executor when a tier binds to a
// local provider — with no IR change and no loud-fail. All offline (no ollama, no Claude).
import { parseIr, type ComponentNode, type WarbleIr } from "../src/ir.js";
import { resolveNodeCapabilities } from "../src/resolve.js";
import { ModelConfig } from "../src/models.js";
import { buildDispatchPlan, shouldSplitPerStepTier, type BuildConfig } from "../src/options.js";
import {
  planProviderRouting,
  resolveStagedSteps,
  distinctProviders,
  usesLocalProvider,
  buildStepMessages,
  type StagedStep,
} from "../src/route.js";
import { localProfile } from "../src/targets.js";

const DEMO_AGENT_IR = fileURLToPath(new URL("../../../examples/demo-agent/ir.golden.json", import.meta.url));
const GENBI_DEFAULT_IR = fileURLToPath(new URL("../../../genbi-default/ir.golden.json", import.meta.url));
const TARGET = "claude-agent-sdk:local";

function ir(path: string): WarbleIr {
  return parseIr(readFileSync(path, "utf8"));
}
function firstNode(path: string): ComponentNode {
  return ir(path).components[0]!;
}
function nodeByVerb(path: string, verb: string): ComponentNode {
  const n = ir(path).components.find((c) => c.verb === verb);
  assert.ok(n, `component '${verb}' present`);
  return n!;
}

/** A binding where the `cheap` tier is a local ollama model and `strong`/`orchestrator` stay cloud. */
const HYBRID_CHEAP_LOCAL = `
tiers:
  strong: opus
  cheap:
    provider: openai_compat
    endpoint: http://localhost:11434/v1
    model: qwen2.5
  orchestrator: sonnet
`;

// --- the mode decision -------------------------------------------------------------------------

test("all-cloud multi-tier component routes to sdk-split (unchanged path)", () => {
  const n = firstNode(DEMO_AGENT_IR); // generate_dashboard: strong + cheap
  const plan = planProviderRouting(n, ModelConfig.default(), shouldSplitPerStepTier(n));
  assert.equal(plan.mode, "sdk-split");
  assert.deepEqual(plan.providers, ["anthropic"]);
});

test("a local-provider tier flips the same component to hybrid-staged", () => {
  const n = firstNode(DEMO_AGENT_IR);
  const models = ModelConfig.fromYaml(HYBRID_CHEAP_LOCAL);
  const plan = planProviderRouting(n, models, shouldSplitPerStepTier(n));
  assert.equal(plan.mode, "hybrid-staged");
  // generate_dashboard steps are plan_dashboard@strong (cloud) then compose_layout@cheap (local).
  assert.deepEqual(plan.providers, ["anthropic", "openai_compat"]);
});

test("answer_query (3 steps, cheap→local) resolves each step's provider/endpoint/model", () => {
  const n = nodeByVerb(GENBI_DEFAULT_IR, "answer_query");
  const steps = resolveStagedSteps(n, ModelConfig.fromYaml(HYBRID_CHEAP_LOCAL));
  const resolve = steps.find((s) => s.name === "resolve_intent")!;
  const generate = steps.find((s) => s.name === "generate_sql")!;
  assert.equal(resolve.provider, "openai_compat");
  assert.equal(resolve.endpoint, "http://localhost:11434/v1");
  assert.equal(resolve.model, "qwen2.5");
  assert.equal(generate.provider, "anthropic");
  assert.equal(generate.model, "opus");
  // IO contract carried through for marshaling: resolve produces query_intent, generate consumes it.
  assert.equal(resolve.produces, "query_intent");
  assert.deepEqual(generate.consumes, ["query_intent"]);
});

test("usesLocalProvider / distinctProviders reflect the resolved steps", () => {
  const cloud = resolveStagedSteps(firstNode(DEMO_AGENT_IR), ModelConfig.default());
  assert.equal(usesLocalProvider(cloud), false);
  assert.deepEqual(distinctProviders(cloud), ["anthropic"]);

  const hybrid = resolveStagedSteps(firstNode(DEMO_AGENT_IR), ModelConfig.fromYaml(HYBRID_CHEAP_LOCAL));
  assert.equal(usesLocalProvider(hybrid), true);
});

// --- buildDispatchPlan integration: no loud-fail, no SDK agents on the hybrid path -------------

function planFor(node: ComponentNode, models: ModelConfig) {
  const report = resolveNodeCapabilities(node, TARGET);
  const cfg: BuildConfig = {
    target: TARGET,
    flavor: "programmatic",
    models,
    question: "how many orders",
    cwd: "/abs/examples/jaffle-wren",
  };
  return buildDispatchPlan(node, report, cfg);
}

test("hybrid answer_query: buildDispatchPlan does NOT loud-fail (local step bypasses agents[].model)", () => {
  const n = nodeByVerb(GENBI_DEFAULT_IR, "answer_query");
  const plan = planFor(n, ModelConfig.fromYaml(HYBRID_CHEAP_LOCAL));
  assert.equal(plan.meta.mode, "hybrid-staged");
  assert.equal(plan.meta.stagedSteps.length, 3);
  assert.equal(plan.options.agents, undefined, "hybrid path builds NO SDK agents (would loud-fail)");
  assert.deepEqual(plan.meta.providers, ["openai_compat", "anthropic"]);
});

test("same IR, all-cloud binding: answer_query still splits into SDK subagents (regression guard)", () => {
  const n = nodeByVerb(GENBI_DEFAULT_IR, "answer_query");
  const plan = planFor(n, ModelConfig.default());
  assert.equal(plan.meta.mode, "sdk-split");
  assert.ok(plan.options.agents, "all-cloud multi-tier still uses agents");
});

test("the target declares llm:per_step_provider realize-via (the hybrid support flag)", () => {
  // The binding-time gate reads this: a target whose profile lacks it (or marks it fail) loud-fails on
  // a non-Anthropic binding. This SDK target supports hybrid, so it must declare realize-via.
  const e = localProfile()["llm:per_step_provider"];
  assert.ok(e, "profile must declare llm:per_step_provider");
  assert.equal(e.outcome, "realize-via");
  assert.notEqual(e.outcome, "fail");
});

test("hybrid on a realize-render component is a documented wall-hit (POC scope)", () => {
  // genbi-default generate_dashboard has a realize render gate; hybrid-staged render is not in POC.
  const n = nodeByVerb(GENBI_DEFAULT_IR, "generate_dashboard");
  assert.throws(
    () => planFor(n, ModelConfig.fromYaml(HYBRID_CHEAP_LOCAL)),
    (e: unknown) => e instanceof Error && /hybrid-staged.*render gate.*wall-hit/.test(e.message),
  );
});

// --- marshaling ---------------------------------------------------------------------------------

test("buildStepMessages puts the step prompt as system and marshals consumed slots into the user turn", () => {
  const step: StagedStep = {
    name: "generate_sql",
    tier: "strong",
    provider: "anthropic",
    endpoint: null,
    model: "opus",
    consumes: ["query_intent"],
    produces: "query_result",
    prompt: "Write SQL for the intent.",
    conditional: false,
    when: null,
  };
  const msgs = buildStepMessages(step, "how many orders", { query_intent: "count of orders" });
  assert.equal(msgs[0]!.role, "system");
  assert.equal(msgs[0]!.content, "Write SQL for the intent.");
  assert.equal(msgs[1]!.role, "user");
  assert.match(msgs[1]!.content, /how many orders/);
  assert.match(msgs[1]!.content, /Input 'query_intent':\ncount of orders/);
});

test("buildStepMessages flags a missing upstream slot instead of silently dropping it", () => {
  const step: StagedStep = {
    name: "generate_sql", tier: "strong", provider: "anthropic", endpoint: null, model: "opus",
    consumes: ["query_intent"], produces: null, prompt: "p", conditional: false, when: null,
  };
  const msgs = buildStepMessages(step, "q", {});
  assert.match(msgs[1]!.content, /input 'query_intent' was not produced/);
});
