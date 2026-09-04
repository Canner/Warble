import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Cross-back-end conformance: this back-end's conditional guard/repair decision layer
// (conditional.ts) is exercised against the SAME shared fixture the claude-code-cli back-end's
// mirrored Rust module (conditional.rs) is tested against. A semantic drift between the two
// back-ends' understanding of the closed guard vocabulary or the bounded repair loop fails HERE
// and in that crate's test — whichever moved away from the shared fixture.
import {
  classifyConditionalStep,
  runRepairLoop,
  type ConditionalDecision,
  type GuardState,
  type StepIdentity,
  type StepOutcome,
} from "../src/conditional.js";
import type { WhenGuard } from "../src/ir.js";

const dirName = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(dirName, "..", "..", "conformance-fixtures", "conditional.json");

interface GuardScenario {
  name: string;
  when: WhenGuard;
  consumes: string[];
  preceding_step: StepIdentity | null;
  /** The fixture's key is `slots`, and stays that way: it is a cross-back-end contract file, so
   *  renaming the key would mean changing every consumer in lockstep for no gain. Internally the
   *  same data is `artifacts`, because IR 0.7 took "slot" for prompt positions. This field is the
   *  one place the two names meet, and both halves of getting it wrong are caught: renaming only
   *  the read below is a compile error against this declaration, and renaming this declaration
   *  with it compiles but leaves the fixture's own key unread, which throws a `TypeError` from the
   *  first scenario whose guard actually reads an artifact — the `on_failure` scenarios read
   *  `outcomes` instead and pass straight through. Both were confirmed by mutation. */
  slots: Record<string, string>;
  outcomes: Record<string, StepOutcome>;
  expected_decision: ConditionalDecision;
}

interface RepairLoopScenario {
  name: string;
  max_attempts: number;
  attempt_outcomes: Array<"success" | "failure">;
  expected: { recovered: boolean; attempts: number };
}

interface Fixture {
  guard_scenarios: GuardScenario[];
  repair_loop_scenarios: RepairLoopScenario[];
}

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
}

test("shared conformance fixture: guard_scenarios match classifyConditionalStep's decision", () => {
  const fixture = loadFixture();
  assert.ok(fixture.guard_scenarios.length > 0, "fixture must carry guard scenarios");
  for (const scenario of fixture.guard_scenarios) {
    const state: GuardState = { artifacts: scenario.slots, outcomes: scenario.outcomes };
    const decision = classifyConditionalStep(
      scenario.when,
      scenario.consumes,
      scenario.preceding_step,
      state,
    );
    assert.deepEqual(decision, scenario.expected_decision, `scenario '${scenario.name}'`);
  }
});

test("shared conformance fixture: repair_loop_scenarios match runRepairLoop's recovery/exhaustion", async () => {
  const fixture = loadFixture();
  assert.ok(fixture.repair_loop_scenarios.length > 0, "fixture must carry repair-loop scenarios");
  for (const scenario of fixture.repair_loop_scenarios) {
    let idx = 0;
    const result = await runRepairLoop(scenario.max_attempts, async () => {
      const failed = scenario.attempt_outcomes[idx] === "failure";
      idx++;
      return { failed };
    });
    assert.deepEqual(result, scenario.expected, `scenario '${scenario.name}'`);
  }
});
