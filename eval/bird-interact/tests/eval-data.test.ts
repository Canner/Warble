import assert from "node:assert/strict";
import test from "node:test";

import {
  mergePublicWithGroundTruth,
  parseGroundTruthJsonl,
  parsePublicJsonl,
  selectAlienSmoke,
  serializeJsonl,
  sha256,
} from "../src/eval-data.js";
import { SMOKE_TASK_IDS } from "../src/runtime-layout.js";

type JsonRecord = Record<string, unknown>;

function publicRow(id: string): JsonRecord {
  return {
    instance_id: id,
    selected_database: id.startsWith("alien_") ? "alien" : "other",
    category: id.startsWith("alien_") ? "Query" : "Other",
    amb_user_query: `question for ${id}`,
    query: `public query ${id}`,
    user_query_ambiguity: { label: "ambiguous" },
    knowledge_ambiguity: ["knowledge"],
    sol_sql: ["SELECT public root decoy"],
    external_knowledge: ["public root knowledge decoy"],
    test_cases: [{ input: "public root test decoy" }],
    follow_up: {
      query: `follow up query ${id}`,
      user_query_ambiguity: { source: "public" },
      knowledge_ambiguity: ["follow-up knowledge"],
      sol_sql: "SELECT public follow-up decoy",
      external_knowledge: ["public follow-up knowledge decoy"],
      test_cases: [{ input: "public follow-up test decoy" }],
      sentinel_follow_up: `public-${id}`,
    },
    sentinel_row: `public-${id}`,
  };
}

function gtRow(id: string, followUpSql: string | string[] = "SELECT follow_up"): JsonRecord {
  return {
    instance_id: id,
    sol_sql: ["SELECT main"],
    external_knowledge: ["official knowledge"],
    test_cases: [{ input: 1 }],
    follow_up: {
      sol_sql: followUpSql,
      external_knowledge: ["follow official knowledge"],
      test_cases: [{ input: 2 }],
      sentinel_gt_follow_up: "must not leak",
    },
    sentinel_gt_row: "must not leak",
  };
}

function ids(): string[] {
  const filler = 300 - SMOKE_TASK_IDS.length;
  return [...SMOKE_TASK_IDS, ...Array.from({ length: filler }, (_, i) => `task_${i + 1}`)];
}

