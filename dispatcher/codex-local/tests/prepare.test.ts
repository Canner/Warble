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
      step: component.step.name,
      tier: component.step.tier,
      tools: component.enabledTools,
    })),
    [
      { id: "connect_source", step: "connect", tier: "strong", tools: ["probe_setup"] },
      { id: "build_context", step: "build", tier: "strong", tools: ["probe_setup"] },
    ],
  );
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

test("loud-fails if Setup grows a second step or loses its locked guardrail", () => {
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
    /executes exactly one llm_call per dispatch; component declares 2/,
  );

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

test("accepts a one-step Setup component whose tier is cheap, not strong (decision-58: tier whitelist deleted)", () => {
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
  assert.equal(preparedComponent.step.tier, "cheap");
  assert.equal(preparedComponent.model, "gpt-5.4-mini");
});

test("reject set is unchanged: conditional step, present `when`, missing produces, and an unsatisfiable consumes all still wall-hit", () => {
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
    /does not evaluate step conditions/,
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
    /does not evaluate step conditions/,
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
