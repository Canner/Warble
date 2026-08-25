import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { OFFICIAL_USER_SIM_MODEL, buildRunReport, type RunInputs } from "../src/report-build.js";
import { GATED_GROUND_TRUTH_NOTICE } from "../src/report-model.js";
import { CANNED_USER_RESPONSE } from "../src/report-simulator.js";

/**
 * Index with a narrowing assertion: `noUncheckedIndexedAccess` types every element `T | undefined`,
 * and an assertion here fails the same test that a missing element would have failed anyway.
 */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  assert.ok(item !== undefined, `expected an element at index ${index}`);
  return item;
}

const checkout = process.env.BIRD_INTERACT_CHECKOUT;

/**
 * Invented, and it has to stay invented.
 *
 * This file is committed; the real `sol_sql` is gated benchmark material that exists only in the
 * gitignored `data/` tree. Nothing may be copied out of there into here — not a statement, and not
 * a fragment of one either.
 */
const GOLD = "SELECT c.ClassName, AVG(h.MassKg - 0.25 * ABS(h.DriftKg)) FROM InventedHulls h";

function inputs(over: Partial<RunInputs> = {}): RunInputs {
  return {
    run: "alien-5",
    generatedAt: "2026-08-25 11:41",
    manifest: {
      version: 1, createdAt: "2026-08-25T00:00:00.000Z",
      official: { repository: "r", commit: "4".repeat(40) },
      publicSnapshot: { repository: "h", commit: "5".repeat(40), fileCount: 57, manifestSha256: "6".repeat(64) },
      groundTruth: { file: "private/gt.jsonl", sha256: "7".repeat(64) },
      outputs: {
        combined: { file: "c", rows: 300, sha256: "8".repeat(64) },
        smoke: { file: "s", rows: 1, sha256: "8".repeat(64) },
        mdl: { file: "m", sha256: "8".repeat(64) },
      },
      database: {
        name: "alien", template: "alien_template", container: "c", hostPort: 55432,
        imageReference: "i", imageId: `sha256:${"9".repeat(64)}`, repoDigests: [],
      },
      wren: { version: "wrenai 0.8.1" },
      taskIds: ["alien_1"],
    } as RunInputs["manifest"],
    pythonVersion: "3.11.15",
    systemModel: "claude-sonnet-4-5-20250929",
    userSimulatorModel: OFFICIAL_USER_SIM_MODEL,
    official: {
      metrics: { total_tasks: 1, total_reward: 0, average_reward: 0, phase1_rate: 0, phase1_count: 0, phase2_rate: 0, phase2_count: 0 },
      results: [{
        task_id: "alien_1", instance_id: "alien_1", database: "alien",
        phase1_passed: false, phase2_passed: false, total_reward: 0,
        budget_used: 18, budget_remaining: -1, elapsed_seconds: 65.6,
        dialogue_history: [{ role: "agent", content: "which metric?" }, { role: "user", content: "LOAD = MassKg - 0.25 * ABS(DriftKg)" }],
      }],
    },
    traces: {
      alien_1: {
        task_id: "alien_1", initial_budget: 18, budget_remaining: -1, model_turns: 23,
        phase1_completed: false, phase2_completed: false, total_reward: 0, current_phase: 1,
        dialogue_history: [{ role: "agent", content: "which metric?" }, { role: "user", content: "LOAD = MassKg - 0.25 * ABS(DriftKg)" }],
        rejected_actions: [],
        tool_trajectory: [
          { type: "tool", tool: "get_knowledge_definition", args: {}, result: "ok", cost: 0.5, budget_before: 18, budget_after: 17.5, phase: 1 },
          { type: "tool", tool: "submit_sql", args: { sql: GOLD }, result: "SQL failed Phase 1. Your SQL is not correct.", cost: 3, budget_before: 13, budget_after: 10, phase: 1, semantic_sql: GOLD, native_sql: "WITH x AS (...) SELECT 1" },
        ],
      },
    },
    dataset: {
      alien_1: {
        instance_id: "alien_1", selected_database: "alien", category: "Query",
        difficulty_tier: "Moderate", high_level: false,
        amb_user_query: "how does load vary", query: "how does LOAD vary by ClassName",
        external_knowledge: [0, 50],
        knowledge_ambiguity: [{ deleted_knowledge: 0 }],
        conditions: { decimal: -1, distinct: false, order: true },
        user_query_ambiguity: {
          critical_ambiguity: [{ term: "hull load", sql_snippet: "h.MassKg - 0.25 * ABS(h.DriftKg)", is_mask: true, type: "knowledge_linking_ambiguity" }],
          non_critical_ambiguity: [{ term: "order", sql_snippet: "ORDER BY avg_load DESC", is_mask: false, type: "sort_ambiguity" }],
        },
        sol_sql: [GOLD],
      },
    },
    simulatorLog: "INFO ready\n",
    tolerant: null,
    ...over,
  } as RunInputs;
}

