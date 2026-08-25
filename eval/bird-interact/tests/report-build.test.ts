import assert from "node:assert/strict";
import test from "node:test";

import { OFFICIAL_USER_SIM_MODEL, buildRunReport, type RunInputs } from "../src/report-build.js";
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

const GOLD = "SELECT o.WeathProfile, AVG(s.SnrRatio - 0.1 * ABS(s.NoiseFloorDbm)) FROM Signals s";

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
        dialogue_history: [{ role: "agent", content: "which metric?" }, { role: "user", content: "SNQI = SnrRatio - 0.1 * ABS(NoiseFloorDbm)" }],
      }],
    },
    traces: {
      alien_1: {
        task_id: "alien_1", initial_budget: 18, budget_remaining: -1, model_turns: 23,
        phase1_completed: false, phase2_completed: false, total_reward: 0, current_phase: 1,
        dialogue_history: [{ role: "agent", content: "which metric?" }, { role: "user", content: "SNQI = SnrRatio - 0.1 * ABS(NoiseFloorDbm)" }],
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
        amb_user_query: "how does quality vary", query: "how does SNQI vary by WeathProfile",
        external_knowledge: [0, 50],
        knowledge_ambiguity: [{ deleted_knowledge: 0 }],
        conditions: { decimal: -1, distinct: false, order: true },
        user_query_ambiguity: {
          critical_ambiguity: [{ term: "signal quality", sql_snippet: "s.SnrRatio - 0.1 * ABS(s.NoiseFloorDbm)", is_mask: true, type: "knowledge_linking_ambiguity" }],
          non_critical_ambiguity: [{ term: "order", sql_snippet: "ORDER BY avg_snqi DESC", is_mask: false, type: "sort_ambiguity" }],
        },
        sol_sql: [GOLD],
      },
    },
    simulatorLog: "INFO ready\n",
    tolerant: null,
    ...over,
  } as RunInputs;
}

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
  assert.match(at(at(r.tasks, 0).asks, 0).answer, /SNQI/);
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
