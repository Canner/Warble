import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { OFFICIAL_USER_SIM_MODEL, buildRunReport, type RunInputs } from "../src/report-build.js";
import { GATED_GROUND_TRUTH_NOTICE, parseRunReport } from "../src/report-model.js";
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

/* -------------------------------------------------------------------------- */
/* A withheld run publishes NOTHING a reader could quote as a score            */
/* -------------------------------------------------------------------------- */

/**
 * The same run, void.
 *
 * The recorded VOID run published `intent-miss` for all five of its tasks beside 47 withheld
 * cells: one page saying no score from this run means anything, and pinning the failure on the
 * agent in the same table. A failure class derived from an untrustworthy run is untrustworthy too.
 */
function voidRun(over: Partial<RunInputs> = {}): RunInputs {
  return inputs({ simulatorLog: "LLM call failed: boom\n", ...over });
}

test("a withheld run publishes no per-task verdict at all", () => {
  const task = at(buildRunReport(voidRun()).tasks, 0);
  assert.equal(task.failureClass, null, "no failure class is publishable from a withheld run");
  assert.equal(task.reward, null);
  assert.equal(task.phase1Passed, null);
  assert.equal(task.phase2Passed, null);
  assert.equal(task.tolerantPassed, null);
  // Everything that is not a score still stands: which task ran, and what it did.
  assert.equal(task.taskId, "alien_1");
  assert.equal(task.budgetUsed, 18);
  assert.equal(task.submits.length, 1);
});

test("a withheld run publishes no breakdown average or phase-1 count", () => {
  const r = buildRunReport(voidRun());
  for (const row of [...r.byDifficulty, ...r.byHighLevel]) {
    assert.equal(row.averageReward, null, `${row.key} published an average on a withheld run`);
    assert.equal(row.phase1Count, null, `${row.key} published a pass count on a withheld run`);
    assert.equal(row.tasks, 1, "the census is not a score and is still reported");
  }
});

/**
 * The builder and the schema have to agree, because `report-cli` validates every report it writes:
 * a masked field the schema forbade, or an unmasked one it required, would fail the command rather
 * than the suite.
 */
test("both a reportable and a withheld report validate against the schema", () => {
  const healthy = buildRunReport(inputs());
  assert.deepEqual(parseRunReport(JSON.parse(JSON.stringify(healthy))), healthy);
  const held = buildRunReport(voidRun());
  assert.deepEqual(parseRunReport(JSON.parse(JSON.stringify(held))), held);
});

test("a tolerant verdict on a withheld run is withheld too, never published", () => {
  const r = buildRunReport(voidRun({ tolerant: { alien_1: true } }));
  assert.equal(r.tolerant, null);
  assert.equal(at(r.tasks, 0).tolerantPassed, null);
  assert.equal(at(r.tasks, 0).failureClass, null);
});

/* -------------------------------------------------------------------------- */
/* Simulator health is graded on asks ATTEMPTED                                */
/* -------------------------------------------------------------------------- */

/**
 * The run this whole section exists for: every `ask_user` errored.
 *
 * `tools.ts` records the trajectory entry after the try/catch and the dialogue pair only inside the
 * successful path, so a failed ask leaves a charged call and NO dialogue turn. The log stays quiet
 * too — the smoke runs uvicorn at `--log-level warning`.
 */
function everyAskErrored(): RunInputs {
  const base = inputs();
  const row = at(base.official.results, 0);
  const trace = base.traces.alien_1;
  assert.ok(trace !== undefined);
  return {
    ...base,
    official: { ...base.official, results: [{ ...row, dialogue_history: [] }] },
    traces: {
      alien_1: {
        ...trace,
        tool_trajectory: [
          { type: "tool", tool: "ask_user", args: { question: "which metric?" }, result: "Error: 404 Task not initialized", cost: 2, budget_before: 18, budget_after: 16, phase: 1 },
          ...trace.tool_trajectory,
        ],
      },
    },
    simulatorLog: "",
  } as RunInputs;
}

