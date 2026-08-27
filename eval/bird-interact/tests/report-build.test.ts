import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SQL_RECORD_LIMIT } from "../src/preview-truncation.js";
import { OFFICIAL_USER_SIM_MODEL, buildRunReport, type RunInputs } from "../src/report-build.js";
import { GATED_GROUND_TRUTH_NOTICE, parseRunReport, statesAnOutcome } from "../src/report-model.js";
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

/**
 * A real answer came back, and that is the whole of what it settles.
 *
 * This task required entries 0 and 50 and withheld 0; with no knowledge-base text in the inputs, an
 * answer carrying a formula cannot be tied to either id, and the answer here is on topic only
 * because the fixture wrote it that way. So the pair is `null` — undetermined — and not `[]`, which
 * would say the report looked and found nothing recovered and nothing missed.
 */
test("an ask that came back real leaves recovery undetermined rather than empty", () => {
  const knowledge = at(buildRunReport(inputs()).tasks, 0).knowledge;
  assert.deepEqual(knowledge.withheld, [0]);
  assert.equal(knowledge.recovered, null, "no answer here can be tied to entry 0");
  assert.equal(knowledge.missed, null, "and an empty list would be a per-id claim too");
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

/**
 * The finding that survived a full fix wave: the submission carried the score past every mask.
 *
 * `data/runs/alien-5-VOID-usersim-broken/report.json` had `withheld` set, `strict` and `tolerant`
 * `null`, every per-task cell `null` — and sixteen submission results each saying
 * `SQL failed Phase 1.`, from which "0 of 5 tasks passed phase 1" reads off verbatim. Nothing
 * asserted against the field, which is why the fix wave went straight past it.
 */
test("a withheld run publishes no submission outcome, and keeps everything else", () => {
  const submits = at(buildRunReport(voidRun()).tasks, 0).submits;
  assert.equal(submits.length, 1, "the submission itself is not deleted");
  const submit = at(submits, 0);
  assert.equal(submit.result, null, "the scorer's own words are a verdict");
  assert.equal(submit.phase, null, "a phase-2 label says the scorer accepted phase 1");
  // Everything the run legitimately carries is still on the page: how many times it tried, what it
  // wrote, what Wren planned, what it cost and what it left.
  assert.equal(submit.attempt, 1);
  assert.equal(submit.semanticSql, GOLD);
  assert.equal(submit.nativeSql, "WITH x AS (...) SELECT 1");
  assert.equal(submit.cost, 3);
  assert.equal(submit.budgetBefore, 13);
  assert.equal(submit.budgetAfter, 10);
});

test("a reportable run still publishes what the scorer said", () => {
  const submit = at(at(buildRunReport(inputs()).tasks, 0).submits, 0);
  assert.equal(submit.result, "SQL failed Phase 1. Your SQL is not correct.");
  assert.equal(submit.phase, 1);
});

/**
 * The attempt count is a fact about the agent, and a withheld run keeps it.
 *
 * Masking must not become deletion: a reader of a withheld report should still see that a task
 * submitted three times and what it submitted each time — they simply must not learn whether any
 * of it was accepted.
 */
test("a withheld run still shows how many times a task submitted and what it submitted", () => {
  const r = buildRunReport(voidRun({ traces: reachedPhase2().traces }));
  assert.equal(r.withheld !== null, true, "the fixture has to be a withheld run");
  const submits = at(r.tasks, 0).submits;
  assert.deepEqual(submits.map((s) => s.attempt), [1, 2]);
  assert.deepEqual(submits.map((s) => s.semanticSql), [GOLD, FOLLOW_UP_SQL]);
  assert.deepEqual(
    submits.map((s) => s.phase),
    [null, null],
    "the second submission answered the follow-up, which only a passing task is asked",
  );
});

/**
 * The defect array is the other half of the finding, and the answer there is not masking.
 *
 * A defect is a statement about the RECORD, not about the agent. Deleting it on a withheld run
 * would hide the very anomaly that made the run untrustworthy — so every defect survives, and only
 * the values a disagreement quotes are dropped.
 */
test("a withheld run names a trace disagreement without either side of it", () => {
  const base = inputs();
  const drifted = {
    traces: {
      alien_1: { ...base.traces.alien_1, total_reward: 1, phase1_completed: true },
    },
  } as Partial<RunInputs>;
  const reportable = buildRunReport({ ...base, ...drifted } as RunInputs);
  assert.ok(
    reportable.defects.some((d) => /official reward 0 but trace reward 1/.test(d)),
    `a reportable run states both values: ${reportable.defects.join(" | ")}`,
  );

  const held = buildRunReport(voidRun(drifted));
  assert.equal(held.withheld !== null, true);
  const named = held.defects.filter((d) => /disagree/.test(d));
  assert.equal(named.length, 2, `both disagreements are still named: ${held.defects.join(" | ")}`);
  assert.ok(named.some((d) => /reward/.test(d)), "the reward disagreement is named");
  assert.ok(named.some((d) => /phase1_passed/.test(d)), "the phase-1 disagreement is named");
  for (const defect of held.defects) {
    assert.ok(!statesAnOutcome(defect), `a withheld run published a verdict in a defect: ${defect}`);
  }
});

/** Every defect a withheld run can produce, held to the same rule in one place. */
test("no defect of a withheld run states an outcome", () => {
  const base = inputs();
  const messy = buildRunReport(
    voidRun({
      traces: {
        alien_1: { ...base.traces.alien_1, task_id: "alien_9", total_reward: 1, phase2_completed: true },
        alien_4: base.traces.alien_1,
      },
      dataset: {},
    } as Partial<RunInputs>),
  );
  assert.ok(messy.defects.length >= 4, `expected several defects: ${messy.defects.join(" | ")}`);
  for (const defect of messy.defects) {
    assert.ok(!statesAnOutcome(defect), `a withheld run published a verdict in a defect: ${defect}`);
  }
});

/* -------------------------------------------------------------------------- */
/* The regenerated artifact itself, field by field                             */
/* -------------------------------------------------------------------------- */

/**
 * The recorded withheld run, if this checkout has one.
 *
 * `data/` is gitignored in its entirety, so a fresh clone has no runs and this skips. Where the
 * tree DOES carry the run, the artifact is the thing the finding was found in and the thing a
 * reader would forward, so it is worth asserting against directly rather than only against a
 * fixture the test file wrote itself.
 */
const WITHHELD_ARTIFACT = fileURLToPath(
  new URL("../data/runs/alien-5-VOID-usersim-broken/report.json", import.meta.url),
);

/**
 * Every field a withheld `TaskIR` may publish, classified — and an unclassified one is a failure.
 *
 * This is the guard the finding needed and did not have. `submits[].result` slipped through a
 * nineteen-finding fix wave precisely because no test named it, and the next field added to
 * `TaskIR` would slip through the same gap. So the test does not check a list of known leaks: it
 * walks whatever the artifact actually contains and fails on any path it has not been told about,
 * which forces whoever adds a field to decide which of these three it is.
 */
const WITHHELD_TASK_FIELDS: Readonly<Record<string, "withheld" | "free-text" | "fact">> = {
  // A verdict: `null`, or the run is not withheld at all.
  reward: "withheld",
  phase1Passed: "withheld",
  phase2Passed: "withheld",
  tolerantPassed: "withheld",
  failureClass: "withheld",
  "submits[].result": "withheld",
  "submits[].phase": "withheld",
  // Free text the run legitimately carries — the question, the answers, and SQL from three sources.
  // Scanned for nothing: SQL may contain any word at all, and holding it to a prose predicate would
  // fail a report for a column named `passed`.
  "goldSql[]": "free-text",
  "followUpGoldSql[]": "free-text",
  "submits[].semanticSql": "free-text",
  "submits[].nativeSql": "free-text",
  "asks[].question": "free-text",
  "asks[].answer": "free-text",
  "ambiguities[].term": "free-text",
  "ambiguities[].type": "free-text",
  // Facts about what ran, which a withheld run reports in full: no verdict, but held to the
  // predicate anyway so a new sentence cannot appear in one of them unnoticed.
  taskId: "fact",
  database: "fact",
  category: "fact",
  difficultyTier: "fact",
  highLevel: "fact",
  budgetUsed: "fact",
  budgetRemaining: "fact",
  initialBudget: "fact",
  modelTurns: "fact",
  elapsedSeconds: "fact",
  "toolCalls.*": "fact",
  "submits[].attempt": "fact",
  "submits[].cost": "fact",
  "submits[].budgetBefore": "fact",
  "submits[].budgetAfter": "fact",
  "asks[].canned": "fact",
  "knowledge.required[]": "fact",
  "knowledge.withheld[]": "fact",
  // Two spellings each, and both are facts about what the RECORD could establish rather than
  // verdicts on the agent: `leaves` flattens a list, so ids arrive under the `[]` path, while the
  // undetermined pair arrives as a scalar `null` under the bare one. A withheld run keeps both —
  // "this report reads no knowledge base" is as true of a void run as of any other.
  "knowledge.recovered[]": "fact",
  "knowledge.recovered": "fact",
  "knowledge.missed[]": "fact",
  "knowledge.missed": "fact",
  "ambiguities[].isMask": "fact",
  "ambiguities[].critical": "fact",
  // A grade of the submitted SQL against the dataset's own snippet, computed here and not by the
  // scorer. It says nothing about whether the submission was accepted — see the page's own legend
  // — and it is derived from SQL this report publishes anyway.
  "ambiguities[].match": "fact",
};

/** Every scalar in a value, by the path it sits at, with array indices collapsed. */
function leaves(value: unknown, path: string): [string, unknown][] {
  if (Array.isArray(value)) return value.flatMap((item) => leaves(item, `${path}[]`));
  if (value !== null && typeof value === "object") {
    // `toolCalls` is keyed by tool name, so its keys are data rather than field names.
    const key = (name: string): string =>
      path === "toolCalls" ? `${path}.*` : path === "" ? name : `${path}.${name}`;
    return Object.entries(value).flatMap(([name, item]) => leaves(item, key(name)));
  }
  return [[path, value]];
}

test(
  "the regenerated withheld artifact states no outcome anywhere in it",
  { skip: existsSync(WITHHELD_ARTIFACT) ? false : "no recorded VOID run in data/runs/" },
  async () => {
    const raw: unknown = JSON.parse(await readFile(WITHHELD_ARTIFACT, "utf8"));
    // A stale artifact fails the schema, which is the right outcome and a confusing message: the
    // artifact predates a rule, and the fix is to rebuild it rather than to change anything here.
    let report: ReturnType<typeof parseRunReport>;
    try {
      report = parseRunReport(raw);
    } catch (error) {
      assert.fail(
        `${WITHHELD_ARTIFACT} does not satisfy the current schema — regenerate it with ` +
          `\`just report-bird-eval alien-5-VOID-usersim-broken\`: ${String(error)}`,
      );
    }
    assert.notEqual(report.withheld, null, "this run is the withheld one");
    assert.equal(report.strict, null);
    assert.equal(report.tolerant, null);

    let outcomes = 0;
    for (const task of report.tasks) {
      for (const [path, value] of leaves(task, "")) {
        const kind = WITHHELD_TASK_FIELDS[path];
        assert.ok(
          kind !== undefined,
          `${path} is a field this test has never been told about: classify it in ` +
            "WITHHELD_TASK_FIELDS as a verdict, as free text, or as a fact about what ran",
        );
        if (kind === "withheld") {
          assert.equal(value, null, `${path} publishes a verdict on a withheld run`);
        } else if (kind === "fact" && typeof value === "string" && statesAnOutcome(value)) {
          outcomes += 1;
        }
      }
      for (const submit of task.submits) {
        if (submit.result !== null && statesAnOutcome(submit.result)) outcomes += 1;
      }
    }
    assert.equal(outcomes, 0, "a withheld artifact stated an outcome");

    for (const defect of report.defects) {
      assert.ok(!statesAnOutcome(defect), `a withheld artifact published a verdict: ${defect}`);
    }
  },
);

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
 * The same inputs with nothing deleted from the knowledge base.
 *
 * `intent-ok` needs a DETERMINED recovery: `missed: []` says the report looked and found nothing
 * missing, while the base fixture's open ask channel leaves it `null` — undetermined — and an
 * undetermined channel withdraws the claim. A test whose subject is something else entirely, an
 * execution failure or a record the recorder cut short, has to take the knowledge channel out of
 * its answer rather than let it decide the class the test is asserting about. A task that withheld
 * no entry has nothing to recover and nothing to miss, which is the determination `[]` states.
 */
function nothingWithheld(base: RunInputs): RunInputs {
  const row = at(Object.values(base.dataset), 0);
  return { ...base, dataset: { alien_1: { ...row, knowledge_ambiguity: [] } } } as RunInputs;
}

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
    buildRunReport(
      nothingWithheld({
        ...base,
        traces: {
          alien_1: {
            ...trace,
            tool_trajectory: trace.tool_trajectory.map((entry) =>
              entry.tool === "submit_sql" ? { ...entry, result } : entry,
            ),
          },
        },
      } as RunInputs),
    ).tasks,
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
  const graded = (r: ReturnType<typeof buildRunReport>): [string, string | null][] =>
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

/* -------------------------------------------------------------------------- */
/* Grading a record the recorder cut short                                     */
/* -------------------------------------------------------------------------- */

/**
 * Filler that mentions none of the critical snippet's columns, so only the cut can explain their
 * absence — and long enough that `artifacts.ts` would have kept a prefix of it.
 *
 * The repeat count is derived from the limit rather than written down, because it was written down
 * once: a fixture of 2,600 characters stopped reaching the cut the moment statements got their own
 * one, and a fixture that no longer reaches the cut tests nothing while still passing its own name.
 */
const FILLER_LINE = "SELECT c.ClassName, h.SpeedKts AS speed_kts FROM InventedHulls h\n";
const FILLER = FILLER_LINE.repeat(Math.ceil(SQL_RECORD_LIMIT / FILLER_LINE.length) + 1);

/** What `safeText` records of a submission longer than the limit: its first `SQL_RECORD_LIMIT` chars. */
function cutTo(sql: string): string {
  const recorded = sql.slice(0, SQL_RECORD_LIMIT);
  assert.equal(recorded.length, SQL_RECORD_LIMIT, "the fixture must reach the cut to be a prefix");
  return recorded;
}

/**
 * The same run, with the phase-1 submission recorded as `recorded` rather than in full — and with
 * nothing deleted from its knowledge base, so the class these tests assert is decided by the cut
 * and by nothing else. See `nothingWithheld`.
 */
function submittedAsRecorded(recorded: string): RunInputs {
  const base = inputs();
  const trace = base.traces.alien_1;
  assert.ok(trace !== undefined);
  return nothingWithheld({
    ...base,
    traces: {
      alien_1: {
        ...trace,
        tool_trajectory: trace.tool_trajectory.map((entry) =>
          entry.tool === "submit_sql"
            ? { ...entry, args: { sql: recorded }, semantic_sql: recorded }
            : entry,
        ),
      },
    },
  } as RunInputs);
}

/**
 * The verified defect: an ambiguity resolved after character 2000 was published as a misread
 * question.
 *
 * `safeText` cuts every recorded string at `SQL_RECORD_LIMIT`, so a submission that reaches the limit
 * is a prefix of what really ran. `miss` says a column the gold fragment needs never appears —
 * a statement about the whole submission — and `classifyPhase` turns a critical `miss` into
 * `intent-miss`, the strongest thing this report says about an agent, off where the recorder
 * stopped writing rather than off anything the agent did.
 */
test("a critical ambiguity graded against a cut record is inconclusive, not a misread question", () => {
  const task = at(buildRunReport(submittedAsRecorded(cutTo(FILLER))).tasks, 0);
  const critical = at(task.ambiguities, 0);
  assert.equal(critical.term, "hull load");
  assert.equal(critical.match, "inconclusive", "a prefix cannot evidence that a column never appears");
  assert.notEqual(task.failureClass, "intent-miss");
  assert.equal(task.failureClass, "intent-ungraded");
});

/**
 * One direction only, and it has to be: a fragment found IN the prefix is in the whole submission,
 * so the cut can never manufacture a match. Grading a cut record inconclusive across the board
 * would throw away the evidence `intent-ok` is built from.
 */
test("a cut record still grades a fragment that is inside the part that was kept", () => {
  const task = at(buildRunReport(submittedAsRecorded(cutTo(`${GOLD}\n${FILLER}`))).tasks, 0);
  assert.equal(at(task.ambiguities, 0).match, "exact");
  assert.equal(task.failureClass, "intent-ok");
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

/**
 * The mechanism the finding names: one answer, about something else entirely.
 *
 * `knowledgeFor` marked EVERY withheld id recovered as soon as any ask came back non-canned, so an
 * answer about sort order published entry 0 as recovered by asking — a per-id claim on evidence
 * that says only that the channel was open.
 */
function unrelatedAnswer(): RunInputs {
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
            { role: "agent", content: "should the rows be sorted?" },
            { role: "user", content: "descending, please" },
          ],
        },
      ],
    },
  } as RunInputs;
}