test("gold SQL is read off the dataset row", () => {
  const r = buildRunReport(inputs());
  assert.deepEqual(at(r.tasks, 0).goldSql, [GOLD]);
});

test("several gold statements all survive, in the dataset's own order", () => {
  const base = inputs();
  const second = "-- second statement\nSELECT COUNT(*) FROM InventedHulls";
  const r = buildRunReport({
    ...base,
    dataset: { alien_1: { ...at(Object.values(base.dataset), 0), sol_sql: [GOLD, second] } },
  } as RunInputs);
  assert.deepEqual(at(r.tasks, 0).goldSql, [GOLD, second]);
});

/**
 * The empty case is a list, never a placeholder string: a placeholder would render inside a `<pre>`
 * and read as a statement a reader could quote as the answer.
 */
test("a task with no dataset row yields no gold rather than a fabricated one", () => {
  const r = buildRunReport(inputs({ dataset: {} }));
  assert.deepEqual(at(r.tasks, 0).goldSql, []);
  assert.ok(r.defects.some((d) => d.includes("alien_1") && /dataset row/i.test(d)));
});

test("a dataset row whose sol_sql is not a list of statements yields no gold", () => {
  const base = inputs();
  const row = at(Object.values(base.dataset), 0);
  for (const wrong of [undefined, "SELECT 1", [], [42, null], [" "]]) {
    const r = buildRunReport({
      ...base,
      dataset: { alien_1: { ...row, sol_sql: wrong } },
    } as unknown as RunInputs);
    assert.deepEqual(at(r.tasks, 0).goldSql, [], `accepted ${JSON.stringify(wrong)} as gold`);
  }
});

test("every report states that it carries gated ground truth", () => {
  assert.equal(buildRunReport(inputs()).gatedNotice, GATED_GROUND_TRUTH_NOTICE);
  // A run with no gold on it still carries the statement: the artifact's format is what is gated,
  // and a notice that came and went would teach a reader to look for it before forwarding.
  assert.equal(buildRunReport(inputs({ dataset: {} })).gatedNotice, GATED_GROUND_TRUTH_NOTICE);
});

test("a healthy run reports strict scores and no tolerant column", () => {
  const r = buildRunReport(inputs());
  assert.equal(r.withheld, null);
  assert.equal(r.strict?.totalTasks, 1);
  assert.equal(r.tolerant, null);
  assert.equal(r.simulator.verdict, "healthy");
  assert.equal(at(r.tasks, 0).tolerantPassed, null);
});

test("the agent's ask is recorded with the answer it received", () => {
  const r = buildRunReport(inputs());
  assert.equal(at(r.tasks, 0).asks.length, 1);
  assert.equal(at(at(r.tasks, 0).asks, 0).canned, false);
  assert.match(at(at(r.tasks, 0).asks, 0).answer, /LOAD/);
});

test("withheld knowledge recovered through ask_user is not counted as missed", () => {
  const r = buildRunReport(inputs());
  assert.deepEqual(at(r.tasks, 0).knowledge.withheld, [0]);
  assert.deepEqual(at(r.tasks, 0).knowledge.missed, []);
});

test("a void simulator withholds both scores and names the reason", () => {
  const r = buildRunReport(inputs({ simulatorLog: "LLM call failed: boom\n" }));
  assert.equal(r.simulator.verdict, "void");
  assert.equal(r.strict, null);
  assert.equal(r.tolerant, null);
  assert.match(r.withheld ?? "", /simulator/i);
});

test("a tolerant verdict turns a strict failure into passed-tolerant", () => {
  const r = buildRunReport(inputs({ tolerant: { alien_1: true } }));
  assert.equal(at(r.tasks, 0).tolerantPassed, true);
  assert.equal(at(r.tasks, 0).failureClass, "passed-tolerant");
  assert.equal(r.tolerant?.phase1Count, 1);
});

