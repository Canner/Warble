import assert from "node:assert/strict";
import test from "node:test";

import {
  CLASS_LABEL,
  classifyPhase,
  gradeAmbiguities,
  matchSnippet,
  normalizeSql,
  snippetColumns,
  type AmbiguityVerdict,
} from "../src/report-diagnose.js";

test("normalizeSql reduces two dialects of one query to the same string", () => {
  assert.equal(normalizeSql("/* note */ SELECT s.ModType -- trailing\n"), "selectmodtype");
  assert.equal(normalizeSql('SELECT "public".signals.modtype'), "selectmodtype");
  assert.equal(normalizeSql("SELECT avg(x)::numeric"), "selectavg(x)");
});

test("snippetColumns reads qualified references only", () => {
  assert.deepEqual(snippetColumns("h.MassKg - 0.25 * ABS(h.DriftKg)").sort(), [
    "driftkg",
    "masskg",
  ]);
  assert.deepEqual(snippetColumns("COUNT(*)"), []);
});

test("matchSnippet grades exact, columns and miss", () => {
  const snippet = "h.MassKg - 0.25 * ABS(h.DriftKg)";
  assert.equal(matchSnippet("SELECT h.MassKg - 0.25 * ABS(h.DriftKg) FROM hulls h", snippet), "exact");
  assert.equal(
    matchSnippet("SELECT AVG(masskg) - 0.25 * ABS(driftkg) FROM hulls", snippet),
    "columns",
  );
  assert.equal(matchSnippet("SELECT masskg FROM hulls", snippet), "miss");
  assert.equal(matchSnippet("", snippet), "miss");
});

/**
 * The `miss` this used to assert was the report's strongest claim about the agent, manufactured.
 *
 * 395 of the 826 critical-ambiguity snippets in this package's merged dataset reference no
 * qualified column at all — `COUNT(*) FILTER (WHERE SNQI > 0) as analyzable signals`, whole
 * `CREATE FUNCTION` bodies. For those the literal test is the only one there is, so any correct
 * rewrite graded `miss`, and a critical `miss` is the sole route to `intent-miss`.
 */
test("a snippet with no qualified column is exact or inconclusive, never a miss", () => {
  assert.equal(matchSnippet("SELECT COUNT(*)", "COUNT(*)"), "exact");
  assert.equal(matchSnippet("SELECT 1", "COUNT(*)"), "inconclusive");
  assert.equal(
    matchSnippet(
      "SELECT COUNT(*) FILTER (WHERE s.snqi > 0) AS usable FROM signals s",
      "COUNT(*) FILTER (WHERE SNQI > 0) as analyzable signals",
    ),
    "inconclusive",
    "a correct rewrite of an unqualified fragment is not evidence of a misread",
  );
});

/**
 * The grade describes what the SNIPPET can evidence, and that does not change with the haystack:
 * an ungradable fragment is ungradable against an empty submission too.
 */
test("an ungradable snippet stays inconclusive even against no SQL at all", () => {
  assert.equal(matchSnippet("", "COUNT(*)"), "inconclusive");
  assert.equal(matchSnippet("SELECT 1", ""), "inconclusive");
});

test("gradeAmbiguities keeps critical and non-critical apart", () => {
  const verdicts = gradeAmbiguities(
    "SELECT c.classname, AVG(h.masskg) FROM hulls h ORDER BY 2",
    [{ term: "hull load", sql_snippet: "h.MassKg - 0.25 * ABS(h.DriftKg)", is_mask: true, type: "knowledge_linking_ambiguity" }],
    [{ term: "order", sql_snippet: "ORDER BY avg_load DESC", is_mask: false, type: "sort_ambiguity" }],
  );
  assert.deepEqual(
    verdicts.map((v) => [v.term, v.critical, v.isMask, v.match]),
    [
      // The critical fragment names two qualified columns and only one of them appears.
      ["hull load", true, true, "miss"],
      // `ORDER BY avg_load DESC` names no qualified column, so nothing but the literal could
      // grade it — the agent's `ORDER BY 2` is a different sort, but this snippet cannot say so.
      ["order", false, false, "inconclusive"],
    ],
  );
});

/** A critical ambiguity graded present: the evidence `intent-ok` is not allowed to do without. */
const UNDERSTOOD: readonly AmbiguityVerdict[] = [
  { term: "hull load", type: "knowledge_linking_ambiguity", isMask: true, critical: true, match: "columns" },
];

const base = {
  passed: false,
  tolerantPassed: null,
  executionFailed: false,
  recordMissing: false,
  submitted: true,
  ambiguities: UNDERSTOOD,
  missedKnowledge: 0,
};

