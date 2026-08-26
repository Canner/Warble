import assert from "node:assert/strict";
import test from "node:test";

import { describeGap, metaCommandRefusal, questionDiff, readOnlySelect } from "../src/autopsy-goldgap.js";

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

/**
 * The shape this pins, and what the single string it replaced did.
 *
 * `readOnlySelect` used to return ONE string — `BEGIN; SET TRANSACTION READ ONLY;\n<stmt>\nROLLBACK;`
 * — which the caller handed to a single `psql -c`. Up to psql 14, `-c` prints only the LAST
 * command's result, and that is the ROLLBACK: stdout was empty for gold and for the agent alike,
 * two empty results compare equal, and every Query task published a tolerant pass that nothing had
 * measured. Measured against real clients: psql 14.24 prints nothing for that batch, psql 18.4
 * prints the rows. One command per element keeps the statement alone in its own `-c`, where every
 * psql version prints it.
 */
test("readOnlySelect keeps the statement in a command of its own", () => {
  const commands = readOnlySelect("SELECT 1");
  assert.ok(Array.isArray(commands), "the wrapper must be commands to send one by one, not one string");
  assert.equal(commands.length, 3);
  assert.match(commands[0] ?? "", /BEGIN;\s*SET TRANSACTION READ ONLY;/i);
  assert.equal(commands[1], "SELECT 1");
  assert.match(commands[2] ?? "", /^ROLLBACK;$/i);
  assert.ok(
    !commands.some((command) => command.includes("SELECT 1") && /ROLLBACK/i.test(command)),
    "no command may hold both the statement and the ROLLBACK that hides its result",
  );
});

/**
 * The cost of the shape above, and where it is paid.
 *
 * A statement alone in its own `-c` is also FIRST in it, and psql reads a `-c` whose first
 * character is a backslash as a client-side meta-command: `\!` runs a shell command on the host,
 * `\copy` and `\o` write host files, `\i` reads them. None of that reaches a server, so none of the
 * three read-only layers is even in the path. Measured on psql 14.24 and 18.4 against a real
 * PostgreSQL 14.24: `\! id -un > /tmp/f` wrote that file and the replay returned `[]`.
 *
 * The rule is stated on the raw text, and is wider than psql's own boundary by exactly one thing:
 * leading whitespace. Measured, psql looks at the FIRST CHARACTER, so `   \! …` and `\n\! …` reach
 * the server and fail there with `syntax error at or near "\"`; `firstVisible` skips whitespace, so
 * they are refused here instead. A bare leading backslash is not valid PostgreSQL either, so that
 * widening loses no measurement and does not depend on where psql looks next year.
 *
 * A backslash after a comment or after a `;` is NOT refused. `-- x\n\! …` begins with `-` and
 * `SELECT 1; \! …` begins with `S`, so both are built into an argv and sent, and both fail on the
 * server with the same `syntax error at or near "\"` — measured on both clients, with all three
 * read-only layers in the path. That is the correct outcome and is why the narrower rule is safe;
 * the comment case sits in the second list below, the one nothing may refuse.
 */
test("a statement psql would read as a meta-command is refused, not built into an argv", () => {
  for (const sql of ["\\! id", "   \\! id", "\n\\copy x TO 'y'", "\t\\i /etc/passwd", "\\"]) {
    assert.match(metaCommandRefusal(sql) ?? "", /meta-command/, `not refused: ${JSON.stringify(sql)}`);
    assert.throws(() => readOnlySelect(sql), /meta-command/);
  }
  // The message describes the shape; quoting the statement would put gold in a page that says
  // nothing about carrying any — see `describePsqlFailure` in the autopsy for the same rule.
  assert.ok(!(metaCommandRefusal("\\! cat /etc/shadow") ?? "").includes("/etc/shadow"));

  for (const sql of ["SELECT 1", "SELECT 'a \\! b'", "-- \\! id\nSELECT 1", "SELECT E'\\\\n'"]) {
    assert.equal(metaCommandRefusal(sql), null, `wrongly refused: ${JSON.stringify(sql)}`);
    assert.equal(readOnlySelect(sql)[1], sql);
  }
});
