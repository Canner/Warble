/**
 * Tolerant result-set comparison, ported from BIRD-Interact's `tolerant_ex`
 * (`bird_interact_score.py`).
 *
 * The official scorer's strict comparison fails an agent whose values are all correct
 * but whose row order, extra columns, extra rows, or numeric representation differ from
 * gold — e.g. a correct `AVG` failing because gold is a `Decimal` and the agent's driver
 * returned a `float`, or a correct answer failing because gold sorted `DESC` and the
 * agent's query (with no `ORDER BY` requirement in the task) came back `ASC`. Tolerant
 * asks the weaker, more useful question: did the agent compute the right numbers? It
 * does so by normalising cell values across the numeric tower, then searching for *some*
 * injective mapping from gold's columns onto the agent's columns under which every gold
 * row (with its multiplicity) is contained in the agent's rows.
 *
 * This module is pure: no filesystem, network, `Date.now`/`new Date()`, or other
 * environment access. `normalizeCell` accepts a `Date` *value* (data the caller passed
 * in) and formats it deterministically — that is not a clock read.
 *
 * Why non-integral numbers round to 2 decimal places, not more
 * ------------------------------------------------------------
 * `TOLERANT_DECIMAL_PLACES = 2` matches `preprocess_results`'s `decimal_places` default in
 * the pinned checkout's `shared/db_utils.py`
 * (`data/cache/BIRD-Interact/BIRD-Interact-ADK/shared/db_utils.py:184`) — the function the
 * *official strict* comparator runs every result value through before comparing. Tolerant
 * exists to ask a strictly weaker question than strict, so it must never be pickier than
 * strict on the same axis: any two values strict already treats as equal must normalise to
 * the same `CellKey` here too. A tighter rounding (six significant figures, say) would make
 * tolerant reject pairs strict accepts, which is backwards — do not "improve" this back to
 * more precision without re-checking that invariant against `preprocess_results`.
 *
 * Why a timestamp normalises to its date
 * ------------------------------------------------------------
 * The same `preprocess_results` collapses EVERY `date` and `datetime` to `%Y-%m-%d` before
 * strict compares it, so strict cannot tell `2024-01-15 09:30:00` from `2024-01-15`. The
 * date axis is therefore one more axis on which tolerant must not be pickier — and it was:
 * this module's truncating branch only fired for a `Date` *object*, and the pipeline that
 * feeds it never produces one. `autopsy-cli.ts` shells out to `psql -X -A -t`, so every cell
 * arrives as text; `coerceCell` turns only fields matching its numeric pattern into numbers,
 * and `"2024-01-15 09:30:00"` is not one, so it stayed a full-length string. Gold returning
 * a `date` where the agent returned a `timestamp` then passed strict and failed tolerant.
 * The truncation is done where the values actually are — on the string forms psql writes —
 * and `TIMESTAMP_TEXT` is deliberately narrow: it requires a real time component, so a
 * string that merely begins with a date (`"2024-01-15 to 2024-02-01"`) is left whole.
 *
 * Why the search ceiling throws instead of returning `false`
 * ------------------------------------------------------------
 * The column-assignment search is a depth-first search over injective mappings from
 * gold columns to agent columns, entirely synchronous and CPU-bound — nothing here
 * yields back to the event loop or writes a progress line. A pathological input (many
 * columns whose value multisets are hard to tell apart) does not make the search run
 * slow with a warning; it stalls the process with no log line, no partial result, and no
 * way to distinguish "still working" from "wedged forever". A cap that silently returned
 * `false` in that situation would be worse than the stall: it would report a confident
 * tolerant-fail verdict for an input the search never finished examining, inventing an
 * answer instead of admitting the measurement could not be completed. Throwing
 * `TolerantSearchLimit` forces that distinction to surface rather than letting an eval
 * report read it as "the agent's SQL was wrong".
 */

export const TOLERANT_DECIMAL_PLACES = 2;
export const MAX_CANDIDATE_VISITS = 2_000_000;

export type CellKey =
  | readonly ["null"]
  | readonly ["bool", boolean]
  | readonly ["num", number]
  | readonly ["str", string];

const NULL_CELL: CellKey = ["null"];

