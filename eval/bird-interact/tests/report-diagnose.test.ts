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

test("a snippet with no qualified column can only be graded exact or miss", () => {
  assert.equal(matchSnippet("SELECT COUNT(*)", "COUNT(*)"), "exact");
  assert.equal(matchSnippet("SELECT 1", "COUNT(*)"), "miss");
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
      ["hull load", true, true, "miss"],
      ["order", false, false, "miss"],
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
