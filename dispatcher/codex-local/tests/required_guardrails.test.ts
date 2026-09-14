import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseIr } from "../src/ir.js";
import { validateRequirements } from "../src/target_profile.js";
import { ASK_IR_PATH, ENRICH_IR_PATH, SETUP_IR_PATH, uncomposedDashboardIr } from "./helpers.js";

const cases = [
  ["exec", readFileSync(SETUP_IR_PATH, "utf8"), "attach_source", ["setup_execution"]],
  ["turn", readFileSync(ENRICH_IR_PATH, "utf8"), "survey_context", ["read_only_execution"]],
  ["orchestrate", readFileSync(ASK_IR_PATH, "utf8"), "answer_query", ["read_only_execution", "deterministic_gate", "row_limit", "statement_timeout"]],
  ["orchestrate", uncomposedDashboardIr(), "generate_dashboard", ["artifact_write"]],
] as const;

for (const [transport, raw, component, guards] of cases) {
  for (const guard of guards) {
    test(`${transport} refuses a missing capability-required ${guard} guardrail`, () => {
      const node = parseIr(raw).components.find((candidate) => candidate.id === component)!;
      assert.doesNotThrow(() => validateRequirements(node, transport));
      node.guardrails = node.guardrails.filter((candidate) => candidate.name !== guard);
      assert.throws(() => validateRequirements(node, transport), new RegExp(`required guardrail '${guard}' is missing`));
    });
  }
}
