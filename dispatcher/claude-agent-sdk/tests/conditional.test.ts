import { test } from "node:test";
import assert from "node:assert/strict";

// Pure decision-layer tests for the conditional guard/repair realization (no SDK, no network) — see
// conditional.ts's module doc for the R1 (repair fold-into-loop) / R2 (guarded-skip) split.
import {
  classifyConditionalStep,
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  evaluateGuard,
  repairFoldTarget,
  runRepairLoop,
  type GuardState,
  type StepIdentity,
} from "../src/conditional.js";
import type { WhenGuard } from "../src/ir.js";

const GENERATE_SQL: StepIdentity = { name: "generate_sql", produces: "query_result" };

test("evaluateGuard: on_failure is true iff the target step's recorded outcome is failure", () => {
  const when: WhenGuard = { guard: "on_failure", target: "generate_sql" };
  const failed: GuardState = { artifacts: {}, outcomes: { generate_sql: "failure" } };
  const succeeded: GuardState = { artifacts: {}, outcomes: { generate_sql: "success" } };
  const unknown: GuardState = { artifacts: {}, outcomes: {} };
  assert.equal(evaluateGuard(when, failed), true);
  assert.equal(evaluateGuard(when, succeeded), false);
  assert.equal(evaluateGuard(when, unknown), false);
});

test("evaluateGuard: on_flag reads a boolean field out of a produced JSON artifact", () => {
  const when: WhenGuard = { guard: "on_flag", target: "query_intent.needs_clarification" };
  const flagged: GuardState = {
    artifacts: { query_intent: JSON.stringify({ needs_clarification: true }) },
    outcomes: {},
  };
  const clear: GuardState = {
    artifacts: { query_intent: JSON.stringify({ needs_clarification: false }) },
    outcomes: {},
  };
  const malformed: GuardState = { artifacts: { query_intent: "not json" }, outcomes: {} };
  const absent: GuardState = { artifacts: {}, outcomes: {} };
  assert.equal(evaluateGuard(when, flagged), true);
  assert.equal(evaluateGuard(when, clear), false);
  assert.equal(evaluateGuard(when, malformed), false);
  assert.equal(evaluateGuard(when, absent), false);
});

test("evaluateGuard: on_missing is true iff the target artifact was never produced", () => {
  const when: WhenGuard = { guard: "on_missing", target: "query_result" };
  const missing: GuardState = { artifacts: {}, outcomes: {} };
  const present: GuardState = { artifacts: { query_result: "42" }, outcomes: {} };
  assert.equal(evaluateGuard(when, missing), true);
  assert.equal(evaluateGuard(when, present), false);
});

test("evaluateGuard: an unrecognized guard name loud-fails (closed vocabulary)", () => {
  const when = { guard: "on_vibes", target: "x" } as unknown as WhenGuard;
  assert.throws(() => evaluateGuard(when, { artifacts: {}, outcomes: {} }), /unknown guard 'on_vibes'/);
});

test("repairFoldTarget: matches the adjacent on_failure→produces/consumes repair shape", () => {
  const when: WhenGuard = { guard: "on_failure", target: "generate_sql" };
  const target = repairFoldTarget(when, ["query_result"], GENERATE_SQL);
  assert.deepEqual(target, GENERATE_SQL);
});

test("repairFoldTarget: null when the guard target isn't the preceding step", () => {
  const when: WhenGuard = { guard: "on_failure", target: "resolve_intent" };
  assert.equal(repairFoldTarget(when, ["query_result"], GENERATE_SQL), null);
});

test("repairFoldTarget: null when the preceding step's output isn't consumed (not the repair shape)", () => {
  const when: WhenGuard = { guard: "on_failure", target: "generate_sql" };
  assert.equal(repairFoldTarget(when, ["something_else"], GENERATE_SQL), null);
});

test("repairFoldTarget: null for on_flag/on_missing guards regardless of adjacency", () => {
  const when: WhenGuard = { guard: "on_flag", target: "generate_sql" };
  assert.equal(repairFoldTarget(when, ["query_result"], GENERATE_SQL), null);
});

test("repairFoldTarget: null when there is no preceding step", () => {
  const when: WhenGuard = { guard: "on_failure", target: "generate_sql" };
  assert.equal(repairFoldTarget(when, ["query_result"], null), null);
});

