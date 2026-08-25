import assert from "node:assert/strict";
import test from "node:test";

import { esc, renderReportHtml } from "../src/report-html.js";
import type { RunReportIR } from "../src/report-model.js";

function report(over: Partial<RunReportIR> = {}): RunReportIR {
  return {
    version: 1,
    generatedAt: "2026-08-25 11:41",
    provenance: {
      run: "alien-5", officialCommit: "4".repeat(40), publicSnapshotCommit: "5".repeat(40),
      imageId: "sha256:abc", repoDigests: [], wrenVersion: "wrenai 0.8.1", pythonVersion: "3.11.15",
      taskIds: ["alien_1"], systemModel: "claude-sonnet-4-5-20250929", userSimulatorModel: "openai/gpt-4o",
    },
    simulator: { llmCallFailures: 0, asks: 1, cannedResponses: 0, verdict: "healthy" },
    warnings: ["Query subset; never comparable with the official leaderboard."],
    defects: [],
    strict: { totalTasks: 1, totalReward: 0, averageReward: 0, phase1Count: 0, phase1Rate: 0, phase2Count: 0, phase2Rate: 0 },
    tolerant: null,
    withheld: null,
    budget: { used: 18, initial: 18, exhaustedTasks: 1 },
    byDifficulty: [{ key: "Moderate", tasks: 1, averageReward: 0, phase1Count: 0 }],
    byHighLevel: [{ key: "false", tasks: 1, averageReward: 0, phase1Count: 0 }],
    difficultyVocabularies: ["Moderate"],
    tasks: [{
      taskId: "alien_1", database: "alien", category: "Query", difficultyTier: "Moderate", highLevel: false,
      reward: 0, phase1Passed: false, phase2Passed: false, tolerantPassed: null,
      budgetUsed: 18, budgetRemaining: -1, initialBudget: 18, modelTurns: 23, elapsedSeconds: 65.6,
      toolCalls: { submit_sql: 3 }, submits: [], asks: [],
      knowledge: { required: [0], withheld: [0], recovered: [], missed: [0] },
      ambiguities: [], failureClass: "intent-miss",
    }],
    ...over,
  };
}

test("esc neutralises every HTML metacharacter", () => {
  assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("the page renders every section and is self-contained", () => {
  const html = renderReportHtml([report()]);
  assert.match(html, /^<!doctype html>/i);
  assert.ok(!/<script\s+src=|<link\s+rel="stylesheet"/i.test(html), "must embed its own styles");
  for (const heading of ["Before comparing these", "Reward", "Budget", "Tasks"]) {
    assert.ok(html.includes(heading), `missing section: ${heading}`);
  }
  assert.ok(html.includes("alien_1"));
});

test("a withheld run renders the reason and never the number", () => {
  const html = renderReportHtml([
    report({ strict: null, tolerant: null, withheld: "the user simulator answered nothing", simulator: { llmCallFailures: 3, asks: 5, cannedResponses: 5, verdict: "void" } }),
  ]);
  assert.ok(html.includes("the user simulator answered nothing"));
  assert.ok(!/average_?[Rr]eward|0\.00/.test(html), "a void run must not render a score");
});

test("an uncomputed tolerant column says so instead of rendering blank", () => {
  assert.match(renderReportHtml([report()]), /not computed/i);
});

test("a computed tolerant score renders beside strict", () => {
  const html = renderReportHtml([
    report({ tolerant: { totalTasks: 1, totalReward: 1, averageReward: 1, phase1Count: 1, phase1Rate: 1, phase2Count: 0, phase2Rate: 0 } }),
  ]);
  assert.ok(html.includes("tolerant") || html.includes("Tolerant"));
  assert.ok(!/not computed/i.test(html));
});

test("defects are rendered rather than dropped", () => {
  const html = renderReportHtml([report({ defects: ["alien_1: official reward 0 but trace reward 1"] })]);
  assert.ok(html.includes("official reward 0 but trace reward 1"));
});

test("the same report renders byte-identically twice", () => {
  assert.equal(renderReportHtml([report()]), renderReportHtml([report()]));
});
