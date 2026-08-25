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

const base = {
  passed: false,
  tolerantPassed: null,
  executionFailed: false,
  submitted: true,
  ambiguities: [] as readonly AmbiguityVerdict[],
  missedKnowledge: 0,
};

test("classifyPhase orders classes by what the evidence supports", () => {
  assert.equal(classifyPhase({ ...base, passed: true }), "passed");
  assert.equal(classifyPhase({ ...base, submitted: false }), "no-sql");
  assert.equal(classifyPhase({ ...base, executionFailed: true }), "exec-error");
  assert.equal(classifyPhase({ ...base, tolerantPassed: true }), "passed-tolerant");
  assert.equal(classifyPhase({ ...base, missedKnowledge: 1 }), "intent-miss");
  assert.equal(
    classifyPhase({
      ...base,
      ambiguities: [{ term: "t", type: "x", isMask: true, critical: true, match: "miss" }],
    }),
    "intent-miss",
  );
  assert.equal(
    classifyPhase({
      ...base,
      ambiguities: [{ term: "t", type: "x", isMask: false, critical: false, match: "miss" }],
    }),
    "intent-ok",
  );
  assert.equal(classifyPhase(base), "intent-ok");
});

/**
 * `inconclusive` says the snippet could not be graded by columns. That is a fact about the gold
 * fragment, not about the agent, and it must never become "answered a different question".
 */
test("a critical ambiguity that could not be graded is not a misread", () => {
  assert.equal(
    classifyPhase({
      ...base,
      ambiguities: [{ term: "t", type: "x", isMask: true, critical: true, match: "inconclusive" }],
    }),
    "intent-ok",
  );
  // And `columns` is not one either: the columns are all there, written differently.
  assert.equal(
    classifyPhase({
      ...base,
      ambiguities: [{ term: "t", type: "x", isMask: true, critical: true, match: "columns" }],
    }),
    "intent-ok",
  );
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
  for (const c of ["passed", "passed-tolerant", "no-sql", "exec-error", "intent-miss", "intent-ok"] as const) {
    assert.ok(CLASS_LABEL[c].length > 0);
  }
});
