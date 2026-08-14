import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CodexDispatchError,
  prepareAllSetup,
  prepareSetup,
  SUPPORTED_IR_VERSION,
} from "../src/index.js";
import { fakeMcp, SETUP_IR_PATH } from "./helpers.js";

const raw = readFileSync(SETUP_IR_PATH, "utf8");

test("prepares both genbi Setup single-strong-step components", () => {
  const all = prepareAllSetup(raw, { model: "gpt-5.4", mcp: fakeMcp() });
  assert.deepEqual(
    all.map((component) => ({
      id: component.componentId,
      step: component.steps[0]!.name,
      tier: component.steps[0]!.tier,
      tools: component.enabledTools,
    })),
    [
      { id: "connect_source", step: "connect", tier: "strong", tools: ["probe_setup"] },
      { id: "build_context", step: "build", tier: "strong", tools: ["probe_setup"] },
    ],
  );
  // AC#6 evidence: both real genbi Setup components are still single-step, so their manifest/
  // describe-relevant shape (steps.length) must stay exactly 1 -- this executor's n-step support
  // must not change what these two components already resolve to.
  for (const component of all) assert.equal(component.steps.length, 1);
});

test("public raw-IR preparation loud-fails on an unsupported IR version", () => {
  const unsupported = JSON.parse(raw) as { warble_ir_version: string };
  unsupported.warble_ir_version = "9.9";

  assert.throws(
    () =>
      prepareSetup({
        ir: JSON.stringify(unsupported),
        component: "connect_source",
        model: "gpt-5.4",
        mcp: fakeMcp(),
      }),
    (error: unknown) =>
      error instanceof CodexDispatchError &&
      error.message.includes("9.9") &&
      error.message.includes(SUPPORTED_IR_VERSION),
  );
});

test("accepts the current IR version and loud-fails the prior one it was bumped from", () => {
  // Locks in the direction of the bump: SUPPORTED_IR_VERSION must be "0.5", and an IR still
  // carrying the pre-bump "0.3" (this dispatcher's old accepted version, before profile bind
  // values started resolving into the IR) must be rejected rather than silently accepted.
  assert.equal(SUPPORTED_IR_VERSION, "0.5");

  const current = JSON.parse(raw) as { warble_ir_version: string };
  assert.equal(current.warble_ir_version, "0.5");
  assert.doesNotThrow(() =>
    prepareSetup({
      ir: raw,
      component: "connect_source",
      model: "gpt-5.4",
      mcp: fakeMcp(),
    }),
  );

  const stale = JSON.parse(raw) as { warble_ir_version: string };
  stale.warble_ir_version = "0.3";
  assert.throws(
    () =>
      prepareSetup({
        ir: JSON.stringify(stale),
        component: "connect_source",
        model: "gpt-5.4",
        mcp: fakeMcp(),
      }),
    (error: unknown) =>
      error instanceof CodexDispatchError &&
      error.message.includes("0.3") &&
      error.message.includes(SUPPORTED_IR_VERSION),
  );
});

test("dispatches by IR shape/capability, never component identity", () => {
  const renamed = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  renamed.components[0]!["id"] = "custom_source_onboarding";
  renamed.components[0]!["verb"] = "custom_source_onboarding";
  const prepared = prepareSetup({
    ir: JSON.stringify(renamed),
    component: "custom_source_onboarding",
    model: "gpt-5.4",
    mcp: fakeMcp(),
  });
  assert.equal(prepared.domainCapability, "source_connect");
  assert.equal(prepared.componentId, "custom_source_onboarding");

  const genbiDefaultPath = fileURLToPath(
    new URL("../../../genbi-default/ir.golden.json", import.meta.url),
  );
  const genbiDefault = readFileSync(genbiDefaultPath, "utf8");
  assert.throws(
    () =>
      prepareSetup({
        ir: genbiDefault,
        component: "answer_query",
        model: "gpt-5.4",
        mcp: fakeMcp(),
      }),
    (error: unknown) =>
      error instanceof CodexDispatchError &&
      /requires analytical\/skill\/one_shot\/none with no render blocks/.test(error.message),
  );
});

