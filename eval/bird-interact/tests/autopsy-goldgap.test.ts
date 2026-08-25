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
