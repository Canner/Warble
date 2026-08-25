import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseIr, distinctTiers } from "../src/ir.js";
import { DispatchError } from "../src/error.js";

const DEMO_AGENT_IR = fileURLToPath(
  new URL("../../../examples/demo-agent/ir.golden.json", import.meta.url),
);

const GENBI_DEFAULT_IR = fileURLToPath(
  new URL("../../../genbi-default/ir.golden.json", import.meta.url),
);

const IR_VERSION_MISMATCH_FIXTURE = fileURLToPath(
  new URL("../../conformance-fixtures/ir-version-mismatch.json", import.meta.url),
);

function loadDemoIr() {
  return parseIr(readFileSync(DEMO_AGENT_IR, "utf8"));
}

test("deserializes the demo-agent golden IR (the same JSON the Rust front-end emits)", () => {
  const ir = loadDemoIr();
  assert.equal(ir.warble_ir_version, "0.6");
  assert.equal(ir.profile, "orders-analytics");
  assert.equal(ir.context_binding.project, "../jaffle-wren");
  assert.deepEqual(ir.config, {});
  assert.equal(ir.components.length, 1);

  const node = ir.components[0]!;
  assert.equal(node.id, "generate_dashboard");
  assert.equal(node.verb, "generate_dashboard");
  assert.equal(node.type, "analytical");
  assert.equal(node.realization_kind, "skill");
  assert.equal(node.trigger.kind, "one_shot");
  assert.equal(node.effect.outcome.kind, "none");
});

test("carries the v0.2 per-step I/O contract + tiers", () => {
  const node = loadDemoIr().components[0]!;
  assert.deepEqual(
    node.llm_calls.map((c) => c.name),
    ["plan_dashboard", "compose_layout"],
  );
  assert.deepEqual(
    node.llm_calls.map((c) => c.tier),
    ["strong", "cheap"],
  );
  assert.deepEqual(distinctTiers(node.llm_calls), ["strong", "cheap"]);

  const [plan, compose] = node.llm_calls as [typeof node.llm_calls[number], typeof node.llm_calls[number]];
  assert.deepEqual(plan.consumes, []);
  assert.equal(plan.produces, "query_plan");
  assert.deepEqual(compose.consumes, ["query_plan"]);
  assert.equal(compose.produces, "dashboard_summary");
  assert.ok(plan.prompt.length > 0 && !plan.prompt.startsWith("##"));

  // unconditional steps carry when: null (present key, no guard).
  assert.equal(plan.conditional, false);
  assert.equal(plan.when, null);
});

test("parses a conditional step's `when` guard object (closed vocabulary)", () => {
  const ir = parseIr(readFileSync(GENBI_DEFAULT_IR, "utf8"));
  const answerQuery = ir.components.find((c) => c.id === "answer_query");
  assert.ok(answerQuery, "answer_query component must be present");

  const repair = answerQuery.llm_calls.find((c) => c.name === "repair_sql");
  assert.ok(repair, "repair_sql step must be present");
  assert.equal(repair.conditional, true);
  // The real object-parsing path: `when` deserializes into a { guard, target } record.
  assert.deepEqual(repair.when, { guard: "on_failure", target: "generate_sql" });

  // A sibling unconditional step in the same component still carries when: null.
  const generate = answerQuery.llm_calls.find((c) => c.name === "generate_sql");
  assert.ok(generate, "generate_sql step must be present");
  assert.equal(generate.when, null);
});

test("preserves the locked read-only guardrail and typed render blocks", () => {
  const node = loadDemoIr().components[0]!;
  const readOnly = node.guardrails.find((g) => g.name === "read_only_execution");
  assert.ok(readOnly?.locked, "read_only_execution is locked");
  assert.deepEqual(
    node.effect.render_blocks.map((b) => b.type),
    ["chart", "table", "kpi_card"],
  );
  assert.deepEqual(node.required_capabilities, [
    "sql_execution:read_only",
    "genbi_build",
    "llm:per_step_tier",
    "llm:strong",
    "llm:cheap",
  ]);
});

test("loud-fails on an unsupported IR version", () => {
  assert.throws(
    () => parseIr(JSON.stringify({ warble_ir_version: "9.9", profile: "x", components: [] })),
    (e: unknown) => e instanceof DispatchError && /unsupported warble_ir_version '9.9'/.test((e as Error).message),
  );
});

test("loud-fails on the shared cross-back-end version-mismatch fixture", () => {
  const fixture = JSON.parse(readFileSync(IR_VERSION_MISMATCH_FIXTURE, "utf8")) as {
    ir: unknown;
    expected_error_contains: string[];
  };
  assert.throws(
    () => parseIr(JSON.stringify(fixture.ir)),
    (e: unknown) =>
      e instanceof DispatchError &&
      fixture.expected_error_contains.every((substring) => e.message.includes(substring)),
  );
});

test("loud-fails on a missing load-bearing field", () => {
  assert.throws(
    () =>
      parseIr(
        JSON.stringify({
          warble_ir_version: "0.6",
          profile: "x",
          context_binding: { project: "p", binding_mode: "m" },
          config: {},
          components: [{ id: "c" }],
        }),
      ),
    (e: unknown) => e instanceof DispatchError,
  );
});

test("loud-fails on an out-of-vocabulary enum value", () => {
  assert.throws(
    () =>
      parseIr(
        JSON.stringify({
          warble_ir_version: "0.6",
          profile: "x",
          context_binding: { project: "p", binding_mode: "m" },
          config: {},
          components: [
            {
              id: "c",
              verb: "c",
              type: "analytical",
              realization_kind: "skill",
              context_binding: { project: "p", binding_mode: "m" },
              precondition_result: { status: "pass", checks: [] },
              prompt_fragment: "x",
              llm_calls: [],
              guardrails: [],
              trigger: { kind: "hourly" },
              required_capabilities: [],
              borrowed_actions: [],
              eval_ref: "e",
              effect: { render_blocks: [], outcome: { kind: "none" } },
            },
          ],
        }),
      ),
    (e: unknown) => e instanceof DispatchError && /trigger.*'hourly'/.test((e as Error).message),
  );
});