test("a run whose every ask_user errored is void, not healthy", () => {
  const r = buildRunReport(everyAskErrored());
  assert.equal(r.simulator.verdict, "void", "an attempted ask that got nothing is not health");
  assert.equal(r.simulator.asks, 1, "the attempt is counted even though no answer came back");
  assert.equal(r.simulator.answered, 0);
  assert.equal(r.strict, null, "a void run's scores are withheld");
  assert.notEqual(r.withheld, null);
  assert.equal(at(r.tasks, 0).failureClass, null);
  // The evidence was in the same object all along.
  assert.equal(at(r.tasks, 0).toolCalls.ask_user, 1);
});

test("a task that attempted more asks than it answered is a named defect", () => {
  const defects = buildRunReport(everyAskErrored()).defects;
  const defect = defects.find((d) => d.includes("alien_1") && /no answer/i.test(d));
  assert.ok(defect !== undefined, `no unanswered-ask defect in: ${defects.join(" | ")}`);
  assert.match(defect, /1 attempted, 0 answered/, "the counts are on the line, not just the verdict");
});

test("the withheld reason says the asks came back with nothing, not that they were canned", () => {
  const reason = buildRunReport(everyAskErrored()).withheld ?? "";
  assert.match(reason, /none of the 1 ask it was sent came back with any answer/i);
  assert.ok(!/canned/.test(reason), "nothing was canned: the asks errored");
});