test("public Setup preparation accepts a component named 'apply_enrichment' as long as its declared contract is honest", () => {
  // A component's id/verb carries no dispatch meaning (invariant #1) — including the literal
  // string "apply_enrichment", which used to be treated as reserved purely by name. A legitimately
  // Setup-shaped component that happens to share that name is dispatchable like any other, both
  // scoped and as part of the whole-profile aggregate.
  const renamed = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  renamed.components[0]!["id"] = "apply_enrichment";
  renamed.components[0]!["verb"] = "apply_enrichment";

  const prepared = prepareSetup({
    ir: JSON.stringify(renamed),
    component: "apply_enrichment",
    model: "gpt-5.4",
    mcp: fakeMcp(),
  });
  assert.equal(prepared.componentId, "apply_enrichment");

  const all = prepareAllSetup(JSON.stringify(renamed), { model: "gpt-5.4", mcp: fakeMcp() });
  assert.deepEqual(all.map((component) => component.componentId), ["apply_enrichment", "build_context"]);
});

test("AC#3 evidence: this transport now genuinely accepts more than one llm_call per dispatch", () => {
  // The phase-A wall-hit this replaces rejected any component declaring more than one llm_call,
  // regardless of shape. Two distinct steps, wired produces-to-consumes, must now be accepted --
  // the whole point of the n-step generic executor -- not merely tolerated by a loosened check.
  const twoSteps = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const component = twoSteps.components[0]!;
  const first = (component["llm_calls"] as Array<Record<string, unknown>>)[0]!;
  const second = structuredClone(first);
  second["name"] = "confirm";
  second["consumes"] = [first["produces"]];
  second["produces"] = "confirmation";
  component["llm_calls"] = [first, second];

  const prepared = prepareSetup({
    ir: JSON.stringify(twoSteps),
    component: "connect_source",
    model: "gpt-5.4",
    mcp: fakeMcp(),
  });
  assert.deepEqual(
    prepared.steps.map((step) => ({ name: step.name, consumes: step.consumes, produces: step.produces })),
    [
      { name: "connect", consumes: [], produces: "connection_summary" },
      { name: "confirm", consumes: ["connection_summary"], produces: "confirmation" },
    ],
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
      prepareSetup({
        ir: JSON.stringify(twoSteps),
        component: "connect_source",
        model: "gpt-5.4",
        mcp: fakeMcp(),
      }),
    /step name 'connect' is declared more than once/,
  );
});

test("AC#3 evidence: an on_failure-guarded step is now accepted and evaluated, not wall-hit as an unevaluated condition", () => {
  const guarded = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const component = guarded.components[0]!;
  const first = (component["llm_calls"] as Array<Record<string, unknown>>)[0]!;
  const repair = structuredClone(first);
  repair["name"] = "repair_connect";
  repair["conditional"] = true;
  repair["when"] = { guard: "on_failure", target: "connect" };
  repair["produces"] = "connection_summary_repaired";
  component["llm_calls"] = [first, repair];

  const prepared = prepareSetup({
    ir: JSON.stringify(guarded),
    component: "connect_source",
    model: "gpt-5.4",
    mcp: fakeMcp(),
  });
  assert.deepEqual(prepared.steps[1]!.when, { guard: "on_failure", target: "connect" });
});

test("a conditional step that is not the last step is rejected, since a later step could otherwise consume from a producer that never ran", () => {
  const notLast = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const component = notLast.components[0]!;
  const first = (component["llm_calls"] as Array<Record<string, unknown>>)[0]!;
  first["name"] = "connect";
  const repair = structuredClone(first);
  repair["name"] = "repair_connect";
  repair["conditional"] = true;
  repair["when"] = { guard: "on_failure", target: "connect" };
  repair["produces"] = "connection_summary_repaired";
  const after = structuredClone(first);
  after["name"] = "confirm";
  after["consumes"] = [];
  after["produces"] = "confirmation";
  component["llm_calls"] = [first, repair, after];
  assert.throws(
    () =>
      prepareSetup({
        ir: JSON.stringify(notLast),
        component: "connect_source",
        model: "gpt-5.4",
        mcp: fakeMcp(),
      }),
    /conditional step 'repair_connect' must be the last step/,
  );
});

