import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CodexDispatchError,
  prepareEnrich,
  SUPPORTED_IR_VERSION,
} from "../src/index.js";
import { ENRICH_IR_PATH, fakeEnrichMcp, preparedEnrich } from "./helpers.js";

const raw = readFileSync(ENRICH_IR_PATH, "utf8");

test("chat --component survey_context: scoped dispatch succeeds and resolves only its own domain capabilities", () => {
  const prepared = preparedEnrich("survey_context");
  assert.equal(prepared.componentId, "survey_context");
  assert.deepEqual(prepared.domainCapabilities, ["semantic_introspection", "raw_material_read"]);
  assert.equal(prepared.steps[0]!.name, "survey");
  assert.equal(prepared.steps[0]!.tier, "cheap");
  assert.deepEqual(
    prepared.capabilities.sort((a, b) => a.capability.localeCompare(b.capability)),
    [
      { capability: "llm:cheap", outcome: "native", via: null },
      { capability: "raw_material_read", outcome: "realize-via", via: "mcp:enrich" },
      { capability: "semantic_introspection", outcome: "realize-via", via: "mcp:enrich" },
    ],
  );
  assert.deepEqual(prepared.enabledTools.sort(), ["get_context", "read_raw_material"]);
});

test("chat --component propose_changes: scoped dispatch also succeeds, despite apply_changes's unmet capabilities", () => {
  const prepared = preparedEnrich("propose_changes");
  assert.equal(prepared.componentId, "propose_changes");
  assert.deepEqual(prepared.domainCapabilities, ["semantic_introspection"]);
  assert.equal(prepared.steps[0]!.name, "propose");
  assert.equal(prepared.steps[0]!.tier, "strong");
  assert.deepEqual(
    prepared.capabilities,
    [
      { capability: "semantic_introspection", outcome: "realize-via", via: "mcp:enrich" },
      { capability: "llm:strong", outcome: "native", via: null },
    ],
  );
  assert.deepEqual(prepared.enabledTools, ["get_context"]);
});

// Never claim native for a capability the runtime can't honestly guarantee: every
// non-llm capability resolved for the two read-only components must be realize-via an
// allowlisted MCP tool, never native — Codex child agents have no cwd-scoped read primitive
// outside their per-step MCP allowlist, unlike claude-agent-sdk's SDK-level Read tool.
test("no domain capability is ever claimed native — only llm:* is", () => {
  for (const componentId of ["survey_context", "propose_changes"]) {
    const prepared = preparedEnrich(componentId);
    for (const entry of prepared.capabilities) {
      if (entry.capability.startsWith("llm:")) {
        assert.equal(entry.outcome, "native");
        assert.equal(entry.via, null);
      } else {
        assert.equal(entry.outcome, "realize-via");
        assert.ok(entry.via?.startsWith("mcp:"));
      }
    }
  }
});

// apply_changes is host-executed by contract: its genuine IR shape (non-`skill`
// realization_kind, host-owned capabilities) must wall-hit before any shape/capability check could
// otherwise make it look like a legal read-only component. The rejection is on IR grounds, not on
// its name — see dispatch_contract.test.ts for the companion case proving the name carries no
// dispatch meaning either way.
test("chat --component apply_changes: wall-hits at the host-executed legality boundary", () => {
  assert.throws(
    () => prepareEnrich({ ir: raw, component: "apply_changes", model: "gpt-5.4", mcp: fakeEnrichMcp() }),
    (error: unknown) =>
      error instanceof CodexDispatchError &&
      /apply_changes/.test(error.message) &&
      /host-executed/.test(error.message),
    "apply_changes must wall-hit by reserved identity before mutable IR shape validation",
  );
});

