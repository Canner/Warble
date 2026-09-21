import { CodexDispatchError } from "./error.js";
import { parseIrInput, type WarbleIr } from "./ir.js";
import { prepareOrchestrateNode, type OrchestrateMcpServerConfig, type OrchestrateTierModels, type PreparedOrchestrateComponent } from "./orchestrate_prepare.js";
import { validateStepToolBindings } from "./tool_bindings.js";
import { validateDashboardRenderEnvelope } from "./render_contract.js";
import { verifyContextPreconditions } from "./context_preconditions.js";

export const INVOCATION_DEFAULTS = Object.freeze({
  maxDepth: 8, maxAttempts: 32, maxSteps: 40, maxStepsPerChild: 12,
  maxRequestBytes: 65_536, maxResultBytes: 1_048_576, timeoutMs: 120_000,
});
export type ResolvedInvocationLimits = { -readonly [K in keyof typeof INVOCATION_DEFAULTS]: number };
export type InvocationLimits = Partial<ResolvedInvocationLimits> & {
  /** Unsupported: app-server turns contain an unbounded number of model iterations. */
  maxModelTurns?: number; maxTurns?: number; maxCostUsd?: number;
};
export interface ComponentBinding {
  transport: "orchestrate";
  models: OrchestrateTierModels;
  mcp: OrchestrateMcpServerConfig;
  /** Host-provided context for this component only. Never inherited from the caller. */
  context: string;
}
export interface InvocationNode {
  prepared: PreparedOrchestrateComponent;
  context: string;
  brief: string;
  aliases: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
export interface PreparedInvocation {
  target: "codex:local";
  profile: string;
  root: string;
  nodes: Readonly<Record<string, InvocationNode>>;
  limits: ResolvedInvocationLimits;
}
const preparedPlans = new WeakSet<object>();
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(message: string): never { throw new CodexDispatchError(`unsupported_callee: ${message}`); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function emptyFacet(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}
export function assertPreparedInvocation(plan: PreparedInvocation): void {
  if (!preparedPlans.has(plan)) fail("execution requires an immutable prepared invocation plan");
}
export function prepareComponentInvocation(input: {
  ir: string | WarbleIr; component: string;
  bindings: Record<string, ComponentBinding>; limits?: InvocationLimits;
  /** Host-selected Warble CLI with check-context support. Used only for context preconditions. */
  warbleBin?: string;
}): PreparedInvocation {
  if (!isRecord(input.bindings) || (input.limits !== undefined && !isRecord(input.limits))) fail("invalid bindings or limits object");
  const raw: unknown = typeof input.ir === "string" ? JSON.parse(input.ir) : structuredClone(input.ir);
  const ir = parseIrInput(input.ir);
  if (!isRecord(raw) || !Array.isArray(raw.components)) fail("invalid IR");
  const limits: ResolvedInvocationLimits = { ...INVOCATION_DEFAULTS };
  for (const [key, value] of Object.entries(input.limits ?? {})) {
    if (!Object.hasOwn(limits, key)) fail("hard model-turn/dollar caps and unknown limits are unsupported");
    const k = key as keyof typeof limits;
    if (!Number.isSafeInteger(value) || value < 1 || value > INVOCATION_DEFAULTS[k]) fail(`invalid ${key}`);
    limits[k] = value;
  }
  const byId = new Map(ir.components.map((node) => [node.id, node]));
  if (byId.size !== ir.components.length) fail("duplicate mounted component identity");
  const rawById = new Map(raw.components.filter(isRecord).map((node) => [node.id, node]));
  const root = byId.get(input.component);
  if (!root?.entrypoint) fail("selected component is missing or not entry eligible");
  if (!emptyFacet(raw.slots) || !emptyFacet(raw.assets)) fail("profile slots/assets are not supported");
  const nodes: Record<string, InvocationNode> = Object.create(null);
  const active = new Set<string>();
  const contextChecks: Array<{id: string; context: string; preconditions: unknown[]}> = [];
  const visit = (id: string): void => {
    if (active.has(id)) fail("cyclic component-call graph");
    if (Object.hasOwn(nodes, id)) return;
    const node = byId.get(id), original = rawById.get(id);
    if (!node || !original) fail("missing mounted callee");
    active.add(id);
    const binding = Object.hasOwn(input.bindings, id) ? structuredClone(input.bindings[id]) : undefined;
    if (!binding || binding.transport !== "orchestrate" || !isRecord(binding.mcp) || !isRecord(binding.models) ||
        typeof binding.context !== "string" || !binding.context.trim()) fail("each reachable component needs explicit orchestrate/model/MCP/context bindings");
    if (!emptyFacet(original.assets) || !emptyFacet(original.slots) || !emptyFacet(original.borrowed_actions)) fail("reachable assets/slots/actions are unsupported");
    if (typeof original.brief !== "undefined" && original.brief !== null && typeof original.brief !== "string") fail("invalid compiled brief");
    if (original.context_precondition !== undefined) {
      if (!Array.isArray(original.context_precondition)) fail("malformed context preconditions");
      if (original.context_precondition.length) {
        contextChecks.push({id, context: binding.context, preconditions: original.context_precondition});
      }
    }
    if (!node.guardrails.some((guard) => guard.name === "read_only_execution" && guard.locked)) fail("read-only enforcement is required");
    const forbidden = new Set(["data_write", "context_write", "setup_execution", "source_connect", "context_build", "human_approval", "scheduler", "event_bus", "version_control"]);
    if (id !== input.component) forbidden.add("artifact_write");
    if (node.required_capabilities.some((cap) => forbidden.has(cap)) || node.guardrails.some((guard) => forbidden.has(guard.name))) fail("reachable write/action authority is unsupported");
    const stepNames = node.llm_calls.map((step) => step.name);
    if (new Set(stepNames).size !== stepNames.length || stepNames.some((name) => !/^[a-z_][a-z0-9_]*$/.test(name))) fail("invalid or duplicate step identity");
    validateStepToolBindings(binding.mcp, stepNames);
    // The invocation surface must not collide with any MCP namespace or native tool name.
    const aliases: Record<string, Record<string, string>> = Object.create(null);
    for (const step of node.llm_calls) {
      const edges: Record<string, string> = Object.create(null);
      for (const edge of step.component_calls) {
        if (!/^[a-z_][a-z0-9_]*$/.test(edge.alias) || Object.hasOwn(edges, edge.alias) || !edge.component) fail("invalid or duplicate component-call alias");
        edges[edge.alias] = edge.component;
      }
      const effective = step.capabilities ?? node.required_capabilities;
      if (step.capabilities && binding.mcp.toolsByStep[step.name]?.length && node.required_capabilities.some((capability) => !effective.includes(capability))) fail("narrowed step MCP authority cannot be attested by this binding format");
      if (effective.some((capability) => !node.required_capabilities.includes(capability))) fail("step capabilities must narrow component requirements");
      if (step.component_calls.length && !effective.includes("component_invocation")) fail("effective step component_invocation requirement is missing");
      aliases[step.name] = edges;
    }
    const prepared = prepareOrchestrateNode({ ir, component: id, models: binding.models, mcp: binding.mcp }, ir, node, true);
    if (node.effect.render_blocks.length && prepared.executionKind !== "render_envelope") fail("render blocks require enforced render capability");
    // Do not erase unsupported fields through the legacy narrow parser.
    for (const guard of original.guardrails as unknown[]) {
      if (!isRecord(guard) || (Object.hasOwn(guard, "scope") && typeof guard.scope !== "string") ||
          (Object.hasOwn(guard, "threshold") && !Number.isFinite(guard.threshold))) fail("malformed guardrail parameters");
    }
    for (const edges of Object.values(aliases)) for (const callee of Object.values(edges)) visit(callee);
    nodes[id] = { prepared, context: binding.context, brief: typeof original.brief === "string" ? original.brief : "", aliases };
    active.delete(id);
  };
  visit(input.component);
  // Resolve every structural/authority boundary first. The only preflight subprocess is the
  // deterministic context evaluator; no model or MCP process starts before every check passes.
  for (const check of contextChecks) {
    nodes[check.id]!.context = verifyContextPreconditions(check.context, check.preconditions, input.warbleBin ?? "warble");
  }
  const plan = freeze({ target: "codex:local" as const, profile: ir.profile, root: input.component, nodes, limits });
  preparedPlans.add(plan);
  return plan;
}

export interface InvocationRequest { request: string; input: Record<string, unknown> }
export type InvocationErrorCode = "invalid_request" | "invalid_result" | "budget_exhausted" | "cancelled" | "transient_transport" | "callee_failed";
export type InvocationResult =
  | { status: "ok"; output: { kind: "value"; value: unknown } | { kind: "render"; blocks: Record<string, unknown>[]; summary?: string }; provenance?: Record<string, unknown> }
  | { status: "refused"; code: "callee_refused"; message: string }
  | { status: "error"; code: InvocationErrorCode; message: string; retryable: boolean };
export function invocationError(code: InvocationErrorCode): InvocationResult {
  return { status: "error", code, message: `Component invocation ${code.replaceAll("_", " ")}.`, retryable: code === "transient_transport" };
}
export function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
export function normalizeInvocationRequest(value: unknown, limit: number): InvocationRequest | null {
  try {
    if (!isRecord(value) || Object.keys(value).some((key) => key !== "request" && key !== "input") ||
        typeof value.request !== "string" || !value.request.trim() || (value.input !== undefined && !isRecord(value.input))) return null;
    const normalized = { request: value.request, input: value.input ?? {} };
    return jsonBytes(normalized) <= limit ? structuredClone(normalized) : null;
  } catch { return null; }
}
export function normalizeInvocationResult(value: unknown, node: InvocationNode, limit: number): InvocationResult {
  try {
    let result: InvocationResult;
    if (isRecord(value) && value.status === "refused") {
      result = { status: "refused", code: "callee_refused", message: "The child declined the request." };
    } else if (isRecord(value) && (value.status === "error" || value.ok === false)) {
      result = invocationError("callee_failed");
    } else {
      const provenance: Record<string, unknown> = {};
      if (isRecord(value)) {
        if (typeof value.verified === "boolean") provenance.verified = value.verified;
        if (Object.hasOwn(value, "definition")) provenance.definition = value.definition;
      }
      const output: Extract<InvocationResult, {status: "ok"}>["output"] = node.prepared.node.effect.render_blocks.length
        ? (() => {
            const render = validateDashboardRenderEnvelope(value, node.prepared.node, true);
            return { kind: "render" as const, blocks: render.blocks, ...(render.summary === undefined ? {} : {summary: render.summary}) };
          })()
        : { kind: "value", value };
      result = { status: "ok", output, ...(Object.keys(provenance).length ? {provenance} : {}) };
    }
    return jsonBytes(result) <= limit ? result : invocationError("invalid_result");
  } catch { return invocationError("invalid_result"); }
}

export function buildInvocationManifest(plan: PreparedInvocation) {
  assertPreparedInvocation(plan);
  return {
    version: "0.3", target: plan.target, profile: plan.profile, transport: "orchestrate",
    entry: plan.root, component_invocation: {outcome: "realize-via", via: "host-scoped-dynamic-alias"},
    limits: plan.limits, modelTurnHardLimit: false, monetaryHardLimit: false,
    components: Object.entries(plan.nodes).map(([id, node]) => ({
      id, role: id === plan.root ? "entry" : "callee", capabilities: node.prepared.capabilities,
      steps: node.prepared.steps.map((step) => ({name: step.name, model: step.model, enabledTools: step.enabledTools, componentCalls: node.aliases[step.name]})),
    })),
  };
}