test("an on_failure target that is not a strictly earlier step is rejected, not silently accepted as an unresolvable guard", () => {
  const badTarget = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const component = badTarget.components[0]!;
  const first = (component["llm_calls"] as Array<Record<string, unknown>>)[0]!;
  first["name"] = "connect";
  const repair = structuredClone(first);
  repair["name"] = "repair_connect";
  repair["conditional"] = true;
  repair["when"] = { guard: "on_failure", target: "does_not_exist" };
  repair["produces"] = "connection_summary_repaired";
  component["llm_calls"] = [first, repair];
  assert.throws(
    () =>
      prepareSetup({
        ir: JSON.stringify(badTarget),
        component: "connect_source",
        model: "gpt-5.4",
        mcp: fakeMcp(),
      }),
    /on_failure target 'does_not_exist' is not an earlier step/,
  );
});

test("AC#3 evidence: per-step tiers are accepted via llm:per_step_tier, since Setup spawns a fresh --model process per step", () => {
  const mixedTier = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const component = mixedTier.components[0]!;
  const first = (component["llm_calls"] as Array<Record<string, unknown>>)[0]!;
  first["tier"] = "cheap";
  const second = structuredClone(first);
  second["name"] = "confirm";
  second["tier"] = "strong";
  second["consumes"] = [first["produces"]];
  second["produces"] = "confirmation";
  component["llm_calls"] = [first, second];
  component["required_capabilities"] = ["source_connect", "llm:per_step_tier"];

  const prepared = prepareSetup({
    ir: JSON.stringify(mixedTier),
    component: "connect_source",
    model: { cheap: "gpt-5.4-mini", strong: "gpt-5.4" },
    mcp: fakeMcp(),
  });
  assert.deepEqual(
    prepared.steps.map((step) => ({ tier: step.tier, model: step.model })),
    [
      { tier: "cheap", model: "gpt-5.4-mini" },
      { tier: "strong", model: "gpt-5.4" },
    ],
  );
});

test("loud-fails if Setup loses its locked guardrail", () => {
  const unlocked = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  (unlocked.components[0]!["guardrails"] as Array<Record<string, unknown>>)[0]!["locked"] = false;
  assert.throws(
    () =>
      prepareSetup({
        ir: JSON.stringify(unlocked),
        component: "connect_source",
        model: "gpt-5.4",
        mcp: fakeMcp(),
      }),
    /locked setup_execution/,
  );

  const extraGuardrail = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  (extraGuardrail.components[0]!["guardrails"] as unknown[]).push({
    name: "human_approval",
    locked: true,
    scope: ".",
  });
  assert.throws(
    () =>
      prepareSetup({
        ir: JSON.stringify(extraGuardrail),
        component: "connect_source",
        model: "gpt-5.4",
        mcp: fakeMcp(),
      }),
    /exactly one locked setup_execution guardrail/,
  );
});

test("loud-fails on every additional or duplicated capability", () => {
  for (const capability of ["human_approval", "context_write_authz", "llm:strong"]) {
    const changed = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
    (changed.components[0]!["required_capabilities"] as string[]).push(capability);
    assert.throws(
      () =>
        prepareSetup({
          ir: JSON.stringify(changed),
          component: "connect_source",
          model: "gpt-5.4",
          mcp: fakeMcp(),
        }),
      /supports exactly 'source_connect' and 'llm:strong'/,
    );
  }
});