test("an answer about something else names no withheld entry recovered", () => {
  const task = at(buildRunReport(unrelatedAnswer()).tasks, 0);
  assert.deepEqual(task.knowledge.withheld, [0]);
  assert.equal(task.knowledge.recovered, null, "nothing ties this answer to entry 0");
  assert.equal(task.knowledge.missed, null, "and nothing says entry 0 never arrived either");
  assert.notEqual(task.failureClass, "intent-miss", "an undetermined miss accuses nobody");
});

/**
 * The other half of the same `null`, and the half the consumer was dropping.
 *
 * `ClassifyInput.missedKnowledge` is a count, so `KnowledgeIR.missed`'s three states arrive there
 * as two: `null` could only be passed as `0`, which says the phase missed nothing. Zero is safe
 * for `intent-miss` — that class needs a miss to exist and an undetermined channel supplies none,
 * which is what the test above checks. It is not safe for `intent-ok`, which is the strongest
 * thing this report says in the agent's favour and which missed knowledge is allowed to overturn:
 * an agent cannot have applied a formula it never read. So the task whose recovery this report
 * calls undeterminable was published as having understood the question, on the strength of the
 * check that could not run.
 */
test("an undetermined recovery publishes no intent-ok either", () => {
  const task = at(buildRunReport(unrelatedAnswer()).tasks, 0);
  assert.equal(task.knowledge.missed, null, "the channel came back open and settles no id");
  assert.ok(
    task.ambiguities.some((a) => a.critical && (a.match === "exact" || a.match === "columns")),
    "the ambiguity evidence intent-ok rests on is present, so only the knowledge state can withdraw it",
  );
  assert.equal(task.failureClass, "intent-ungraded");
  assert.notEqual(task.failureClass, "intent-ok");
});