/**
 * A `timestamp`/`timestamptz` as PostgreSQL's `ISO` DateStyle writes it, and nothing else.
 *
 * The date and a real time-of-day are both required, so only a value that genuinely carries a
 * time is truncated. Fractional seconds and a `+HH`, `+HH:MM` or `Z` offset are optional because
 * psql prints them only when the column has them.
 */
const TIMESTAMP_TEXT =
  /^(\d{4}-\d{2}-\d{2})[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?(?:[+-]\d{2}(?::?\d{2})?(?::\d{2})?|Z))?$/;

/**
 * Python's `round()` — half to EVEN — for the one input where it and `toFixed` disagree.
 *
 * `toFixed` is correctly rounded on the double's exact value but breaks a tie away from zero,
 * where `round()` breaks it towards the even neighbour: `0.125` is `0.13` under one and `0.12`
 * under the other. Only an exact tie differs, and a double is an exact tie at `places` decimals
 * only when it is `m / 2^(places+1)` for odd `m` — a tie is `n / (2 * 10^places)` with `n` odd,
 * and a dyadic rational of that form forces `5^places | n`. Scaling by a power of two is exact
 * in binary floating point, so that test is exact rather than an epsilon comparison, and the
 * scaled value at a tie is exactly `k + 0.5` and brackets its two neighbours without error.
 *
 * The benchmark runs `round(item, 2)` on floats and `Decimal.quantize(ROUND_HALF_UP)` on
 * `Decimal`s, so its own two paths disagree on the same tie. This follows the float path
 * because that is the one this pipeline produces: `psql` hands back text and `coerceCell` parses
 * it with `Number`, so every value that reaches here is a double.
 */
function roundHalfToEven(value: number, places: number): number {
  const tieScaled = value * 2 ** (places + 1);
  const isTie = Number.isInteger(tieScaled) && !Number.isInteger(tieScaled / 2);
  if (!isTie) return Number(value.toFixed(places));
  const scaled = value * 10 ** places;
  const down = Math.floor(scaled);
  const up = Math.ceil(scaled);
  return (down % 2 === 0 ? down : up) / 10 ** places;
}

export class TolerantSearchLimit extends Error {
  constructor(maxVisits: number) {
    super(`tolerant comparison exceeded ${maxVisits} candidate visits`);
    this.name = "TolerantSearchLimit";
  }
}

/**
 * Normalise a raw cell value into a `CellKey` so equivalent values compare equal
 * regardless of their source representation (int vs float vs Decimal-as-string, trimmed
 * whitespace, timestamp vs date, ...). Two `CellKey`s are equal iff their JSON strings
 * are equal, which is also how this module keys them in `Map`s.
 *
 * Both date branches collapse to `%Y-%m-%d`, matching `preprocess_results`; the string one is
 * the branch this pipeline actually reaches, and the `Date` one is kept for a caller that
 * hands over a real `Date` value.
 */
export function normalizeCell(v: unknown): CellKey {
  if (v === null || v === undefined) {
    return ["null"];
  }
  if (typeof v === "boolean") {
    return ["bool", v];
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      return ["str", String(v)];
    }
    if (Number.isInteger(v)) {
      return ["num", v];
    }
    return ["num", roundHalfToEven(v, TOLERANT_DECIMAL_PLACES)];
  }
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) {
      return ["str", String(v).trim()];
    }
    return ["str", v.toISOString().slice(0, 10)];
  }
  const text = String(v).trim();
  const timestamp = TIMESTAMP_TEXT.exec(text);
  const date = timestamp?.[1];
  return ["str", date ?? text];
}

/** Narrow a possibly-`undefined` indexed read into a definite value or throw. */
function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(`autopsy-tolerant: ${message}`);
  }
  return value;
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

function normalizeAndPad(rows: readonly (readonly unknown[])[], width: number): CellKey[][] {
  return rows.map((row) => {
    const normalized: CellKey[] = row.map((cell) => normalizeCell(cell));
    while (normalized.length < width) {
      normalized.push(NULL_CELL);
    }
    return normalized;
  });
}