test("accepts a one-step Setup component whose tier is cheap, not strong (the tier whitelist was deleted)", () => {
  const cheapTier = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const component = cheapTier.components[0]!;
  (component["llm_calls"] as Array<Record<string, unknown>>)[0]!["tier"] = "cheap";
  component["required_capabilities"] = ["source_connect", "llm:cheap"];

  const preparedComponent = prepareSetup({
    ir: JSON.stringify(cheapTier),
    component: "connect_source",
    model: "gpt-5.4-mini",
    mcp: fakeMcp(),
  });
  assert.equal(preparedComponent.steps[0]!.tier, "cheap");
  assert.equal(preparedComponent.steps[0]!.model, "gpt-5.4-mini");
});

test("a malformed conditional/when pair still wall-hits, now via parseStepWhen's own shape checks rather than a blanket 'not evaluated' reject", () => {
  // A single-step component with `conditional: true` and no proper on_failure(target) guard is
  // still rejected -- but the reason is now the honest one: this transport DOES evaluate
  // conditions, so a malformed one is a shape error, not "conditions are never evaluated".
  const conditional = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  (conditional.components[0]!["llm_calls"] as Array<Record<string, unknown>>)[0]!["conditional"] = true;
  assert.throws(
    () =>
      prepareSetup({
        ir: JSON.stringify(conditional),
        component: "connect_source",
        model: "gpt-5.4",
        mcp: fakeMcp(),
      }),
    /repair requires on_failure\(target\)/,
  );

  const whenPresent = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  (whenPresent.components[0]!["llm_calls"] as Array<Record<string, unknown>>)[0]!["when"] = {
    kind: "on_failure",
  };
  assert.throws(
    () =>
      prepareSetup({
        ir: JSON.stringify(whenPresent),
        component: "connect_source",
        model: "gpt-5.4",
        mcp: fakeMcp(),
      }),
    /is unconditional but has a when guard/,
  );

  const noProduces = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  (noProduces.components[0]!["llm_calls"] as Array<Record<string, unknown>>)[0]!["produces"] = null;
  assert.throws(
    () =>
      prepareSetup({
        ir: JSON.stringify(noProduces),
        component: "connect_source",
        model: "gpt-5.4",
        mcp: fakeMcp(),
      }),
    /requires a produced slot/,
  );

  const unsatisfiedConsumes = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  (unsatisfiedConsumes.components[0]!["llm_calls"] as Array<Record<string, unknown>>)[0]!["consumes"] = [
    "nothing_produced_this_dispatch",
  ];
  assert.throws(
    () =>
      prepareSetup({
        ir: JSON.stringify(unsatisfiedConsumes),
        component: "connect_source",
        model: "gpt-5.4",
        mcp: fakeMcp(),
      }),
    /consumes 'nothing_produced_this_dispatch' but no earlier step produces it/,
  );
});

test("an unresolvable tier still loud-fails, via the target-capability backstop rather than a tier whitelist", () => {
  const exoticTier = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const component = exoticTier.components[0]!;
  (component["llm_calls"] as Array<Record<string, unknown>>)[0]!["tier"] = "medium";
  component["required_capabilities"] = ["source_connect", "llm:medium"];

  assert.throws(
    () =>
      prepareSetup({
        ir: JSON.stringify(exoticTier),
        component: "connect_source",
        model: "gpt-5.4",
        mcp: fakeMcp(),
      }),
    (error: unknown) =>
      error instanceof CodexDispatchError && /llm:medium.*no realization/.test(error.message),
  );
});

test("MCP config rejects key-path injection and relative commands", () => {
  assert.throws(
    () =>
      prepareSetup({
        ir: raw,
        component: "connect_source",
        model: "gpt-5.4",
        mcp: { ...fakeMcp(), name: "setup.required=false" },
      }),
    /server name/,
  );
  assert.throws(
    () =>
      prepareSetup({
        ir: raw,
        component: "connect_source",
        model: "gpt-5.4",
        mcp: { ...fakeMcp(), command: "relative/server" },
      }),
    /command must be absolute/,
  );
});
