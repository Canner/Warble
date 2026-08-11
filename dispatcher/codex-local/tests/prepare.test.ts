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
  // Locks in the direction of the bump: SUPPORTED_IR_VERSION must be "0.4", and an IR still
  // carrying the pre-bump "0.3" (this dispatcher's old accepted version, before profile bind
  // values started resolving into the IR) must be rejected rather than silently accepted.
  assert.equal(SUPPORTED_IR_VERSION, "0.4");

  const current = JSON.parse(raw) as { warble_ir_version: string };
  assert.equal(current.warble_ir_version, "0.4");
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
      /Setup prototype requires/.test(error.message),
  );
});

test("public Setup preparation refuses a forged reserved host-executed identity", () => {
  const forged = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  forged.components[0]!["id"] = "apply_enrichment";
  forged.components[0]!["verb"] = "apply_enrichment";

  assert.throws(
    () =>
      prepareSetup({
        ir: JSON.stringify(forged),
        component: "apply_enrichment",
        model: "gpt-5.4",
        mcp: fakeMcp(),
      }),
    /apply_enrichment.*host-executed/,
  );
  assert.throws(
    () => prepareAllSetup(JSON.stringify(forged), { model: "gpt-5.4", mcp: fakeMcp() }),
    /apply_enrichment.*host-executed/,
  );
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
    /requires exactly one llm_call/,
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