test("a non-official user-simulator model raises a comparability warning", () => {
  const withOfficial = buildRunReport(inputs());
  assert.ok(!withOfficial.warnings.some((w) => /user simulator/i.test(w)));
  const swapped = buildRunReport(inputs({ userSimulatorModel: "openai/gpt-4o" }));
  assert.ok(swapped.warnings.some((w) => /user simulator/i.test(w) && w.includes("openai/gpt-4o")));
});

/**
 * "Differs from the official default" and "we do not know what it was" are different facts, and the
 * unknown one must not be delivered as silence: with no warning at all, the absence would read
 * exactly like the verified-official case above.
 */
test("an unrecorded user-simulator model warns that it is unknown, not that it differs", () => {
  const unknown = buildRunReport(inputs({ userSimulatorModel: null }));
  const warning = unknown.warnings.find((w) => /user simulator/i.test(w));
  assert.ok(warning !== undefined, "an unrecorded simulator must still warn");
  assert.match(warning, /did not record/i, "it must say the run recorded nothing");
  assert.match(warning, /unrecorded/i, "the gap is stated in the same word the page renders");
  assert.ok(!/ran on/.test(warning), "it must not claim any model ran");
  assert.ok(warning.includes(OFFICIAL_USER_SIM_MODEL), "the official default is still the reference");

  // And the three states stay distinct: unknown never renders as the differs-from-official text.
  const differs = buildRunReport(inputs({ userSimulatorModel: "openai/gpt-4o" }));
  assert.notEqual(warning, differs.warnings.find((w) => /user simulator/i.test(w)));
});

test("every run warns that it is a subset and not leaderboard-comparable", () => {
  const r = buildRunReport(inputs());
  assert.ok(r.warnings.some((w) => /leaderboard/i.test(w)));
});

test("a trace that disagrees with the official row is a named defect", () => {
  const base = inputs();
  const drifted = {
    ...base,
    traces: { alien_1: { ...base.traces.alien_1, total_reward: 1 } },
  } as RunInputs;
  const r = buildRunReport(drifted);
  assert.ok(r.defects.some((d) => d.includes("alien_1") && /reward/i.test(d)));
});

test("a missing trace is a named defect rather than a crash", () => {
  const r = buildRunReport(inputs({ traces: {} }));
  assert.ok(r.defects.some((d) => d.includes("alien_1") && /trace/i.test(d)));
  assert.equal(at(r.tasks, 0).submits.length, 0);
});

test("both difficulty vocabularies survive into the breakdown unmerged", () => {
  const base = inputs();
  const two = {
    ...base,
    official: {
      metrics: { ...base.official.metrics, total_tasks: 2 },
      results: [base.official.results[0], { ...base.official.results[0], task_id: "alien_2", instance_id: "alien_2" }],
    },
    traces: { ...base.traces, alien_2: { ...base.traces.alien_1, task_id: "alien_2" } },
    dataset: {
      ...base.dataset,
      alien_2: { ...base.dataset.alien_1, instance_id: "alien_2", difficulty_tier: "Medium" },
    },
  } as RunInputs;
  const r = buildRunReport(two);
  assert.deepEqual(r.difficultyVocabularies.slice().sort(), ["Medium", "Moderate"]);
  assert.deepEqual(r.byDifficulty.map((g) => g.key).sort(), ["Medium", "Moderate"]);
});

test("an all-canned ask set voids the run from the dialogue alone", () => {
  const base = inputs();
  const canned = {
    ...base,
    official: {
      ...base.official,
      results: [{
        ...base.official.results[0],
        dialogue_history: [{ role: "agent", content: "q" }, { role: "user", content: CANNED_USER_RESPONSE }],
      }],
    },
  } as RunInputs;
  assert.equal(buildRunReport(canned).withheld !== null, true);
});

/**
 * The same run, with the final `submit_sql` recording `result`.
 *
 * `tools.ts` strips `"[exec_err_flg] "` before recording, so the results a real trace carries are
 * the bare messages; the marker form is here because the official row may still preserve it.
 */
function classifyWithSubmitResult(result: string): string {
  const base = inputs();
  const trace = base.traces.alien_1;
  assert.ok(trace !== undefined);
  return at(
    buildRunReport({
      ...base,
      traces: {
        alien_1: {
          ...trace,
          tool_trajectory: trace.tool_trajectory.map((entry) =>
            entry.tool === "submit_sql" ? { ...entry, result } : entry,
          ),
        },
      },
    }).tasks,
    0,
  ).failureClass;
}

test("SQL that failed to execute is exec-error, not a misread question", () => {
  assert.equal(
    classifyWithSubmitResult('Error executing submitted SQL: relation "x" does not exist'),
    "exec-error",
  );
});

