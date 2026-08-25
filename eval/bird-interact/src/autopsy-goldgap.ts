/**
 * The two pure pieces an autopsy needs once `tolerantEx` has said "no": a word-level diff
 * showing what the ambiguous question hid, and a description of what is missing from the
 * agent's result set compared to gold.
 *
 * This module is pure: no filesystem, no network, no clock, no environment access.
 * `readOnlySelect` merely *builds* the SQL commands for a caller to run — it executes nothing, and
 * the server-side half of the read-only guarantee it describes lives with that caller. The one
 * guarantee it does hold alone is `metaCommandRefusal`'s, because that one is about what psql does
 * with an argument BEFORE any server sees it, and so has nowhere server-side to live.
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
 * A statement's first non-whitespace character, or `""` when it has none.
 *
 * Written on the raw text rather than on a trimmed copy so a very long statement is not copied to
 * ask a question about one character.
 */
function firstVisible(sql: string): string {
  for (const character of sql) {
    if (!/\s/.test(character)) return character;
  }
  return "";
}

/**
 * The stated reason a statement cannot be replayed at all, or `null` when psql will send it to the
 * server. Today there is exactly one: psql would run it HERE instead.
 *
 * `readOnlySelect` puts the statement alone in a `-c` of its own, which also puts it FIRST in that
 * argument — and psql decides what a `-c` IS from its first character. A leading backslash makes
 * the whole argument a client-side meta-command that never reaches a server: `\!` runs a shell
 * command as whoever is running the autopsy, `\copy` and `\o` write files on this machine, `\i`
 * and `\lo_import` read them. Measured through the replay's own argv against a real PostgreSQL
 * 14.24, on psql 14.24 and 18.4 alike: `\! id -un > /tmp/f` returned an empty result and left that
 * file behind holding the developer's username; `\copy (SELECT 1) TO '/tmp/f.csv'` wrote a host
 * file the same way.
 *
 * Nothing else in this replay can see that. The read-only ROLE, `default_transaction_read_only`
 * and the wrapper below are all things the SERVER applies, and a meta-command never reaches a
 * server — which is why the refusal has to be here, before an argv is built, rather than in any of
 * them. The statement is dataset gold or recorded agent text, so it is refused rather than escaped
 * or rewritten: a replay is a measurement, and a statement psql will not send is not one.
 *
 * The rule is deliberately WIDER than the boundary that was measured. psql looks at the raw first
 * character, so `   \! …`, `\n\! …`, `-- x\n\! …` and `SELECT 1; \! …` all reach the server and
 * fail there with `syntax error at or near "\"` — measured on both clients. Those are refused here
 * too, because a bare backslash outside a string or a comment is not valid PostgreSQL in any of
 * those positions either: refusing the whole shape costs no measurable task, and does not rest on
 * psql never moving where it starts looking.
 *
 * The reason describes the SHAPE and never quotes the statement, for the reason `describePsqlFailure`
 * gives in `autopsy-cli`: it becomes a task's stated "could not measure" on a page that would
 * otherwise be publishing gold it never said it carried.
 */
export function metaCommandRefusal(sql: string): string | null {
  if (firstVisible(sql) !== "\\") return null;
  return (
    "this statement begins with a backslash, which psql runs as a meta-command on THIS machine — " +
    "`\\!` executes a shell command, `\\copy` and `\\o` write files here — instead of sending it to " +
    "the server, where the read-only role, the read-only setting and the read-only transaction all " +
    "are. It is refused rather than replayed, so this task has no verdict."
  );
}

/**
 * The read-only replay of one statement, as the commands psql must be given SEPARATELY — one
 * `-c` argument each, never joined into one string. Both halves of that sentence are load-bearing.
 *
 * Why they must not be one string
 * ------------------------------
 * They used to be: `BEGIN; SET TRANSACTION READ ONLY;\n<stmt>\nROLLBACK;`, handed to a single
 * `psql -c`. Up to psql 14 — Ubuntu 22.04's stock client, and the autopsy runs the HOST binary —
 * `-c` prints only the LAST command's result, and that is the ROLLBACK. Stdout was therefore
 * EMPTY, for gold and for the agent alike; two empty results compare equal, so every Query task
 * published a tolerant pass over a comparison of nothing against nothing. Measured: psql 14.24
 * prints not one byte for that batch where psql 18.4 prints the rows. With one command per `-c`,
 * only the middle one produces tuples and every psql version prints exactly it — the caller's
 * `SHOW_ALL_RESULTS=off` then holds the same line for a `sol_sql` that is itself several
 * statements.
 *
 * Why the wrapper is only half of the read-only guarantee
 * ------------------------------------------------------
 * It is a string, and a statement can talk its way out of it: replaying
 * `ROLLBACK; CREATE TABLE pwn AS SELECT 1; COMMIT` ends the read-only transaction, creates the
 * table in the implicit transaction that follows, commits it, and leaves the trailing ROLLBACK a
 * no-op warning — measured end to end against a real PostgreSQL, on the template database every
 * later replay reads. The half that cannot be talked out of is server-side, in the `PGOPTIONS`
 * `createPsqlQuery` sets on the psql it spawns. This wrapper stays as defence in depth: it scopes
 * the guarantee to the replay itself, so a connection that somehow arrives without those options
 * is still inside an explicit read-only transaction that is rolled back.
 *
 * What the same shape costs, and why this throws
 * ----------------------------------------------
 * A statement alone in its own `-c` is also FIRST in it, which is where psql looks to decide
 * whether a `-c` is SQL at all — see `metaCommandRefusal`. The refusal lives here rather than in
 * the caller because this is the one function that decides the statement goes into an argument of
 * its own: a caller cannot build the argv without it, and so cannot forget it.
 *
 * This function only builds strings. Executing them is the caller's job; nothing in this
 * module touches a database.
 */
export function readOnlySelect(sql: string): readonly string[] {
  const refusal = metaCommandRefusal(sql);
  if (refusal !== null) throw new Error(refusal);
  return ["BEGIN; SET TRANSACTION READ ONLY;", sql, "ROLLBACK;"];
}
