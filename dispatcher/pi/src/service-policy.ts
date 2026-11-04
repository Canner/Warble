import { evaluate, validatePolicies } from "./cedar.js";
import { DEFAULT_LIMITS } from "./runner.js";

export const SERVICE_PROTOCOL = "warble-private-service/1";
export const SERVICE_SCHEMA = `namespace Service {
  entity Agent = { project: String, caller: String, role: String, zone: String };
  entity Resource = { project: String, kind: String, name: String, columns: Set<String>, recipient: String };
  type Context = { session: String, epoch: Long };
  action "invoke_component", "invoke_tool", "execute_query", "receive_metadata", "receive_answer"
    appliesTo { principal: Agent, resource: Resource, context: Context };
}`;
export interface ServiceRequest {
  caller: string; project: string; role: "planner" | "worker"; session: string; epoch: number;
  action: "invoke_component" | "invoke_tool" | "execute_query" | "receive_metadata" | "receive_answer";
  kind: string; name: string; columns: string[]; recipient: string;
}
const actions = ["invoke_component", "invoke_tool", "execute_query", "receive_metadata", "receive_answer"];
/** Trusted host API; never exposed as an MCP/model tool. Policies are intersected. */
export class ServicePolicy {
  constructor(private readonly policies: readonly string[]) {
    if (policies.length < 2 || policies.some(p => !validatePolicies(p, SERVICE_SCHEMA))) throw Error("invalid_policy");
  }
  authorize(r: ServiceRequest): boolean {
    if (!r || !actions.includes(r.action) || !["planner", "worker"].includes(r.role)
      || !Number.isSafeInteger(r.epoch) || r.epoch < 1 || !Array.isArray(r.columns)
      || !r.columns.every(c => typeof c === "string")
      || [r.caller, r.project, r.session, r.kind, r.name].some(s => typeof s !== "string" || !s || s.length > 256)) return false;
    if (r.action === "receive_answer" && r.recipient !== r.caller) return false;
    const principal = { type: "Service::Agent", id: r.caller + ":" + r.role };
    const resource = { type: "Service::Resource", id: r.kind + ":" + r.name };
    const request = { principal, resource, action: { type: "Service::Action", id: r.action },
      entities: [
        { uid: principal, attrs: { project: r.project, caller: r.caller, role: r.role,
          zone: r.role === "worker" ? "private" : "public" }, parents: [] },
        { uid: resource, attrs: { project: r.project, kind: r.kind, name: r.name,
          columns: r.columns, recipient: r.recipient }, parents: [] },
      ], context: { session: r.session, epoch: r.epoch } };
    return this.policies.every(p => evaluate(p, request, SERVICE_SCHEMA) === "allow");
  }
}

/** Host-supplied `init.limits`. Every field is optional; an absent field keeps today's constant. */
export interface ExecutionLimits {
  deadlineMs?: number; maxTokens?: number; enableThinking?: boolean; maxTurns?: number;
  maxToolCalls?: number; providerMaxRetries?: number; providerMaxRetryDelayMs?: number;
}
const LIMIT_RANGES = { deadlineMs: [5000, 600000], maxTokens: [256, 65536], maxTurns: [1, 64], maxToolCalls: [1, 256],
  providerMaxRetries: [0, 8], providerMaxRetryDelayMs: [100, 60000] } as const;
/** Bounded diagnostic: a known field name, `unsupported_limit:<field>` or `unknown_limit`; never echoes host text. */
export function parseLimits(raw: unknown): ExecutionLimits | { error: string } {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "limits" };
  const known = [...Object.keys(LIMIT_RANGES), "enableThinking", "reasoningBudgetTokens"];
  const keys = Object.keys(raw);
  if (keys.includes("reasoningBudgetTokens")) return { error: "unsupported_limit:reasoningBudgetTokens" };
  if (keys.some(k => !known.includes(k))) return { error: "unknown_limit" };
  const value = raw as Record<string, unknown>, limits: ExecutionLimits = {};
  if ("enableThinking" in value) {
    if (typeof value.enableThinking !== "boolean") return { error: "enableThinking" };
    limits.enableThinking = value.enableThinking;
  }
  for (const [field, [min, max]] of Object.entries(LIMIT_RANGES)) {
    if (!(field in value)) continue;
    const v = value[field];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) return { error: field };
    (limits as Record<string, number>)[field] = v;
  }
  return limits;
}
/** Resolve the child timeout and runner backstop. Absent `deadlineMs` keeps the legacy 60 s leaf / 90 s root. */
export function planExecution(limits: ExecutionLimits, root: boolean) {
  const d = limits.deadlineMs;
  return {
    runnerTimeoutMs: d === undefined ? (root ? 90000 : 60000) : d + 5000,
    childDeadlineMs: d,
    maxTurns: limits.maxTurns ?? DEFAULT_LIMITS.maxTurns,
    maxToolCalls: limits.maxToolCalls ?? DEFAULT_LIMITS.maxToolCalls,
    providerMaxRetries: limits.providerMaxRetries ?? 0,
  };
}
export const invocationAbortMs = (limits: ExecutionLimits) => limits.deadlineMs === undefined ? 90000 : limits.deadlineMs + 30000;