/**
 * And the guard against over-correcting: `[]` is a determination, so it grounds the claim `null`
 * cannot. A task that withheld nothing has nothing to recover and nothing to miss, and reading its
 * empty list as "we could not tell" would withdraw every `intent-ok` this report can still make.
 */
test("a determined empty miss still supports intent-ok", () => {
  const base = inputs();
  const row = at(Object.values(base.dataset), 0);
  const task = at(
    buildRunReport({
      ...base,
      dataset: { alien_1: { ...row, knowledge_ambiguity: [] } },
    } as RunInputs).tasks,
    0,
  );
  assert.deepEqual(task.knowledge.missed, [], "determined, and empty");
  assert.equal(task.failureClass, "intent-ok");
});

/**
 * The direction the record DOES settle. The task deletes the entry from the knowledge base and
 * `ask_user` is the only route back to it, so a task that never asked never obtained it — and the
 * `intent-miss` that follows is as strong as the evidence behind it.
 */
/** The same run with no dialogue at all: the recovery channel was never opened. */
function neverAsked(): RunInputs {
  const base = inputs();
  const row = at(base.official.results, 0);
  return {
    ...base,
    official: { ...base.official, results: [{ ...row, dialogue_history: [] }] },
  } as RunInputs;
}

test("a task that never asked still names the entry it never obtained", () => {
  const task = at(buildRunReport(neverAsked()).tasks, 0);
  assert.deepEqual(task.knowledge.missed, [0]);
  assert.deepEqual(task.knowledge.recovered, [], "a closed channel settles both lists");
  assert.equal(task.failureClass, "intent-miss");
});

