import { CodexDispatchError } from "./error.js";
import type { ComponentNode } from "./ir.js";

interface JsonRecord {
  [key: string]: unknown;
}

export interface DashboardRenderEnvelope {
  blocks: JsonRecord[];
  summary?: string;
  verified: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePrimitive(value: unknown, type: string, context: string): void {
  if (type.endsWith("?")) {
    if (value === undefined || value === null) return;
    validatePrimitive(value, type.slice(0, -1), context);
    return;
  }
  if (type.endsWith("[]")) {
    if (!Array.isArray(value)) throw new CodexDispatchError(`${context} must be an array`);
    const itemType = type.slice(0, -2);
    for (const [index, item] of value.entries()) {
      validatePrimitive(item, itemType, `${context}[${index}]`);
    }
    return;
  }
  if (type.includes("|")) {
    const alternatives = type.split("|");
    if (alternatives.includes("string") && typeof value === "string") return;
    if (alternatives.includes("number") && typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value === "string" && alternatives.includes(value)) return;
    throw new CodexDispatchError(`${context} does not match '${type}'`);
  }
  if (type === "string" && typeof value === "string") return;
  if (type === "number" && typeof value === "number" && Number.isFinite(value)) return;
  if (type === "boolean" && typeof value === "boolean") return;
  if (type === "row" && isRecord(value)) return;
  throw new CodexDispatchError(`${context} does not match '${type}'`);
}

export function validateDashboardRenderEnvelope(
  value: unknown,
  node: ComponentNode,
): DashboardRenderEnvelope {
  if (!isRecord(value)) throw new CodexDispatchError("dashboard output must be a JSON object");
  const keys = Object.keys(value);
  if (
    keys.some((key) => !new Set(["blocks", "summary", "verified"]).has(key)) ||
    !Array.isArray(value["blocks"]) ||
    value["blocks"].length === 0 ||
    typeof value["verified"] !== "boolean" ||
    (value["summary"] !== undefined && typeof value["summary"] !== "string")
  ) {
    throw new CodexDispatchError(
      "dashboard output requires only non-empty blocks, optional summary, and boolean verified",
    );
  }

  const contracts = new Map<string, Record<string, string>>();
  for (const entry of node.effect.render_blocks) {
    if (!isRecord(entry) || typeof entry["type"] !== "string" || !isRecord(entry["fields"])) {
      throw new CodexDispatchError("dashboard IR contains a malformed render block contract");
    }
    const fields = entry["fields"];
    if (!Object.values(fields).every((field) => typeof field === "string")) {
      throw new CodexDispatchError("dashboard IR contains a malformed render field contract");
    }
    contracts.set(entry["type"], fields as Record<string, string>);
  }

  let hasDataPanel = false;
  let hasDefinition = false;
  const blocks = value["blocks"].map((entry, index): JsonRecord => {
    if (!isRecord(entry) || typeof entry["type"] !== "string") {
      throw new CodexDispatchError(`dashboard block[${index}] requires a string type`);
    }
    const fields = contracts.get(entry["type"]);
    if (!fields) {
      throw new CodexDispatchError(`dashboard block[${index}] uses undeclared type '${entry["type"]}'`);
    }
    const allowed = new Set(["type", ...Object.keys(fields)]);
    if (Object.keys(entry).some((key) => !allowed.has(key))) {
      throw new CodexDispatchError(`dashboard block[${index}] contains undeclared fields`);
    }
    for (const [field, type] of Object.entries(fields)) {
      validatePrimitive(entry[field], type, `dashboard block[${index}].${field}`);
    }
    if (["kpi_card", "table", "chart"].includes(entry["type"])) hasDataPanel = true;
    if (entry["type"] === "definition") hasDefinition = true;
    return entry;
  });
  if (!hasDataPanel || !hasDefinition) {
    throw new CodexDispatchError(
      "dashboard output requires at least one data panel and one definition block",
    );
  }
  return {
    blocks,
    ...(typeof value["summary"] === "string" ? { summary: value["summary"] } : {}),
    verified: value["verified"],
  };
}