test("a submission that timed out is exec-error", () => {
  assert.equal(classifyWithSubmitResult("Submitted SQL execution timed out"), "exec-error");
});

test("the raw [exec_err_flg] marker is still recognised", () => {
  assert.equal(
    classifyWithSubmitResult("[exec_err_flg] Error executing submitted SQL: boom"),
    "exec-error",
  );
});

test("an ordinary scorer rejection is not an execution failure", () => {
  const failureClass = classifyWithSubmitResult("SQL failed Phase 1. Your SQL is not correct.");
  assert.notEqual(failureClass, "exec-error");
  assert.equal(failureClass, "intent-ok");
});

/**
 * The same run whose only answered ask was canned, plus a second ask nothing ever answered.
 *
 * The empty answer is the one an unfiltered ratio would count as a non-canned ask.
 */
function cannedThenUnanswered(): RunInputs {
  const base = inputs();
  const row = at(base.official.results, 0);
  return {
    ...base,
    official: {
      ...base.official,
      results: [
        {
          ...row,
          dialogue_history: [
            { role: "agent", content: "which metric?" },
            { role: "user", content: CANNED_USER_RESPONSE },
            { role: "agent", content: "still there?" },
          ],
        },
      ],
    },
  };
}

test("a trace with no official row is a named defect, not a dropped task", () => {
  const base = inputs();
  const trace = base.traces.alien_1;
  assert.ok(trace !== undefined);
  const r = buildRunReport({
    ...base,
    traces: { ...base.traces, alien_4: { ...trace, task_id: "alien_4" } },
  });
  assert.ok(r.defects.some((d) => d.includes("alien_4") && /official result file/i.test(d)));
  assert.equal(r.tasks.length, 1);
});

test("a manifest task with no official row is a named defect", () => {
  const base = inputs();
  const r = buildRunReport({
    ...base,
    manifest: { ...base.manifest, taskIds: ["alien_1", "alien_4"] },
  });
  assert.ok(r.defects.some((d) => d.includes("alien_4") && /manifest/i.test(d)));
  assert.equal(r.tasks.length, 1);
});

test("an unanswered ask cannot rescue an all-canned run from void", () => {
  const r = buildRunReport(cannedThenUnanswered());
  assert.equal(r.simulator.verdict, "void");
  assert.equal(r.simulator.asks, 1);
  assert.equal(r.strict, null);
  assert.notEqual(r.withheld, null);
});

test("an ask that received no answer is a named defect", () => {
  const r = buildRunReport(cannedThenUnanswered());
  assert.ok(r.defects.some((d) => d.includes("alien_1") && /no answer/i.test(d)));
});

test("tolerant is never below strict: a strict pass counts as a tolerant pass", () => {
  const base = inputs();
  const row = at(base.official.results, 0);
  const trace = base.traces.alien_1;
  assert.ok(trace !== undefined);
  const r = buildRunReport({
    ...base,
    official: { ...base.official, results: [{ ...row, phase1_passed: true, total_reward: 1 }] },
    traces: { alien_1: { ...trace, phase1_completed: true, total_reward: 1 } },
    // The autopsy's own replay disagrees, as it does on the recorded run: the official scorer
    // accepted `STDDEV` through the dataset's `test_cases` where the replay wants `STDDEV_POP`.
    tolerant: { alien_1: false },
  });
  assert.equal(at(r.tasks, 0).tolerantPassed, false);
  assert.equal(r.strict?.phase1Count, 1);
  assert.equal(r.tolerant?.phase1Count, 1);
  assert.ok((r.tolerant?.phase1Count ?? 0) >= (r.strict?.phase1Count ?? 0));
});

/**
 * The constant cannot be pinned by the fixture, which sets `userSimulatorModel` FROM it and so
 * agrees with any string it holds. The benchmark's own code is the only authority.
 */
test(
  "the official user-simulator default is read from the pinned checkout, not from memory",
  { skip: checkout === undefined ? "set BIRD_INTERACT_CHECKOUT to pin the simulator model" : false },
  async () => {
    assert.ok(checkout);
    const config = await readFile(join(checkout, "BIRD-Interact-ADK/shared/config.py"), "utf8");
    const match = /user_sim_model:\s*str\s*=\s*["']([^"']+)["']/.exec(config);
    assert.ok(match, "shared/config.py no longer declares a user_sim_model default");
    assert.equal(match[1], OFFICIAL_USER_SIM_MODEL);
  },
);