/**
 * A task that withheld nothing has nothing to determine, and `null` there would read as a limit of
 * the report rather than as the fact that the question does not arise.
 */
test("a task with no withheld knowledge publishes an empty pair, not an undetermined one", () => {
  const base = inputs();
  const row = at(Object.values(base.dataset), 0);
  const r = buildRunReport({
    ...base,
    dataset: { alien_1: { ...row, knowledge_ambiguity: [] } },
  } as RunInputs);
  const knowledge = at(r.tasks, 0).knowledge;
  assert.deepEqual(knowledge.withheld, []);
  assert.deepEqual(knowledge.recovered, []);
  assert.deepEqual(knowledge.missed, []);
});

/**
 * The field walk is what catches a `TaskIR` field nobody classified, and it can only catch a field
 * it can see: `leaves` flattens an array, so an EMPTY list contributes no leaf at all and a `null`
 * arrives as a scalar under a different path than the same field's `[]` spelling. Both have to be
 * classified. The artifact test that exercises the walk skips on a clone with no recorded run, so
 * the classification is held here, where it always runs.
 */
test("every field of an undetermined task is classified for the withheld-artifact walk", () => {
  const task = at(buildRunReport(unrelatedAnswer()).tasks, 0);
  for (const [path] of leaves(task, "")) {
    assert.ok(
      WITHHELD_TASK_FIELDS[path] !== undefined,
      `${path} is a field the withheld-artifact walk has never been told about`,
    );
  }
});


