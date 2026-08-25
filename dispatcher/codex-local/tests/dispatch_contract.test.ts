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

test("a component's id carries no dispatch meaning: renaming a legitimate component to 'apply_enrichment' is accepted, and renaming the genuine gated-tool component away from it is still refused", () => {
  // Invariant #1: dispatchers key on IR shape, never on id/verb. The literal string
  // "apply_enrichment" used to be treated as reserved purely by name; it no longer is. A
  // legitimately setup-/Ask-shaped component that happens to share that name dispatches like any
  // other, and the genuine gated-tool component (non-`skill` realization_kind) still wall-hits
  // under a different name, because the rejection is about its IR shape, not its identity.
  const setupRenamed = renamedIr(SETUP_IR_PATH, "connect_source", "apply_enrichment");
  const askRenamed = renamedIr(ASK_IR_PATH, "answer_query", "apply_enrichment");
  assert.equal(classifyDispatchContract(setupRenamed, "apply_enrichment"), "setup");
  assert.equal(classifyDispatchContract(askRenamed, "apply_enrichment"), "ask");
  assert.equal(supportsSetupAggregate(setupRenamed), true);

  const genuineRenamed = renamedIr(ENRICH_IR_PATH, "apply_enrichment", "apply_enrichment_v2");
  assert.throws(
    () => classifyDispatchContract(genuineRenamed, "apply_enrichment_v2"),
    /apply_enrichment_v2.*host-executed/,
  );
});

test("a reshaped component declaring only honestly-realizable capabilities is dispatchable, regardless of what it is named", () => {
  // The reverse of the case above: a component's declared contract, not its name, is what makes
  // it legal here. Reshaping the genuine gated-tool component's `required_capabilities` and
  // `realization_kind` to request nothing this target cannot honestly guarantee makes it
  // dispatchable — apply remains host-owned in practice because nothing else in the git-authored
  // profile ever declares this shape for it, not because the dispatcher recognizes its name.
  const reshaped = withComponent(ENRICH_IR_PATH, "apply_enrichment", (node) => {
    Object.assign(node, {
      type: "analytical",
      realization_kind: "skill",
      required_capabilities: ["semantic_introspection", "llm:strong"],
      llm_calls: [
        {
          name: "draft",
          tier: "strong",
          prompt: "reshaped read-only shape",
          produces: "enrichment_proposal",
          consumes: [],
          conditional: false,
          when: null,
        },
      ],
      guardrails: [{ name: "read_only_execution", locked: true }],
      effect: { render_blocks: [], outcome: { kind: "none" } },
    });
  });
  assert.equal(classifyDispatchContract(reshaped, "apply_enrichment"), "enrich");
});

test("a zero-match wall-hit surfaces the specific family reason instead of only the generic sentence", () => {
  // Before this fix, matchesXContractShape swallowed every CodexDispatchError and returned only a
  // boolean, so classifyDispatchContract's zero-match branch could report nothing more specific
  // than "no supported codex:local execution contract matches its complete IR shape" — the precise
  // guardrail/shape reason that used to be printed (pre-dispatch-through-app-server) was lost.
  const brokenGuardrail = withComponent(ASK_IR_PATH, "answer_query", (node) => {
    (node["guardrails"] as Array<Record<string, unknown>>)[0]!["locked"] = false;
  });
  assert.throws(
    () => classifyDispatchContract(brokenGuardrail, "answer_query"),
    /no supported codex:local execution contract matches its complete IR shape.*Ask guardrails must match the locked read-only\/deterministic and bounded row\/timeout contract/,
  );
});
