# BIRD-Interact report and autopsy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a finished `data/runs/<run>/` into a report that says how much it scored, whether that score is trustworthy, why the rest failed, and what is missing from the answers it did submit.

**Architecture:** Two commands split on what they may touch — an offline `report` over the `data/` tree, and an `autopsy` that reaches the prepared PostgreSQL. Analysis and presentation are separated by a JSON report IR, mirroring the repo's `compile → IR → dispatch` seam, so tests assert against the IR rather than rendered HTML. Every analysis module is pure; only the two `*-cli.ts` bins touch the filesystem or spawn `psql`.

**Tech Stack:** TypeScript (ESM, `tsc --strict`), Zod 4, `node:test`, tsup, `psql` via `node:child_process`. No new npm dependencies.

**Spec:** `docs/spec/bird-interact/specs/2026-08-25-bird-interact-report-design.md`

## Global Constraints

- **No runtime command reads any project outside this repository.** The port is a reading of that source, never a dependency on it. Nothing links, imports, or shells into an external checkout.
- **No new npm dependencies.** PostgreSQL access shells out to `psql -X -A -t`, as `prepare-cli.ts` already does.
- Container name and port come from the verified `data/runtime/manifest.json`, never from a flag.
- `tsup.config.ts` must keep `splitting: false`; every bin stays a single self-contained entry file or its `import.meta.url === process.argv[1]` guard never matches and the CLI silently exits zero.
- Every bin supports `--help` (output contains `Usage:`) and `--version` (output matches `/^\d+\.\d+\.\d+$/`); `tests/bin-entry.test.ts` enforces both.
- Analysis modules are pure and receive already-parsed inputs. Only `report-cli.ts` and `autopsy-cli.ts` read files.
- The generated-at timestamp is passed into renderers, never read inside them, so identical inputs render byte-identically under test.
- Package commands run from `eval/bird-interact/`; `just` recipes run from the Warble root.
- Test style: `node:test` + `node:assert/strict`, imports from `../src/<module>.js`.

---

### Task 1: Snippet grading and failure classification

**Files:**
- Create: `eval/bird-interact/src/report-diagnose.ts`
- Test: `eval/bird-interact/tests/report-diagnose.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SnippetMatch`, `normalizeSql(sql: string): string`, `snippetColumns(snippet: string): string[]`, `matchSnippet(agentSql: string, snippet: string): SnippetMatch`, `AmbiguitySpec`, `AmbiguityVerdict`, `gradeAmbiguities(agentSql, critical, nonCritical): AmbiguityVerdict[]`, `FailureClass`, `ClassifyInput`, `classifyPhase(input: ClassifyInput): FailureClass`, `CLASS_LABEL: Record<FailureClass, string>`.

- [ ] **Step 1: Write the failing test**

```ts
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
  assert.deepEqual(snippetColumns("t.GainDb - 0.4 * ABS(t.DriftHz)").sort(), [
    "drifthz",
    "gaindb",
  ]);
  assert.deepEqual(snippetColumns("COUNT(*)"), []);
});

test("matchSnippet grades exact, columns and miss", () => {
  const snippet = "t.GainDb - 0.4 * ABS(t.DriftHz)";
  assert.equal(matchSnippet("SELECT t.GainDb - 0.4 * ABS(t.DriftHz) FROM signals", snippet), "exact");
  assert.equal(
    matchSnippet("SELECT AVG(gaindb) - 0.4 * ABS(drifthz) FROM signals", snippet),
    "columns",
  );
  assert.equal(matchSnippet("SELECT gaindb FROM traces", snippet), "miss");
  assert.equal(matchSnippet("", snippet), "miss");
});

test("a snippet with no qualified column can only be graded exact or miss", () => {
  assert.equal(matchSnippet("SELECT COUNT(*)", "COUNT(*)"), "exact");
  assert.equal(matchSnippet("SELECT 1", "COUNT(*)"), "miss");
});

test("gradeAmbiguities keeps critical and non-critical apart", () => {
  const verdicts = gradeAmbiguities(
    "SELECT o.sitelabel, AVG(t.gaindb) FROM signals s ORDER BY 2",
    [{ term: "signal quality", sql_snippet: "t.GainDb - 0.4 * ABS(t.DriftHz)", is_mask: true, type: "knowledge_linking_ambiguity" }],
    [{ term: "order", sql_snippet: "ORDER BY avg_snqi DESC", is_mask: false, type: "sort_ambiguity" }],
  );
  assert.deepEqual(
    verdicts.map((v) => [v.term, v.critical, v.isMask, v.match]),
    [
      ["signal quality", true, true, "miss"],
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eval/bird-interact && node --import tsx --test tests/report-diagnose.test.ts`
Expected: FAIL — cannot find module `../src/report-diagnose.js`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * WHY a task failed, from the dataset's own evidence rather than from reading SQL by hand.
 *
 * The reward says a task failed. It does not say whether the agent MISREAD the question or
 * merely wrote the query badly, and those two have opposite fixes: ask better versus generate
 * better. `user_query_ambiguity` names each ambiguity the question deliberately introduced AND
 * the `sql_snippet` a correct resolution must produce, so the split is answerable from the
 * dataset instead of inferred from the verdict.
 */

/** How well a gold `sql_snippet` is reflected in what the agent submitted. */
export type SnippetMatch =
  /** The fragment itself is present, modulo aliases, quoting, casts and whitespace. */
  | "exact"
  /** Every column the fragment references is present, but written differently. */
  | "columns"
  /** At least one column the fragment needs never appears. */
  | "miss";

/**
 * Strip SQL to something two dialects of the same query agree on.
 *
 * Gold writes `s.ModType`; the agent, coming through the MDL, writes `public.signals.modtype`.
 * Keeping the qualifier would fail every comparison on naming rather than on meaning.
 */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .toLowerCase()
    .replace(/"/g, "")
    // `a.b` -> `b`; the global scan continues past each match, so `public.signals.modtype`
    // fully reduces in one pass.
    .replace(/\b[a-z_][a-z0-9_]*\s*\.\s*/g, "")
    .replace(/\s+/g, "")
    .replace(/::[a-z]+/g, "");
}

/**
 * The columns a gold snippet references, as bare lowercase names.
 *
 * Read from QUALIFIED references only. Tokenising and subtracting a keyword list needs that
 * list to be complete or it reports `avg` and `case` as columns and every snippet trivially
 * misses. Gold snippets are consistently alias-qualified, so the qualifier IS the marker.
 */
export function snippetColumns(snippet: string): string[] {
  const found = new Set<string>();
  for (const m of snippet.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
    found.add(m[1].toLowerCase());
  }
  return [...found];
}

/** Grade one gold `sql_snippet` against the SQL the agent actually submitted. */
export function matchSnippet(agentSql: string, snippet: string): SnippetMatch {
  const haystack = normalizeSql(agentSql);
  if (haystack === "") return "miss";
  if (haystack.includes(normalizeSql(snippet))) return "exact";
  const columns = snippetColumns(snippet);
  // No qualified column means `exact` was the only test available; reporting `miss` on the
  // column test would claim evidence the snippet cannot provide.
  if (columns.length === 0) return "miss";
  return columns.every((c) => haystack.includes(c)) ? "columns" : "miss";
}

export interface AmbiguitySpec {
  readonly term: string;
  readonly sql_snippet: string;
  readonly is_mask?: boolean;
  readonly type?: string;
}

/** One ambiguity the question introduced, graded against the agent's answer. */
export interface AmbiguityVerdict {
  readonly term: string;
  /** `schema_linking_ambiguity`, `sort_ambiguity`, … straight from the dataset. */
  readonly type: string;
  /** Was this the entry the task WITHHELD, so asking was the only route? */
  readonly isMask: boolean;
  readonly critical: boolean;
  readonly match: SnippetMatch;
}