/* -------------------------------------------------------------------------- */
/* A refused action is not a charged one                                       */
/* -------------------------------------------------------------------------- */

/**
 * A refusal as `tools.ts` records one, now that it matches the official ADK ledger.
 *
 * `beginAction` refuses any tool but `submit_sql` when the budget will not cover it, and the entry
 * `tools.ts` pushes for it carries the tool's LIST price in `cost` beside a budget that did not
 * move — so `cost` cannot tell a refusal from a charged call, and the unmoved budget is the only
 * thing that can. The refusal produces no dialogue turn, so a refused `ask_user` counted as a
 * charged call is an ask the simulator appears to have left unanswered.
 */
function refused(tool: string, budget: number, cost: number): Record<string, unknown> {
  return {
    type: "tool",
    tool,
    args: {},
    result: '{"error": "Budget exhausted (0.0 remaining). You MUST call submit_sql now."}',
    cost,
    budget_before: budget,
    budget_after: budget,
    phase: 1,
  };
}

/** The same run, with a refused `ask_user` and a refused knowledge lookup in its trajectory. */
function withRefusals(): RunInputs {
  const base = neverAsked();
  const trace = base.traces.alien_1;
  assert.ok(trace !== undefined);
  return {
    ...base,
    traces: {
      alien_1: {
        ...trace,
        tool_trajectory: [
          ...trace.tool_trajectory,
          refused("get_knowledge_definition", 0.5, 0.5),
          refused("ask_user", 0.5, 2),
        ],
      },
    },
  } as unknown as RunInputs;
}

