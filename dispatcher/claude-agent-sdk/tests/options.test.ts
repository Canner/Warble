import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseIr, type ComponentNode } from "../src/ir.js";
import { resolveNodeCapabilities } from "../src/resolve.js";
import { ModelConfig } from "../src/models.js";
import {
  buildDispatchPlan,
  buildMutationSection,
  shouldSplitPerStepTier,
  type BuildConfig,
} from "../src/options.js";
import { DispatchError } from "../src/error.js";

const DEMO_AGENT_IR = fileURLToPath(new URL("../../../examples/demo-agent/ir.golden.json", import.meta.url));
const RENDER_DEMO_IR = fileURLToPath(new URL("../../../examples/render-demo/ir.golden.json", import.meta.url));
const GENBI_SETUP_IR = fileURLToPath(new URL("../../../genbi-setup/ir.golden.json", import.meta.url));

const TARGET = "claude-agent-sdk:local";

function node(path: string): ComponentNode {
  return parseIr(readFileSync(path, "utf8")).components[0]!;
}

function nodeByVerb(path: string, verb: string): ComponentNode {
  const found = parseIr(readFileSync(path, "utf8")).components.find((c) => c.verb === verb);
  if (!found) throw new Error(`no component with verb '${verb}' in ${path}`);
  return found;
}

function planForNode(n: ComponentNode, over: Partial<BuildConfig> = {}) {
  const report = resolveNodeCapabilities(n, TARGET);
  const cfg: BuildConfig = {
    target: TARGET,
    flavor: "programmatic",
    models: ModelConfig.default(),
    question: "orders overview",
    cwd: "/abs/examples/jaffle-wren",
    ...over,
  };
  return buildDispatchPlan(n, report, cfg);
}

function planFor(path: string, over: Partial<BuildConfig> = {}) {
  return planForNode(node(path), over);
}

// --- single-tier collapse path (render-demo) ---------------------------------------------------

test("render-demo (single strong tier) maps to model=opus, cwd, and the question as prompt", () => {
  const plan = planFor(RENDER_DEMO_IR);
  assert.equal(plan.meta.split, false);
  assert.equal(plan.meta.model, "opus");
  assert.equal(plan.options.model, "opus");
  assert.equal(plan.options.cwd, "/abs/examples/jaffle-wren");
  assert.equal(plan.prompt, "orders overview");
  assert.equal(plan.options.permissionMode, "default");
});

test("read-only maps to: Bash NOT auto-allowed (canUseTool gates it), no Write tool, destructive bash denied", () => {
  const plan = planFor(RENDER_DEMO_IR); // programmatic flavor → agent stays read-only
  assert.deepEqual(plan.options.tools, ["Read", "Bash"]);
  assert.deepEqual(plan.options.allowedTools, ["Read"]); // Bash left to canUseTool
  assert.ok(!(plan.options.tools as string[]).includes("Write"), "no Write on programmatic flavor");
  assert.deepEqual(plan.options.disallowedTools, ["Bash(rm:*)", "Bash(sudo:*)", "Bash(dd:*)"]);
  assert.equal(plan.meta.readOnly, true);
});

// --- +Setup (genbi-setup: the 5th enforcement point, setup_execution) -------------------------

test("+Setup: connect_source grants Write+Edit+Bash, keeps the destructive-bash denylist, and sets meta.setupScope", () => {
  const n = nodeByVerb(GENBI_SETUP_IR, "connect_source");
  const plan = planForNode(n, { cwd: "/abs/scratch/new-project" });
  assert.ok((plan.options.tools as string[]).includes("Write"), "setup component grants Write");
  assert.ok((plan.options.tools as string[]).includes("Edit"), "setup component grants Edit");
  assert.ok((plan.options.tools as string[]).includes("Bash"), "setup component grants Bash");
  assert.deepEqual(
    plan.options.disallowedTools,
    ["Bash(rm:*)", "Bash(sudo:*)", "Bash(dd:*)"],
    "the destructive-bash denylist is retained even though setup is not read_only_execution",
  );
  assert.equal(plan.meta.setupScope, ".", "defaults to the project root");
  assert.equal(plan.meta.readOnly, false, "setup_execution is a distinct flavor from read_only_execution");
});

test("+Setup: build_context carries the same setupScope/tool shape as connect_source", () => {
  const n = nodeByVerb(GENBI_SETUP_IR, "build_context");
  const plan = planForNode(n, { cwd: "/abs/scratch/new-project" });
  assert.equal(plan.meta.setupScope, ".");
  assert.ok((plan.options.tools as string[]).includes("Write"));
  assert.deepEqual(plan.options.disallowedTools, ["Bash(rm:*)", "Bash(sudo:*)", "Bash(dd:*)"]);
});

test("non-setup component (render-demo) leaves meta.setupScope null", () => {
  const plan = planFor(RENDER_DEMO_IR);
  assert.equal(plan.meta.setupScope, null);
});

