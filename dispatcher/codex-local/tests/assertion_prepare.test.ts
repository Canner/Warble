import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyDispatchContract,
  parseIr,
  prepareAssertion,
} from "../src/index.js";
import { ASSERTION_IR_PATH, GENBI_ASSERTION_IR_PATH, preparedAssertion } from "./helpers.js";

function assertionRaw(mutator?: (node: Record<string, unknown>) => void): string {
  const raw = JSON.parse(readFileSync(ASSERTION_IR_PATH, "utf8")) as Record<string, unknown>;
  const node = (raw["components"] as Array<Record<string, unknown>>)[0]!;
  mutator?.(node);
  return JSON.stringify(raw);
}

test("assertion parser retains outcome, bindings, and precondition facets", () => {
  const node = parseIr(assertionRaw()).components[0]!;
  assert.equal(node.effect.outcome.verdict_type, "freshness_verdict");
  assert.deepEqual(node.effect.outcome.emits, ["freshness_breach"]);
  assert.deepEqual(node.binds, { expected_cadence: "24h", model: "orders" });
  assert.deepEqual(node.params.map((param) => [param.name, param.bind, param.default, param.source]), [
    ["model", "required", undefined, undefined],
    ["expected_cadence", "optional", "24h", undefined],
    ["connection", undefined, undefined, "runtime-injected"],
    ["model_binding", undefined, undefined, "runtime-injected"],
  ]);
  assert.equal(node.precondition_result?.status, "pass");
  assert.deepEqual(node.precondition_result?.checks, [{ predicate: "model_has_timestamp", outcome: "pass" }]);
});

test("assertion selection follows complete anatomy, not component id or verb", () => {
  const raw = assertionRaw((node) => {
    node["id"] = "renamed_check";
    node["verb"] = "different_words";
  });
  const ir = parseIr(raw);
  assert.equal(classifyDispatchContract(ir, "renamed_check"), "assertion");
  assert.equal(prepareAssertion({ ir: raw, component: "renamed_check", model: "cheap" }).componentId, "renamed_check");
});

test("assertion requires exact capabilities and guardrails before preparation", () => {
  for (const mutate of [
    (node: Record<string, unknown>) => ((node["required_capabilities"] as string[]).pop()),
    // Replacement duplicate: same cardinality but silently missing llm:cheap must still wall-hit.
    (node: Record<string, unknown>) => ((node["required_capabilities"] as string[])[3] = "scheduler"),
    (node: Record<string, unknown>) => (node["required_capabilities"] as string[]).push("llm:strong"),
    (node: Record<string, unknown>) => ((node["guardrails"] as Array<Record<string, unknown>>)[0]!["locked"] = false),
  ]) {
    const raw = assertionRaw(mutate);
    assert.throws(
      () => prepareAssertion({ ir: raw, component: "monitor_freshness", model: "cheap" }),
      /wall-hit/,
    );
  }
});

test("assertion's cheap on_flag severity step is the only accepted conditional topology", () => {
  assert.equal(preparedAssertion().step.when.guard, "on_flag");
  const raw = assertionRaw((node) => {
    const call = (node["llm_calls"] as Array<Record<string, unknown>>)[0]!;
    call["when"] = { guard: "on_failure", target: "other" };
  });
  assert.throws(
    () => prepareAssertion({ ir: raw, component: "monitor_freshness", model: "cheap" }),
    /on_flag/,
  );
  const miswired = assertionRaw((node) => {
    const call = (node["llm_calls"] as Array<Record<string, unknown>>)[0]!;
    call["when"] = { guard: "on_flag", target: "other_reading.stale" };
  });
  assert.throws(
    () => prepareAssertion({ ir: miswired, component: "monitor_freshness", model: "cheap" }),
    /consumed freshness reading/,
  );
});

test("effective compiler binds, not parameter defaults, determine pinned assertion model and cadence", () => {
  const prepared = prepareAssertion({
    ir: readFileSync(GENBI_ASSERTION_IR_PATH, "utf8"),
    component: "monitor_freshness",
    model: "cheap",
  });
  assert.equal(prepared.pinnedModel, "orders");
  assert.equal(prepared.pinnedCadenceMs, 48 * 60 * 60 * 1_000);
  const missingBinds = assertionRaw((node) => { delete node["binds"]; });
  assert.throws(
    () => prepareAssertion({ ir: missingBinds, component: "monitor_freshness", model: "cheap" }),
    /effective binds/,
  );
});

test("event, gated-tool, mutating, and incomplete assertion anatomy wall-hit before runtime", () => {
  for (const mutate of [
    (node: Record<string, unknown>) => ((node["trigger"] as Record<string, unknown>)["kind"] = "event"),
    (node: Record<string, unknown>) => (node["realization_kind"] = "gated-tool"),
    (node: Record<string, unknown>) => (node["type"] = "mutating"),
    (node: Record<string, unknown>) => ((node["effect"] as Record<string, unknown>)["outcome"] = { kind: "assertion" }),
  ]) {
    const raw = assertionRaw(mutate);
    assert.throws(
      () => prepareAssertion({ ir: raw, component: "monitor_freshness", model: "cheap" }),
      /wall-hit|host-executed/,
    );
  }
});