/**
 * The verified defect: a refused ask is an ask the run never made, and counting it made the
 * simulator look like it had gone silent — `void`, which withholds every score in the report. A
 * budget refusal is evidence about the agent's spending, never about the simulator.
 */
test("a refused ask_user is not an attempted ask", () => {
  const r = buildRunReport(withRefusals());
  assert.equal(at(r.tasks, 0).toolCalls.ask_user ?? 0, 0, "nothing was charged for it");
  assert.equal(r.simulator.asks, 0, "and it is not an ask the simulator failed to answer");
  assert.equal(
    r.simulator.verdict,
    "unexercised",
    "nothing reached the simulator, so its health was never observed",
  );
  assert.equal(r.withheld, null, "a refusal must not withhold the run's scores");
  assert.ok(
    !r.defects.some((d) => /no answer/i.test(d)),
    `a refusal was named as an unanswered ask: ${r.defects.join(" | ")}`,
  );
});

/** The count is of charged calls, so a refused lookup does not inflate the tool table either. */
test("a refused call is left out of the charged tool counts", () => {
  const toolCalls = at(buildRunReport(withRefusals()).tasks, 0).toolCalls;
  assert.equal(toolCalls.get_knowledge_definition, 1, "the one charged lookup still counts");
  assert.equal(toolCalls.ask_user ?? 0, 0);
});

/**
 * The predicate reads two recorded numbers, and a trace that recorded neither must not read as one
 * long refusal: `report-cli` casts each parsed `trace.json` without validating it, so a legacy
 * trace with no budget fields would otherwise zero every count in the report at once.
 */
test("an entry that recorded no budget is still counted as charged", () => {
  const base = neverAsked();
  const trace = base.traces.alien_1;
  assert.ok(trace !== undefined);
  const r = buildRunReport({
    ...base,
    traces: {
      alien_1: {
        ...trace,
        tool_trajectory: trace.tool_trajectory.map(
          ({ budget_before: _before, budget_after: _after, ...rest }) => rest,
        ),
      },
    },
  } as unknown as RunInputs);
  assert.equal(at(r.tasks, 0).toolCalls.get_knowledge_definition, 1);
  assert.equal(at(r.tasks, 0).submits.length, 1, "and the submission is still a submission");
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