/**
 * Grade every ambiguity of one phase.
 *
 * Critical and non-critical stay apart rather than summed: only the critical ones are budgeted
 * and scored upstream, and a non-critical miss is a stylistic divergence, not a misread question.
 */
export function gradeAmbiguities(
  agentSql: string,
  critical: readonly AmbiguitySpec[],
  nonCritical: readonly AmbiguitySpec[] = [],
): AmbiguityVerdict[] {
  const grade = (a: AmbiguitySpec, isCritical: boolean): AmbiguityVerdict => ({
    term: a.term,
    type: a.type ?? "unknown",
    isMask: a.is_mask === true,
    critical: isCritical,
    match: matchSnippet(agentSql, a.sql_snippet),
  });
  return [...critical.map((a) => grade(a, true)), ...nonCritical.map((a) => grade(a, false))];
}

export type FailureClass =
  | "passed"
  | "passed-tolerant"
  | "no-sql"
  | "exec-error"
  | "intent-miss"
  | "intent-ok";

export interface ClassifyInput {
  readonly passed: boolean;
  /** `null` when no autopsy has produced a tolerant verdict for this phase. */
  readonly tolerantPassed: boolean | null;
  readonly executionFailed: boolean;
  readonly submitted: boolean;
  readonly ambiguities: readonly AmbiguityVerdict[];
  /** Required `external_knowledge` entries the phase needed but never opened. */
  readonly missedKnowledge: number;
}

/**
 * Where a task's failure actually lives, strongest evidence first.
 *
 * `passed-tolerant` is tested before the misread check: a task whose numbers are right has
 * demonstrably not misread the question, whatever its output shape. `intent-miss` requires a
 * CRITICAL ambiguity whose columns are wholly absent, or a required formula the phase never
 * opened — it cannot have applied knowledge it did not read. Everything clearing that bar is
 * `intent-ok`: understanding is evidenced, so the divergence is downstream of it, and that is
 * not separable from the run record alone.
 */
export function classifyPhase(input: ClassifyInput): FailureClass {
  if (input.passed) return "passed";
  if (!input.submitted) return "no-sql";
  if (input.executionFailed) return "exec-error";
  if (input.tolerantPassed === true) return "passed-tolerant";
  const misread = input.ambiguities.some((a) => a.critical && a.match === "miss");
  return misread || input.missedKnowledge > 0 ? "intent-miss" : "intent-ok";
}

