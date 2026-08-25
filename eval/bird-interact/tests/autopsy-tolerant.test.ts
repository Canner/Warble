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

test("non-integral numbers compare at two decimal places", () => {
  assert.deepEqual(normalizeCell(-4.5599999999), normalizeCell(-4.56));
  assert.notDeepEqual(normalizeCell(1.234), normalizeCell(1.244));
  // The alien_1/alien-5 motivating case: agent wrote ROUND(x, 2) where gold did not.
  // Strict (via preprocess_results' decimal_places=2) treats these as equal; tolerant must too.
  assert.deepEqual(normalizeCell(-1.42745), normalizeCell(-1.43));
});

/**
 * The date axis, on the string forms the pipeline really produces.
 *
 * `preprocess_results` collapses every `date` and `datetime` to `%Y-%m-%d` before STRICT
 * compares it, so strict cannot tell a timestamp from its date. Tolerant asks a weaker question
 * and must not be pickier on the same axis. The truncating branch used to require a `Date`
 * object, which `autopsy-cli`'s `psql -X -A -t` pipeline never produces: `coerceCell` leaves
 * `"2024-01-15 09:30:00"` a string because it fails the numeric test, and the full-length string
 * then failed against gold's `"2024-01-15"`.
 */
test("a timestamp string normalises to its date, exactly as strict already sees it", () => {
  assert.deepEqual(normalizeCell("2024-01-15 09:30:00"), ["str", "2024-01-15"]);
  assert.deepEqual(normalizeCell("2024-01-15 09:30:00"), normalizeCell("2024-01-15"));
  // The forms psql writes for `timestamp`, `timestamptz` and a fractional-second column.
  for (const text of [
    "2024-01-15 09:30:00.123456",
    "2024-01-15 09:30:00+00",
    "2024-01-15 09:30:00+05:30",
    "2024-01-15T09:30:00Z",
    "2024-01-15 09:30",
  ]) {
    assert.deepEqual(normalizeCell(text), ["str", "2024-01-15"], `not truncated: ${text}`);
  }
});

test("gold's date and the agent's timestamp are the same answer", () => {
  assert.equal(tolerantEx([["2024-01-15 09:30:00"]], [["2024-01-15"]]), true);
  assert.equal(tolerantEx([["2024-01-15"]], [["2024-01-15 09:30:00"]]), true);
  // A different DAY is still a different answer: the truncation is not a free pass.
  assert.equal(tolerantEx([["2024-01-16 09:30:00"]], [["2024-01-15"]]), false);
});

/** Only a real time component truncates: a string that merely starts with a date is a string. */
test("a string that is not a timestamp keeps every character", () => {
  for (const text of [
    "2024-01-15 to 2024-02-01",
    "2024-01-15 night shift",
    "2024-01-15-09",
    "not a date at all",
  ]) {
    assert.deepEqual(normalizeCell(text), ["str", text], `wrongly truncated: ${text}`);
  }
});

/**
 * `toFixed` breaks a tie away from zero; the benchmark's `round(item, 2)` breaks it to even.
 * `0.125` is the smallest case, and the module's claim is that it matches the benchmark.
 */
test("an exact tie rounds to even, the way Python's round does", () => {
  assert.deepEqual(normalizeCell(0.125), ["num", 0.12]);
  assert.deepEqual(normalizeCell(-0.125), ["num", -0.12]);
  assert.deepEqual(normalizeCell(0.135), ["num", 0.14]);
  assert.deepEqual(normalizeCell(0.375), ["num", 0.38]);
  assert.deepEqual(normalizeCell(1.125), ["num", 1.12]);
  // And a value that only LOOKS like a tie is not one: 0.005 as a double sits above 1/200, so
  // correct rounding takes it up, exactly as Python does. Half-to-even must not reach it.
  assert.deepEqual(normalizeCell(0.005), ["num", 0.01]);
  assert.deepEqual(normalizeCell(2.675), ["num", 2.67]);
  assert.deepEqual(normalizeCell(1.005), ["num", 1]);
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
  // The visit counter increments before the ceiling is tested, so the first candidate
  // examined at depth 0 already spends one visit per agent row. A ceiling of 1 therefore
  // trips deterministically on an input that is otherwise a clean match.
  assert.throws(() => tolerantEx([[1], [2]], [[1], [2]], 1), TolerantSearchLimit);
});

test("the default ceiling does not trip on an ordinary comparison", () => {
  assert.equal(tolerantEx([[1], [2]], [[1], [2]]), true);
});
