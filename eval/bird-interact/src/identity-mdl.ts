import { z } from "zod";

/** A fixed query suitable for `psql -t -A`; it returns exactly one JSON array. */
export const INFORMATION_SCHEMA_INTROSPECTION_SQL = `
SELECT COALESCE(
  json_agg(
    json_build_object(
      'table_name', columns.table_name,
      'column_name', columns.column_name,
      'ordinal_position', columns.ordinal_position,
      'data_type', columns.data_type,
      'type_category', types.typtype
    )
    ORDER BY columns.table_name, columns.ordinal_position, columns.column_name
  ),
  '[]'::json
)::text
FROM information_schema.columns AS columns
JOIN information_schema.tables AS tables
  ON tables.table_schema = columns.table_schema
  AND tables.table_name = columns.table_name
LEFT JOIN pg_namespace AS udt_schema
  ON udt_schema.nspname = columns.udt_schema
LEFT JOIN pg_type AS types
  ON types.typname = columns.udt_name
  AND types.typnamespace = udt_schema.oid
WHERE columns.table_schema = 'public'
  AND tables.table_schema = 'public'
  AND tables.table_type = 'BASE TABLE';
`.trim();

export const IntrospectionColumnSchema = z.object({
  table_name: z.string().min(1),
  column_name: z.string().min(1),
  ordinal_position: z.number().int().positive(),
  data_type: z.string().min(1),
  /**
   * `pg_type.typtype` for the column's underlying type: `b` base, `e` enum, `c` composite, `d`
   * domain, `r`/`m` range, `p` pseudo. Optional because it decides nothing on its own — every
   * `data_type` except `USER-DEFINED` is mapped by name, and a `USER-DEFINED` column without a
   * category is refused exactly like an unrecognised one.
   */
  type_category: z.string().min(1).nullish(),
}).strict();

export type IntrospectionColumn = z.infer<typeof IntrospectionColumnSchema>;

export interface IdentityMdlColumn {
  name: string;
  type: WrenColumnType;
}

export interface IdentityMdl {
  catalog: "wren";
  schema: "public";
  models: Array<{
    name: string;
    tableReference: { schema: "public"; table: string };
    columns: IdentityMdlColumn[];
  }>;
  relationships: [];
  views: [];
}

export type WrenColumnType =
  | "VARCHAR"
  | "BOOLEAN"
  | "SMALLINT"
  | "INTEGER"
  | "BIGINT"
  | "DECIMAL"
  | "REAL"
  | "DOUBLE"
  | "DATE"
  | "TIME"
  | "TIMESTAMP"
  | "JSON"
  | "UUID";

/**
 * Every `information_schema.columns.data_type` the pinned BIRD-Interact databases actually use.
 *
 * The map is an allowlist rather than a fallback: a type nobody has looked at is refused during
 * preparation, where it is one line of output, instead of reaching the agent as a silently wrong
 * column description. `inet` maps to VARCHAR because PostgreSQL hands a client its text form, which
 * is what an agent writing SQL against it sees.
 */
const POSTGRES_TO_WREN: ReadonlyMap<string, WrenColumnType> = new Map([
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
]);

/**
 * `information_schema` reports every enum, composite, domain and extension type as the single
 * `data_type` "USER-DEFINED", so the type itself has to be classified by `pg_type.typtype`.
 *
 * Only enums are resolved, and only to VARCHAR: PostgreSQL transmits an enum value as its label,
 * so a client — and the agent writing SQL for it — sees a string. This is also why declaring it
 * VARCHAR does not disturb enum ordering: the identity MDL emits no cast, so `ORDER BY` still runs
 * against the physical enum column and keeps its declaration order. Composites, domains and ranges
 * have no such single honest answer and stay refused.
 */
const USER_DEFINED_DATA_TYPE = "USER-DEFINED";
const ENUM_TYPE_CATEGORY = "e";

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateColumnSet(records: readonly IntrospectionColumn[]): void {
  if (records.length === 0) {
    throw new Error("PostgreSQL public schema contains no base-table columns");
  }

  const names = new Set<string>();
  const ordinals = new Set<string>();
  for (const record of records) {
    const nameKey = `${record.table_name}\u0000${record.column_name}`;
    const ordinalKey = `${record.table_name}\u0000${record.ordinal_position}`;
    if (names.has(nameKey)) {
      throw new Error("PostgreSQL introspection contains duplicate table and column records");
    }
    if (ordinals.has(ordinalKey)) {
      throw new Error("PostgreSQL introspection contains duplicate column ordinals");
    }
    names.add(nameKey);
    ordinals.add(ordinalKey);
  }
}

/** Parses the single JSON value emitted by the fixed introspection query. */
export function parseIntrospectionJson(stdout: string): IntrospectionColumn[] {
  if (!stdout.trim()) {
    throw new Error("PostgreSQL introspection returned no JSON");
  }

  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("PostgreSQL introspection returned malformed JSON");
  }

  const parsed = z.array(IntrospectionColumnSchema).safeParse(value);
  if (!parsed.success) {
    throw new Error("PostgreSQL introspection JSON must be an array of column records");
  }
  validateColumnSet(parsed.data);
  return parsed.data;
}

function mappedType(record: IntrospectionColumn): WrenColumnType {
  if (record.data_type === USER_DEFINED_DATA_TYPE) {
    if (record.type_category === ENUM_TYPE_CATEGORY) return "VARCHAR";
    throw new Error(
      `Unsupported user-defined PostgreSQL type (category ${record.type_category ?? "unknown"}) for table "${record.table_name}", column "${record.column_name}"`,
    );
  }
  const type = POSTGRES_TO_WREN.get(record.data_type);
  if (!type) {
    throw new Error(
      `Unsupported PostgreSQL type "${record.data_type}" for table "${record.table_name}", column "${record.column_name}"`,
    );
  }
  return type;
}

function sortedColumns(records: readonly IntrospectionColumn[]): IntrospectionColumn[] {
  validateColumnSet(records);
  return [...records].sort((left, right) =>
    compareNames(left.table_name, right.table_name) ||
    left.ordinal_position - right.ordinal_position ||
    compareNames(left.column_name, right.column_name),
  );
}

/** Builds the minimal Wren MDL using only physical PostgreSQL identifiers and types. */
export function buildIdentityMdl(records: readonly IntrospectionColumn[]): IdentityMdl {
  const models: IdentityMdl["models"] = [];
  for (const record of sortedColumns(records)) {
    let model = models.at(-1);
    if (!model || model.name !== record.table_name) {
      model = {
        name: record.table_name,
        tableReference: { schema: "public", table: record.table_name },
        columns: [],
      };
      models.push(model);
    }
    model.columns.push({ name: record.column_name, type: mappedType(record) });
  }

  return {
    catalog: "wren",
    schema: "public",
    models,
    relationships: [],
    views: [],
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Returns a harmless representative query for the first physical table. */
export function representativeIdentityQuery(
  source: IdentityMdl | readonly IntrospectionColumn[],
): string {
  const table = "models" in source
    ? source.models.slice().sort((left, right) => compareNames(left.name, right.name))[0]?.name
    : sortedColumns(source)[0]?.table_name;
  if (!table) throw new Error("Identity MDL contains no physical tables");
  return `SELECT * FROM ${quoteIdentifier(table)} LIMIT 1`;
}
