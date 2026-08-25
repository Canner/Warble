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
