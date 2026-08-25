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
  | "miss"
  /**
   * The fragment references no qualified column, so the column test could not run, and it did not
   * match literally either. Not a misread: this snippet carries no column evidence at all, and
   * grading it `miss` manufactured the report's strongest claim about the agent out of nothing.
   */
  | "inconclusive";

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
 * misses, so the qualifier is the only marker available.
 *
 * **Plenty of gold snippets carry no qualifier at all**: 395 of the 826 critical-ambiguity
 * snippets in this package's merged dataset have no `alias.Column` reference — whole
 * `CREATE FUNCTION` bodies, and fragments like `COUNT(*) FILTER (WHERE SNQI > 0)`. Those return
 * `[]` here and cannot be graded by columns at all, which is what `inconclusive` is for.
 */
export function snippetColumns(snippet: string): string[] {
  const found = new Set<string>();
  for (const m of snippet.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
    // The capture group always matches when the pattern does; the guard is for
    // `noUncheckedIndexedAccess`, not a behavior change.
    const column = m[1];
    if (column !== undefined) found.add(column.toLowerCase());
  }
  return [...found];
}

/**
 * Grade one gold `sql_snippet` against the SQL the agent actually submitted.
 *
 * The literal test runs first because it is the only one an unqualified snippet has. A snippet
 * with no qualified column that did not match literally is `inconclusive` REGARDLESS of what the
 * agent wrote — including when it submitted nothing — because the grade describes what the snippet
 * can evidence, and that does not change with the haystack.
 */
export function matchSnippet(agentSql: string, snippet: string): SnippetMatch {
  const haystack = normalizeSql(agentSql);
  const needle = normalizeSql(snippet);
  // An empty needle is `includes`-true against anything; a snippet that normalises to nothing
  // evidences nothing, and falls through to `inconclusive` with the rest of the ungradable ones.
  if (needle !== "" && haystack.includes(needle)) return "exact";
  const columns = snippetColumns(snippet);
  if (columns.length === 0) return "inconclusive";
  if (haystack === "") return "miss";
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
 *
 * Only `miss` counts. An `inconclusive` snippet says the fragment could not be graded by columns,
 * which is not evidence of anything about the agent and must never reach `intent-miss`.
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