function columnMultiset(rows: readonly (readonly CellKey[])[], colIndex: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const cell = must(row[colIndex], `column ${colIndex} missing from a padded row`);
    const key = JSON.stringify(cell);
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

function prefixMultiset(
  rows: readonly (readonly CellKey[])[],
  assignedColumns: readonly number[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const prefix = assignedColumns.map((colIndex) => must(row[colIndex], `column ${colIndex} missing from a padded row`));
    const key = JSON.stringify(prefix);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * True when every gold row (respecting multiplicity) is contained in the agent's rows
 * under some injective column mapping from gold columns onto agent columns — absorbing
 * extra agent columns, extra agent rows, row ordering, and numeric representation.
 *
 * `maxVisits` bounds the column-assignment search: each candidate column tried at each
 * depth spends one visit per agent row, checked before the branch is pruned or explored.
 * Exceeding it throws `TolerantSearchLimit` (see the module doc comment for why this is
 * a throw, not a `false`).
 */
export function tolerantEx(
  predRows: readonly (readonly unknown[])[],
  solRows: readonly (readonly unknown[])[],
  maxVisits: number = MAX_CANDIDATE_VISITS,
): boolean {
  if (solRows.length === 0) {
    return predRows.length === 0;
  }
  if (predRows.length === 0) {
    return false;
  }

  const predWidth = rowWidth(predRows);
  const solWidth = rowWidth(solRows);
  if (solWidth === 0) {
    // Gold rows carry no columns at all: there is nothing left to ask of the agent.
    return true;
  }
  if (predWidth < solWidth) {
    // A narrower agent result can never contain every gold column.
    return false;
  }

  const paddedPred = normalizeAndPad(predRows, predWidth);
  const paddedSol = normalizeAndPad(solRows, solWidth);

  const predColumnMultisets: Map<string, number>[] = [];
  for (let a = 0; a < predWidth; a++) {
    predColumnMultisets.push(columnMultiset(paddedPred, a));
  }
  const solColumnMultisets: Map<string, number>[] = [];
  for (let g = 0; g < solWidth; g++) {
    solColumnMultisets.push(columnMultiset(paddedSol, g));
  }

  // For each gold column, the candidate agent columns are those whose multiset contains
  // gold's — i.e. every value gold needs from that column is present in the agent's
  // column at least as many times.
  const candidatesByGoldColumn: number[][] = [];
  for (let g = 0; g < solWidth; g++) {
    const goldMultiset = must(solColumnMultisets[g], "gold column multiset missing");
    const candidates: number[] = [];
    for (let a = 0; a < predWidth; a++) {
      const agentMultiset = must(predColumnMultisets[a], "agent column multiset missing");
      if (containsMultiset(agentMultiset, goldMultiset)) {
        candidates.push(a);
      }
    }
    if (candidates.length === 0) {
      return false;
    }
    candidatesByGoldColumn.push(candidates);
  }

  // Gold prefix-tuple multisets per depth: at depth d, the multiset of gold's first d+1
  // columns' values across all gold rows. Used to prune a column-assignment branch as
  // soon as its running prefix can no longer contain gold's.
  const goldPrefixCounts: Map<string, number>[] = [];
  for (let d = 0; d < solWidth; d++) {
    const counts = new Map<string, number>();
    for (const row of paddedSol) {
      const key = JSON.stringify(row.slice(0, d + 1));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    goldPrefixCounts.push(counts);
  }

  const agentRowCount = paddedPred.length;
  let visits = 0;

  function search(depth: number, usedAgentColumns: ReadonlySet<number>, assignedAgentColumns: readonly number[]): boolean {
    const candidates = must(candidatesByGoldColumn[depth], "gold column candidates missing");
    const goldPrefix = must(goldPrefixCounts[depth], "gold prefix counts missing");

    for (const agentColumn of candidates) {
      if (usedAgentColumns.has(agentColumn)) {
        continue; // injective: an agent column can back at most one gold column
      }

      const nextAssigned = [...assignedAgentColumns, agentColumn];

      visits += agentRowCount;
      if (visits > maxVisits) {
        throw new TolerantSearchLimit(maxVisits);
      }

      const prefixCounts = prefixMultiset(paddedPred, nextAssigned);
      if (!containsMultiset(prefixCounts, goldPrefix)) {
        continue; // prune: this assignment's running prefix can't contain gold's
      }

      if (depth === solWidth - 1) {
        return true; // full injective assignment validated end to end
      }

      const nextUsed = new Set(usedAgentColumns);
      nextUsed.add(agentColumn);
      if (search(depth + 1, nextUsed, nextAssigned)) {
        return true;
      }
    }

    return false;
  }

  return search(0, new Set<number>(), []);
}
