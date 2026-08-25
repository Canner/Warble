import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_COSTS,
  applySubmitResponse,
  beginAction,
  calculateInitialBudget,
  formatBirdBudget,
} from "../src/protocol.js";
import type { BirdSessionState, BirdToolName } from "../src/types.js";

function stateWithBudget(budget: number): BirdSessionState {
  return {
    task_id: "alien_1",
    db_name: "alien",
    user_query: "ambiguous query",
    current_phase: 1,
    budget_remaining: budget,
    initial_budget: budget,
    total_reward: 0,
    dialogue_history: [],
    tool_trajectory: [],
    adk_events: [],
    phase1_completed: false,
    phase2_completed: false,
    task_done: false,
  };
}

test("uses the pinned official initial-budget formula", () => {
  assert.equal(
    calculateInitialBudget({ critical: 2, knowledge: 1, patience: 3 }),
    18,
  );
});

/**
 * Every expectation here is the verbatim output of CPython 3.12 `f"{v:.1f}"` for that literal.
 *
 * `f"{v:.1f}"` rounds the double's TRUE binary value and breaks a tie half-to-even only when that
 * value IS the midpoint, so which way an `x.x5` literal goes is a property of its binary expansion
 * rather than of its digits. `0.05` and `0.45` sit just above their midpoint and round up; `0.15`,
 * `0.35` and `0.95` sit just below and round down; only the quarters are real ties, and those
 * alone go to the even digit. No tolerance around the midpoint can reproduce that pattern — it
 * turns the values nearest the midpoint into ties, which is the one thing they are not.
 */
test("formats budgets exactly as Python's one-decimal format does", () => {
  const pythonOutput: ReadonlyArray<readonly [number, string]> = [
    [0, "0.0"],
    [0.05, "0.1"],
    [0.15, "0.1"],
    [0.25, "0.2"],
    [0.35, "0.3"],
    [0.45, "0.5"],
    [0.5, "0.5"],
    [0.75, "0.8"],
    [0.95, "0.9"],
    [1, "1.0"],
    [1.05, "1.1"],
    [1.15, "1.1"],
    [1.25, "1.2"],
    [1.5, "1.5"],
    [1.75, "1.8"],
    [2, "2.0"],
    [2.25, "2.2"],
    [2.35, "2.4"],
    [2.5, "2.5"],
    [3, "3.0"],
    [7.5, "7.5"],
    [12, "12.0"],
    [-0.25, "-0.2"],
    [-1.5, "-1.5"],
  ];

  for (const [value, expected] of pythonOutput) {
    assert.equal(formatBirdBudget(value), expected, `${value} must format as Python does`);
  }
});

/**
 * The reachable domain, pinned independently of the rounding rule that serves the rest.
 *
 * An initial budget is an integer and every cost is 0.5, 1, 2 or 3, so a live ledger only ever
 * holds a multiple of 0.5: all exactly representable, none of them a tie at one decimal. This is
 * the set the differential oracle and every fixture budget live in, so a change to the rounding
 * rule has to leave it untouched.
 */
test("every budget a live ledger can hold formats as its own exact value", () => {
  for (let halves = 0; halves <= 120; halves += 1) {
    const budget = halves / 2;
    assert.equal(
      formatBirdBudget(budget),
      `${Math.floor(budget)}.${halves % 2 === 0 ? "0" : "5"}`,
    );
  }
});

test("exports exactly the nine pinned action costs", () => {
  assert.deepEqual(TOOL_COSTS, {
    execute_sql: 1,
    get_schema: 1,
    get_all_column_meanings: 1,
    get_column_meaning: 0.5,
    get_all_external_knowledge_names: 0.5,
    get_knowledge_definition: 0.5,
    get_all_knowledge_definitions: 1,
    ask_user: 2,
    submit_sql: 3,
  });
});

test("an affordable action is charged before execution", () => {
  assert.deepEqual(beginAction(stateWithBudget(2), "ask_user"), {
    kind: "execute",
    cost: 2,
    budgetBefore: 2,
    budgetAfter: 0,
    forcedExit: false,
  });
});

test("an unaffordable non-submit is rejected without charge or mutation", () => {
  const state = stateWithBudget(1);
  const snapshot = structuredClone(state);
  assert.deepEqual(beginAction(state, "ask_user"), {
    kind: "reject",
    cost: 0,
    requiredCost: 2,
    budgetBefore: 1,
    budgetAfter: 1,
    message:
      "Budget exhausted (1.0 remaining). You MUST call submit_sql now with your best SQL.",
  });
  assert.deepEqual(state, snapshot);
});

test("all non-submit tools use their declared cost", () => {
  for (const [name, cost] of Object.entries(TOOL_COSTS)) {
    if (name === "submit_sql") continue;
    const decision = beginAction(stateWithBudget(10), name as BirdToolName);
    assert.equal(decision.kind, "execute");
    assert.equal(decision.cost, cost);
    assert.equal(decision.budgetAfter, 10 - cost);
  }
});

test("submit at or below its price becomes the free terminal exit", () => {
  for (const budget of [3, 2, 0]) {
    assert.deepEqual(beginAction(stateWithBudget(budget), "submit_sql"), {
      kind: "execute",
      cost: 3,
      budgetBefore: budget,
      budgetAfter: -1,
      forcedExit: true,
    });
  }
});

test("a failed submit leaves phase and reward open while budget remains", () => {
  const original = stateWithBudget(8);
  const next = applySubmitResponse(
    original,
    { passed: false, message: "SQL failed Phase 1.", reward: 0 },
  );
  assert.equal(next.current_phase, 1);
  assert.equal(next.total_reward, 0);
  assert.equal(next.phase1_completed, false);
  assert.equal(next.task_done, false);
  assert.equal(next._last_submit_raw, "SQL failed Phase 1.");
  assert.equal(original._last_submit_raw, undefined);
});

test("phase 1 pass with follow-up advances but keeps the task open", () => {
  const next = applySubmitResponse(
    stateWithBudget(8),
    {
      passed: true,
      message: "Phase 1 correct",
      reward: 0.7,
      phase_completed: 1,
      has_follow_up: true,
      follow_up_query: "now change it",
    },
  );
  assert.equal(next.total_reward, 0.7);
  assert.equal(next.phase1_completed, true);
  assert.equal(next.current_phase, 2);
  assert.equal(next.task_done, false);
});

test("phase 1 pass without follow-up completes the task", () => {
  const next = applySubmitResponse(
    stateWithBudget(8),
    {
      passed: true,
      message: "Phase 1 correct",
      reward: 0.7,
      phase_completed: 1,
      has_follow_up: false,
    },
  );
  assert.equal(next.phase1_completed, true);
  assert.equal(next.current_phase, 2);
  assert.equal(next.task_done, true);
});

test("phase 2 pass accumulates reward and completes the task", () => {
  const state = stateWithBudget(8);
  state.current_phase = 2;
  state.phase1_completed = true;
  state.total_reward = 0.7;
  const next = applySubmitResponse(
    state,
    {
      passed: true,
      message: "Phase 2 correct",
      reward: 0.3,
      phase_completed: 2,
    },
  );
  assert.equal(next.total_reward, 1);
  assert.equal(next.phase2_completed, true);
  assert.equal(next.task_done, true);
});

test("a forced failed submit leaves task_done authoritative and records the result", () => {
  const next = applySubmitResponse(
    stateWithBudget(-1),
    { passed: false, message: "wrong", reward: 0 },
  );
  assert.equal(next.task_done, false);
  assert.equal(next._last_submit_raw, "wrong");
});
