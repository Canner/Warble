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

test("chat --component inspect_context: scoped dispatch succeeds and resolves only its own domain capabilities", () => {
  const prepared = preparedEnrich("inspect_context");
  assert.equal(prepared.componentId, "inspect_context");
  assert.deepEqual(prepared.domainCapabilities, ["semantic_introspection", "raw_material_read"]);
  assert.equal(prepared.step.name, "inspect");
  assert.equal(prepared.step.tier, "cheap");
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

test("chat --component draft_enrichment: scoped dispatch also succeeds, despite apply_enrichment's unmet capabilities", () => {
  const prepared = preparedEnrich("draft_enrichment");
  assert.equal(prepared.componentId, "draft_enrichment");
  assert.deepEqual(prepared.domainCapabilities, ["semantic_introspection"]);
  assert.equal(prepared.step.name, "draft");
  assert.equal(prepared.step.tier, "strong");
  assert.deepEqual(
    prepared.capabilities,
    [
      { capability: "semantic_introspection", outcome: "realize-via", via: "mcp:enrich" },
      { capability: "llm:strong", outcome: "native", via: null },
    ],
  );
  assert.deepEqual(prepared.enabledTools, ["get_context"]);
});

// AC4 (never claim native for a capability the runtime can't honestly guarantee): every
// non-llm capability resolved for the two read-only components must be realize-via an
// allowlisted MCP tool, never native — Codex child agents have no cwd-scoped read primitive
// outside their per-step MCP allowlist, unlike claude-agent-sdk's SDK-level Read tool.
test("no domain capability is ever claimed native — only llm:* is", () => {
  for (const componentId of ["inspect_context", "draft_enrichment"]) {
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

// apply_enrichment is host-executed by contract: its genuine IR shape (non-`skill`
// realization_kind, host-owned capabilities) must wall-hit before any shape/capability check could
// otherwise make it look like a legal read-only component. The rejection is on IR grounds, not on
// its name — see dispatch_contract.test.ts for the companion case proving the name carries no
// dispatch meaning either way.
test("chat --component apply_enrichment: wall-hits at the host-executed legality boundary", () => {
  assert.throws(
    () => prepareEnrich({ ir: raw, component: "apply_enrichment", model: "gpt-5.4", mcp: fakeEnrichMcp() }),
    (error: unknown) =>
      error instanceof CodexDispatchError &&
      /apply_enrichment/.test(error.message) &&
      /host-executed/.test(error.message),
    "apply_enrichment must wall-hit by reserved identity before mutable IR shape validation",
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
          component: "inspect_context",
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
        component: "inspect_context",
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

  const genbiDefaultPath = fileURLToPath(
    new URL("../../../genbi-default/ir.golden.json", import.meta.url),
  );
  const genbiDefault = readFileSync(genbiDefaultPath, "utf8");
  assert.throws(
    () =>
      prepareEnrich({
        ir: genbiDefault,
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

test("loud-fails if a component grows a second step, loses its lock, or gains an extra guardrail", () => {
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
        component: "inspect_context",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    /executes exactly one llm_call per dispatch; component declares 2/,
  );

  const unlocked = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  (unlocked.components[0]!["guardrails"] as Array<Record<string, unknown>>)[0]!["locked"] = false;
  assert.throws(
    () =>
      prepareEnrich({
        ir: JSON.stringify(unlocked),
        component: "inspect_context",
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
        component: "inspect_context",
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
        component: "inspect_context",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    /supports exactly/,
  );
});

// decision-58 deletes the inline `step.tier !== "cheap" && step.tier !== "strong"` whitelist from
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
        component: "inspect_context",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    (error: unknown) =>
      error instanceof CodexDispatchError &&
      /cannot be dispatched by codex:local/.test(error.message) &&
      error.message.includes("llm:per_step_tier"),
  );
});

test("reject set is unchanged: conditional step, present `when`, missing produces, and an unsatisfiable consumes all still wall-hit", () => {
  const conditional = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  (conditional.components[0]!["llm_calls"] as Array<Record<string, unknown>>)[0]!["conditional"] = true;
  assert.throws(
    () =>
      prepareEnrich({
        ir: JSON.stringify(conditional),
        component: "inspect_context",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    /does not evaluate step conditions/,
  );

  const whenPresent = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  (whenPresent.components[0]!["llm_calls"] as Array<Record<string, unknown>>)[0]!["when"] = {
    kind: "on_failure",
  };
  assert.throws(
    () =>
      prepareEnrich({
        ir: JSON.stringify(whenPresent),
        component: "inspect_context",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    /does not evaluate step conditions/,
  );

  const noProduces = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  (noProduces.components[0]!["llm_calls"] as Array<Record<string, unknown>>)[0]!["produces"] = null;
  assert.throws(
    () =>
      prepareEnrich({
        ir: JSON.stringify(noProduces),
        component: "inspect_context",
        model: "gpt-5.4",
        mcp: fakeEnrichMcp(),
      }),
    /requires a produced slot/,
  );

  const unsatisfiedConsumes = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  (unsatisfiedConsumes.components[0]!["llm_calls"] as Array<Record<string, unknown>>)[0]!["consumes"] = [
    "nothing_produced_this_dispatch",
  ];
  assert.throws(
    () =>
      prepareEnrich({
        ir: JSON.stringify(unsatisfiedConsumes),
        component: "inspect_context",
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
        component: "inspect_context",
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
        component: "inspect_context",
        model: "gpt-5.4",
        mcp: { ...fakeEnrichMcp(), name: "enrich.required=false" },
      }),
    /server name/,
  );
  assert.throws(
    () =>
      prepareEnrich({
        ir: raw,
        component: "inspect_context",
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
      /genbi-enrich-context/.test(error.message),
  );
});