test("classifyPhase orders classes by what the evidence supports", () => {
  assert.equal(classifyPhase({ ...base, passed: true }), "passed");
  assert.equal(classifyPhase({ ...base, recordMissing: true }), "no-record");
  assert.equal(classifyPhase({ ...base, submitted: false }), "no-sql");
  assert.equal(classifyPhase({ ...base, executionFailed: true }), "exec-error");
  assert.equal(classifyPhase({ ...base, tolerantPassed: true }), "passed-tolerant");
  assert.equal(classifyPhase({ ...base, missedKnowledge: 1 }), "intent-miss");
  assert.equal(
    classifyPhase({
      ...base,
      ambiguities: [...UNDERSTOOD, { term: "t", type: "x", isMask: true, critical: true, match: "miss" }],
    }),
    "intent-miss",
  );
  assert.equal(
    classifyPhase({
      ...base,
      ambiguities: [...UNDERSTOOD, { term: "t", type: "x", isMask: false, critical: false, match: "miss" }],
    }),
    "intent-ok",
  );
  assert.equal(classifyPhase(base), "intent-ok");
});

/**
 * `intent-ok` says the agent understood the question — the strongest thing this report says in the
 * agent's favour — and it used to be the unguarded fall-through.
 *
 * A task with no dataset row has no ambiguity to grade and no knowledge to miss, so it cleared the
 * `intent-miss` bar vacuously and was published as understood off an empty list. The missing row is
 * a run-level defect that is never linked to the task, so nothing on the page contradicted it.
 */
test("intent-ok requires a critical ambiguity graded present, not an empty list", () => {
  assert.equal(
    classifyPhase({ ...base, ambiguities: [] }),
    "intent-ungraded",
    "an empty ambiguity list evidences nothing about understanding",
  );
  for (const match of ["exact", "columns"] as const) {
    assert.equal(
      classifyPhase({
        ...base,
        ambiguities: [{ term: "t", type: "x", isMask: true, critical: true, match }],
      }),
      "intent-ok",
      `a critical ${match} is the evidence intent-ok rests on`,
    );
  }
});

/**
 * `inconclusive` says the snippet could not be graded by columns. That is a fact about the gold
 * fragment, not about the agent — so it is neither a misread NOR evidence of understanding.
 */
test("a critical ambiguity that could not be graded is neither a misread nor an intent-ok", () => {
  assert.equal(
    classifyPhase({
      ...base,
      ambiguities: [{ term: "t", type: "x", isMask: true, critical: true, match: "inconclusive" }],
    }),
    "intent-ungraded",
  );
  // A non-critical grade is not the evidence either: only the critical ones are scored upstream.
  assert.equal(
    classifyPhase({
      ...base,
      ambiguities: [{ term: "t", type: "x", isMask: false, critical: false, match: "exact" }],
    }),
    "intent-ungraded",
  );
  // And `columns` on a critical ambiguity IS evidence: the columns are all there, written
  // differently, which is what the design calls a snippet present.
  assert.equal(
    classifyPhase({
      ...base,
      ambiguities: [{ term: "t", type: "x", isMask: true, critical: true, match: "columns" }],
    }),
    "intent-ok",
  );
});

/**
 * `no-sql` claims the agent submitted nothing. That claim is read off Warble's trace — the file
 * that records submissions — so with no trace it was being made from the absence of its own
 * evidence, and the page then said "nothing to score — infrastructure, not the agent" about a task
 * whose record simply never got written.
 */
test("a missing record is not a claim about what the agent submitted", () => {
  assert.equal(
    classifyPhase({ ...base, recordMissing: true, submitted: false }),
    "no-record",
    "with no trace, `submitted: false` means the file is missing, not the submission",
  );
  // The official row still outranks it: a task the scorer passed is passed, trace or no trace.
  assert.equal(classifyPhase({ ...base, recordMissing: true, passed: true }), "passed");
});

test("a critical miss cannot outrank a tolerant pass", () => {
  assert.equal(
    classifyPhase({
      ...base,
      tolerantPassed: true,
      missedKnowledge: 2,
      ambiguities: [{ term: "t", type: "x", isMask: true, critical: true, match: "miss" }],
    }),
    "passed-tolerant",
  );
});

test("every class has a label", () => {
  for (const c of [
    "passed",
    "passed-tolerant",
    "no-record",
    "no-sql",
    "exec-error",
    "intent-miss",
    "intent-ok",
    "intent-ungraded",
  ] as const) {
    assert.ok(CLASS_LABEL[c].length > 0);
  }
  // The two new labels must not restate a verdict they are there to withhold.
  assert.match(CLASS_LABEL["no-record"], /unknown/i);
  assert.match(CLASS_LABEL["intent-ungraded"], /could not be graded/i);
});
