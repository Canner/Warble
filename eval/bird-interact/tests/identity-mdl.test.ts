import assert from "node:assert/strict";
import test from "node:test";

import {
  INFORMATION_SCHEMA_INTROSPECTION_SQL,
  buildIdentityMdl,
  parseIntrospectionJson,
  representativeIdentityQuery,
} from "../src/identity-mdl.js";

const columns = [
  { table_name: "zebra", column_name: "second", ordinal_position: 2, data_type: "integer" },
  { table_name: "ant", column_name: "label", ordinal_position: 1, data_type: "character varying" },
  { table_name: "zebra", column_name: "first", ordinal_position: 1, data_type: "text" },
] as const;

test("builds a deterministic, physical-only MDL from shuffled columns", () => {
  const mdl = buildIdentityMdl([...columns]);

  assert.deepEqual(mdl, {
    catalog: "wren",
    schema: "public",
    models: [
      {
        name: "ant",
        tableReference: { schema: "public", table: "ant" },
        columns: [{ name: "label", type: "VARCHAR" }],
      },
      {
        name: "zebra",
        tableReference: { schema: "public", table: "zebra" },
        columns: [
          { name: "first", type: "VARCHAR" },
          { name: "second", type: "INTEGER" },
        ],
      },
    ],
    relationships: [],
    views: [],
  });
});

test("maps every supported PostgreSQL type", () => {
  const mappings = [
    ["character", "VARCHAR"],
    ["character varying", "VARCHAR"],
    ["text", "VARCHAR"],
    ["smallint", "SMALLINT"],
    ["integer", "INTEGER"],
    ["numeric", "DECIMAL"],
    ["double precision", "DOUBLE"],
    ["date", "DATE"],
    ["time without time zone", "TIME"],
    ["timestamp with time zone", "TIMESTAMP"],
  ] as const;

  const mdl = buildIdentityMdl(mappings.map(([data_type], index) => ({
    table_name: "types",
    column_name: `c${index}`,
    ordinal_position: index + 1,
    data_type,
  })));

  assert.deepEqual(mdl.models[0]?.columns.map((column) => column.type), mappings.map(([, type]) => type));
});

test("rejects unsupported PostgreSQL types without coercion", () => {
  for (const data_type of ["jsonb", "ARRAY", "USER-DEFINED", "toString", "constructor", "__proto__"]) {
    const unrelatedSentinel = "UNRELATED_SENTINEL_DO_NOT_LEAK";
    assert.throws(
      () => buildIdentityMdl([
        { table_name: "orders", column_name: "payload", ordinal_position: 1, data_type },
        { table_name: unrelatedSentinel, column_name: "id", ordinal_position: 1, data_type: "integer" },
      ]),
      (error: unknown) => error instanceof Error &&
        error.message.includes("orders") &&
        error.message.includes("payload") &&
        error.message.includes(data_type) &&
        !error.message.includes(unrelatedSentinel),
    );
  }
});

test("serialized MDL contains no semantic metadata", () => {
  const serialized = JSON.stringify(buildIdentityMdl([...columns])).toLowerCase();
  for (const forbidden of [
    "description", "sample", "knowledge", "external knowledge", "sql", "test case", "gt", "calculated", "semantic alias",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("parses one JSON array and rejects invalid database schemas", () => {
  assert.deepEqual(parseIntrospectionJson(JSON.stringify(columns)), [...columns]);
  for (const stdout of ["", "not json", "{}", "[]", JSON.stringify([{ ...columns[0], ordinal_position: 0 }]), JSON.stringify([columns[0], { ...columns[0], ordinal_position: 1 }]), JSON.stringify([columns[0], { ...columns[0], column_name: "other" }])]) {
    assert.throws(() => parseIntrospectionJson(stdout));
  }
});

test("preserves physical identifiers byte-for-byte and rejects padded types", () => {
  const padded = [{
    table_name: " orders ",
    column_name: " item ",
    ordinal_position: 1,
    data_type: " integer ",
  }];

  assert.deepEqual(parseIntrospectionJson(JSON.stringify(padded)), padded);
  assert.throws(
    () => buildIdentityMdl(parseIntrospectionJson(JSON.stringify(padded))),
    /Unsupported PostgreSQL type " integer " for table " orders ", column " item "/,
  );
});

test("quotes physical identifiers in the representative query", () => {
  assert.equal(
    representativeIdentityQuery([{ table_name: 'a"b', column_name: "id", ordinal_position: 1, data_type: "integer" }]),
    'SELECT * FROM "a""b" LIMIT 1',
  );
  assert.equal(representativeIdentityQuery(buildIdentityMdl([...columns])), 'SELECT * FROM "ant" LIMIT 1');
});

test("introspection SQL is fixed and returns public base-table column JSON", () => {
  const normalized = INFORMATION_SCHEMA_INTROSPECTION_SQL.replace(/\s+/g, " ").trim();
  assert.equal(normalized, [
    "SELECT COALESCE(",
    "json_agg(",
    "json_build_object(",
    "'table_name', columns.table_name,",
    "'column_name', columns.column_name,",
    "'ordinal_position', columns.ordinal_position,",
    "'data_type', columns.data_type",
    ")",
    "ORDER BY columns.table_name, columns.ordinal_position, columns.column_name",
    "),",
    "'[]'::json",
    ")::text",
    "FROM information_schema.columns AS columns",
    "JOIN information_schema.tables AS tables",
    "ON tables.table_schema = columns.table_schema",
    "AND tables.table_name = columns.table_name",
    "WHERE columns.table_schema = 'public'",
    "AND tables.table_schema = 'public'",
    "AND tables.table_type = 'BASE TABLE';",
  ].join(" "));
  assert.equal(INFORMATION_SCHEMA_INTROSPECTION_SQL.includes("${"), false);
});