function jsonl(rows: JsonRecord[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

function publicRows(): JsonRecord[] {
  return ids().map(publicRow);
}

function gtRows(): JsonRecord[] {
  return ids().map((id, index) => gtRow(id, index === 0 ? ["SELECT follow 1", "SELECT follow 2"] : "SELECT follow"));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertRejects(fn: () => unknown, expression: RegExp): void {
  assert.throws(fn, expression);
}

test("parses 300 public and GT rows while preserving forward-compatible metadata", () => {
  const publicTasks = parsePublicJsonl(jsonl(publicRows()));
  const gtTasks = parseGroundTruthJsonl(jsonl(gtRows()));

  assert.equal(publicTasks.length, 300);
  assert.equal(gtTasks.length, 300);
  assert.equal(publicTasks[0]?.query, "public query alien_1");
  assert.deepEqual(publicTasks[0]?.user_query_ambiguity, { label: "ambiguous" });
  assert.deepEqual(publicTasks[0]?.knowledge_ambiguity, ["knowledge"]);
  assert.equal(publicTasks[0]?.sentinel_row, "public-alien_1");
  assert.equal(publicTasks[0]?.follow_up.query, "follow up query alien_1");
  assert.deepEqual(publicTasks[0]?.follow_up.user_query_ambiguity, { source: "public" });
  assert.deepEqual(publicTasks[0]?.follow_up.knowledge_ambiguity, ["follow-up knowledge"]);
  assert.equal(publicTasks[0]?.follow_up.sentinel_follow_up, "public-alien_1");
  assert.equal(gtTasks[0]?.sentinel_gt_row, "must not leak");
  assert.equal(gtTasks[0]?.follow_up.sentinel_gt_follow_up, "must not leak");
  assert.deepEqual(gtTasks[0]?.follow_up.sol_sql, ["SELECT follow 1", "SELECT follow 2"]);
});

test("redacts malformed JSON row content while reporting its one-based line", () => {
  const rows = publicRows();
  const text = `${JSON.stringify(rows[0])}\n{ "secret": "DO_NOT_LEAK",`;
  assert.throws(() => parsePublicJsonl(text), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /line 2/i);
    assert.doesNotMatch(error.message, /DO_NOT_LEAK|secret/);
    return true;
  });
});

test("requires exactly 300 uniquely identified public and GT rows", () => {
  assertRejects(() => parsePublicJsonl(jsonl(publicRows().slice(0, 299))), /300/);
  assertRejects(() => parsePublicJsonl(jsonl([...publicRows(), publicRow("extra")])), /300/);
  const duplicatePublic = publicRows();
  duplicatePublic[299] = publicRow("task_1");
  assertRejects(() => parsePublicJsonl(jsonl(duplicatePublic)), /duplicate|unique/i);

  assertRejects(() => parseGroundTruthJsonl(jsonl(gtRows().slice(0, 299))), /300/);
  assertRejects(() => parseGroundTruthJsonl(jsonl([...gtRows(), gtRow("extra")])), /300/);
  const duplicateGt = gtRows();
  duplicateGt[299] = gtRow("task_1");
  assertRejects(() => parseGroundTruthJsonl(jsonl(duplicateGt)), /duplicate|unique/i);
});

test("rejects every required public field with an invalid shape", () => {
  for (const [field, value] of [
    ["instance_id", ""],
    ["selected_database", 1],
    ["category", ""],
    ["amb_user_query", null],
    ["follow_up", []],
  ] as const) {
    const rows = publicRows();
    rows[0] = { ...rows[0], [field]: value };
    assertRejects(() => parsePublicJsonl(jsonl(rows)), /invalid/i);
  }
});

test("rejects every required GT and nested follow-up field with an invalid shape", () => {
  const invalidRootFields: ReadonlyArray<readonly [string, unknown]> = [
    ["instance_id", ""],
    ["sol_sql", []],
    ["sol_sql", "SELECT 1"],
    ["sol_sql", [""]],
    ["sol_sql", ["SELECT 1", ""]],
    ["external_knowledge", "not a list"],
    ["test_cases", {}],
    ["follow_up", null],
  ];
  for (const [field, value] of invalidRootFields) {
    const rows = gtRows();
    rows[0] = { ...rows[0], [field]: value };
    assertRejects(() => parseGroundTruthJsonl(jsonl(rows)), /invalid/i);
  }

  for (const value of ["", [], [""], 9]) {
    const rows = gtRows();
    rows[0] = { ...rows[0], follow_up: { ...(rows[0]?.follow_up as JsonRecord), sol_sql: value } };
    assertRejects(() => parseGroundTruthJsonl(jsonl(rows)), /invalid/i);
  }
  for (const [field, value] of [["external_knowledge", {}], ["test_cases", "not a list"]] as const) {
    const rows = gtRows();
    rows[0] = { ...rows[0], follow_up: { ...(rows[0]?.follow_up as JsonRecord), [field]: value } };
    assertRejects(() => parseGroundTruthJsonl(jsonl(rows)), /invalid/i);
  }
});

test("merges only authoritative GT fields without mutating inputs", () => {
  const parsedPublic = parsePublicJsonl(jsonl(publicRows()));
  const parsedGt = parseGroundTruthJsonl(jsonl(gtRows()));
  const publicBefore = clone(parsedPublic);
  const gtBefore = clone(parsedGt);
  const publicSerializedBefore = serializeJsonl(parsedPublic);
  const gtSerializedBefore = serializeJsonl(parsedGt);
  const combined = mergePublicWithGroundTruth(parsedPublic, parsedGt);
  const row = combined[0];

  assert.deepEqual(parsedPublic, publicBefore);
  assert.deepEqual(parsedGt, gtBefore);
  assert.deepEqual(publicBefore[0]?.sol_sql, ["SELECT public root decoy"]);
  assert.equal(publicBefore[0]?.follow_up.sol_sql, "SELECT public follow-up decoy");
  assert.equal(row?.query, "public query alien_1");
  assert.equal(row?.sentinel_row, "public-alien_1");
  assert.equal(row?.follow_up.query, "follow up query alien_1");
  assert.equal(row?.follow_up.sentinel_follow_up, "public-alien_1");
  assert.equal("sentinel_gt_row" in (row ?? {}), false);
  assert.equal("sentinel_gt_follow_up" in (row?.follow_up ?? {}), false);
  assert.deepEqual(row?.sol_sql, ["SELECT main"]);
  assert.deepEqual(row?.external_knowledge, ["official knowledge"]);
  assert.deepEqual(row?.test_cases, [{ input: 1 }]);
  assert.deepEqual(row?.follow_up.sol_sql, ["SELECT follow 1", "SELECT follow 2"]);
  assert.deepEqual(row?.follow_up.external_knowledge, ["follow official knowledge"]);
  assert.deepEqual(row?.follow_up.test_cases, [{ input: 2 }]);
  assert.equal(serializeJsonl(parsedPublic), publicSerializedBefore);
  assert.equal(serializeJsonl(parsedGt), gtSerializedBefore);
});

test("rejects a public and GT ID set mismatch before merge", () => {
  const parsedPublic = parsePublicJsonl(jsonl(publicRows()));
  const changedGt = gtRows();
  changedGt[299] = gtRow("not_the_same_id");
  assertRejects(
    () => mergePublicWithGroundTruth(parsedPublic, parseGroundTruthJsonl(jsonl(changedGt))),
    /identical|match/i,
  );
});

test("selects the fixed alien smoke tasks in their official order", () => {
  const combined = mergePublicWithGroundTruth(
    parsePublicJsonl(jsonl(publicRows())),
    parseGroundTruthJsonl(jsonl(gtRows())),
  );
  assert.deepEqual(
    selectAlienSmoke([...combined].reverse()).map((row) => row.instance_id),
    [...SMOKE_TASK_IDS],
  );
});

test("rejects every invalid alien smoke selection without exposing row content", () => {
  const combined = mergePublicWithGroundTruth(
    parsePublicJsonl(jsonl(publicRows())),
    parseGroundTruthJsonl(jsonl(gtRows())),
  );
  const cases = [
    combined.filter((row) => row.instance_id !== "alien_2"),
    [...combined, clone(combined[0]!)],
    combined.map((row) => row.instance_id === "alien_1" ? { ...row, selected_database: "wrong", secret: "DO_NOT_LEAK" } : row),
    combined.map((row) => row.instance_id === "alien_1" ? { ...row, category: "wrong", secret: "DO_NOT_LEAK" } : row),
  ];
  for (const rows of cases) {
    assert.throws(() => selectAlienSmoke(rows), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /DO_NOT_LEAK/);
      return true;
    });
  }
});

test("serializes compact deterministic JSONL with a final newline and hashes exact bytes", () => {
  const rows = [{ z: 1, a: { b: true } }, { item: "two" }];
  const expected = '{"z":1,"a":{"b":true}}\n{"item":"two"}\n';
  assert.equal(serializeJsonl(rows), expected);
  assert.equal(serializeJsonl(rows), serializeJsonl(rows));
  assert.equal(sha256(expected), "6be998e926c54c13177cb9bdc9a3b93678c31d382dc0cc8f3e67cfcd6c9e7090");
  assert.equal(sha256(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