/** Human-facing one-liner per class, so the report explains itself. */
export const CLASS_LABEL: Record<FailureClass, string> = {
  passed: "passed (strict)",
  "passed-tolerant": "right numbers, wrong shape",
  "no-sql": "nothing to score — infrastructure, not the agent",
  "exec-error": "the submitted SQL did not run",
  "intent-miss": "answered a different question — a critical ambiguity was resolved wrongly",
  "intent-ok": "understood the question; the divergence is downstream of understanding",
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd eval/bird-interact && node --import tsx --test tests/report-diagnose.test.ts && npm run check-types`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add eval/bird-interact/src/report-diagnose.ts eval/bird-interact/tests/report-diagnose.test.ts
git commit -m "feat(bird-eval): grade dataset ambiguities and classify phase failures"
```

---

### Task 2: User-simulator health

**Files:**
- Create: `eval/bird-interact/src/report-simulator.ts`
- Test: `eval/bird-interact/tests/report-simulator.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CANNED_USER_RESPONSE: string`, `SimulatorVerdict`, `SimulatorHealth`, `countLlmCallFailures(log: string): number`, `assessSimulator(input: { log: string; answers: readonly string[] }): SimulatorHealth`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { CANNED_USER_RESPONSE, assessSimulator, countLlmCallFailures } from "../src/report-simulator.js";

const real = "The metric is GQI, calculated as GainDb minus 0.4 times ABS(DriftHz).";

test("counts every LLM failure line in the simulator log", () => {
  assert.equal(countLlmCallFailures(""), 0);
  assert.equal(
    countLlmCallFailures("LLM call failed: litellm.BadRequestError\nLLM call failed: again\n"),
    2,
  );
});

test("one LLM failure voids the run even when some answers look real", () => {
  const health = assessSimulator({ log: "LLM call failed: boom\n", answers: [real, real] });
  assert.equal(health.verdict, "void");
  assert.equal(health.llmCallFailures, 1);
});

test("an all-canned ask set voids the run with no log evidence at all", () => {
  const health = assessSimulator({ log: "", answers: [CANNED_USER_RESPONSE, CANNED_USER_RESPONSE] });
  assert.deepEqual(health, { llmCallFailures: 0, asks: 2, cannedResponses: 2, verdict: "void" });
});

test("a partially canned ask set is degraded, not void", () => {
  const health = assessSimulator({ log: "", answers: [real, CANNED_USER_RESPONSE] });
  assert.equal(health.verdict, "degraded");
  assert.equal(health.cannedResponses, 1);
});

test("a clean log with real answers is healthy, and so is a run that never asked", () => {
  assert.equal(assessSimulator({ log: "INFO ready\n", answers: [real] }).verdict, "healthy");
  assert.equal(assessSimulator({ log: "", answers: [] }).verdict, "healthy");
});

test("the canned answer is matched after trimming surrounding whitespace", () => {
  assert.equal(assessSimulator({ log: "", answers: [`  ${CANNED_USER_RESPONSE}\n`] }).verdict, "void");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eval/bird-interact && node --import tsx --test tests/report-simulator.test.ts`
Expected: FAIL — cannot find module `../src/report-simulator.js`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Whether the official user simulator was actually answering.
 *
 * `user_simulator/server.py` calls its model with a hardcoded `temperature=0`. A model that
 * rejects that value fails EVERY call, and the server falls through to a canned non-answer. The
 * run still completes with error-free result rows and a valid-looking protocol trace — and
 * scores near zero, because BIRD deliberately deletes one required knowledge entry per task and
 * `ask_user` is the only way to recover it. A broken simulator is indistinguishable from a weak
 * agent unless something looks, so this looks, every time.
 */

/** The exact string `user_simulator/server.py` returns when it could not generate a response. */
export const CANNED_USER_RESPONSE = "I'm not sure I understand your question.";

export type SimulatorVerdict = "healthy" | "degraded" | "void";

export interface SimulatorHealth {
  readonly llmCallFailures: number;
  readonly asks: number;
  readonly cannedResponses: number;
  readonly verdict: SimulatorVerdict;
}

export function countLlmCallFailures(log: string): number {
  return log.split("LLM call failed").length - 1;
}

/**
 * `void` on any LLM failure, or when every ask in the run got the canned answer — with no ask
 * answered, the knowledge-recovery channel the benchmark depends on was closed and no score
 * from the run means anything. `degraded` when only some asks were canned.
 *
 * **One logged failure voids a run whose other answers look real, and that is deliberate.** The
 * intuitive reading — nine real answers and one transient blip is what `degraded` exists for, and
 * at what these runs cost one 429 means paying for the run twice — was put, and does not survive
 * the pinned checkout on two independent counts.
 *
 * - *The blip never reaches this counter.* `shared/llm.py:30` passes `num_retries=MAX_RETRIES` (5,
 *   line 14) into `litellm.completion`, under the docstring "Retries on rate limit / transient
 *   errors". The retry INTENT is upstream's own and sits at the pinned commit; the routing belongs
 *   to a floating dependency and is quoted as such — in the fetched venv (litellm 1.98.0, what
 *   `requirements.txt`'s `litellm>=1.0.0` resolved to) that count is spent by
 *   `completion_with_retries`, the tenacity retryer `utils.py` hands any `openai.APIError`, which
 *   is the class a 429 arrives as. So for `LLM call failed` to be written at all, EVERY attempt had
 *   to fail: a request the model rejects outright — the hardcoded `temperature=0` above is that
 *   class — or a provider down across the whole budget. Neither is transient, and both recur on
 *   the next ask.
 * - *It is the only detector of one failure mode.* One `/ask` spends two calls — `_ask_sync` runs
 *   `_parse_action`, then `_generate_response` (`user_simulator/server.py:139-142`) — and
 *   `_call_llm` returns `""` on either (65-76). If the SECOND failed, line 119 returns
 *   `CANNED_USER_RESPONSE` and `cannedResponses` already sees it. If the FIRST failed, `action` is
 *   `""` (88-95) and `_generate_response` runs ANYWAY, returning an ordinary `<s>…</s>` answer that
 *   is neither canned nor missing: strike this clause and that run reads **`healthy`**. And that
 *   answer is damaged, not merely unverified — stage 1 IS the gate (`labeled()`, `unlabeled()`,
 *   `unanswerable()`), while the stage-2 prompt carries the ground-truth SQL, the clear query and
 *   the labeled ambiguity JSON and is told to answer "based on this action". Blanked, the answer is
 *   generated with gold in context and nothing saying whether the question was answerable at all.
 *   Note what that does to the objection's arithmetic: there is no missing tenth answer. There are
 *   ten, and the damaged one is among the nine being called real.
 *
 * Withholding rather than publishing a rate follows from that. The benchmark deletes one required
 * knowledge entry per task and `ask_user` is the only route back, so one ungated answer can decide
 * a whole task, and a subset this size moves by whole tasks: the rate `degraded` would publish is
 * precisely the number that would be wrong. The choice hides nothing either way — `llmCallFailures`
 * is returned here beside the verdict, and `withheld` names the reason on the page and in
 * `report.json`.
 */
export function assessSimulator(input: {
  readonly log: string;
  readonly answers: readonly string[];
}): SimulatorHealth {
  const llmCallFailures = countLlmCallFailures(input.log);
  const asks = input.answers.length;
  const cannedResponses = input.answers.filter((a) => a.trim() === CANNED_USER_RESPONSE).length;
  const verdict: SimulatorVerdict =
    llmCallFailures > 0 || (asks > 0 && cannedResponses === asks)
      ? "void"
      : cannedResponses > 0
        ? "degraded"
        : "healthy";
  return { llmCallFailures, asks, cannedResponses, verdict };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd eval/bird-interact && node --import tsx --test tests/report-simulator.test.ts && npm run check-types`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add eval/bird-interact/src/report-simulator.ts eval/bird-interact/tests/report-simulator.test.ts
git commit -m "feat(bird-eval): detect a user simulator that answered nothing"
```

---

### Task 3: The report IR

**Files:**
- Create: `eval/bird-interact/src/report-model.ts`
- Test: `eval/bird-interact/tests/report-model.test.ts`

**Interfaces:**
- Consumes: `AmbiguityVerdict`, `FailureClass` from `report-diagnose.js`; `SimulatorHealth` from `report-simulator.js`.
- Produces: interfaces `ProvenanceIR`, `ScoreIR`, `BudgetIR`, `GroupRowIR`, `AskIR`, `SubmitIR`, `KnowledgeIR`, `TaskIR`, `RunReportIR`; and `runReportSchema` (a Zod schema), `parseRunReport(value: unknown): RunReportIR`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { parseRunReport, type RunReportIR } from "../src/report-model.js";

function minimal(): RunReportIR {
  return {
    version: 1,
    generatedAt: "2026-08-25 11:41",
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
  assert.throws(() => parseRunReport(JSON.parse(JSON.stringify(bad))), /withheld/i);
});

test("the schema rejects an unknown version", () => {
  assert.throws(() => parseRunReport({ ...minimal(), version: 2 }), /version/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eval/bird-interact && node --import tsx --test tests/report-model.test.ts`
Expected: FAIL — cannot find module `../src/report-model.js`.

- [ ] **Step 3: Write the implementation**

```ts
import { z } from "zod";

import type { AmbiguityVerdict, FailureClass } from "./report-diagnose.js";
import type { SimulatorHealth } from "./report-simulator.js";

/**
 * The report IR: what the analysis produced, before anything renders it.
 *
 * Analysis and presentation are separated by this document for the same reason the compiler and
 * its back-ends are separated by `ir.json` — tests assert against it, a CI gate can read it, and
 * no number exists only inside a rendered page.
 */

export interface ProvenanceIR {
  readonly run: string;
  readonly officialCommit: string;
  readonly publicSnapshotCommit: string;
  readonly imageId: string;
  readonly repoDigests: readonly string[];
  readonly wrenVersion: string;
  readonly pythonVersion: string;
  readonly taskIds: readonly string[];
  readonly systemModel: string;
  /** `null` when no `data/private/.env` recorded one, e.g. an oracle-only run. */
  readonly userSimulatorModel: string | null;
}

export interface ScoreIR {
  readonly totalTasks: number;
  readonly totalReward: number;
  readonly averageReward: number;
  readonly phase1Count: number;
  readonly phase1Rate: number;
  readonly phase2Count: number;
  readonly phase2Rate: number;
}

export interface BudgetIR {
  readonly used: number;
  readonly initial: number;
  readonly exhaustedTasks: number;
}

export interface GroupRowIR {
  readonly key: string;
  readonly tasks: number;
  readonly averageReward: number;
  readonly phase1Count: number;
}

export interface AskIR {
  readonly question: string;
  readonly answer: string;
  readonly canned: boolean;
}

export interface SubmitIR {
  readonly attempt: number;
  readonly cost: number;
  readonly budgetBefore: number;
  readonly budgetAfter: number;
  /** What the agent wrote. */
  readonly semanticSql: string;
  /** What Wren planned; `null` when the submission bypassed planning. */
  readonly nativeSql: string | null;
  readonly result: string;
}

export interface KnowledgeIR {
  readonly required: readonly number[];
  /** Entries `knowledge_ambiguity[].deleted_knowledge` hid from the agent's view. */
  readonly withheld: readonly number[];
  /** Withheld entries whose definition reached the agent through `ask_user`. */
  readonly recovered: readonly number[];
  /** Required entries the agent never obtained by any route. */
  readonly missed: readonly number[];
}

export interface TaskIR {
  readonly taskId: string;
  readonly database: string;
  readonly category: string;
  readonly difficultyTier: string;
  readonly highLevel: boolean;
  readonly reward: number;
  readonly phase1Passed: boolean;
  readonly phase2Passed: boolean;
  /** `null` when no autopsy produced a tolerant verdict. */
  readonly tolerantPassed: boolean | null;
  readonly budgetUsed: number;
  readonly budgetRemaining: number;
  readonly initialBudget: number;
  readonly modelTurns: number;
  readonly elapsedSeconds: number;
  readonly toolCalls: Readonly<Record<string, number>>;
  readonly submits: readonly SubmitIR[];
  readonly asks: readonly AskIR[];
  readonly knowledge: KnowledgeIR;
  readonly ambiguities: readonly AmbiguityVerdict[];
  readonly failureClass: FailureClass;
}

export interface RunReportIR {
  readonly version: 1;
  readonly generatedAt: string;
  readonly provenance: ProvenanceIR;
  readonly simulator: SimulatorHealth;
  readonly warnings: readonly string[];
  /** Named disagreements between the official record and Warble's own trace. */
  readonly defects: readonly string[];
  /** `null` only when `withheld` states why. */
  readonly strict: ScoreIR | null;
  /** `null` when no autopsy computed it, or when scores are withheld. */
  readonly tolerant: ScoreIR | null;
  /** The reason scores are withheld, or `null` when they are reportable. */
  readonly withheld: string | null;
  readonly budget: BudgetIR;
  readonly byDifficulty: readonly GroupRowIR[];
  readonly byHighLevel: readonly GroupRowIR[];
  /**
   * The distinct `difficulty_tier` vocabularies present.
   *
   * The dataset carries `Simple`/`Moderate`/`Challenging` on most rows and `Easy`/`Medium`/`Hard`
   * on the rest. The breakdown reports both verbatim; folding them together is a mapping this
   * package has no authority to make.
   */
  readonly difficultyVocabularies: readonly string[];
  readonly tasks: readonly TaskIR[];
}

const finite = z.number().finite();
const count = z.number().int().nonnegative();

const scoreSchema = z.object({
  totalTasks: count,
  totalReward: finite,
  averageReward: finite,
  phase1Count: count,
  phase1Rate: finite,
  phase2Count: count,
  phase2Rate: finite,
});

const matchSchema = z.enum(["exact", "columns", "miss"]);

const ambiguitySchema = z.object({
  term: z.string(),
  type: z.string(),
  isMask: z.boolean(),
  critical: z.boolean(),
  match: matchSchema,
});

const taskSchema = z.object({
  taskId: z.string().min(1),
  database: z.string().min(1),
  category: z.string().min(1),
  difficultyTier: z.string(),
  highLevel: z.boolean(),
  reward: finite,
  phase1Passed: z.boolean(),
  phase2Passed: z.boolean(),
  tolerantPassed: z.boolean().nullable(),
  budgetUsed: finite,
  budgetRemaining: finite,
  initialBudget: finite,
  modelTurns: count,
  elapsedSeconds: finite,
  toolCalls: z.record(z.string(), count),
  submits: z.array(z.object({
    attempt: z.number().int().positive(),
    cost: finite,
    budgetBefore: finite,
    budgetAfter: finite,
    semanticSql: z.string(),
    nativeSql: z.string().nullable(),
    result: z.string(),
  })),
  asks: z.array(z.object({ question: z.string(), answer: z.string(), canned: z.boolean() })),
  knowledge: z.object({
    required: z.array(z.number().int()),
    withheld: z.array(z.number().int()),
    recovered: z.array(z.number().int()),
    missed: z.array(z.number().int()),
  }),
  ambiguities: z.array(ambiguitySchema),
  failureClass: z.enum(["passed", "passed-tolerant", "no-sql", "exec-error", "intent-miss", "intent-ok"]),
});

const groupSchema = z.object({
  key: z.string(),
  tasks: count,
  averageReward: finite,
  phase1Count: count,
});

export const runReportSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.string().min(1),
    provenance: z.object({
      run: z.string().min(1),
      officialCommit: z.string().min(1),
      publicSnapshotCommit: z.string().min(1),
      imageId: z.string().min(1),
      repoDigests: z.array(z.string()),
      wrenVersion: z.string().min(1),
      pythonVersion: z.string().min(1),
      taskIds: z.array(z.string().min(1)),
      systemModel: z.string().min(1),
      userSimulatorModel: z.string().nullable(),
    }),
    simulator: z.object({
      llmCallFailures: count,
      asks: count,
      cannedResponses: count,
      verdict: z.enum(["healthy", "degraded", "void"]),
    }),
    warnings: z.array(z.string()),
    defects: z.array(z.string()),
    strict: scoreSchema.nullable(),
    tolerant: scoreSchema.nullable(),
    withheld: z.string().min(1).nullable(),
    budget: z.object({ used: finite, initial: finite, exhaustedTasks: count }),
    byDifficulty: z.array(groupSchema),
    byHighLevel: z.array(groupSchema),
    difficultyVocabularies: z.array(z.string()),
    tasks: z.array(taskSchema),
  })
  // A withheld report that still states a score defeats the whole point of withholding it.
  .refine((r) => r.withheld === null || (r.strict === null && r.tolerant === null), {
    message: "a withheld report must carry no strict or tolerant score",
    path: ["withheld"],
  })
  .refine((r) => r.withheld !== null || r.strict !== null, {
    message: "a report with no strict score must state why it is withheld",
    path: ["withheld"],
  });

export function parseRunReport(value: unknown): RunReportIR {
  return runReportSchema.parse(value) as RunReportIR;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd eval/bird-interact && node --import tsx --test tests/report-model.test.ts && npm run check-types`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add eval/bird-interact/src/report-model.ts eval/bird-interact/tests/report-model.test.ts
git commit -m "feat(bird-eval): define the report IR and its schema"
```

---

### Task 4: Build the report IR from a run

**Files:**
- Create: `eval/bird-interact/src/report-build.ts`
- Test: `eval/bird-interact/tests/report-build.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: `RunInputs` (the already-parsed inputs a caller must supply), `TolerantVerdicts` (`Readonly<Record<string, boolean>>` keyed by task id), `OFFICIAL_USER_SIM_MODEL: string`, `buildRunReport(inputs: RunInputs): RunReportIR`.

`RunInputs` fields, all already parsed by the caller:

```ts
export interface RunInputs {
  readonly run: string;
  readonly generatedAt: string;
  readonly manifest: PrepareManifest;
  readonly pythonVersion: string;
  readonly systemModel: string;
  readonly userSimulatorModel: string | null;
  /** Parsed `a-interact.json`. */
  readonly official: OfficialResultFile;
  /** Parsed `traces/<task>/trace.json`, keyed by task id; a missing trace is a defect. */
  readonly traces: Readonly<Record<string, WarbleTrace>>;
  /** Parsed rows of `bird_interact_data_with_gt.jsonl`, keyed by `instance_id`. */
  readonly dataset: Readonly<Record<string, DatasetRow>>;
  /** Raw text of `logs/user-simulator.log`; empty string when absent. */
  readonly simulatorLog: string;
  /** Parsed `tolerant.json`, or `null` when no autopsy has run. */
  readonly tolerant: TolerantVerdicts | null;
}
```

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { OFFICIAL_USER_SIM_MODEL, buildRunReport, type RunInputs } from "../src/report-build.js";
import { CANNED_USER_RESPONSE } from "../src/report-simulator.js";

const GOLD = "SELECT o.WeathProfile, AVG(t.GainDb - 0.4 * ABS(t.DriftHz)) FROM Signals s";

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
        dialogue_history: [{ role: "agent", content: "which metric?" }, { role: "user", content: "GQI = GainDb - 0.4 * ABS(DriftHz)" }],
      }],
    },
    traces: {
      alien_1: {
        task_id: "alien_1", initial_budget: 18, budget_remaining: -1, model_turns: 23,
        phase1_completed: false, phase2_completed: false, total_reward: 0, current_phase: 1,
        dialogue_history: [{ role: "agent", content: "which metric?" }, { role: "user", content: "GQI = GainDb - 0.4 * ABS(DriftHz)" }],
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
          critical_ambiguity: [{ term: "signal quality", sql_snippet: "t.GainDb - 0.4 * ABS(t.DriftHz)", is_mask: true, type: "knowledge_linking_ambiguity" }],
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
  assert.equal(r.tasks[0].tolerantPassed, null);
});

