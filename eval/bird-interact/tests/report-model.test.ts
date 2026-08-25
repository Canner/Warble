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

/** Phase 2's gold, which answers a different question — also invented. */
const FOLLOW_UP_GOLD = "-- follow-up gold\nSELECT AVG(mass_kg) FROM invented_hulls";

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
    simulator: { llmCallFailures: 0, asks: 1, answered: 1, cannedResponses: 0, verdict: "healthy" },
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
      followUpGoldSql: [FOLLOW_UP_GOLD],
      submits: [{
        attempt: 1, phase: 1, cost: 3, budgetBefore: 13, budgetAfter: 10,
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

/**
 * A report that withholds properly: no aggregate, no breakdown score, no per-task verdict.
 *
 * The envelope has to cover all three. `report.json` is the CI-gate consumer this IR exists for,
 * and a withheld run that published `byDifficulty[].averageReward` or `tasks[].reward` handed the
 * suppressed headline straight back to it — the HTML masking those cells was the only thing
 * standing between a void run and a quotable score.
 */
function withheldReport(): RunReportIR {
  const base = minimal();
  const task = base.tasks[0];
  assert.ok(task !== undefined);
  return {
    ...base,
    strict: null,
    tolerant: null,
    withheld: "user simulator answered nothing",
    byDifficulty: base.byDifficulty.map((g) => ({ ...g, averageReward: null, phase1Count: null })),
    byHighLevel: base.byHighLevel.map((g) => ({ ...g, averageReward: null, phase1Count: null })),
    tasks: [
      {
        ...task,
        reward: null,
        phase1Passed: null,
        phase2Passed: null,
        tolerantPassed: null,
        failureClass: null,
      },
    ],
  };
}

test("a withheld report carries the reason and no scores", () => {
  const report = withheldReport();
  assert.deepEqual(parseRunReport(JSON.parse(JSON.stringify(report))), report);
});

test("the schema rejects a report that states a score while withholding", () => {
  const bad = { ...minimal(), withheld: "user simulator answered nothing" };
  assert.throws(
    () => parseRunReport(JSON.parse(JSON.stringify(bad))),
    /must carry no strict or tolerant score/i,
  );
});

test("the schema rejects a withheld report that still publishes a per-task verdict", () => {
  const held = withheldReport();
  const task = held.tasks[0];
  assert.ok(task !== undefined);
  const recoverable: readonly Partial<(typeof held.tasks)[number]>[] = [
    { reward: 0.75 },
    { phase1Passed: false },
    { phase2Passed: false },
    { tolerantPassed: true },
    { failureClass: "intent-miss" },
  ];
  for (const field of recoverable) {
    assert.throws(
      () => parseRunReport(JSON.parse(JSON.stringify({ ...held, tasks: [{ ...task, ...field }] }))),
      /no recoverable score/i,
      `a withheld report kept ${Object.keys(field).join(", ")}`,
    );
  }
});

test("the schema rejects a withheld report whose breakdowns still average a reward", () => {
  const held = withheldReport();
  for (const key of ["byDifficulty", "byHighLevel"] as const) {
    const rows = held[key].map((g) => ({ ...g, averageReward: 0.75 }));
    assert.throws(
      () => parseRunReport(JSON.parse(JSON.stringify({ ...held, [key]: rows }))),
      /no recoverable score/i,
      `${key} published an average on a withheld run`,
    );
    const counts = held[key].map((g) => ({ ...g, phase1Count: 1 }));
    assert.throws(
      () => parseRunReport(JSON.parse(JSON.stringify({ ...held, [key]: counts }))),
      /no recoverable score/i,
      `${key} published a phase-1 count on a withheld run`,
    );
  }
});

/**
 * The other direction, so `null` keeps exactly one meaning. Without it a builder that dropped a
 * verdict by accident would publish a report claiming, in the schema's own vocabulary, that the
 * run had been withheld.
 */
test("the schema rejects a reportable run that dropped a verdict it never withheld", () => {
  const base = minimal();
  const task = base.tasks[0];
  assert.ok(task !== undefined);
  assert.throws(
    () => parseRunReport(JSON.parse(JSON.stringify({ ...base, tasks: [{ ...task, failureClass: null }] }))),
    /reserved for a withheld run/i,
  );
  assert.throws(
    () =>
      parseRunReport(
        JSON.parse(JSON.stringify({ ...base, byDifficulty: base.byDifficulty.map((g) => ({ ...g, averageReward: null })) })),
      ),
    /reserved for a withheld run/i,
  );
});

/**
 * `inconclusive` is a grade, not a spelling of `miss`: a snippet with no qualified column carries
 * no column evidence, and the schema has to carry the distinction the analysis draws.
 */
test("the schema accepts every snippet grade, inconclusive included", () => {
  const base = minimal();
  const task = base.tasks[0];
  assert.ok(task !== undefined);
  for (const match of ["exact", "columns", "miss", "inconclusive"] as const) {
    const candidate: unknown = {
      ...base,
      tasks: [{ ...task, ambiguities: [{ term: "t", type: "sort_ambiguity", isMask: false, critical: true, match }] }],
    };
    assert.equal(parseRunReport(candidate).tasks[0]?.ambiguities[0]?.match, match);
  }
  assert.throws(
    () =>
      parseRunReport({
        ...base,
        tasks: [{ ...task, ambiguities: [{ term: "t", type: "x", isMask: false, critical: true, match: "unsure" }] }],
      }),
    /match/,
  );
});

/**
 * The tolerant column counts tasks. A `totalReward`/`averageReward` on it was the phase-1 count and
 * the phase-1 RATE under a reward's name, printed one line under strict's genuine reward average.
 */
test("the tolerant score carries no reward-named field, and none survives validation", () => {
  const tolerant = { totalTasks: 1, phase1Count: 1, phase1Rate: 1, phase2Count: 0, phase2Rate: 0 };
  assert.deepEqual(parseRunReport(JSON.parse(JSON.stringify({ ...minimal(), tolerant }))).tolerant, tolerant);
  const smuggled = parseRunReport(
    JSON.parse(JSON.stringify({ ...minimal(), tolerant: { ...tolerant, averageReward: 0.6, totalReward: 3 } })),
  ).tolerant;
  assert.deepEqual(smuggled, tolerant, "a reward-named field does not survive validation");
  assert.ok(smuggled !== null && !("averageReward" in smuggled), "no averageReward reaches a reader");
  assert.ok(smuggled !== null && !("totalReward" in smuggled), "no totalReward reaches a reader");
});

/* -------------------------------------------------------------------------- */
/* A run with no tasks has no rate                                             */
/* -------------------------------------------------------------------------- */

/** The empty run: no tasks, so no average and no rate — only sums and counts, which are 0. */
function emptyRun(): RunReportIR {
  return {
    ...minimal(),
    strict: {
      totalTasks: 0, totalReward: 0, averageReward: null,
      phase1Count: 0, phase1Rate: null, phase2Count: 0, phase2Rate: null,
    },
    byDifficulty: [],
    byHighLevel: [],
    difficultyVocabularies: [],
    tasks: [],
  };
}

test("a run with no tasks states no rate and no average, and still validates", () => {
  const report = emptyRun();
  assert.deepEqual(parseRunReport(JSON.parse(JSON.stringify(report))), report);
});

/**
 * `0` is a measurement; the quotient over zero tasks is not one.
 *
 * The recorded defect: empty results and an empty manifest task list produced `averageReward: 0`,
 * `phase1Rate: 0`, verdict `healthy`, no defects, and passed this schema — a page stating
 * "average reward 0.00" and "phase 1 passed 0/0 (0%)" for a run that measured nothing.
 */
test("the schema rejects a zero-task run that states a rate anyway", () => {
  const empty = emptyRun();
  const strict = empty.strict;
  assert.ok(strict !== null);
  for (const field of ["averageReward", "phase1Rate", "phase2Rate"] as const) {
    assert.throws(
      () => parseRunReport(JSON.parse(JSON.stringify({ ...empty, strict: { ...strict, [field]: 0 } }))),
      /null exactly when the run scored no tasks/i,
      `a zero-task run published ${field}`,
    );
  }
  assert.throws(
    () =>
      parseRunReport(
        JSON.parse(
          JSON.stringify({
            ...empty,
            tolerant: { totalTasks: 0, phase1Count: 0, phase1Rate: 0, phase2Count: 0, phase2Rate: null },
          }),
        ),
      ),
    /null exactly when the run scored no tasks/i,
    "the tolerant column is held to the same rule",
  );
});

/** And the other direction, so `null` keeps one meaning: a measured run states every quotient. */
test("the schema rejects a run with tasks that dropped a rate", () => {
  const base = minimal();
  const strict = base.strict;
  assert.ok(strict !== null);
  for (const field of ["averageReward", "phase1Rate", "phase2Rate"] as const) {
    assert.throws(
      () => parseRunReport(JSON.parse(JSON.stringify({ ...base, strict: { ...strict, [field]: null } }))),
      /null exactly when the run scored no tasks/i,
      `a scored run dropped ${field}`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* The fields a missing record leaves unknown                                  */
/* -------------------------------------------------------------------------- */

test("an unknown initial budget round-trips as null rather than as zero", () => {
  const base = minimal();
  const task = base.tasks[0];
  assert.ok(task !== undefined);
  const report: RunReportIR = {
    ...base,
    budget: { ...base.budget, initial: null },
    tasks: [{ ...task, initialBudget: null }],
  };
  const parsed = parseRunReport(JSON.parse(JSON.stringify(report)));
  assert.equal(parsed.tasks[0]?.initialBudget, null);
  assert.equal(parsed.budget.initial, null);
});

test("a submission carries the phase it answered, and no-record is a failure class", () => {
  const base = minimal();
  const task = base.tasks[0];
  assert.ok(task !== undefined);
  const submit = task.submits[0];
  assert.ok(submit !== undefined);
  const report: RunReportIR = {
    ...base,
    tasks: [
      {
        ...task,
        failureClass: "intent-ungraded",
        submits: [submit, { ...submit, attempt: 2, phase: 2 }, { ...submit, attempt: 3, phase: null }],
      },
    ],
  };
  const parsed = parseRunReport(JSON.parse(JSON.stringify(report)));
  assert.deepEqual(parsed.tasks[0]?.submits.map((s) => s.phase), [1, 2, null]);
  assert.equal(parsed.tasks[0]?.failureClass, "intent-ungraded");
  assert.equal(
    parseRunReport(JSON.parse(JSON.stringify({ ...base, tasks: [{ ...task, failureClass: "no-record" }] })))
      .tasks[0]?.failureClass,
    "no-record",
  );
});

test("phase-2 gold round-trips as its own list of statements", () => {
  const parsed = parseRunReport(JSON.parse(JSON.stringify(minimal())));
  assert.deepEqual(parsed.tasks[0]?.followUpGoldSql, [FOLLOW_UP_GOLD]);
  assert.notDeepEqual(parsed.tasks[0]?.goldSql, parsed.tasks[0]?.followUpGoldSql);
  const task = minimal().tasks[0];
  assert.ok(task !== undefined);
  assert.throws(
    () => parseRunReport({ ...minimal(), tasks: [{ ...task, followUpGoldSql: "SELECT 1" }] }),
    /followUpGoldSql/,
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
