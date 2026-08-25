/**
 * The two pure pieces an autopsy needs once `tolerantEx` has said "no": a word-level diff
 * showing what the ambiguous question hid, and a description of what is missing from the
 * agent's result set compared to gold.
 *
 * This module is pure: no filesystem, no network, no clock, no environment access.
 * `readOnlySelect` merely *builds* a SQL string for a caller to run — it executes nothing.
 *
 * Why the gap is described by VALUES, never by column names
 * --------------------------------------------------------
 * The agent names its output columns after the user's words (`condition_name`); gold names
 * them after the schema (`weathprofile`). A name-based diff would report a numerically
 * perfect answer as a total miss — and it would be reporting a fiction, because the official
 * scorer compares values too, so a name mismatch never costs the agent a point. Every
 * comparison here therefore runs over `normalizeCell` keys, and column identity is "some
 * agent column holds these values", not "some agent column has this name".
 *
 * Why a height mismatch stops the analysis
 * ----------------------------------------
 * A per-column diff is only meaningful when the row counts agree. Two result sets of
 * different heights cannot share a column multiset, so with mismatched heights *every* gold
 * column reports missing and the reader learns only that the row set is wrong — the more
 * useful finding, buried under a column list that is an artefact of the height difference
 * rather than a real signal. `describeGap` therefore returns the `row-count` shape and
 * stops: exactly one of three shapes, never a column list with a caveat attached.
 */

import { normalizeCell } from "./autopsy-tolerant.js";

/** One run of question text, flagged with whether the two questions disagree over it. */
export interface DiffSegment {
  readonly text: string;
  readonly changed: boolean;
}

/** The single finding `describeGap` reports — exactly one of three shapes. */
export type Gap =
  | { readonly kind: "match" }
  | { readonly kind: "row-count"; readonly agentRows: number; readonly goldRows: number }
  | { readonly kind: "missing-columns"; readonly missing: readonly number[] };

/**
 * Split into words, whitespace runs, and single punctuation marks, so the diff lands on word
 * boundaries and the untouched text can be rejoined verbatim (every character of the input
 * belongs to exactly one token).
 */
const TOKEN_PATTERN = /\w+|\s+|[^\w\s]/g;

/** Narrow a possibly-`undefined` indexed read into a definite value or throw. */
function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(`autopsy-goldgap: ${message}`);
  }
  return value;
}

function tokenize(text: string): string[] {
  return text.match(TOKEN_PATTERN) ?? [];
}

/**
 * Mark the tokens of each side that lie outside a longest common subsequence of the two
 * lowercased token arrays. `kept[i]` is true when token `i` is part of the LCS, i.e. common
 * to both questions and therefore unchanged.
 *
 * `table[i][j]` is the LCS length of `a[i..]` and `b[j..]`, held in one flat array so the
 * quadratic table costs a single allocation. Both inputs are one paragraph, so a few
 * thousand cells is entirely affordable.
 */
