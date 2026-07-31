import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CodexDispatchError, prepareAllSetup, prepareSetup } from "../src/index.js";
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
