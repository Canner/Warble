import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { classifyDispatchContract, parseIr, supportsSetupAggregate } from "../src/index.js";
import { ASK_IR_PATH, ENRICH_IR_PATH, SETUP_IR_PATH } from "./helpers.js";

function renamedIr(path: string, component: string, replacement: string) {
  const ir = JSON.parse(readFileSync(path, "utf8")) as { components: Array<Record<string, unknown>> };
  const node = ir.components.find((candidate) => candidate["id"] === component);
  assert.ok(node, `missing fixture component ${component}`);
  node["id"] = replacement;
  node["verb"] = replacement;
  return parseIr(JSON.stringify(ir));
}

function withComponent(
  path: string,
  component: string,
  mutate: (node: Record<string, unknown>) => void,
) {
  const ir = JSON.parse(readFileSync(path, "utf8")) as { components: Array<Record<string, unknown>> };
  const node = ir.components.find((candidate) => candidate["id"] === component);
  assert.ok(node, `missing fixture component ${component}`);
  mutate(node);
  return parseIr(JSON.stringify(ir));
}

test("execution contracts are classified from IR shape rather than profile or component names", () => {
  const setup = renamedIr(SETUP_IR_PATH, "connect_source", "custom_onboarding");
  const ask = renamedIr(ASK_IR_PATH, "answer_query", "custom_question");
  const enrich = renamedIr(ENRICH_IR_PATH, "inspect_context", "custom_context_review");

  assert.equal(classifyDispatchContract(setup, "custom_onboarding"), "setup");
  assert.equal(classifyDispatchContract(ask, "custom_question"), "ask");
  assert.equal(classifyDispatchContract(enrich, "custom_context_review"), "enrich");
  assert.equal(supportsSetupAggregate(setup), true);
  assert.equal(supportsSetupAggregate(ask), false);
  assert.throws(() => supportsSetupAggregate(enrich), /apply_enrichment.*host-executed/);
});

test("complete structural predicates reject marker-mixed and incomplete contracts before routing", () => {
  const markerMixed = withComponent(ASK_IR_PATH, "answer_query", (node) => {
    (node["guardrails"] as Array<Record<string, unknown>>).push({
      name: "setup_execution",
      locked: true,
      scope: ".",
    });
  });
  assert.throws(
    () => classifyDispatchContract(markerMixed, "answer_query"),
    /no supported codex:local execution contract matches its complete IR shape/,
  );
  assert.equal(supportsSetupAggregate(markerMixed), false);

  const incompleteSetup = withComponent(SETUP_IR_PATH, "connect_source", (node) => {
    (node["required_capabilities"] as string[]).push("semantic_introspection");
  });
  assert.throws(
    () => classifyDispatchContract(incompleteSetup, "connect_source"),
    /no supported codex:local execution contract matches its complete IR shape/,
  );
  assert.equal(supportsSetupAggregate(incompleteSetup), false);
});

test("host-executed identities are refused before shape classification, even when forged as setup or Ask", () => {
  const setupForgery = renamedIr(SETUP_IR_PATH, "connect_source", "apply_enrichment");
  const askForgery = renamedIr(ASK_IR_PATH, "answer_query", "apply_enrichment");
  for (const ir of [setupForgery, askForgery]) {
    assert.throws(
      () => classifyDispatchContract(ir, "apply_enrichment"),
      /apply_enrichment.*host-executed/,
    );
    assert.throws(() => supportsSetupAggregate(ir), /apply_enrichment.*host-executed/);
  }
});
