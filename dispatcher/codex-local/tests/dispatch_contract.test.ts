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

test("execution contracts are classified from IR shape rather than profile or component names", () => {
  const setup = renamedIr(SETUP_IR_PATH, "connect_source", "custom_onboarding");
  const ask = renamedIr(ASK_IR_PATH, "answer_query", "custom_question");
  const enrich = renamedIr(ENRICH_IR_PATH, "inspect_context", "custom_context_review");

  assert.equal(classifyDispatchContract(setup, "custom_onboarding"), "setup");
  assert.equal(classifyDispatchContract(ask, "custom_question"), "ask");
  assert.equal(classifyDispatchContract(enrich, "custom_context_review"), "enrich");
  assert.equal(supportsSetupAggregate(setup), true);
  assert.equal(supportsSetupAggregate(ask), false);
  assert.equal(supportsSetupAggregate(enrich), false);
});
