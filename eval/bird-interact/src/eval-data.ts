import { createHash } from "node:crypto";

import { z } from "zod";

const TASK_COUNT = 300;
const smokeIds = ["alien_1", "alien_2", "alien_3", "alien_4", "alien_5"] as const;
const nonemptyString = z.string().min(1);
const list = z.array(z.unknown());

const publicFollowUpSchema = z.object({}).passthrough();
const publicTaskSchema = z
  .object({
    instance_id: nonemptyString,
    selected_database: nonemptyString,
    category: nonemptyString,
    amb_user_query: nonemptyString,
    follow_up: publicFollowUpSchema,
  })
  .passthrough();

const followUpSqlSchema = z.union([
  nonemptyString,
  z.array(nonemptyString).min(1),
]);
const groundTruthFollowUpSchema = z
  .object({
    sol_sql: followUpSqlSchema,
    external_knowledge: list,
    test_cases: list,
  })
  .passthrough();
const groundTruthTaskSchema = z
  .object({
    instance_id: nonemptyString,
    sol_sql: z.array(nonemptyString).min(1),
    external_knowledge: list,
    test_cases: list,
    follow_up: groundTruthFollowUpSchema,
  })
  .passthrough();

const combinedFollowUpSchema = z
  .object({
    sol_sql: followUpSqlSchema,
    external_knowledge: list,
    test_cases: list,
  })
  .passthrough();
const combinedTaskSchema = z
  .object({
    instance_id: nonemptyString,
    selected_database: nonemptyString,
    category: nonemptyString,
    amb_user_query: nonemptyString,
    sol_sql: z.array(nonemptyString).min(1),
    external_knowledge: list,
    test_cases: list,
    follow_up: combinedFollowUpSchema,
  })
  .passthrough();

export type PublicTask = z.infer<typeof publicTaskSchema>;
export type GroundTruthTask = z.infer<typeof groundTruthTaskSchema>;
export type CombinedTask = z.infer<typeof combinedTaskSchema>;

export class EvalDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalDataError";
  }
}

function parseJsonl<T>(
  text: string,
  schema: z.ZodType<T>,
  label: "public" | "ground-truth",
): T[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();

  return lines.map((line, index) => {
    const lineNumber = index + 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new EvalDataError(`Invalid ${label} JSONL at line ${lineNumber}`);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new EvalDataError(`Invalid ${label} row at line ${lineNumber}`);
    }
    return parsed.data;
  });
}

function assertTaskSet<T extends { instance_id: string }>(
  rows: readonly T[],
  schema: z.ZodType<T>,
  label: "public" | "ground-truth" | "combined",
): void {
  if (rows.length !== TASK_COUNT) {
    throw new EvalDataError(`${label} data must contain exactly ${TASK_COUNT} rows`);
  }

  const ids = new Set<string>();
  for (const row of rows) {
    if (!schema.safeParse(row).success) {
      throw new EvalDataError(`Invalid ${label} row`);
    }
    if (ids.has(row.instance_id)) {
      throw new EvalDataError(`${label} data must have unique instance IDs`);
    }
    ids.add(row.instance_id);
  }
}

function parseTasks<T extends { instance_id: string }>(
  text: string,
  schema: z.ZodType<T>,
  label: "public" | "ground-truth",
): T[] {
  const rows = parseJsonl(text, schema, label);
  assertTaskSet(rows, schema, label);
  return rows;
}

export function parsePublicJsonl(text: string): PublicTask[] {
  return parseTasks(text, publicTaskSchema, "public");
}

export function parseGroundTruthJsonl(text: string): GroundTruthTask[] {
  return parseTasks(text, groundTruthTaskSchema, "ground-truth");
}

export function mergePublicWithGroundTruth(
  publicRows: readonly PublicTask[],
  gtRows: readonly GroundTruthTask[],
): CombinedTask[] {
  assertTaskSet(publicRows, publicTaskSchema, "public");
  assertTaskSet(gtRows, groundTruthTaskSchema, "ground-truth");

  const gtById = new Map(gtRows.map((row) => [row.instance_id, row]));
  if (gtById.size !== publicRows.length || publicRows.some((row) => !gtById.has(row.instance_id))) {
    throw new EvalDataError("Public and ground-truth instance ID sets must be identical");
  }

  const combined = publicRows.map((publicRow) => {
    const gtRow = gtById.get(publicRow.instance_id);
    if (gtRow === undefined) {
      throw new EvalDataError("Public and ground-truth instance ID sets must be identical");
    }
    return {
      ...publicRow,
      sol_sql: gtRow.sol_sql,
      external_knowledge: gtRow.external_knowledge,
      test_cases: gtRow.test_cases,
      follow_up: {
        ...publicRow.follow_up,
        sol_sql: gtRow.follow_up.sol_sql,
        external_knowledge: gtRow.follow_up.external_knowledge,
        test_cases: gtRow.follow_up.test_cases,
      },
    };
  });

  assertTaskSet(combined, combinedTaskSchema, "combined");
  return combined;
}

export function selectAlienSmoke(combinedRows: readonly CombinedTask[]): CombinedTask[] {
  return smokeIds.map((id) => {
    const matches = combinedRows.filter((row) => row.instance_id === id);
    if (matches.length !== 1) {
      throw new EvalDataError("Invalid alien smoke task selection");
    }
    const row = matches[0];
    if (row?.selected_database !== "alien" || row.category !== "Query") {
      throw new EvalDataError("Invalid alien smoke task selection");
    }
    return row;
  });
}

export function serializeJsonl(rows: readonly object[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}${rows.length > 0 ? "\n" : ""}`;
}

export function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}