test("render_contract (realize-via) → programmatic envelope instructions in the system prompt", () => {
  const plan = planFor(RENDER_DEMO_IR, { flavor: "programmatic" });
  const sp = plan.options.systemPrompt as string;
  assert.match(sp, /## Render output/);
  assert.match(sp, /FINAL message must be a SINGLE JSON object/);
  assert.match(sp, /kpi_card/);
  assert.match(sp, /"blocks"/);
  assert.equal(plan.meta.render.kind, "realize");
  assert.equal(plan.meta.render.flavor, "programmatic");
  // Phase 1.3: the verify+definition contract (G2 hard line + G3 shallow card) is baked into every
  // programmatic render section, regardless of this component's own render_blocks.
  assert.match(sp, /per-answer verify/);
  assert.match(sp, /REFUSE/);
  assert.match(sp, /"verified": true/);
  assert.match(sp, /`definition`/);
});

test("render.onFailure derives from render_contract's resolved criticality: best-effort → degrade", () => {
  // localProfile() declares render_contract as best-effort (targets.ts) — the default, real path.
  const plan = planFor(RENDER_DEMO_IR, { flavor: "programmatic" });
  assert.equal(plan.meta.render.kind, "realize");
  assert.equal(plan.meta.render.onFailure, "degrade");
});

test("render.onFailure derives from render_contract's resolved criticality: required/safety-critical → fail (never silently degrades)", () => {
  const n = node(RENDER_DEMO_IR);
  const report = resolveNodeCapabilities(n, TARGET).map((r) =>
    r.capability === "render_contract" ? { ...r, criticality: "required" as const } : r,
  );
  const cfg: BuildConfig = {
    target: TARGET,
    flavor: "programmatic",
    models: ModelConfig.default(),
    question: "orders overview",
    cwd: "/abs/examples/jaffle-wren",
  };
  const plan = buildDispatchPlan(n, report, cfg);
  assert.equal(plan.meta.render.kind, "realize");
  assert.equal(plan.meta.render.onFailure, "fail");
});

test("prompt render flavor grants scoped Write and bakes the write-html instruction", () => {
  const plan = planFor(RENDER_DEMO_IR, { flavor: "prompt" });
  assert.ok((plan.options.tools as string[]).includes("Write"), "prompt flavor grants Write");
  assert.match(plan.options.systemPrompt as string, /write a SINGLE self-contained `dashboard\.html`/);
});

test("settingSources omitted (SDK isolation — no ambient allowlist can widen the gate)", () => {
  const plan = planFor(RENDER_DEMO_IR);
  assert.equal(plan.options.settingSources, undefined);
});

// --- per-step-tier split path (demo-agent) -----------------------------------------------------

test("demo-agent (strong+cheap) splits per-step-tier into in-loop subagents", () => {
  assert.equal(shouldSplitPerStepTier(node(DEMO_AGENT_IR)), true);
  const plan = planFor(DEMO_AGENT_IR);
  assert.equal(plan.meta.split, true);
  // driver runs the reserved orchestrator model and delegates (Task). The SDK clamps each Task
  // subagent's tools to what's enabled at this parent session level, so Bash must be enabled here
  // (a data-access component) for the subagents below to actually receive it — but it stays out of
  // `allowedTools`, so every call still routes through canUseTool (guardrails.ts); delegation is
  // enforced by the driver prompt, not by withholding the tool (parity spike, 2026-07-15).
  assert.equal(plan.options.model, "sonnet");
  assert.deepEqual(plan.options.tools, ["Task", "Read", "Bash"]);
  assert.deepEqual(plan.options.allowedTools, ["Read", "Task"]);

  const agents = plan.options.agents!;
  assert.deepEqual(Object.keys(agents).sort(), [
    "generate_dashboard__compose_layout",
    "generate_dashboard__plan_dashboard",
  ]);
  assert.equal(agents["generate_dashboard__plan_dashboard"]!.model, "opus"); // strong
  assert.equal(agents["generate_dashboard__compose_layout"]!.model, "haiku"); // cheap
  // subagents keep read-only data tools, never Write
  assert.deepEqual(agents["generate_dashboard__plan_dashboard"]!.tools, ["Read", "Bash"]);
});

test("custom (non-alias) tier on the split path loud-fails (SDK agents[].model constraint)", () => {
  const models = ModelConfig.fromFlags("qwen2.5", "haiku", "sonnet");
  assert.throws(
    () => planFor(DEMO_AGENT_IR, { models }),
    (e: unknown) => e instanceof DispatchError && /restricted alias union/.test((e as Error).message),
  );
});

// --- wall-hits (unsupported enum values loud-fail) ---------------------------------------------

test("unsupported trigger.kind loud-fails as a wall-hit", () => {
  // `scheduled` is now realized (+Assertive); `event` (activation by an inbound event) is not yet a
  // handler and stays a wall-hit even though its `event_bus` transport is realize-via.
  const n: ComponentNode = { ...node(RENDER_DEMO_IR), trigger: { kind: "event" } };
  assert.throws(
    () => buildDispatchPlan(n, [], {
      target: TARGET,
      flavor: "programmatic",
      models: ModelConfig.default(),
      question: "q",
      cwd: "/x",
    }),
    (e: unknown) => e instanceof DispatchError && /trigger\.kind 'event'.*wall-hit/.test((e as Error).message),
  );
});

test("unsupported outcome.kind ('dispatch') loud-fails as a wall-hit", () => {
  // `assertion`/`mutation` are now realized; `dispatch` (+Orchestrating) still loud-fails.
  const base = node(RENDER_DEMO_IR);
  const n: ComponentNode = { ...base, effect: { ...base.effect, outcome: { kind: "dispatch" } } };
  assert.throws(
    () => buildDispatchPlan(n, [], {
      target: TARGET,
      flavor: "programmatic",
      models: ModelConfig.default(),
      question: "q",
      cwd: "/x",
    }),
    (e: unknown) => e instanceof DispatchError && /outcome\.kind 'dispatch'.*wall-hit/.test((e as Error).message),
  );
});

test("mutation outcome.kind is now supported (+Mutating) — builds a plan with the mutation section", () => {
  const base = node(RENDER_DEMO_IR);
  const n: ComponentNode = {
    ...base,
    realization_kind: "gated-tool",
    effect: {
      ...base.effect,
      outcome: { kind: "mutation", target: "models/orders.yml", change_type: "update" },
    },
  };
  const plan = buildDispatchPlan(n, [], {
    target: TARGET,
    flavor: "programmatic",
    models: ModelConfig.default(),
    question: "q",
    cwd: "/x",
  });
  assert.equal(plan.meta.mutation, true);
  assert.match(plan.options.systemPrompt as string, /## Mutation output/);
});

test("gated-tool realization_kind is now supported (+Mutating)", () => {
  // `tool` is realized (+Assertive); `gated-tool` (a tool behind a hard approval gate) is the
  // +Mutating extension point and now builds too.
  const base = node(RENDER_DEMO_IR);
  const n: ComponentNode = {
    ...base,
    realization_kind: "gated-tool",
    effect: { ...base.effect, outcome: { kind: "mutation" } },
  };
  const plan = buildDispatchPlan(n, [], {
    target: TARGET,
    flavor: "programmatic",
    models: ModelConfig.default(),
    question: "q",
    cwd: "/x",
  });
  assert.equal(plan.meta.mutation, true);
});

test("+Assertive: tool · scheduled · assertion builds a read-only verdict plan with the assertion section", () => {
  const base = node(RENDER_DEMO_IR);
  const assertive: ComponentNode = {
    ...base,
    realization_kind: "tool",
    trigger: { kind: "scheduled" },
    effect: {
      render_blocks: [{ type: "status", fields: {} }],
      outcome: { kind: "assertion", verdict_type: "freshness_verdict", emits: ["freshness_breach"] },
    },
    borrowed_actions: ["notify_slack", "open_ticket"],
    // read-only floor kept; drop artifact_write/render_contract so it is a pure assertion.
    guardrails: base.guardrails.filter((g) => g.name !== "artifact_write"),
    required_capabilities: base.required_capabilities.filter(
      (c) => c !== "artifact_write" && c !== "render_contract" && c !== "llm:per_step_tier",
    ),
    // single tier so it takes the single-agent path (like monitor_freshness).
    llm_calls: base.llm_calls.map((c) => ({ ...c, tier: "cheap" })),
  };
  const plan = buildDispatchPlan(assertive, [], {
    target: TARGET,
    flavor: "programmatic",
    models: ModelConfig.default(),
    question: "is orders fresh?",
    cwd: "/x",
  });

  assert.equal(plan.meta.assertion, true);
  assert.equal(plan.meta.readOnly, true);
  // Read-only: no Write/Edit in the tool set.
  assert.ok(!(plan.options.tools as string[]).includes("Write"));
  assert.ok(!(plan.options.tools as string[]).includes("Edit"));
  const sys = plan.options.systemPrompt as string;
  assert.match(sys, /## Assertion output/);
  assert.match(sys, /freshness_verdict/);
  assert.match(sys, /DETERMINISTIC/);
  assert.match(sys, /freshness_breach/);
  assert.match(sys, /notify_slack|open_ticket/);
});

test("+Mutating: buildMutationSection describes the two-phase gated lifecycle", () => {
  const base = node(RENDER_DEMO_IR);
  const mutating: ComponentNode = {
    ...base,
    realization_kind: "gated-tool",
    effect: {
      ...base.effect,
      outcome: { kind: "mutation", target: "models/orders.yml", change_type: "update" },
    },
  };
  const section = buildMutationSection(mutating);
  assert.match(section, /## Mutation output/);
  assert.match(section, /orders\.yml/);
  assert.match(section, /dry-run/i);
  assert.match(section, /blast/i);
  assert.match(section, /approval/i);
  assert.match(section, /rollback/i);
  assert.match(section, /diff/i);
});

// --- models config -----------------------------------------------------------------------------

test("ModelConfig.fromYaml parses the tier→model map; undefined tier loud-fails", () => {
  const models = ModelConfig.fromYaml("tiers:\n  strong: opus\n  cheap: haiku\n  orchestrator: sonnet\n");
  assert.equal(models.require("strong"), "opus");
  assert.throws(() => models.require("mystery"), (e: unknown) => e instanceof DispatchError);
});