function lcsKeptFlags(a: readonly string[], b: readonly string[]): { aKept: boolean[]; bKept: boolean[] } {
  const n = a.length;
  const m = b.length;
  const stride = m + 1;
  const table = new Array<number>((n + 1) * stride).fill(0);
  const at = (i: number, j: number): number => must(table[i * stride + j], `lcs cell (${i},${j}) missing`);

  for (let i = n - 1; i >= 0; i--) {
    const aToken = must(a[i], `left token ${i} missing`);
    for (let j = m - 1; j >= 0; j--) {
      const bToken = must(b[j], `right token ${j} missing`);
      table[i * stride + j] =
        aToken === bToken ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const aKept = new Array<boolean>(n).fill(false);
  const bKept = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (must(a[i], `left token ${i} missing`) === must(b[j], `right token ${j} missing`)) {
      aKept[i] = true;
      bKept[j] = true;
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      i++;
    } else {
      j++;
    }
  }

  return { aKept, bKept };
}

/** Coalesce a token run into segments, merging neighbours that share a `changed` flag. */
function toSegments(tokens: readonly string[], kept: readonly boolean[]): DiffSegment[] {
  const segments: DiffSegment[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const text = must(tokens[i], `token ${i} missing`);
    const changed = !must(kept[i], `kept flag ${i} missing`);
    const previous = segments[segments.length - 1];
    if (previous !== undefined && previous.changed === changed) {
      segments[segments.length - 1] = { text: previous.text + text, changed };
    } else {
      segments.push({ text, changed });
    }
  }
  return segments;
}

/**
 * Word-level diff of the ambiguous question the agent was shown against the gold question,
 * showing exactly what the ambiguity hid. Tokens are matched case-insensitively — the reader
 * cares that gold said `SNQI` where the user said `quality`, not that a word was capitalised
 * — but each side's segments carry the original text so the questions render verbatim.
 */
export function questionDiff(
  ambiguous: string,
  gold: string,
): { left: DiffSegment[]; right: DiffSegment[] } {
  const leftTokens = tokenize(ambiguous);
  const rightTokens = tokenize(gold);
  const { aKept, bKept } = lcsKeptFlags(
    leftTokens.map((token) => token.toLowerCase()),
    rightTokens.map((token) => token.toLowerCase()),
  );
  return {
    left: toSegments(leftTokens, aKept),
    right: toSegments(rightTokens, bKept),
  };
}

function rowWidth(rows: readonly (readonly unknown[])[]): number {
  let width = 0;
  for (const row of rows) {
    if (row.length > width) {
      width = row.length;
    }
  }
  return width;
}

/**
 * The multiset of normalised values in one column, keyed the way `autopsy-tolerant` keys
 * them: a `CellKey` is a tuple, so structural equality is its JSON string. Rows shorter than
 * `width` contribute a null cell, matching how the tolerant comparator pads ragged input.
 */
function columnMultiset(rows: readonly (readonly unknown[])[], colIndex: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = JSON.stringify(normalizeCell(colIndex < row.length ? row[colIndex] : null));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function containsMultiset(haystack: Map<string, number>, needle: Map<string, number>): boolean {
  for (const [key, need] of needle) {
    if ((haystack.get(key) ?? 0) < need) {
      return false;
    }
  }
  return true;
}

/**
 * Describe what gold has that the agent's result set does not.
 *
 * Heights first: when the row counts disagree, that is the whole finding (see the module
 * doc comment). Otherwise every gold column is looked for among the agent's columns by
 * value multiset — any agent column that contains gold's values counts, whatever it is
 * named and whatever position it sits in. Gold indices with no such column are `missing`;
 * none missing is a `match`.
 *
 * The per-column search is deliberately *not* the injective assignment `tolerantEx`
 * performs. That question ("is this answer right?") is already settled by the time an
 * autopsy runs; this one is "which gold column has no home at all in the agent's output?",
 * and answering it independently per column keeps one shared column from hiding a second
 * genuinely missing one behind a failed matching.
 */
export function describeGap(
  predRows: readonly (readonly unknown[])[],
  solRows: readonly (readonly unknown[])[],
): Gap {
  if (predRows.length !== solRows.length) {
    return { kind: "row-count", agentRows: predRows.length, goldRows: solRows.length };
  }

  const predWidth = rowWidth(predRows);
  const solWidth = rowWidth(solRows);

  const predColumnMultisets: Map<string, number>[] = [];
  for (let a = 0; a < predWidth; a++) {
    predColumnMultisets.push(columnMultiset(predRows, a));
  }

  const missing: number[] = [];
  for (let g = 0; g < solWidth; g++) {
    const goldMultiset = columnMultiset(solRows, g);
    const found = predColumnMultisets.some((agentMultiset) => containsMultiset(agentMultiset, goldMultiset));
    if (!found) {
      missing.push(g);
    }
  }

  if (missing.length === 0) {
    return { kind: "match" };
  }
  return { kind: "missing-columns", missing };
}

/**
 * Wrap a statement so the caller — which feeds this to `psql` — cannot leave anything
 * behind: the transaction is declared read only and rolled back regardless. Replaying a
 * Query task's SQL to explain a failure must never mutate the database it is inspecting.
 *
 * This function only builds the string. Executing it is the caller's job; nothing in this
 * module touches a database.
 */
export function readOnlySelect(sql: string): string {
  return `BEGIN; SET TRANSACTION READ ONLY;\n${sql}\nROLLBACK;`;
}