test("classifyConditionalStep: repair-shaped on_failure + target failed → repair", () => {
  const when: WhenGuard = { guard: "on_failure", target: "generate_sql" };
  const state: GuardState = { artifacts: { query_result: "boom: syntax error" }, outcomes: { generate_sql: "failure" } };
  const decision = classifyConditionalStep(when, ["query_result"], GENERATE_SQL, state);
  assert.deepEqual(decision, { kind: "repair", target: GENERATE_SQL });
});

test("classifyConditionalStep: repair-shaped on_failure + target succeeded → skip (nothing to repair)", () => {
  const when: WhenGuard = { guard: "on_failure", target: "generate_sql" };
  const state: GuardState = { artifacts: { query_result: "42" }, outcomes: { generate_sql: "success" } };
  const decision = classifyConditionalStep(when, ["query_result"], GENERATE_SQL, state);
  assert.deepEqual(decision, { kind: "skip" });
});

test("classifyConditionalStep: on_flag guard true → run (R2)", () => {
  const when: WhenGuard = { guard: "on_flag", target: "query_intent.needs_clarification" };
  const state: GuardState = { artifacts: { query_intent: JSON.stringify({ needs_clarification: true }) }, outcomes: {} };
  const decision = classifyConditionalStep(when, ["query_intent"], null, state);
  assert.deepEqual(decision, { kind: "run" });
});

test("classifyConditionalStep: on_flag guard false → skip (R2)", () => {
  const when: WhenGuard = { guard: "on_flag", target: "query_intent.needs_clarification" };
  const state: GuardState = { artifacts: { query_intent: JSON.stringify({ needs_clarification: false }) }, outcomes: {} };
  const decision = classifyConditionalStep(when, ["query_intent"], null, state);
  assert.deepEqual(decision, { kind: "skip" });
});

test("classifyConditionalStep: on_missing guard true (artifact absent) → run", () => {
  const when: WhenGuard = { guard: "on_missing", target: "cached_result" };
  const state: GuardState = { artifacts: {}, outcomes: {} };
  const decision = classifyConditionalStep(when, [], null, state);
  assert.deepEqual(decision, { kind: "run" });
});

test("classifyConditionalStep: on_failure NOT shaped like adjacent repair falls back to R2 guarded-skip", () => {
  // Target failed, but this step doesn't consume the target's output — not the repair shape.
  const when: WhenGuard = { guard: "on_failure", target: "generate_sql" };
  const state: GuardState = { artifacts: {}, outcomes: { generate_sql: "failure" } };
  const decision = classifyConditionalStep(when, ["something_else"], GENERATE_SQL, state);
  assert.deepEqual(decision, { kind: "run" });
});

test("runRepairLoop: recovers on the first successful attempt", async () => {
  let calls = 0;
  const result = await runRepairLoop(DEFAULT_MAX_REPAIR_ATTEMPTS, async () => {
    calls++;
    return { failed: false };
  });
  assert.deepEqual(result, { recovered: true, attempts: 1 });
  assert.equal(calls, 1);
});

test("runRepairLoop: exhausts the bound and reports non-recovery (caller loud-fails)", async () => {
  let calls = 0;
  const result = await runRepairLoop(DEFAULT_MAX_REPAIR_ATTEMPTS, async () => {
    calls++;
    return { failed: true };
  });
  assert.deepEqual(result, { recovered: false, attempts: DEFAULT_MAX_REPAIR_ATTEMPTS });
  assert.equal(calls, DEFAULT_MAX_REPAIR_ATTEMPTS);
});

test("runRepairLoop: never exceeds maxAttempts even when every attempt fails", async () => {
  let calls = 0;
  const maxAttempts = 3;
  await runRepairLoop(maxAttempts, async () => {
    calls++;
    return { failed: true };
  });
  assert.equal(calls, maxAttempts);
});

test("runRepairLoop: recovers on a later attempt within the bound", async () => {
  let calls = 0;
  const maxAttempts = 3;
  const result = await runRepairLoop(maxAttempts, async () => {
    calls++;
    return { failed: calls < 2 };
  });
  assert.deepEqual(result, { recovered: true, attempts: 2 });
});