test("the agent's ask is recorded with the answer it received", () => {
  const r = buildRunReport(inputs());
  assert.equal(r.tasks[0].asks.length, 1);
  assert.equal(r.tasks[0].asks[0].canned, false);
  assert.match(r.tasks[0].asks[0].answer, /SNQI/);
});

test("withheld knowledge recovered through ask_user is not counted as missed", () => {
  const r = buildRunReport(inputs());
  assert.deepEqual(r.tasks[0].knowledge.withheld, [0]);
  assert.deepEqual(r.tasks[0].knowledge.missed, []);
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
  assert.equal(r.tasks[0].tolerantPassed, true);
  assert.equal(r.tasks[0].failureClass, "passed-tolerant");
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
  assert.equal(r.tasks[0].submits.length, 0);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eval/bird-interact && node --import tsx --test tests/report-build.test.ts`
Expected: FAIL — cannot find module `../src/report-build.js`.

- [ ] **Step 3: Write the implementation**

Create `report-build.ts`. It is pure: it receives parsed inputs and returns a `RunReportIR`.

Structure it as these functions, in this order:

1. **Input types.** Declare `OfficialResultFile`, `OfficialResultRow`, `WarbleTrace`, `TrajectoryEntry`, `DatasetRow`, `TolerantVerdicts`, `RunInputs` as `readonly` interfaces matching the shapes in the test above. Keep every field the builder actually reads and no more.

2. `export const OFFICIAL_USER_SIM_MODEL = "anthropic/claude-sonnet-4-5-20250929";`

3. `function dialogueAsks(history)` — walk the `dialogue_history` pairing each `role: "agent"` entry with the `role: "user"` entry that follows it, returning `{ question, answer }[]`. An agent entry with no following user entry yields `answer: ""`.

4. `function knowledgeFor(row, asks)` — `required` is `row.external_knowledge` filtered to integers; `withheld` is every `deleted_knowledge` in `row.knowledge_ambiguity`; `recovered` is each withheld id whose knowledge name or definition text appears in any ask answer — match on the KB entry's `knowledge` name, case-insensitively, and when the caller supplied no KB text fall back to treating a withheld id as recovered when any non-canned answer exists; `missed` is `required` minus the ids evidenced as obtained (either not withheld, or withheld and recovered).

   *Note for the implementer:* the KB text is not in `RunInputs`. Keep `knowledgeFor` dependent only on what is: mark a withheld id `recovered` when at least one ask answer is non-canned and non-empty, and `missed` otherwise. Record this limit in the module doc comment — the report must not claim evidence it does not have.

5. `function submitsFor(trace)` — map `trace.tool_trajectory` entries with `tool === "submit_sql"` to `SubmitIR`, numbering `attempt` from 1, reading `semantic_sql ?? String(args.sql ?? "")` and `native_sql ?? null`.

6. `function toolCallsFor(trace)` — count entries by `tool`.

7. `function defectsFor(row, trace)` — return the named disagreements: a missing trace (`"alien_1: no Warble trace for this task"`), a reward mismatch (`"alien_1: official reward 0 but trace reward 1"`), and phase mismatches for `phase1_passed`/`phase1_completed` and `phase2_passed`/`phase2_completed`.

8. `function buildTask(...)` — assemble a `TaskIR`. `ambiguities` come from `gradeAmbiguities(lastSubmitSql, critical, nonCritical)` where `lastSubmitSql` is the final submit's `semanticSql` or `""`. `failureClass` comes from `classifyPhase({ passed: phase1Passed, tolerantPassed, executionFailed: lastResult.includes("[exec_err_flg]"), submitted: submits.length > 0, ambiguities, missedKnowledge: knowledge.missed.length })`.

9. `function score(tasks, pick)` — build a `ScoreIR` over tasks, where `pick` selects the phase-1 verdict (`t => t.phase1Passed` for strict, `t => t.tolerantPassed === true` for tolerant). `totalReward` sums `reward` for strict; for tolerant it sums 1 per tolerant pass. Rates are `count / totalTasks`, or `0` when there are no tasks.

10. `function groupBy(tasks, keyOf)` — produce `GroupRowIR[]` sorted by `key`.

11. `function warningsFor(inputs, tasks)` — always include the subset/leaderboard warning and the other-local-harness warning; add the user-simulator warning when `inputs.userSimulatorModel !== null && inputs.userSimulatorModel !== OFFICIAL_USER_SIM_MODEL`, naming the model; add a warning when no task has `category === "Management"`, stating that the full a-interact protocol is only exercised with both Query and Management tasks; add the task-count warning naming `tasks.length`.

12. `export function buildRunReport(inputs: RunInputs): RunReportIR` — assemble everything, compute `simulator` via `assessSimulator({ log: inputs.simulatorLog, answers: <every ask answer across tasks> })`, and when `simulator.verdict === "void"` set `strict: null`, `tolerant: null`, and `withheld` to a sentence naming the reason (mentioning `simulator`). Otherwise set `strict` and set `tolerant` only when `inputs.tolerant !== null`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd eval/bird-interact && node --import tsx --test tests/report-build.test.ts && npm run check-types`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add eval/bird-interact/src/report-build.ts eval/bird-interact/tests/report-build.test.ts
git commit -m "feat(bird-eval): build the report IR from a finished run"
```

---

### Task 5: Render the report as one self-contained page

**Files:**
- Create: `eval/bird-interact/src/report-html.ts`
- Test: `eval/bird-interact/tests/report-html.test.ts`

**Interfaces:**
- Consumes: `RunReportIR` from `report-model.js`, `CLASS_LABEL` from `report-diagnose.js`.
- Produces: `esc(v: unknown): string`, `renderReportHtml(reports: readonly RunReportIR[]): string`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eval/bird-interact && node --import tsx --test tests/report-html.test.ts`
Expected: FAIL — cannot find module `../src/report-html.js`.

- [ ] **Step 3: Write the implementation**

Create `report-html.ts` as a pure renderer. Requirements the tests pin:

- `esc` maps `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, `'` → `&#39;`, in that order (`&` first or the other entities get double-escaped). Everything interpolated from the IR goes through it.
- `renderReportHtml(reports)` returns a document starting `<!doctype html>` with an inline `<style>` block and no external `<script src>` or `<link rel="stylesheet">`.
- Section order, each an `<section><h2>…</h2>`: **Before comparing these** (warnings, plus defects under their own heading when non-empty), **Simulator**, **Reward**, **Budget**, **By difficulty**, **By question level**, **Tasks**.
- The **Reward** section renders strict and tolerant side by side. When `withheld !== null`, render the reason in place of both and render no numeric score anywhere on the page. When `tolerant === null` and nothing is withheld, render `not computed — run just autopsy-bird-eval` in the tolerant cell.
- `difficultyVocabularies.length > 1` adds a note under **By difficulty** stating that the dataset carries more than one vocabulary and that the rows are not merged.
- The **Tasks** section renders one row per task: id, category, difficulty, reward, phase flags, budget used/initial, failure class via `CLASS_LABEL`, and the ambiguity verdicts.
- With more than one report the page renders one column per run in the score and breakdown tables — the comparison case.
- No `Date` is read: `generatedAt` comes from the IR.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd eval/bird-interact && node --import tsx --test tests/report-html.test.ts && npm run check-types`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add eval/bird-interact/src/report-html.ts eval/bird-interact/tests/report-html.test.ts
git commit -m "feat(bird-eval): render the report IR as one self-contained page"
```

---

### Task 6: The offline `report` bin

This task ships the offline report end to end.

**Files:**
- Create: `eval/bird-interact/src/report-cli.ts`
- Modify: `eval/bird-interact/tsup.config.ts`, `eval/bird-interact/package.json`, `eval/bird-interact/tests/bin-entry.test.ts`, `justfile`
- Test: `eval/bird-interact/tests/report-cli.test.ts`

**Interfaces:**
- Consumes: `buildRunReport`, `RunInputs` from `report-build.js`; `renderReportHtml` from `report-html.js`; `parseRunReport` from `report-model.js`; `CliUsageError` from `cli-usage.js`; `readPrepareManifest` from `prepare-cli.js`.
- Produces: `ReportArgs`, `parseReportArgs(argv: readonly string[]): { kind: "help" } | { kind: "version" } | { kind: "run"; config: ReportArgs }`, `loadRunInputs(dataRoot: string, run: string, generatedAt: string): Promise<RunInputs>`, `main(argv?: readonly string[]): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { CliUsageError } from "../src/cli-usage.js";
import { parseReportArgs } from "../src/report-cli.js";

test("parses run names as positionals and an optional output pair", () => {
  const parsed = parseReportArgs(["alien-5", "alien-3", "--out", "/tmp/r.html", "--json", "/tmp/r.json"]);
  assert.equal(parsed.kind, "run");
  if (parsed.kind !== "run") return;
  assert.deepEqual(parsed.config.runs, ["alien-5", "alien-3"]);
  assert.equal(parsed.config.out, "/tmp/r.html");
  assert.equal(parsed.config.json, "/tmp/r.json");
});

test("help and version short-circuit before any run is required", () => {
  assert.equal(parseReportArgs(["--help"]).kind, "help");
  assert.equal(parseReportArgs(["-V"]).kind, "version");
});

test("naming no run is a usage error, not an empty report", () => {
  assert.throws(() => parseReportArgs([]), CliUsageError);
});

test("an unknown flag is a usage error", () => {
  assert.throws(() => parseReportArgs(["alien-5", "--nope"]), CliUsageError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eval/bird-interact && node --import tsx --test tests/report-cli.test.ts`
Expected: FAIL — cannot find module `../src/report-cli.js`.

- [ ] **Step 3: Write the implementation and wire the bin**

`report-cli.ts`:

- `parseReportArgs` uses `node:util`'s `parseArgs` with `strict: true`, **`allowPositionals: true`**, and options `help` (`boolean`, short `h`), `version` (`boolean`, short `V`), `out` (`string`), `json` (`string`). Wrap any `parseArgs` throw in `CliUsageError`. Return `{ kind: "help" }` / `{ kind: "version" }` first; then require at least one positional or throw `CliUsageError("usage: warble-bird-report <run> [<run> ...] [--out <file>] [--json <file>]")`.
- `loadRunInputs` reads, from `<dataRoot>/runs/<run>/`: `a-interact.json`, `manifest.json`, `python-environment.json`, `logs/user-simulator.log` (missing → `""`), `tolerant.json` (missing → `null`), and every `traces/<task>/trace.json`. It reads the dataset from `<dataRoot>/runtime/bird_interact_data_with_gt.jsonl`, keyed by `instance_id`. The user-simulator model is read from `<dataRoot>/private/.env`'s `USER_SIM_MODEL` when that file exists, else `null`; **the value is a model name, never a key — no other variable from that file is read or reported.**
- A missing run directory or unreadable `a-interact.json` throws. A truncated final JSONL line is skipped with a `process.stderr.write` naming the line. An unknown `record` discriminator is skipped with a message.
- `main` builds each report, writes the JSON (default `<run>/report.json`) and the HTML (default `<run>/report.html`), then prints one summary line per run to stderr. `generatedAt` is computed in `main` and passed down.
- Guard the entry point exactly as `smoke-cli.ts` does:

```ts
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
```

- `HELP` must begin `Usage: warble-bird-report <run> [<run> ...]` and list every option; `--version` prints the package version.

`tsup.config.ts` — add `"src/report-cli.ts"` to `entry`. Leave `splitting: false`.

`package.json` — add `"warble-bird-report": "./dist/report-cli.js"` to `bin`.

`tests/bin-entry.test.ts` — add `"report-cli"` to `BINS` and `"warble-bird-report"` to the expected sorted bin-key list.

`justfile` — add below the smoke recipe:

```make
# Render one or more finished runs as report.json + report.html (offline).
report-bird-eval *args:
    cd {{bird_eval_dir}} && npm run build && node dist/report-cli.js {{args}}
```

- [ ] **Step 4: Run the full suite**

Run: `cd eval/bird-interact && npm run check-types && npm test && npm run build`
Then, from the Warble root: `just report-bird-eval alien-5`
Expected: tests pass; the command writes `eval/bird-interact/data/runs/alien-5/report.json` and `report.html`.

- [ ] **Step 5: Verify the acceptance runs**

Run: `just report-bird-eval alien-5-VOID-usersim-broken`
Expected: the written `report.json` has `withheld` non-null, `strict: null`, `tolerant: null`, and the HTML shows the reason and no score.

- [ ] **Step 6: Commit**

```bash
git add eval/bird-interact/src/report-cli.ts eval/bird-interact/tests/report-cli.test.ts \
  eval/bird-interact/tsup.config.ts eval/bird-interact/package.json \
  eval/bird-interact/tests/bin-entry.test.ts justfile
git commit -m "feat(bird-eval): ship the offline run report"
```

---

### Task 7: The tolerant comparator

**Files:**
- Create: `eval/bird-interact/src/autopsy-tolerant.ts`
- Test: `eval/bird-interact/tests/autopsy-tolerant.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_CANDIDATE_VISITS: number`, `TOLERANT_SIG_FIGS: number`, `CellKey`, `normalizeCell(v: unknown): CellKey`, `tolerantEx(predRows: readonly (readonly unknown[])[], solRows: readonly (readonly unknown[])[]): boolean` (throws `TolerantSearchLimit` when the search ceiling is hit), `class TolerantSearchLimit extends Error`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { TolerantSearchLimit, normalizeCell, tolerantEx } from "../src/autopsy-tolerant.js";

test("normalizeCell collapses the numeric tower and nulls", () => {
  assert.deepEqual(normalizeCell(null), ["null"]);
  assert.deepEqual(normalizeCell(3), ["num", 3]);
  assert.deepEqual(normalizeCell(3.0), ["num", 3]);
  assert.deepEqual(normalizeCell("3"), ["str", "3"]);
  assert.deepEqual(normalizeCell(true), ["bool", true]);
  assert.deepEqual(normalizeCell("  x "), ["str", "x"]);
});

test("non-integral numbers compare at six significant figures", () => {
  assert.deepEqual(normalizeCell(-4.5599999999), normalizeCell(-4.56));
  assert.notDeepEqual(normalizeCell(1.23456), normalizeCell(1.23457));
});

test("identical values in a different row order pass", () => {
  assert.equal(tolerantEx([[2], [1]], [[1], [2]]), true);
});

test("an extra agent column is absorbed", () => {
  assert.equal(tolerantEx([[1, "rank-a"], [2, "rank-b"]], [[1], [2]]), true);
});

test("extra agent rows are absorbed", () => {
  assert.equal(tolerantEx([[1], [2], [3]], [[1], [2]]), true);
});

test("a genuinely wrong value fails", () => {
  assert.equal(tolerantEx([[1], [9]], [[1], [2]]), false);
});

test("row multiplicity is preserved", () => {
  assert.equal(tolerantEx([["a"], ["b"]], [["a"], ["a"], ["b"]]), false);
});

test("a narrower agent result can never contain gold", () => {
  assert.equal(tolerantEx([[1]], [[1, 2]]), false);
});

test("empty gold passes only against an empty prediction", () => {
  assert.equal(tolerantEx([], []), true);
  assert.equal(tolerantEx([[1]], []), false);
  assert.equal(tolerantEx([], [[1]]), false);
});

test("column pairing is found regardless of position", () => {
  assert.equal(tolerantEx([["x", 1], ["y", 2]], [[1, "x"], [2, "y"]]), true);
});

test("hitting the search ceiling raises rather than reporting a failure", () => {
  const width = 12;
  const rows = Array.from({ length: 400 }, () => Array.from({ length: width }, () => 1));
  assert.throws(() => tolerantEx(rows, rows.map((r) => r.slice(0, width - 1))), TolerantSearchLimit);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eval/bird-interact && node --import tsx --test tests/autopsy-tolerant.test.ts`
Expected: FAIL — cannot find module `../src/autopsy-tolerant.js`.

- [ ] **Step 3: Write the implementation**

Port `tolerant_ex` from `bird_interact_score.py`. Required behaviour:

- `TOLERANT_SIG_FIGS = 6`, `MAX_CANDIDATE_VISITS = 2_000_000`.
- `CellKey = readonly ["null"] | readonly ["bool", boolean] | readonly ["num", number] | readonly ["str", string]`. Compare keys by their JSON string so they can be `Map` keys.
- `normalizeCell`: `null`/`undefined` → `["null"]`; `boolean` → `["bool", v]`; a `number` that is an integer → `["num", v]`; a non-integral finite `number` → `["num", <v rounded to 6 significant figures>]`; a non-finite number → `["str", String(v)]`; a `Date` → `["str", <YYYY-MM-DD>]`; anything else → `["str", String(v).trim()]`. Six significant figures via `Number(v.toPrecision(TOLERANT_SIG_FIGS))`.
- `tolerantEx(pred, sol)`: empty `sol` → `pred.length === 0`; empty `pred` with non-empty `sol` → `false`. Normalise every cell. Pad each row to its side's maximum width with `["null"]`. When the agent is narrower than gold, `false`.
- Build a multiset per column on both sides. For each gold column, the candidate agent columns are those whose multiset contains gold's. Any gold column with no candidate → `false`.
- Build gold prefix-tuple counts per depth, then depth-first search over injective column assignments, pruning a branch whose running prefix counts do not contain gold's. Count candidate rows examined; exceeding `MAX_CANDIDATE_VISITS` throws `TolerantSearchLimit`.
- Document in the module comment why the ceiling throws rather than returning `false`: the search is synchronous and CPU-bound, so an uncapped pathological input stalls with no log line, and a cap that silently reads as "fail" would invent a verdict.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd eval/bird-interact && node --import tsx --test tests/autopsy-tolerant.test.ts && npm run check-types`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add eval/bird-interact/src/autopsy-tolerant.ts eval/bird-interact/tests/autopsy-tolerant.test.ts
git commit -m "feat(bird-eval): port the tolerant result comparison"
```

---

### Task 8: Question diff and result gap

**Files:**
- Create: `eval/bird-interact/src/autopsy-goldgap.ts`
- Test: `eval/bird-interact/tests/autopsy-goldgap.test.ts`

**Interfaces:**
- Consumes: `normalizeCell` from `autopsy-tolerant.js`.
- Produces: `DiffSegment`, `questionDiff(ambiguous: string, gold: string): { left: DiffSegment[]; right: DiffSegment[] }`, `Gap`, `describeGap(predRows, solRows): Gap`, `readOnlySelect(sql: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { describeGap, questionDiff, readOnlySelect } from "../src/autopsy-goldgap.js";

test("questionDiff marks only what the ambiguous question hid", () => {
  const { left, right } = questionDiff("show me the quality", "show me the SNQI");
  assert.equal(left.filter((s) => s.changed).map((s) => s.text).join(""), "quality");
  assert.equal(right.filter((s) => s.changed).map((s) => s.text).join(""), "SNQI");
  assert.equal(left.filter((s) => !s.changed).map((s) => s.text).join(""), "show me the ");
});

test("identical questions produce no changed span", () => {
  const { left, right } = questionDiff("same text", "same text");
  assert.ok(!left.some((s) => s.changed));
  assert.ok(!right.some((s) => s.changed));
});

test("describeGap reports a match when every gold value is present", () => {
  assert.deepEqual(describeGap([[1, "x"], [2, "y"]], [[1, "x"], [2, "y"]]), { kind: "match" });
});

test("describeGap reports the row set first when heights disagree", () => {
  assert.deepEqual(describeGap([[1]], [[1], [2]]), { kind: "row-count", agentRows: 1, goldRows: 2 });
});

test("describeGap names the gold columns the agent never produced", () => {
  const gap = describeGap([[1, 5], [2, 6]], [[1, 99], [2, 98]]);
  assert.equal(gap.kind, "missing-columns");
  if (gap.kind !== "missing-columns") return;
  assert.deepEqual(gap.missing, [1]);
});

test("a column matches on values even when the agent named it differently", () => {
  assert.deepEqual(describeGap([["clear", 1]], [["clear", 1]]), { kind: "match" });
});

test("readOnlySelect wraps a statement in a read-only transaction", () => {
  const sql = readOnlySelect("SELECT 1");
  assert.match(sql, /BEGIN;\s*SET TRANSACTION READ ONLY;/i);
  assert.ok(sql.includes("SELECT 1"));
  assert.match(sql, /ROLLBACK;/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eval/bird-interact && node --import tsx --test tests/autopsy-goldgap.test.ts`
Expected: FAIL — cannot find module `../src/autopsy-goldgap.js`.

- [ ] **Step 3: Write the implementation**

- `questionDiff`: tokenise both sides with `/\w+|\s+|[^\w\s]/g`, take an LCS over the lowercased token arrays, and mark every token outside the LCS as `changed: true`. Both inputs are one paragraph, so the quadratic table is a few thousand cells.
- `Gap` is exactly three shapes:

```ts
export type Gap =
  | { readonly kind: "match" }
  | { readonly kind: "row-count"; readonly agentRows: number; readonly goldRows: number }
  | { readonly kind: "missing-columns"; readonly missing: readonly number[] };
```

- `describeGap`: normalise every cell with `normalizeCell`. **When the row counts differ, return `row-count` and stop** — two result sets of different heights cannot share a column multiset, so every column would report missing and the reader would learn only that the row set is wrong, which is the more useful finding stated once. Otherwise, for each gold column index, look for any agent column whose value multiset contains it; collect the gold indices with no such column into `missing`. Empty `missing` → `match`.
- **Match on values, never on column names.** The agent names columns after the user's words (`condition_name`); gold names them after the schema (`weathprofile`). A name-based diff reports a perfect answer as a total miss, and the official scorer compares values too, so a name mismatch never costs a point.
- `readOnlySelect(sql)` returns `BEGIN; SET TRANSACTION READ ONLY;\n${sql}\nROLLBACK;` — the caller feeds this to `psql`, so a Query task cannot leave anything behind.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd eval/bird-interact && node --import tsx --test tests/autopsy-goldgap.test.ts && npm run check-types`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add eval/bird-interact/src/autopsy-goldgap.ts eval/bird-interact/tests/autopsy-goldgap.test.ts
git commit -m "feat(bird-eval): diff the masked question and the gold result gap"
```

---

### Task 9: The `autopsy` bin

**Files:**
- Create: `eval/bird-interact/src/autopsy-cli.ts`
- Modify: `eval/bird-interact/tsup.config.ts`, `eval/bird-interact/package.json`, `eval/bird-interact/tests/bin-entry.test.ts`, `justfile`
- Test: `eval/bird-interact/tests/autopsy-cli.test.ts`

**Interfaces:**
- Consumes: `tolerantEx`, `TolerantSearchLimit` from `autopsy-tolerant.js`; `describeGap`, `questionDiff`, `readOnlySelect` from `autopsy-goldgap.js`; `readPrepareManifest` from `prepare-cli.js`; `CliUsageError` from `cli-usage.js`.
- Produces:

```ts
export interface AutopsyTaskInput {
  readonly taskId: string;
  readonly goldSql: string;
  readonly agentSql: string;
  readonly ambiguous: string;
  readonly clear: string;
  readonly category: string;
}

export interface TaskAutopsy {
  readonly taskId: string;
  /** The reason this task could not be measured, or `null` when it was. */
  readonly unmeasured: string | null;
  readonly gap: Gap | null;
  readonly question: { readonly left: DiffSegment[]; readonly right: DiffSegment[] };
}

export interface AutopsyDeps {
  readonly run: string;
  readonly container: string;
  readonly port: number;
  readonly tasks: readonly AutopsyTaskInput[];
  readonly probe: () => Promise<boolean>;
  readonly query: (sql: string) => Promise<unknown[][]>;
}

export interface AutopsyResult {
  /** Only the tasks that produced a verdict; an unmeasured task is absent, never `false`. */
  readonly tolerant: Readonly<Record<string, boolean>>;
  readonly tasks: readonly TaskAutopsy[];
}

export function parseAutopsyArgs(argv: readonly string[]):
  | { kind: "help" } | { kind: "version" } | { kind: "run"; config: { run: string; out: string | null } };
export function runAutopsy(deps: AutopsyDeps): Promise<AutopsyResult>;
export function main(argv?: readonly string[]): Promise<void>;
```

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { CliUsageError } from "../src/cli-usage.js";
import { parseAutopsyArgs, runAutopsy } from "../src/autopsy-cli.js";

test("exactly one run is required", () => {
  const parsed = parseAutopsyArgs(["alien-5"]);
  assert.equal(parsed.kind, "run");
  if (parsed.kind !== "run") return;
  assert.equal(parsed.config.run, "alien-5");
  assert.throws(() => parseAutopsyArgs([]), CliUsageError);
  assert.throws(() => parseAutopsyArgs(["a", "b"]), CliUsageError);
});

test("an unreachable database fails loudly, naming container and port", async () => {
  await assert.rejects(
    runAutopsy({
      run: "alien-5",
      container: "warble_bird_interact_postgresql",
      port: 55432,
      tasks: [],
      probe: async () => false,
      query: async () => { throw new Error("unreachable"); },
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("warble_bird_interact_postgresql") &&
      error.message.includes("55432"),
  );
});

test("a reachable database degrades per task, never per section", async () => {
  const result = await runAutopsy({
    run: "alien-5",
    container: "c",
    port: 55432,
    tasks: [
      { taskId: "ok", goldSql: "SELECT 1", agentSql: "SELECT 1", ambiguous: "a", clear: "b", category: "Query" },
      { taskId: "bad", goldSql: "SELECT 1", agentSql: "BOOM", ambiguous: "a", clear: "b", category: "Query" },
    ],
    probe: async () => true,
    query: async (sql: string) => {
      if (sql.includes("BOOM")) throw new Error("syntax error at or near \"BOOM\"");
      return [[1]];
    },
  });
  assert.equal(result.tolerant.ok, true);
  assert.equal(result.tasks.find((t) => t.taskId === "bad")?.unmeasured, "syntax error at or near \"BOOM\"");
  assert.equal(result.tolerant.bad, undefined);
});

test("a Management task is skipped for the gap, with a stated reason", async () => {
  const result = await runAutopsy({
    run: "alien-5", container: "c", port: 55432,
    tasks: [{ taskId: "m", goldSql: "UPDATE t SET x = 1", agentSql: "UPDATE t SET x = 1", ambiguous: "a", clear: "b", category: "Management" }],
    probe: async () => true,
    query: async () => [[1]],
  });
  assert.match(result.tasks[0].unmeasured ?? "", /management/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eval/bird-interact && node --import tsx --test tests/autopsy-cli.test.ts`
Expected: FAIL — cannot find module `../src/autopsy-cli.js`.

- [ ] **Step 3: Write the implementation and wire the bin**

- `parseAutopsyArgs` mirrors `parseReportArgs` but accepts exactly one positional; zero or more than one is a `CliUsageError`.
- `runAutopsy(deps)` takes injected `probe` and `query` so the tests need no database. `probe()` false → throw an `Error` naming the container and port from the manifest and telling the reader to start it. This is a **loud failure, not a degraded report**: a report missing a section for an unstated reason is worse than one that refuses to run.
- Per task: `Management` category → `unmeasured: "management submissions are mutations and cannot be a read-only CTE"`. Otherwise run `readOnlySelect(goldSql)` and `readOnlySelect(agentSql)` through `query`; any throw sets `unmeasured` to that error's message and the task contributes no tolerant verdict. On success compute `tolerantEx(agentRows, goldRows)` and `describeGap(agentRows, goldRows)`; a `TolerantSearchLimit` sets `unmeasured` to the ceiling message rather than a `false` verdict.
- `main` resolves the container and port from `data/runtime/manifest.json`, builds `query` by spawning `psql -X -A -t` against `127.0.0.1:<port>` with the task database, writes `data/runs/<run>/tolerant.json` (a `Record<string, boolean>` of the tasks that produced a verdict) and `autopsy.html`, and guards its entry point exactly as `report-cli.ts` does.
- `tsup.config.ts` gains `"src/autopsy-cli.ts"`; `package.json` gains `"warble-bird-autopsy": "./dist/autopsy-cli.js"`; `tests/bin-entry.test.ts` gains `"autopsy-cli"` and `"warble-bird-autopsy"`.
- `justfile`:

```make
# Per-task autopsy: tolerant verdicts and the gold result gap (needs the container).
autopsy-bird-eval *args:
    cd {{bird_eval_dir}} && npm run build && node dist/autopsy-cli.js {{args}}
```

- [ ] **Step 4: Run the full suite**

Run: `cd eval/bird-interact && npm run check-types && npm test && npm run build`
Expected: all tests pass.

- [ ] **Step 5: Verify against the live container**

Run, from the Warble root, with `warble_bird_interact_postgresql` running:
```bash
just autopsy-bird-eval alien-5
just report-bird-eval alien-5
```
Expected: `tolerant.json` exists; `alien_1` — values identical to gold, sorted the other way — is `true` in it, and the regenerated `report.json` classifies `alien_1` as `passed-tolerant`.

- [ ] **Step 6: Commit**

```bash
git add eval/bird-interact/src/autopsy-cli.ts eval/bird-interact/tests/autopsy-cli.test.ts \
  eval/bird-interact/tsup.config.ts eval/bird-interact/package.json \
  eval/bird-interact/tests/bin-entry.test.ts justfile
git commit -m "feat(bird-eval): ship the per-task autopsy and tolerant verdicts"
```

---

### Task 10: Document both commands

**Files:**
- Modify: `eval/bird-interact/README.md`, `eval/bird-interact/tests/readme-workflow.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `tests/readme-workflow.test.ts`:

```ts
test("the README documents both report commands and the void rule", async () => {
  const text = await readme();
  assertAll(text, "README", [
    "just report-bird-eval",
    "just autopsy-bird-eval",
    "report.json",
    "report.html",
    "tolerant.json",
    /void/i,
    /withheld|withhold/i,
    /temperature=0/,
  ]);
});

test("the justfile forwards arguments to the report recipes", async () => {
  const text = await justfile();
  assertAll(text, "justfile", [/report-bird-eval \*args:/, /autopsy-bird-eval \*args:/]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eval/bird-interact && node --import tsx --test tests/readme-workflow.test.ts`
Expected: FAIL — the README is missing documentation.

- [ ] **Step 3: Update the README**

Add a `## Reading a finished run` section after `### Cleanup` covering:

- the two commands, their arguments, and their default outputs;
- that `report` is offline and `autopsy` needs the container, and that autopsy fails loudly when it is absent;
- that tolerant is computed by autopsy into `tolerant.json` and read by the report, which says **not computed** when it is absent;
- the strict/tolerant distinction in one paragraph: strict is the official verdict enforcing `conditions.order`; tolerant asks whether the numbers are right, absorbing extra columns, extra rows, ordering and numeric type;
- the **void** rule, naming the cause: the official user simulator hardcodes `temperature=0`, a model that rejects it fails every call and falls through to a canned non-answer, and such a run's scores are withheld rather than reported;
- that `difficulty_tier` carries two vocabularies and the breakdown does not merge them.

- [ ] **Step 4: Run the full suite**

Run: `cd eval/bird-interact && npm run check-types && npm test`
Then from the Warble root: `BIRD_INTERACT_CHECKOUT="$PWD/eval/bird-interact/data/cache/BIRD-Interact" just test-bird-eval`
Expected: every test passes, including the official differential.

- [ ] **Step 5: Commit**

```bash
git add eval/bird-interact/README.md eval/bird-interact/tests/readme-workflow.test.ts
git commit -m "docs(bird-eval): document the report and autopsy commands"
```

---

## Checkpoint

Tasks 1-6 deliver working software on their own: the offline report runs, and both acceptance
reports (`alien-5` and the void `alien-5-VOID-usersim-broken`) can be generated before any of the
autopsy work begins. Tasks 7-10 add the database-backed tolerant verdict and the gold gap.
