import assert from "node:assert/strict";
import test from "node:test";

import {
  GATED_GROUND_TRUTH_NOTICE,
  parseRunReport,
  type RunReportIR,
} from "../src/report-model.js";

/**
 * Invented, never the real thing.
 *
 * A test file is committed; `sol_sql` is gated benchmark material that lives only in the gitignored
 * `data/` tree. Nothing here may be copied out of it.
 */
const GOLD = "-- gold\nSELECT hull_class, COUNT(*) FROM invented_hulls GROUP BY hull_class";

function minimal(): RunReportIR {
  return {
    version: 1,
    generatedAt: "2026-08-25 11:41",
    gatedNotice: GATED_GROUND_TRUTH_NOTICE,
    provenance: {
      run: "alien-5",
      officialCommit: "4".repeat(40),
      publicSnapshotCommit: "5".repeat(40),
      imageId: `sha256:${"9".repeat(64)}`,
      repoDigests: [],
      wrenVersion: "wrenai 0.8.1",
      pythonVersion: "3.11.15",
      taskIds: ["alien_1"],
      systemModel: "claude-sonnet-4-5-20250929",
      userSimulatorModel: "openai/gpt-4o",
    },
    simulator: { llmCallFailures: 0, asks: 1, cannedResponses: 0, verdict: "healthy" },
    warnings: ["Query subset of one database; never comparable with the official leaderboard."],
    defects: [],
    strict: {
      totalTasks: 1, totalReward: 0, averageReward: 0,
      phase1Count: 0, phase1Rate: 0, phase2Count: 0, phase2Rate: 0,
    },
    tolerant: null,
    withheld: null,
    budget: { used: 18, initial: 18, exhaustedTasks: 1 },
    byDifficulty: [{ key: "Moderate", tasks: 1, averageReward: 0, phase1Count: 0 }],
    byHighLevel: [{ key: "false", tasks: 1, averageReward: 0, phase1Count: 0 }],
    difficultyVocabularies: ["Moderate"],
    tasks: [{
      taskId: "alien_1", database: "alien", category: "Query",
      difficultyTier: "Moderate", highLevel: false,
      reward: 0, phase1Passed: false, phase2Passed: false, tolerantPassed: null,
      budgetUsed: 18, budgetRemaining: -1, initialBudget: 18,
      modelTurns: 23, elapsedSeconds: 65.6,
      toolCalls: { submit_sql: 3 },
      goldSql: [GOLD],
      submits: [{
        attempt: 1, cost: 3, budgetBefore: 13, budgetAfter: 10,
        semanticSql: "SELECT 1", nativeSql: "SELECT 1",
        result: "SQL failed Phase 1. Your SQL is not correct.",
      }],
      asks: [{ question: "which metric?", answer: "SNQI", canned: false }],
      knowledge: { required: [0, 50], withheld: [0], recovered: [0], missed: [] },
      ambiguities: [{ term: "order", type: "sort_ambiguity", isMask: false, critical: false, match: "miss" }],
      failureClass: "intent-ok",
    }],
  };
}

test("a complete report round-trips through the schema unchanged", () => {
  const report = minimal();
  assert.deepEqual(parseRunReport(JSON.parse(JSON.stringify(report))), report);
});

test("a withheld report carries the reason and no scores", () => {
  const report: RunReportIR = { ...minimal(), strict: null, tolerant: null, withheld: "user simulator answered nothing" };
  assert.deepEqual(parseRunReport(JSON.parse(JSON.stringify(report))), report);
});

test("the schema rejects a report that states a score while withholding", () => {
  const bad = { ...minimal(), withheld: "user simulator answered nothing" };
  assert.throws(
    () => parseRunReport(JSON.parse(JSON.stringify(bad))),
    /must carry no strict or tolerant score/i,
  );
});

test("the schema rejects a report with no strict score and no withheld reason", () => {
  const bad = { ...minimal(), strict: null };
  assert.throws(
    () => parseRunReport(JSON.parse(JSON.stringify(bad))),
    /must state why it is withheld/i,
  );
});

test("the schema rejects an unknown version", () => {
  assert.throws(() => parseRunReport({ ...minimal(), version: 2 }), /version/i);
});

/**
 * Gold round-trips as a LIST, because `sol_sql` is one and a task can be graded on several
 * statements. A bare string that happened to survive would silently render as one gold statement
 * per character to anything that iterated it.
 */
test("gold SQL round-trips as a list of statements", () => {
  const report = minimal();
  const parsed = parseRunReport(JSON.parse(JSON.stringify(report)));
  assert.deepEqual(parsed.tasks[0]?.goldSql, [GOLD]);
  assert.deepEqual(parsed, report);
});

test("a task with no gold carries an empty list, not a placeholder", () => {
  const task = minimal().tasks[0];
  assert.ok(task !== undefined);
  const report: RunReportIR = { ...minimal(), tasks: [{ ...task, goldSql: [] }] };
  assert.deepEqual(parseRunReport(JSON.parse(JSON.stringify(report))).tasks[0]?.goldSql, []);
});

test("the schema rejects gold SQL that is not a list of strings", () => {
  const task = minimal().tasks[0];
  assert.ok(task !== undefined);
  for (const wrong of ["SELECT 1", [1], [null], {}, null]) {
    assert.throws(
      () => parseRunReport({ ...minimal(), tasks: [{ ...task, goldSql: wrong }] }),
      /goldSql/,
      `accepted a wrong-shaped goldSql: ${JSON.stringify(wrong)}`,
    );
  }
});

/**
 * The notice is pinned, not merely required.
 *
 * A report carrying gated ground truth under a softened sentence — or none — is the artifact this
 * field exists to prevent, so the schema refuses it rather than trusting whoever built the report.
 */
test("the schema rejects a report whose gated notice has been softened or dropped", () => {
  for (const wrong of ["", "Contains some SQL.", undefined]) {
    assert.throws(
      () => parseRunReport({ ...minimal(), gatedNotice: wrong }),
      /gatedNotice/,
      `accepted a weakened notice: ${String(wrong)}`,
    );
  }
});

test("the gated notice names the ground truth and the sharing limit", () => {
  assert.match(GATED_GROUND_TRUTH_NOTICE, /ground-truth SQL/);
  assert.match(GATED_GROUND_TRUTH_NOTICE, /gated/i);
  assert.match(GATED_GROUND_TRUTH_NOTICE, /shared/i);
});