test("a run that answered every attempted ask stays healthy", () => {
  const base = inputs();
  const trace = base.traces.alien_1;
  assert.ok(trace !== undefined);
  const r = buildRunReport({
    ...base,
    traces: {
      alien_1: {
        ...trace,
        tool_trajectory: [
          { type: "tool", tool: "ask_user", args: {}, result: "LOAD = ...", cost: 2, budget_before: 18, budget_after: 16, phase: 1 },
          ...trace.tool_trajectory,
        ],
      },
    },
  } as RunInputs);
  assert.equal(r.simulator.verdict, "healthy");
  assert.equal(r.simulator.asks, 1);
  assert.equal(r.simulator.answered, 1);
  assert.ok(!r.defects.some((d) => /no answer/i.test(d)));
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
function classifyWithSubmitResult(result: string): string | null {
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
  // Two asks attempted, one answered — and that one answer was the canned non-answer. Counting
  // the unanswered turn as an answered ask is what would carry this run to `degraded`.
  assert.equal(r.simulator.asks, 2);
  assert.equal(r.simulator.answered, 1);
  assert.equal(r.simulator.cannedResponses, 1);
  assert.equal(r.strict, null);
  assert.notEqual(r.withheld, null);
});

test("an ask that received no answer is a named defect", () => {
  const r = buildRunReport(cannedThenUnanswered());
  assert.ok(r.defects.some((d) => d.includes("alien_1") && /no answer/i.test(d)));
});

test("the tolerant column counts tasks and carries no reward-named field", () => {
  const r = buildRunReport(inputs({ tolerant: { alien_1: true } }));
  const tolerant = r.tolerant;
  assert.ok(tolerant !== null);
  assert.equal(tolerant.phase1Count, 1, "it counts the tasks that passed");
  assert.ok(!("averageReward" in tolerant), "an averageReward here is the pass rate misnamed");
  assert.ok(!("totalReward" in tolerant), "a totalReward here is the pass count misnamed");
  // Strict keeps its genuine reward average, computed from the official per-task reward.
  assert.equal(r.strict?.averageReward, 0);
  assert.equal(r.strict?.totalReward, 0);
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

/* -------------------------------------------------------------------------- */
/* Phase 1's ambiguities are graded against phase 1's submission               */
/* -------------------------------------------------------------------------- */

/**
 * The `alien_2` shape: cleared phase 1, then answered the follow-up.
 *
 * The phase-2 SQL deliberately does not contain the phase-1 snippet — it answers a different
 * question and has no reason to. `submits.at(-1)` is this statement for every task that reached
 * phase 2, which is how the recorded run put a `miss` on a task the official scorer PASSED.
 */
const FOLLOW_UP_SQL = "SELECT AVG(h.SpeedKts) FROM InventedHulls h";

function reachedPhase2(): RunInputs {
  const base = inputs();
  const trace = base.traces.alien_1;
  assert.ok(trace !== undefined);
  const submit = trace.tool_trajectory.find((entry) => entry.tool === "submit_sql");
  assert.ok(submit !== undefined);
  const followUp = {
    ...submit,
    args: { sql: FOLLOW_UP_SQL },
    semantic_sql: FOLLOW_UP_SQL,
    budget_before: 10,
    budget_after: 7,
    phase: 2,
  };
  return {
    ...base,
    traces: { alien_1: { ...trace, tool_trajectory: [...trace.tool_trajectory, followUp] } },
  } as RunInputs;
}

test("phase-1 ambiguities are graded against the last PHASE-1 submission", () => {
  const graded = (r: ReturnType<typeof buildRunReport>): [string, string][] =>
    at(r.tasks, 0).ambiguities.map((a) => [a.term, a.match]);
  // The snippet is in the phase-1 submission, and grading it against the follow-up loses it.
  assert.deepEqual(graded(buildRunReport(inputs())), [["hull load", "exact"], ["order", "inconclusive"]]);
  assert.deepEqual(
    graded(buildRunReport(reachedPhase2())),
    [["hull load", "exact"], ["order", "inconclusive"]],
    "appending a phase-2 submission must not change a phase-1 grade",
  );
});

test("a submission carries the phase it answered", () => {
  const submits = at(buildRunReport(reachedPhase2()).tasks, 0).submits;
  assert.deepEqual(submits.map((s) => [s.attempt, s.phase]), [[1, 1], [2, 2]]);
  assert.equal(at(submits, 1).semanticSql, FOLLOW_UP_SQL, "both submissions are still published");
});

/**
 * A trace that recorded no phase is trusted for nothing but its order.
 *
 * Dropping every submission when no phase is recorded would throw away the only evidence there is;
 * with no phases recorded there is no phase-2 submission to exclude.
 */
test("a trace with no recorded phase grades against its last submission", () => {
  const base = inputs();
  const trace = base.traces.alien_1;
  assert.ok(trace !== undefined);
  const unphased = {
    ...base,
    traces: {
      alien_1: {
        ...trace,
        tool_trajectory: trace.tool_trajectory.map(({ phase: _phase, ...rest }) => rest),
      },
    },
  } as unknown as RunInputs;
  const r = buildRunReport(unphased);
  assert.deepEqual(at(r.tasks, 0).submits.map((s) => s.phase), [null]);
  assert.equal(at(at(r.tasks, 0).ambiguities, 0).match, "exact", "the one submission still grades");
});

/**
 * Phase 2's gold is its own field. Without it the page put a phase-2 submission beside phase-1 gold
 * with nothing saying they answer different questions.
 */
test("phase-2 gold is read from follow_up.sol_sql, stored either way the dataset stores it", () => {
  const base = inputs();
  const row = at(Object.values(base.dataset), 0);
  const followUp = "SELECT AVG(h.SpeedKts) FROM InventedHulls h";
  for (const stored of [followUp, [followUp]]) {
    const r = buildRunReport({
      ...base,
      dataset: { alien_1: { ...row, follow_up: { sol_sql: stored } } },
    } as unknown as RunInputs);
    assert.deepEqual(at(r.tasks, 0).followUpGoldSql, [followUp], `rejected ${JSON.stringify(stored)}`);
  }
  // And phase-1 gold still refuses a bare string, because `sol_sql` is a list on every row.
  assert.deepEqual(buildRunReport(inputs()).tasks[0]?.followUpGoldSql, []);
  for (const wrong of [undefined, 42, null, [7], [" "]]) {
    const r = buildRunReport({
      ...base,
      dataset: { alien_1: { ...row, follow_up: { sol_sql: wrong } } },
    } as unknown as RunInputs);
    assert.deepEqual(at(r.tasks, 0).followUpGoldSql, [], `accepted ${JSON.stringify(wrong)}`);
  }
});

/* -------------------------------------------------------------------------- */
/* Claims the record does not support                                          */
/* -------------------------------------------------------------------------- */

/**
 * `intent-ok` says the agent understood the question, and a task with no dataset row has nothing
 * that could say so: no ambiguity to grade, no knowledge to miss. It used to clear the
 * `intent-miss` bar vacuously and be published as understood off an empty list.
 */
test("a task with no dataset row cannot be published as having understood the question", () => {
  const r = buildRunReport(inputs({ dataset: {} }));
  const task = at(r.tasks, 0);
  assert.deepEqual(task.ambiguities, [], "there was nothing to grade");
  assert.equal(task.failureClass, "intent-ungraded");
  assert.notEqual(task.failureClass, "intent-ok");
});

/**
 * `no-sql` is a claim about what the agent submitted, and it was being read off the absence of the
 * file that records submissions. The only established fact is that Warble's record is missing.
 */
test("a missing trace yields no-record, and no budget denominator", () => {
  const r = buildRunReport(inputs({ traces: {} }));
  const task = at(r.tasks, 0);
  assert.equal(task.failureClass, "no-record");
  assert.notEqual(task.failureClass, "no-sql");
  assert.equal(task.initialBudget, null, "an initial budget of 0 rendered as `18 / 0`");
  assert.equal(r.budget.initial, null, "and one unknown term makes the run's total unknown");
  assert.ok(r.defects.some((d) => d.includes("alien_1") && /trace/i.test(d)));
});

test("a task that really submitted nothing is still no-sql", () => {
  const base = inputs();
  const trace = base.traces.alien_1;
  assert.ok(trace !== undefined);
  const r = buildRunReport({
    ...base,
    traces: {
      alien_1: {
        ...trace,
        tool_trajectory: trace.tool_trajectory.filter((entry) => entry.tool !== "submit_sql"),
      },
    },
  } as RunInputs);
  assert.equal(at(r.tasks, 0).failureClass, "no-sql", "the trace exists and records no submission");
});

/* -------------------------------------------------------------------------- */
/* A run with no tasks                                                         */
/* -------------------------------------------------------------------------- */

/** Empty results and an empty manifest task list: a report over nothing. */
function noTasks(): RunInputs {
  const base = inputs();
  return {
    ...base,
    manifest: { ...base.manifest, taskIds: [] },
    official: {
      metrics: { total_tasks: 0, total_reward: 0, average_reward: 0, phase1_rate: 0, phase1_count: 0, phase2_rate: 0, phase2_count: 0 },
      results: [],
    },
    traces: {},
  } as RunInputs;
}

/**
 * The verified defect: this produced `averageReward: 0`, `phase1Rate: 0`, verdict `healthy`, no
 * defects, and validated — a page stating "average reward 0.00" and "phase 1 passed 0/0 (0%)" for a
 * run that measured nothing.
 */
test("a run with no tasks publishes no rate and no average", () => {
  const r = buildRunReport(noTasks());
  assert.equal(r.strict?.totalTasks, 0);
  assert.equal(r.strict?.averageReward, null, "there is no average over zero tasks");
  assert.equal(r.strict?.phase1Rate, null);
  assert.equal(r.strict?.phase2Rate, null);
  // Sums and counts are still numbers: an empty sum really is 0.
  assert.equal(r.strict?.totalReward, 0);
  assert.equal(r.strict?.phase1Count, 0);
});

test("a run with no tasks names itself a defect", () => {
  const defects = buildRunReport(noTasks()).defects;
  assert.ok(
    defects.some((d) => /scored no tasks/i.test(d)),
    `no empty-run defect in: ${defects.join(" | ")}`,
  );
  // And a run that scored something does not carry it.
  assert.ok(!buildRunReport(inputs()).defects.some((d) => /scored no tasks/i.test(d)));
});

test("a zero-task report still validates, with its rates null", () => {
  const r = buildRunReport(noTasks());
  assert.deepEqual(parseRunReport(JSON.parse(JSON.stringify(r))), r);
});

test("a tolerant column over no tasks has no rate either", () => {
  const r = buildRunReport({ ...noTasks(), tolerant: {} });
  assert.equal(r.tolerant?.totalTasks, 0);
  assert.equal(r.tolerant?.phase1Rate, null);
  assert.equal(r.tolerant?.phase2Rate, null);
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
