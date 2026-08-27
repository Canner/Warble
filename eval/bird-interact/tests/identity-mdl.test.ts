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
    ["inet", "VARCHAR"],
    ["boolean", "BOOLEAN"],
    ["smallint", "SMALLINT"],
    ["integer", "INTEGER"],
    ["bigint", "BIGINT"],
    ["numeric", "DECIMAL"],
    ["real", "REAL"],
    ["double precision", "DOUBLE"],
    ["date", "DATE"],
    ["time without time zone", "TIME"],
    ["timestamp without time zone", "TIMESTAMP"],
    ["timestamp with time zone", "TIMESTAMP"],
    ["jsonb", "JSON"],
    ["json", "JSON"],
    ["uuid", "UUID"],
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
  for (const data_type of ["money", "ARRAY", "tsvector", "toString", "constructor", "__proto__"]) {
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

test("resolves user-defined enum columns and refuses every other user-defined type", () => {
  // information_schema reports enums, composites, domains and extension types all as the one
  // string "USER-DEFINED", so pg_type.typtype is what separates the case with an honest answer.
  const enumColumn = {
    table_name: "cabinenvironment",
    column_name: "emergencybeaconstatus",
    ordinal_position: 1,
    data_type: "USER-DEFINED",
    type_category: "e",
  };
  assert.deepEqual(
    buildIdentityMdl([enumColumn]).models[0]?.columns,
    [{ name: "emergencybeaconstatus", type: "VARCHAR" }],
  );
  // The category survives the introspection parser, which is where it actually arrives from.
  assert.deepEqual(parseIntrospectionJson(JSON.stringify([enumColumn])), [enumColumn]);

  // A composite, domain, range or missing category has no single honest mapping and is refused.
  const { type_category: _enum, ...uncategorized } = enumColumn;
  for (const type_category of ["c", "d", "r", "m", "p", "b", undefined]) {
    assert.throws(
      () => buildIdentityMdl([
        type_category === undefined ? uncategorized : { ...uncategorized, type_category },
      ]),
      (error: unknown) => error instanceof Error &&
        error.message.includes("cabinenvironment") &&
        error.message.includes("emergencybeaconstatus"),
    );
  }

  // A category never rescues a data_type that is not USER-DEFINED.
  assert.throws(
    () => buildIdentityMdl([{ ...uncategorized, data_type: "money", type_category: "e" }]),
    /Unsupported PostgreSQL type "money"/,
  );
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
    "'data_type', columns.data_type,",
    "'type_category', types.typtype",
    ")",
    "ORDER BY columns.table_name, columns.ordinal_position, columns.column_name",
    "),",
    "'[]'::json",
    ")::text",
    "FROM information_schema.columns AS columns",
    "JOIN information_schema.tables AS tables",
    "ON tables.table_schema = columns.table_schema",
    "AND tables.table_name = columns.table_name",
    "LEFT JOIN pg_namespace AS udt_schema",
    "ON udt_schema.nspname = columns.udt_schema",
    "LEFT JOIN pg_type AS types",
    "ON types.typname = columns.udt_name",
    "AND types.typnamespace = udt_schema.oid",
    "WHERE columns.table_schema = 'public'",
    "AND tables.table_schema = 'public'",
    "AND tables.table_type = 'BASE TABLE';",
  ].join(" "));
  assert.equal(INFORMATION_SCHEMA_INTROSPECTION_SQL.includes("${"), false);
});
