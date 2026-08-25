import assert from "node:assert/strict";
import test from "node:test";

import {
  GATED_GROUND_TRUTH_NOTICE,
  parseRunReport,
  statesAnOutcome,
  type RunReportIR,
} from "../src/report-model.js";
import {
  assessSimulator,
  CANNED_USER_RESPONSE,
  LLM_CALL_FAILURE_LOG,
  type SimulatorHealth,
} from "../src/report-simulator.js";

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
 * `null` is not `[]`, and the document has to be able to tell them apart.
 *
 * The report reads no knowledge base, so it cannot tie an answer to an id: a task whose ask channel
 * came back open has no per-id verdict to publish. An empty list would say the opposite — that the
 * report looked and found nothing recovered and nothing missed — which is the per-id claim
 * `report-build.ts` refuses to make, and `missed` is what feeds `intent-miss`. `null` is the same
 * "unknown" the rest of this IR spells that way, and it has to survive the round trip to mean
 * anything to the CI gate reading `report.json`.
 */
test("an undetermined knowledge pair round-trips, and stays distinct from an empty one", () => {
  const base = minimal();
  const task = base.tasks[0];
  assert.ok(task !== undefined);
  const undetermined: RunReportIR = {
    ...base,
    tasks: [
      { ...task, knowledge: { required: [0, 50], withheld: [0], recovered: null, missed: null } },
    ],
  };
  const parsed = parseRunReport(JSON.parse(JSON.stringify(undetermined)));
  assert.deepEqual(parsed, undetermined);
  assert.equal(parsed.tasks[0]?.knowledge.recovered, null, "an empty list would claim it looked");
  // The determined pair is still a pair of lists, and anything else is still refused.
  assert.deepEqual(parseRunReport(JSON.parse(JSON.stringify(base))), base);
  for (const wrong of ["none", 0, {}]) {
    assert.throws(() =>
      parseRunReport(
        JSON.parse(
          JSON.stringify({
            ...base,
            tasks: [{ ...task, knowledge: { ...task.knowledge, recovered: wrong } }],
          }),
        ),
      ),
    );
  }
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
        // The submission's two verdict-bearing fields go with the rest. `result` is the scorer
        // speaking — `SQL failed Phase 1.` is the masked reward in the server's own words — and a
        // submission labelled `phase 2` says the scorer accepted the attempt before it.
        submits: task.submits.map((s) => ({ ...s, phase: null, result: null })),
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

/**
 * The simulator row and the withholding it is supposed to force, tied together at last.
 *
 * Every rule above keys on `withheld`, so a report that never sets it satisfies all of them
 * vacuously — and an IR whose own simulator row said the knowledge-recovery channel was closed
 * validated beside a full set of per-task rewards. `report.json` is read by a CI gate, which took
 * those scores: the void run with quotable numbers, arriving through the schema written to make it
 * impossible. A void verdict is the report saying no number in it means anything.
 */
test("the schema rejects a void simulator verdict beside a published score", () => {
  const voided: RunReportIR["simulator"] = {
    llmCallFailures: 3, asks: 5, answered: 5, cannedResponses: 5, verdict: "void",
  };
  // Typed `RunReportIR` and still a contradiction: the types cannot relate two fields, so the
  // schema is the only thing that can refuse this document.
  const bad: RunReportIR = { ...minimal(), simulator: voided };
  assert.throws(
    () => parseRunReport(JSON.parse(JSON.stringify(bad))),
    /simulator verdict is void must withhold/i,
  );
  // The same run with its scores actually withheld is the document `report-build.ts` writes.
  const held: RunReportIR = { ...withheldReport(), simulator: voided };
  assert.deepEqual(parseRunReport(JSON.parse(JSON.stringify(held))), held);
});

/**
 * One direction, and only one.
 *
 * `withheld` is not evidence about the simulator. A run can be withheld for a reason that has
 * nothing to do with it, and a `degraded` simulator publishes by design — some attempted ask did
 * come back with a real answer. The biconditional would reject both of those legitimate documents,
 * so the rule fires on `void` alone.
 */
test("a degraded simulator still publishes, and a healthy one can still be withheld", () => {
  const degraded: RunReportIR = {
    ...minimal(),
    simulator: { llmCallFailures: 0, asks: 2, answered: 1, cannedResponses: 0, verdict: "degraded" },
  };
  assert.deepEqual(parseRunReport(JSON.parse(JSON.stringify(degraded))), degraded);
  const held: RunReportIR = {
    ...withheldReport(),
    withheld: "the official result file has no row for any task the manifest lists",
  };
  assert.equal(held.simulator.verdict, "healthy");
  assert.deepEqual(parseRunReport(JSON.parse(JSON.stringify(held))), held);
});

/**
 * Every set of counters `assessSimulator` can reach, and the verdict it reaches from each.
 *
 * The rule the schema enforces is a restatement of an arithmetic that lives in another module, so
 * the grid is driven through the real `assessSimulator` and the resulting document through the
 * schema: a change to one that is not made in the other fails here rather than quietly loosening
 * the envelope. Every combination this produces is a legitimate document and must validate.
 */
function simulatorGrid(): { readonly health: SimulatorHealth; readonly answers: readonly string[] }[] {
  const rows: { health: SimulatorHealth; answers: readonly string[] }[] = [];
  for (const failures of [0, 1]) {
    for (const attempts of [0, 1, 2, 3]) {
      for (const real of [0, 1, 2]) {
        for (const canned of [0, 1, 2]) {
          const answers = [
            ...Array.from({ length: real }, (_, i) => `a real answer ${i}`),
            ...Array.from({ length: canned }, () => CANNED_USER_RESPONSE),
          ];
          rows.push({
            health: assessSimulator({
              log: LLM_CALL_FAILURE_LOG.repeat(failures),
              attempts,
              answers,
            }),
            answers,
          });
        }
      }
    }
  }
  return rows;
}

/**
 * The envelope was exactly as strong as whatever wrote the verdict string.
 *
 * `void` forces withholding, and nothing forced `void`: a hand-built row reading 99 LLM call
 * failures, five asks, none answered and five canned answers called itself `healthy` and validated
 * beside a full set of scores. A CI gate reads the verdict, not the counts printed next to it, so a
 * document whose own counters say the knowledge-recovery channel was closed must not be able to
 * call itself healthy — nor to carry counts no run could have produced.
 */
test("the schema holds the simulator verdict to the counters printed beside it", () => {
  const contradictory: RunReportIR = {
    ...minimal(),
    simulator: { llmCallFailures: 99, asks: 5, answered: 0, cannedResponses: 5, verdict: "healthy" },
  };
  assert.throws(
    () => parseRunReport(JSON.parse(JSON.stringify(contradictory))),
    /simulator/i,
    "a healthy verdict beside 99 LLM call failures is a contradiction, not a document",
  );

  // Each wrong verdict over counters that are themselves reachable.
  const wrongVerdicts: readonly RunReportIR["simulator"][] = [
    // Any LLM call failure is void, whatever the answers looked like.
    { llmCallFailures: 1, asks: 1, answered: 1, cannedResponses: 0, verdict: "healthy" },
    { llmCallFailures: 1, asks: 2, answered: 1, cannedResponses: 0, verdict: "degraded" },
    // Asked and got no real answer back: void, canned or unanswered alike.
    { llmCallFailures: 0, asks: 5, answered: 5, cannedResponses: 5, verdict: "degraded" },
    { llmCallFailures: 0, asks: 3, answered: 0, cannedResponses: 0, verdict: "healthy" },
    // Some real, some not: degraded, and neither of the other two.
    { llmCallFailures: 0, asks: 2, answered: 1, cannedResponses: 0, verdict: "healthy" },
    { llmCallFailures: 0, asks: 2, answered: 2, cannedResponses: 1, verdict: "void" },
    // Every attempted ask came back real: healthy, and a run that never asked is healthy too.
    { llmCallFailures: 0, asks: 2, answered: 2, cannedResponses: 0, verdict: "degraded" },
    { llmCallFailures: 0, asks: 0, answered: 0, cannedResponses: 0, verdict: "void" },
  ];
  for (const simulator of wrongVerdicts) {
    const bad: RunReportIR = { ...withheldReport(), simulator };
    assert.throws(
      () => parseRunReport(JSON.parse(JSON.stringify(bad))),
      /verdict/i,
      `accepted ${simulator.verdict} beside ${JSON.stringify(simulator)}`,
    );
  }

  // And counts no run could produce, whatever verdict is written against them: `asks` is the
  // larger of the attempts and the answers, so it never falls below `answered`, and a canned
  // answer is one of the answers.
  const impossible: readonly RunReportIR["simulator"][] = [
    { llmCallFailures: 0, asks: 1, answered: 2, cannedResponses: 0, verdict: "void" },
    { llmCallFailures: 0, asks: 2, answered: 1, cannedResponses: 2, verdict: "void" },
  ];
  for (const simulator of impossible) {
    const bad: RunReportIR = { ...withheldReport(), simulator };
    assert.throws(
      () => parseRunReport(JSON.parse(JSON.stringify(bad))),
      /simulator/i,
      `accepted counts no run could reach: ${JSON.stringify(simulator)}`,
    );
  }
});

/**
 * The other direction, and the one that decides whether the rule is worth having: a rule that
 * outlawed a document the producer really writes would be worse than no rule at all.
 */
test("every simulator row assessSimulator can produce validates", () => {
  for (const { health, answers } of simulatorGrid()) {
    const report: RunReportIR =
      health.verdict === "void" ? { ...withheldReport(), simulator: health } : { ...minimal(), simulator: health };
    assert.doesNotThrow(
      () => parseRunReport(JSON.parse(JSON.stringify(report))),
      `the schema refused a row assessSimulator produced from ${answers.length} answers: ${JSON.stringify(health)}`,
    );
  }
});

/**
 * `warnings` is the third prose array, and it was scanned for nothing.
 *
 * Nothing `warningsFor` writes states an outcome today, so this forbids no document the producer
 * builds — it is here because `defects` was never the only place a sentence could carry a verdict,
 * and a warning is exactly where the next "official reward 0.7 but trace reward 0" would be
 * written. A withheld report states no outcome in prose, in either of the arrays that carry prose.
 */
test("the schema rejects a withheld report whose warning quotes a verdict", () => {
  const held = withheldReport();
  assert.throws(
    () =>
      parseRunReport(
        JSON.parse(JSON.stringify({ ...held, warnings: ["official reward 0.7 but trace reward 0"] })),
      ),
    /warning/i,
  );
  // The wording that names the disagreement without either side of it is the one that survives.
  const named = { ...held, warnings: ["the official file and the trace disagree about this run"] };
  assert.deepEqual(parseRunReport(JSON.parse(JSON.stringify(named))), named);
  // And a reportable run may say whatever it likes: there is no score to hand back.
  const open = { ...minimal(), warnings: ["official reward 0.7 but trace reward 0"] };
  assert.deepEqual(parseRunReport(JSON.parse(JSON.stringify(open))), open);
});

/**
 * The reason exists to be read, and `.min(1)` accepted a space.
 *
 * A report that withholds every number in it and states nothing legible for why is the one document
 * withholding must not be able to produce: every other rule here then treats the blank as a stated
 * reason and lets the suppression through unexplained.
 */
test("the schema rejects a blank withholding reason", () => {
  for (const blank of ["", " ", "\n", "\t "]) {
    assert.throws(
      () => parseRunReport(JSON.parse(JSON.stringify({ ...withheldReport(), withheld: blank }))),
      /withheld|reason/i,
      `accepted a blank reason: ${JSON.stringify(blank)}`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* The two fields that are prose, and so cannot be typed into safety           */
/* -------------------------------------------------------------------------- */

/**
 * The submission result was the last way out of a withheld report.
 *
 * `data/runs/alien-5-VOID-usersim-broken/report.json` published sixteen of these while `withheld`
 * was set, `strict` and `tolerant` were `null` and every per-task cell was `null`. Each one said
 * `SQL failed Phase 1.`, so counting them recovered "0 of 5 tasks passed phase 1" verbatim — the
 * one figure the withholding exists to suppress. On a run with a passing task the same field prints
 * `Reward: 0.7`, because `submitObservation` in `src/tools.ts` writes it there.
 */
test("the schema rejects a withheld report whose submission still states an outcome", () => {
  const held = withheldReport();
  const task = held.tasks[0];
  assert.ok(task !== undefined);
  const submit = task.submits[0];
  assert.ok(submit !== undefined);
  for (const result of [
    "SQL failed Phase 1. Your SQL is not correct.",
    "Phase 1 correct! (Reward: 0.7). Moving to Phase 2.",
    "Reward: 0.7",
    "",
  ]) {
    assert.throws(
      () =>
        parseRunReport(
          JSON.parse(
            JSON.stringify({ ...held, tasks: [{ ...task, submits: [{ ...submit, result }] }] }),
          ),
        ),
      /no recoverable score/i,
      `a withheld report kept a submission result: ${JSON.stringify(result)}`,
    );
  }
});

/**
 * The phase is the same leak written as a number.
 *
 * A submission labelled `phase 2` answers the follow-up question, which the benchmark only asks
 * once phase 1 has been ACCEPTED — so `phase1Passed`, `null` in the same object, reads straight off
 * it. The empty string above and this case together say the rule is about the field existing at
 * all, not about the words in it.
 */
test("the schema rejects a withheld report whose submission still carries a phase", () => {
  const held = withheldReport();
  const task = held.tasks[0];
  assert.ok(task !== undefined);
  const submit = task.submits[0];
  assert.ok(submit !== undefined);
  for (const phase of [1, 2]) {
    assert.throws(
      () =>
        parseRunReport(
          JSON.parse(
            JSON.stringify({ ...held, tasks: [{ ...task, submits: [{ ...submit, phase }] }] }),
          ),
        ),
      /no recoverable score/i,
      `a withheld report kept phase ${phase}`,
    );
  }
});

/**
 * And the other direction, so a `null` result means WITHHELD and nothing else.
 *
 * `phase` gets no such rule and cannot: a trace that recorded no phase yields `null` on a perfectly
 * reportable run, so only the forward direction is enforceable there.
 */
test("the schema rejects a reportable run whose submission dropped its outcome", () => {
  const base = minimal();
  const task = base.tasks[0];
  assert.ok(task !== undefined);
  const submit = task.submits[0];
  assert.ok(submit !== undefined);
  assert.throws(
    () =>
      parseRunReport(
        JSON.parse(
          JSON.stringify({ ...base, tasks: [{ ...task, submits: [{ ...submit, result: null }] }] }),
        ),
      ),
    /reserved for a withheld run/i,
  );
  // A reportable run may still carry an unphased submission: that `null` is the trace's, not the
  // report's, and forbidding it would fail a run whose trace simply predates the phase field.
  const unphased = parseRunReport(
    JSON.parse(
      JSON.stringify({ ...base, tasks: [{ ...task, submits: [{ ...submit, phase: null }] }] }),
    ),
  );
  assert.equal(unphased.tasks[0]?.submits[0]?.phase, null);
});

/**
 * A defect is a statement about the RECORD, so it survives — its values do not.
 *
 * Deleting the defect array on a withheld run would hide the anomaly that made the run
 * untrustworthy in the first place, which is worse than the leak. So the builder rewords the three
 * templates that quote a verdict, and this is the rule that makes the rewording load-bearing.
 */
test("the schema rejects a withheld report whose defect quotes a verdict", () => {
  const held = withheldReport();
  const quoted = [
    "alien_1: official reward 0 but trace reward 1",
    "alien_1: official phase1_passed true but trace phase1_completed false",
    "alien_1: official phase2_passed false but trace phase2_completed true",
  ];
  for (const defect of quoted) {
    assert.throws(
      () => parseRunReport(JSON.parse(JSON.stringify({ ...held, defects: [defect] }))),
      /no defect that states an outcome/i,
      `a withheld report published: ${defect}`,
    );
  }
  // The value-free wording of the same three anomalies passes, and still names them. Knowing two
  // records disagree about phase 1 does not tell you which of them said it passed.
  const named = [
    "alien_1: the official reward and the trace reward disagree; both values are withheld",
    "alien_1: official phase1_passed and trace phase1_completed disagree; both values are withheld",
    "alien_1: official phase2_passed and trace phase2_completed disagree; both values are withheld",
  ];
  assert.deepEqual(
    parseRunReport(JSON.parse(JSON.stringify({ ...held, defects: named }))).defects,
    named,
  );
});

/**
 * The predicate itself, against the sentences that actually occur.
 *
 * The four on the left are `db_environment/server.py` replying to a submission and the defect
 * templates that quote it; the ones on the right are every other line a withheld report publishes,
 * which must keep publishing.
 */
test("statesAnOutcome separates a scorer's verdict from a statement about the record", () => {
  const outcomes = [
    "SQL failed Phase 1. Your SQL is not correct.\nBudget remaining: 6.5 bird-coins",
    "Phase 1 correct! (Reward: 0.7). Moving to Phase 2.\nReward: 0.7\nBudget remaining: 9.0 bird-coins",
    "Phase 2 correct! (Reward: 0.3). Task finished.",
    "alien_1: official reward 0 but trace reward 1",
    "alien_1: official phase1_passed true but trace phase1_completed false",
    "[exec_err_flg] Error executing submitted SQL: relation does not exist",
    "Error executing submitted SQL: relation does not exist",
    "Submitted SQL execution timed out",
  ];
  for (const text of outcomes) {
    assert.ok(statesAnOutcome(text), `an outcome went unrecognised: ${text}`);
  }
  const record = [
    "alien_1: no Warble trace for this task",
    "alien_1: trace records task_id alien_9",
    "alien_1: no dataset row for instance alien_1",
    "alien_1: 1 attempted ask received no answer (1 attempted, 0 answered)",
    "alien_4: a Warble trace exists but the official result file has no row for it",
    "alien_4: the manifest lists this task but the official result file has no row for it",
    "alien_1: the official reward and the trace reward disagree; both values are withheld",
    "alien_1: official phase1_passed and trace phase1_completed disagree; both values are withheld",
    "this run scored no tasks: the report has no average, no rate and nothing to compare, and " +
      "should not have been produced for an empty run",
  ];
  for (const text of record) {
    assert.ok(!statesAnOutcome(text), `a statement about the record was read as a verdict: ${text}`);
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