test("whole-profile-shaped capability lists never smuggle a write/approval capability past the allowlist", () => {
  // Defends the allowlist itself: even if some future IR mutation tried to add a write/approval
  // capability onto a read-only-shaped component, the capability check (which runs first) must
  // still name it and refuse, rather than falling through to the shape checks.
  for (const capability of [
    "context_write_authz",
    "human_approval",
    "context_validate",
    "context_build",
    "version_control",
    "enrichment_apply:deterministic",
  ]) {
    const mutated = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
    (mutated.components[0]!["required_capabilities"] as string[]).push(capability);
    assert.throws(
      () =>
        prepareEnrich({
          ir: JSON.stringify(mutated),
          component: "survey_context",
          model: "gpt-5.4",
          mcp: fakeEnrichMcp(),
        }),
      (error: unknown) =>
        error instanceof CodexDispatchError &&
        error.message.includes(capability) &&
        /cannot be dispatched/.test(error.message),
    );
  }
});

test("public raw-IR preparation loud-fails on an unsupported IR version", () => {
  const unsupported = JSON.parse(raw) as { warble_ir_version: string };
  unsupported.warble_ir_version = "9.9";
  assert.throws(
    () =>
      prepareEnrich({
        ir: JSON.stringify(unsupported),
        component: "survey_context",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    (error: unknown) =>
      error instanceof CodexDispatchError &&
      error.message.includes("9.9") &&
      error.message.includes(SUPPORTED_IR_VERSION),
  );
});

test("dispatches by IR shape/capability, never component identity", () => {
  const renamed = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  renamed.components[0]!["id"] = "custom_inspection_step";
  renamed.components[0]!["verb"] = "custom_inspection_step";
  const prepared = prepareEnrich({
    ir: JSON.stringify(renamed),
    component: "custom_inspection_step",
    model: "gpt-5.4",
    mcp: fakeEnrichMcp(),
  });
  assert.equal(prepared.componentId, "custom_inspection_step");
  assert.deepEqual(prepared.domainCapabilities, ["semantic_introspection", "raw_material_read"]);

  const analysisAgentPath = fileURLToPath(
    new URL("../../../examples/analysis-agent/ir.golden.json", import.meta.url),
  );
  const analysisAgent = readFileSync(analysisAgentPath, "utf8");
  assert.throws(
    () =>
      prepareEnrich({
        ir: analysisAgent,
        component: "answer_query",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    (error: unknown) =>
      error instanceof CodexDispatchError &&
      /cannot be dispatched by codex:local/.test(error.message) &&
      /no honest realization/.test(error.message),
  );
});

test("this transport now genuinely accepts more than one llm_call per dispatch, same tier throughout", () => {
  // The phase-A wall-hit this replaces rejected any component declaring more than one llm_call.
  // Two distinct same-tier steps, wired produces-to-consumes, must now be accepted -- Enrich's
  // persistent-session transport can run several turns, it just can't switch models mid-session
  // (see the single-tier requirement below), so multi-step acceptance must not require a tier
  // change to prove it.
  const twoSteps = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const component = twoSteps.components[0]!;
  const first = (component["llm_calls"] as Array<Record<string, unknown>>)[0]!;
  const second = structuredClone(first);
  second["name"] = "summarize";
  second["consumes"] = [first["produces"]];
  second["produces"] = "gap_summary";
  component["llm_calls"] = [first, second];

  const prepared = prepareEnrich({
    ir: JSON.stringify(twoSteps),
    component: "survey_context",
    model: "gpt-5.4",
    mcp: fakeEnrichMcp(),
  });
  assert.deepEqual(
    prepared.steps.map((step) => ({ name: step.name, tier: step.tier, consumes: step.consumes, produces: step.produces })),
    [
      { name: "survey", tier: "cheap", consumes: [], produces: "enrichment_gaps" },
      { name: "summarize", tier: "cheap", consumes: ["enrichment_gaps"], produces: "gap_summary" },
    ],
  );
});

test("a multi-step Enrich component still must declare exactly one tier -- the persistent session cannot switch models mid-thread", () => {
  // The counterpart to n-step support: unlike Setup (fresh `codex exec` process per step, so
  // `--model` can differ every time), Enrich's `CodexSessionRuntime` binds one model to the whole
  // `thread/start` for its lifetime. A component whose steps disagree on tier must still wall-hit,
  // even though it may now have more than one step.
  // Deliberately leaves required_capabilities as the fixture's original single `llm:cheap` (still
  // within ENRICH_ALLOWED_CAPABILITIES) so the tier-count check itself is what fires, rather than
  // the unrelated, earlier-running capability allowlist check.
  const mixedTier = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const component = mixedTier.components[0]!;
  const first = (component["llm_calls"] as Array<Record<string, unknown>>)[0]!;
  const second = structuredClone(first);
  second["name"] = "escalate";
  second["tier"] = "strong";
  second["consumes"] = [first["produces"]];
  second["produces"] = "gap_summary";
  component["llm_calls"] = [first, second];

  assert.throws(
    () =>
      prepareEnrich({
        ir: JSON.stringify(mixedTier),
        component: "survey_context",
        model: { cheap: "gpt-5.4-mini", strong: "gpt-5.4" },
        mcp: fakeEnrichMcp(),
      }),
    /this transport's persistent session supports exactly one tier per component/,
  );
});

test("a duplicated step name is still rejected, now by name-uniqueness rather than a step-count ceiling", () => {
  const twoSteps = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const component = twoSteps.components[0]!;
  component["llm_calls"] = [
    ...(component["llm_calls"] as unknown[]),
    structuredClone((component["llm_calls"] as unknown[])[0]),
  ];
  assert.throws(
    () =>
      prepareEnrich({
        ir: JSON.stringify(twoSteps),
        component: "survey_context",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    /step name 'survey' is declared more than once/,
  );
});

test("an on_failure-guarded step is now accepted and evaluated, not wall-hit as an unevaluated condition", () => {
  const guarded = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const component = guarded.components[0]!;
  const first = (component["llm_calls"] as Array<Record<string, unknown>>)[0]!;
  const repair = structuredClone(first);
  repair["name"] = "repair_inspect";
  repair["conditional"] = true;
  repair["when"] = { guard: "on_failure", target: "survey" };
  repair["produces"] = "enrichment_gaps_repaired";
  component["llm_calls"] = [first, repair];

  const prepared = prepareEnrich({
    ir: JSON.stringify(guarded),
    component: "survey_context",
    model: "gpt-5.4",
    mcp: fakeEnrichMcp(),
  });
  assert.deepEqual(prepared.steps[1]!.when, { guard: "on_failure", target: "survey" });
});

test("loud-fails if a component loses its lock or gains an extra guardrail", () => {
  const unlocked = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  (unlocked.components[0]!["guardrails"] as Array<Record<string, unknown>>)[0]!["locked"] = false;
  assert.throws(
    () =>
      prepareEnrich({
        ir: JSON.stringify(unlocked),
        component: "survey_context",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    /locked read_only_execution/,
  );

  const extraGuardrail = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  (extraGuardrail.components[0]!["guardrails"] as unknown[]).push({
    name: "artifact_write",
    locked: true,
    scope: ".",
  });
  assert.throws(
    () =>
      prepareEnrich({
        ir: JSON.stringify(extraGuardrail),
        component: "survey_context",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    /exactly one locked read_only_execution guardrail/,
  );
});

test("loud-fails on a duplicated or foreign llm tier capability", () => {
  const changed = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  (changed.components[0]!["required_capabilities"] as string[]).push("llm:strong");
  assert.throws(
    () =>
      prepareEnrich({
        ir: JSON.stringify(changed),
        component: "survey_context",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    /supports exactly/,
  );
});

// The inline `step.tier !== "cheap" && step.tier !== "strong"` whitelist was deleted from
// validateEnrichShape, but Enrich's accept set for tier does not actually widen: the
// ENRICH_ALLOWED_CAPABILITIES gate (target_profile.ts, unchanged in this phase) already bounds
// every llm:* capability an Enrich component may declare to {llm:cheap, llm:strong}, so a tier
// outside that pair still fails there before the deleted clause would ever have been reached. This
// is the honest outcome, not a gap: Setup had no equivalent front-gate, so its own tier-whitelist
// deletion genuinely widens its accept set (see prepare.test.ts's "accepts a one-step Setup
// component whose tier is cheap" case); Enrich's deletion removes dead/redundant code instead.
test("Enrich's accept set for tier does not widen: a tier outside cheap|strong is still rejected by the unchanged capability allowlist", () => {
  const widerTier = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const component = widerTier.components[0]!;
  (component["llm_calls"] as Array<Record<string, unknown>>)[0]!["tier"] = "per_step_tier";
  component["required_capabilities"] = ["semantic_introspection", "raw_material_read", "llm:per_step_tier"];

  assert.throws(
    () =>
      prepareEnrich({
        ir: JSON.stringify(widerTier),
        component: "survey_context",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    (error: unknown) =>
      error instanceof CodexDispatchError &&
      /cannot be dispatched by codex:local/.test(error.message) &&
      error.message.includes("llm:per_step_tier"),
  );
});

test("a malformed conditional/when pair still wall-hits, now via parseStepWhen's own shape checks rather than a blanket 'not evaluated' reject", () => {
  const conditional = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  (conditional.components[0]!["llm_calls"] as Array<Record<string, unknown>>)[0]!["conditional"] = true;
  assert.throws(
    () =>
      prepareEnrich({
        ir: JSON.stringify(conditional),
        component: "survey_context",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    /repair requires on_failure\(target\)/,
  );

  const whenPresent = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  (whenPresent.components[0]!["llm_calls"] as Array<Record<string, unknown>>)[0]!["when"] = {
    kind: "on_failure",
  };
  assert.throws(
    () =>
      prepareEnrich({
        ir: JSON.stringify(whenPresent),
        component: "survey_context",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    /is unconditional but has a when guard/,
  );

  const noProduces = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  (noProduces.components[0]!["llm_calls"] as Array<Record<string, unknown>>)[0]!["produces"] = null;
  assert.throws(
    () =>
      prepareEnrich({
        ir: JSON.stringify(noProduces),
        component: "survey_context",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    /requires a produced artifact/,
  );

  const unsatisfiedConsumes = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  (unsatisfiedConsumes.components[0]!["llm_calls"] as Array<Record<string, unknown>>)[0]!["consumes"] = [
    "nothing_produced_this_dispatch",
  ];
  assert.throws(
    () =>
      prepareEnrich({
        ir: JSON.stringify(unsatisfiedConsumes),
        component: "survey_context",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    /consumes 'nothing_produced_this_dispatch' but no earlier step produces it/,
  );
});

test("an out-of-allowlist tier still loud-fails at the unchanged capability check, before any deleted tier logic could have run", () => {
  const exoticTier = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const component = exoticTier.components[0]!;
  (component["llm_calls"] as Array<Record<string, unknown>>)[0]!["tier"] = "medium";
  component["required_capabilities"] = ["semantic_introspection", "raw_material_read", "llm:medium"];

  assert.throws(
    () =>
      prepareEnrich({
        ir: JSON.stringify(exoticTier),
        component: "survey_context",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    (error: unknown) =>
      error instanceof CodexDispatchError &&
      /llm:medium/.test(error.message) &&
      /no honest realization/.test(error.message),
  );
});

test("MCP config rejects key-path injection and relative commands", () => {
  assert.throws(
    () =>
      prepareEnrich({
        ir: raw,
        component: "survey_context",
        model: "gpt-5.4",
        mcp: { ...fakeEnrichMcp(), name: "enrich.required=false" },
      }),
    /server name/,
  );
  assert.throws(
    () =>
      prepareEnrich({
        ir: raw,
        component: "survey_context",
        model: "gpt-5.4",
        mcp: { ...fakeEnrichMcp(), command: "relative/server" },
      }),
    /command must be absolute/,
  );
});

test("component not found in profile names the profile", () => {
  assert.throws(
    () =>
      prepareEnrich({
        ir: raw,
        component: "does_not_exist",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    (error: unknown) =>
      error instanceof CodexDispatchError &&
      /does_not_exist/.test(error.message) &&
      /propose-apply-agent/.test(error.message),
  );
});
