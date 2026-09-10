import { randomUUID } from "node:crypto";

import {
  classifyConditionalStep,
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  runRepairLoop,
  type StepIdentity,
  type StepOutcome,
} from "./conditional.js";
import type { PreparedComponent, PreparedDispatch } from "./dispatch.js";
import { DispatchError } from "./error.js";
import type { LlmCall, RenderBlock } from "./ir.js";
import type { StagedStep } from "./route.js";

export const DEFAULT_COMPONENT_INVOCATION_LIMITS = Object.freeze({
  maxDepth: 8,
  maxAttempts: 32,
  maxRequestBytes: 65_536,
  maxResultBytes: 1_048_576,
  maxTurns: 40,
  maxTurnsPerChild: 12,
});

export interface ComponentInvocationLimits {
  maxDepth?: number;
  maxAttempts?: number;
  maxRequestBytes?: number;
  maxResultBytes?: number;
  maxTurns?: number;
  maxTurnsPerChild?: number;
  /** Rejected by the Agent SDK composition preflight until provider spend is reservable. */
  maxCostUsd?: number;
  deadlineAt?: number;
}

export interface ComponentInvocationRequest {
  request: string;
  input?: Record<string, unknown>;
}

export interface ComponentProvenance {
  verified?: boolean;
  definition?: unknown;
}

export type ComponentInvocationResult =
  | {
      status: "ok";
      output:
        | { kind: "value"; value: unknown }
        | { kind: "render"; blocks: Record<string, unknown>[]; summary?: string };
      provenance?: ComponentProvenance;
    }
  | { status: "refused"; code: "callee_refused"; message: string }
  | {
      status: "error";
      code:
        | "unsupported_callee"
        | "invalid_request"
        | "invalid_result"
        | "budget_exhausted"
        | "cancelled"
        | "transient_transport"
        | "callee_failed";
      message: string;
      retryable: boolean;
    };

export type ComponentCallStatus =
  | "ok"
  | "refused"
  | "error"
  | "cancelled"
  | "late_discarded";

export interface ComponentCallTrace {
  call_id: string;
  parent_call_id: string | null;
  caller_mount: string;
  trusted_step_id: string;
  alias: string;
  callee_mount: string;
  attempt: number;
  depth: number;
  admitted_at: number;
  completed_at: number;
  status: ComponentCallStatus;
  request_bytes: number;
  result_bytes: number;
  model_turns: number;
  total_cost_usd: number;
  token_usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
  degradation: string | null;
}

export interface ComponentStepUsage {
  model: string;
  usage: unknown;
}

export interface ComponentStepResult {
  text: string;
  turns: number;
  totalCostUsd: number;
  usage?: ComponentStepUsage[];
  degradation?: string | null;
}

/** A step failed after the provider exposed billable telemetry. The runtime must charge it. */
export class ComponentStepExecutionError extends DispatchError {
  constructor(
    message: string,
    readonly telemetry: ComponentStepResult,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ComponentStepExecutionError";
  }
}

export interface ComponentStepRun {
  rootRunId: string;
  callId: string | null;
  parentCallId: string | null;
  component: PreparedComponent;
  step: StagedStep;
  request: Required<ComponentInvocationRequest>;
  artifacts: Readonly<Record<string, string>>;
  aliases: readonly string[];
  signal: AbortSignal;
  maxTurns: number;
  invoke(alias: string, request: unknown): Promise<ComponentInvocationResult>;
}

export type ComponentStepRunner = (run: ComponentStepRun) => Promise<ComponentStepResult>;

export interface ComponentRuntimeOptions {
  prepared: PreparedDispatch;
  runStep: ComponentStepRunner;
  limits?: ComponentInvocationLimits;
  signal?: AbortSignal;
  now?: () => number;
  newId?: () => string;
}

export interface ComponentRootResult {
  finalText: string;
  turns: number;
  totalCostUsd: number;
  usage: ComponentStepUsage[];
  componentCalls: ComponentCallTrace[];
}

interface ResolvedLimits {
  maxDepth: number;
  maxAttempts: number;
  maxRequestBytes: number;
  maxResultBytes: number;
  maxTurns: number;
  maxTurnsPerChild: number;
  deadlineAt?: number;
}

interface AttemptReservation {
  remainingTurns: number;
  reservedTurns: number;
}

interface InvocationFrame {
  component: PreparedComponent;
  callId: string | null;
  parentCallId: string | null;
  ancestry: readonly string[];
  depth: number;
  reservation: AttemptReservation | null;
  queue: Promise<void>;
}

interface ComponentExecution {
  text: string;
  turns: number;
  totalCostUsd: number;
  usage: ComponentStepUsage[];
  degradation: string | null;
}

const FORBIDDEN_CALLEE_CAPABILITIES = new Set([
  "artifact_write",
  "data_write",
  "context_write",
  "setup_execution",
  "human_approval",
  "scheduler",
  "event_bus",
  "notify_channel",
  "write_authz",
  "version_control",
  "source_connect",
  "context_build",
  "blast_radius",
]);

const FORBIDDEN_CALLEE_GUARDRAILS = new Set([
  "artifact_write",
  "data_write",
  "context_write",
  "context_write_authz",
  "setup_execution",
  "human_approval",
]);

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > fallback) {
    throw new DispatchError(`${name} must be an integer between 1 and ${fallback}`);
  }
  return resolved;
}

function resolveLimits(input: ComponentInvocationLimits | undefined): ResolvedLimits {
  assertSupportedComponentInvocationLimits(input);
  const limits: ResolvedLimits = {
    maxDepth: positiveInteger(input?.maxDepth, DEFAULT_COMPONENT_INVOCATION_LIMITS.maxDepth, "maxDepth"),
    maxAttempts: positiveInteger(input?.maxAttempts, DEFAULT_COMPONENT_INVOCATION_LIMITS.maxAttempts, "maxAttempts"),
    maxRequestBytes: positiveInteger(input?.maxRequestBytes, DEFAULT_COMPONENT_INVOCATION_LIMITS.maxRequestBytes, "maxRequestBytes"),
    maxResultBytes: positiveInteger(input?.maxResultBytes, DEFAULT_COMPONENT_INVOCATION_LIMITS.maxResultBytes, "maxResultBytes"),
    maxTurns: positiveInteger(input?.maxTurns, DEFAULT_COMPONENT_INVOCATION_LIMITS.maxTurns, "maxTurns"),
    maxTurnsPerChild: positiveInteger(input?.maxTurnsPerChild, DEFAULT_COMPONENT_INVOCATION_LIMITS.maxTurnsPerChild, "maxTurnsPerChild"),
  };
  if (input?.deadlineAt !== undefined) {
    if (!Number.isFinite(input.deadlineAt)) throw new DispatchError("deadlineAt must be a finite epoch timestamp");
    limits.deadlineAt = input.deadlineAt;
  }
  return limits;
}

/** The SDK's post-spend threshold cannot satisfy composition's hard pre-admission dollar cap. */
export function assertSupportedComponentInvocationLimits(
  input: ComponentInvocationLimits | undefined,
): void {
  if (input?.maxCostUsd !== undefined) {
    throw new DispatchError(
      "unsupported_component_budget: maxCostUsd cannot be enforced before Agent SDK provider spend; " +
        "component composition requires a reservable hard dollar cap",
    );
  }
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundedMessage(message: string): string {
  const collapsed = message.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const withoutPaths = collapsed.replace(/(?:^|\s)\/(?:[^\s/]+\/)*[^\s]*/g, " [redacted path]");
  const safe = /\b(select|insert|update|delete|merge|alter|drop|create)\b/i.test(withoutPaths)
    ? "The callee did not complete the request."
    : withoutPaths;
  return (safe || "The child run did not complete.").slice(0, 240);
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid = value.every((entry) => isJsonValue(entry, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    valid = (prototype === Object.prototype || prototype === null) &&
      Object.values(value as Record<string, unknown>).every((entry) => isJsonValue(entry, seen));
  }
  seen.delete(value);
  return valid;
}

function errorResult(
  code: Exclude<Extract<ComponentInvocationResult, { status: "error" }>["code"], never>,
  message: string,
  retryable = false,
): ComponentInvocationResult {
  return { status: "error", code, message: boundedMessage(message), retryable };
}

export function normalizeComponentRequest(
  value: unknown,
  maxBytes: number = DEFAULT_COMPONENT_INVOCATION_LIMITS.maxRequestBytes,
): { value: Required<ComponentInvocationRequest>; bytes: number } | { error: ComponentInvocationResult } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: errorResult("invalid_request", "The component request must be a JSON object.") };
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.some((key) => key !== "request" && key !== "input")) {
    return { error: errorResult("invalid_request", "The component request contains an unsupported field.") };
  }
  if (typeof obj["request"] !== "string" || obj["request"].trim() === "") {
    return { error: errorResult("invalid_request", "The component request must contain a non-empty request string.") };
  }
  if (obj["input"] !== undefined && (typeof obj["input"] !== "object" || obj["input"] === null || Array.isArray(obj["input"]))) {
    return { error: errorResult("invalid_request", "The component request input must be a JSON object.") };
  }
  if (!isJsonValue(obj["input"] ?? {})) {
    return { error: errorResult("invalid_request", "The component request input must contain only JSON values.") };
  }
  const normalized = {
    request: obj["request"],
    input: JSON.parse(JSON.stringify(obj["input"] ?? {})) as Record<string, unknown>,
  };
  let bytes: number;
  try {
    bytes = byteLength(normalized);
  } catch {
    return { error: errorResult("invalid_request", "The component request must be JSON serializable.") };
  }
  if (bytes > maxBytes) {
    return { error: errorResult("invalid_request", "The component request exceeds the configured byte limit.") };
  }
  return { value: normalized, bytes };
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced ? fenced[1]! : trimmed);
}

function matchesFieldType(value: unknown, type: string): boolean {
  const nullable = type.endsWith("?");
  if (value === null || value === undefined) return nullable;
  const normalized = nullable ? type.slice(0, -1) : type;
  if (normalized.includes("|")) {
    const variants = normalized.split("|");
    const primitives = new Set(["string", "number", "boolean", "row"]);
    return variants.every((variant) => primitives.has(variant))
      ? variants.some((variant) => matchesFieldType(value, variant))
      : typeof value === "string" && variants.includes(value);
  }
  if (normalized.endsWith("[]")) {
    if (!Array.isArray(value)) return false;
    const element = normalized.slice(0, -2);
    return value.every((entry) => matchesFieldType(entry, element));
  }
  switch (normalized) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "row":
      return Array.isArray(value) && value.every((entry) =>
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        (typeof entry === "number" && Number.isFinite(entry))
      );
    default: return typeof value === "string" && value === normalized;
  }
}

function validateRenderBlocks(value: unknown, contract: readonly RenderBlock[]): {
  blocks: Record<string, unknown>[];
  summary?: string;
  provenance?: ComponentProvenance;
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (!Array.isArray(envelope["blocks"])) return null;
  const contracts = new Map(contract.map((block) => [block.type, block]));
  const blocks: Record<string, unknown>[] = [];
  for (const raw of envelope["blocks"]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const block = raw as Record<string, unknown>;
    if (typeof block["type"] !== "string") return null;
    const expected = contracts.get(block["type"]);
    if (!expected) return null;
    for (const [field, type] of Object.entries(expected.fields)) {
      if (!matchesFieldType(block[field], type)) return null;
    }
    blocks.push(block);
  }
  if (envelope["summary"] !== undefined && typeof envelope["summary"] !== "string") return null;
  const provenance: ComponentProvenance = {};
  if (typeof envelope["verified"] === "boolean") provenance.verified = envelope["verified"];
  if (envelope["definition"] !== undefined) provenance.definition = envelope["definition"];
  return {
    blocks,
    ...(typeof envelope["summary"] === "string" ? { summary: envelope["summary"] } : {}),
    ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
  };
}

export function normalizeComponentResult(
  finalText: string,
  renderContract: readonly RenderBlock[],
  maxBytes: number = DEFAULT_COMPONENT_INVOCATION_LIMITS.maxResultBytes,
): { value: ComponentInvocationResult; bytes: number } {
  let parsed: unknown;
  try {
    parsed = parseJsonText(finalText);
  } catch {
    const value = errorResult("invalid_result", "The child returned a non-JSON result.");
    return { value, bytes: byteLength(value) };
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (obj["status"] === "refused") {
      const value: ComponentInvocationResult = {
        status: "refused",
        code: "callee_refused",
        // Child-authored prose may contain provider errors, paths, SQL, or secrets.
        message: "The callee refused the request.",
      };
      return { value, bytes: byteLength(value) };
    }
  }

  let value: ComponentInvocationResult;
  if (renderContract.length > 0) {
    const render = validateRenderBlocks(parsed, renderContract);
    value = render
      ? {
          status: "ok",
          output: { kind: "render", blocks: render.blocks, ...(render.summary ? { summary: render.summary } : {}) },
          ...(render.provenance ? { provenance: render.provenance } : {}),
        }
      : errorResult("invalid_result", "The child result does not satisfy its render contract.");
  } else {
    const provenance: ComponentProvenance = {};
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj["verified"] === "boolean") provenance.verified = obj["verified"];
      if (obj["definition"] !== undefined) provenance.definition = obj["definition"];
    }
    value = {
      status: "ok",
      output: { kind: "value", value: parsed },
      ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
    };
  }
  const bytes = byteLength(value);
  if (bytes > maxBytes) {
    const oversized = errorResult("invalid_result", "The normalized child result exceeds the configured byte limit.");
    return { value: oversized, bytes };
  }
  return { value, bytes };
}

export function assertEligibleComponentCallee(component: PreparedComponent): void {
  const node = component.node;
  const reason =
    node.trigger.kind !== "one_shot" ? `trigger '${node.trigger.kind}'` :
    node.realization_kind !== "skill" ? `realization '${node.realization_kind}'` :
    node.effect.outcome.kind !== "none" ? `outcome '${node.effect.outcome.kind}'` :
    !node.guardrails.some((guardrail) => guardrail.name === "read_only_execution" && guardrail.locked)
      ? "missing locked read_only_execution guardrail" :
    node.required_capabilities.some((capability) => FORBIDDEN_CALLEE_CAPABILITIES.has(capability))
      ? `capability '${node.required_capabilities.find((capability) => FORBIDDEN_CALLEE_CAPABILITIES.has(capability))!}'` :
    node.guardrails.some((guardrail) => FORBIDDEN_CALLEE_GUARDRAILS.has(guardrail.name))
      ? `guardrail '${node.guardrails.find((guardrail) => FORBIDDEN_CALLEE_GUARDRAILS.has(guardrail.name))!.name}'` :
    node.borrowed_actions.length > 0 ? "borrowed action transport" : null;
  const providerReason = component.steps.find((step) => step.provider !== "anthropic");
  if (reason !== null || providerReason) {
    throw new DispatchError(
      `unsupported_callee: component '${node.id}' is not eligible for isolated invocation (` +
        `${reason ?? `provider '${providerReason!.provider}' cannot propagate the Agent SDK cancellation/tool boundary`})`,
    );
  }
}

/** A root caller may own the final render path, but its model step stays read-only and SDK-bound. */
export function assertEligibleComponentCaller(component: PreparedComponent): void {
  const readOnly = component.node.guardrails.some(
    (guardrail) => guardrail.name === "read_only_execution" && guardrail.locked,
  );
  const callingStepNames = new Set(
    component.node.llm_calls.filter((step) => step.component_calls.length > 0).map((step) => step.name),
  );
  const unsupportedProvider = component.steps.find((step) => step.provider !== "anthropic");
  const tools = Array.isArray(component.plan.options.tools) ? component.plan.options.tools : [];
  const unsafeCommandSurface = callingStepNames.size > 0 && tools.includes("Bash");
  const unsupportedPromptRender =
    component.plan.meta.render.kind === "realize" && component.plan.meta.render.flavor === "prompt";
  if (!readOnly || unsupportedProvider || unsafeCommandSurface || unsupportedPromptRender) {
    const reason = !readOnly
      ? "missing locked read_only_execution guardrail"
      : unsupportedProvider
        ? `provider '${unsupportedProvider.provider}' on executable step '${unsupportedProvider.name}'`
        : unsafeCommandSurface
          ? "a calling step has an effective Bash command surface that can execute SQL directly"
          : "prompt-render roots require model-owned artifact writes";
    throw new DispatchError(
      `unsupported_callee: component '${component.id}' cannot expose a trusted step-scoped invocation surface (` +
        `${reason})`,
    );
  }
}

function stepOf(component: PreparedComponent, call: LlmCall): StagedStep {
  const staged = component.steps.find((candidate) => candidate.name === call.name);
  if (!staged) throw new DispatchError(`prepared component '${component.id}' has no resolved step '${call.name}'`);
  return staged;
}

function artifactKey(step: StagedStep): string {
  return step.produces ?? step.name;
}

function aggregateTokenUsage(entries: readonly ComponentStepUsage[]): ComponentCallTrace["token_usage"] {
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let observed = false;
  for (const entry of entries) {
    if (typeof entry.usage !== "object" || entry.usage === null) continue;
    const usage = entry.usage as Record<string, unknown>;
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        totals[key] += value;
        observed = true;
      }
    }
  }
  return observed ? totals : null;
}

export class ComponentInvocationRuntime {
  readonly rootRunId: string;
  readonly componentCalls: ComponentCallTrace[] = [];
  private readonly limits: ResolvedLimits;
  private readonly abortController = new AbortController();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly byId = new Map<string, PreparedComponent>();
  private readonly edgeByStep = new Map<string, ReadonlyMap<string, PreparedComponent>>();
  private readonly descendantDepth = new Map<string, number>();
  private attempts = 0;
  private availableTurns: number;
  private totalTurnsObserved = 0;
  private totalCostUsd = 0;
  private readonly allUsage: ComponentStepUsage[] = [];
  private cancelledAt: number | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ComponentRuntimeOptions) {
    this.limits = resolveLimits(options.limits);
    this.availableTurns = this.limits.maxTurns;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.rootRunId = this.newId();
    for (const component of [...options.prepared.components, ...options.prepared.preparedCallees]) {
      this.byId.set(component.id, component);
    }
    for (const dependency of options.prepared.dependencies) {
      const key = `${dependency.caller}\u0000${dependency.step}`;
      const aliases = new Map(this.edgeByStep.get(key) ?? []);
      const callee = this.byId.get(dependency.component);
      if (!callee) throw new DispatchError(`prepared callee '${dependency.component}' is absent from the immutable registry`);
      aliases.set(dependency.alias, callee);
      this.edgeByStep.set(key, aliases);
    }
    if (options.signal) {
      if (options.signal.aborted) this.cancel();
      else options.signal.addEventListener("abort", () => this.cancel(), { once: true });
    }
    if (this.limits.deadlineAt !== undefined) {
      const delay = Math.max(0, this.limits.deadlineAt - this.now());
      this.deadlineTimer = setTimeout(() => this.cancel(), delay);
    }
  }

  get signal(): AbortSignal { return this.abortController.signal; }

  cancel(): void {
    if (this.cancelledAt !== null) return;
    this.cancelledAt = this.now();
    this.abortController.abort();
  }

  async runRoot(componentId: string, request: ComponentInvocationRequest): Promise<ComponentRootResult> {
    const component = this.options.prepared.components.find((candidate) => candidate.id === componentId);
    if (!component) throw new DispatchError(`component '${componentId}' is not a prepared root entry`);
    const normalized = normalizeComponentRequest(request, this.limits.maxRequestBytes);
    if ("error" in normalized) throw new DispatchError(normalized.error.status === "error" ? normalized.error.message : "invalid request");
    const frame: InvocationFrame = {
      component,
      callId: null,
      parentCallId: null,
      ancestry: [component.id],
      depth: 0,
      reservation: null,
      queue: Promise.resolve(),
    };
    try {
      const result = await this.executeComponent(frame, normalized.value);
      this.throwIfCancelled();
      return {
        finalText: result.text,
        turns: this.totalTurnsObserved,
        totalCostUsd: this.totalCostUsd,
        usage: [...this.allUsage],
        componentCalls: [...this.componentCalls],
      };
    } finally {
      if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    }
  }

  private throwIfCancelled(): void {
    if (this.cancelledAt !== null) throw new DispatchError("cancelled: the root component run was cancelled");
    if (this.limits.deadlineAt !== undefined && this.now() >= this.limits.deadlineAt) {
      this.cancel();
      throw new DispatchError("cancelled: the root component run deadline elapsed");
    }
  }

  private aliasesFor(frame: InvocationFrame, step: LlmCall): ReadonlyMap<string, PreparedComponent> {
    if (!frame.component.node.llm_calls.some((candidate) => candidate === step)) {
      throw new DispatchError("unauthorized_call: forged active-step identity");
    }
    return this.edgeByStep.get(`${frame.component.id}\u0000${step.name}`) ?? new Map();
  }

  private availableFor(frame: InvocationFrame): number {
    return frame.reservation?.remainingTurns ?? this.availableTurns;
  }

  private charge(frame: InvocationFrame, result: ComponentStepResult): void {
    if (!Number.isInteger(result.turns) || result.turns < 0) throw new DispatchError("callee_failed: invalid child turn telemetry");
    if (!Number.isFinite(result.totalCostUsd) || result.totalCostUsd < 0) throw new DispatchError("callee_failed: invalid child cost telemetry");
    this.totalTurnsObserved += result.turns;
    this.totalCostUsd += result.totalCostUsd;
    this.allUsage.push(...(result.usage ?? []));
    if (result.turns > this.availableFor(frame)) {
      if (frame.reservation) frame.reservation.remainingTurns = 0;
      else this.availableTurns = 0;
      throw new DispatchError("budget_exhausted: model turn budget was exceeded");
    }
    if (frame.reservation) frame.reservation.remainingTurns -= result.turns;
    else this.availableTurns -= result.turns;
  }

  private maxDescendantDepth(componentId: string, visiting = new Set<string>()): number {
    const cached = this.descendantDepth.get(componentId);
    if (cached !== undefined) return cached;
    if (visiting.has(componentId)) return this.limits.maxDepth;
    visiting.add(componentId);
    let depth = 0;
    for (const dependency of this.options.prepared.dependencies) {
      if (dependency.caller !== componentId) continue;
      depth = Math.max(depth, 1 + this.maxDescendantDepth(dependency.component, visiting));
    }
    visiting.delete(componentId);
    this.descendantDepth.set(componentId, depth);
    return depth;
  }

  private descendantDepthForStep(frame: InvocationFrame, step: LlmCall): number {
    let depth = 0;
    for (const callee of this.aliasesFor(frame, step).values()) {
      depth = Math.max(depth, 1 + this.maxDescendantDepth(callee.id));
    }
    return depth;
  }

  /** Reserve an active root SDK query before its synchronous child handlers may be admitted. */
  private reserveRootStep(frame: InvocationFrame, step: LlmCall): AttemptReservation {
    const available = this.availableTurns;
    if (available < 1) throw new DispatchError("budget_exhausted: no model turns remain");
    const desiredDescendantTurns =
      this.descendantDepthForStep(frame, step) * this.limits.maxTurnsPerChild;
    const heldForDescendants = Math.min(desiredDescendantTurns, Math.max(0, available - 1));
    const reservedTurns = available - heldForDescendants;
    this.availableTurns -= reservedTurns;
    return { reservedTurns, remainingTurns: reservedTurns };
  }

  private async executeComponent(frame: InvocationFrame, request: Required<ComponentInvocationRequest>): Promise<ComponentExecution> {
    this.throwIfCancelled();
    const artifacts: Record<string, string> = {};
    const outcomes: Record<string, StepOutcome> = {};
    const usage: ComponentStepUsage[] = [];
    let finalText = "";
    let turns = 0;
    let totalCostUsd = 0;
    let degradation: string | null = null;
    const failureTargets = new Set(
      frame.component.node.llm_calls
        .filter((step) => step.conditional && step.when?.guard === "on_failure")
        .map((step) => step.when!.target),
    );

    const execute = async (call: LlmCall, tolerant: boolean): Promise<{ outcome: StepOutcome; text: string }> => {
      const step = stepOf(frame.component, call);
      const aliases = this.aliasesFor(frame, call);
      const rootStepReservation = frame.reservation === null
        ? this.reserveRootStep(frame, call)
        : null;
      const accountingFrame = rootStepReservation === null
        ? frame
        : { ...frame, reservation: rootStepReservation };
      try {
        this.throwIfCancelled();
        const maxTurns = this.availableFor(accountingFrame);
        if (maxTurns < 1) throw new DispatchError("budget_exhausted: no model turns remain");
        const result = await this.options.runStep({
          rootRunId: this.rootRunId,
          callId: frame.callId,
          parentCallId: frame.parentCallId,
          component: frame.component,
          step,
          request,
          artifacts,
          aliases: [...aliases.keys()],
          signal: this.signal,
          maxTurns,
          invoke: (alias, childRequest) => this.enqueueInvocation(frame, call, alias, childRequest),
        });
        this.charge(accountingFrame, result);
        turns += result.turns;
        totalCostUsd += result.totalCostUsd;
        usage.push(...(result.usage ?? []));
        degradation ??= result.degradation ?? null;
        this.throwIfCancelled();
        return { outcome: "success", text: result.text };
      } catch (caught) {
        let error = caught;
        if (caught instanceof ComponentStepExecutionError) {
          try {
            this.charge(accountingFrame, caught.telemetry);
            turns += caught.telemetry.turns;
            totalCostUsd += caught.telemetry.totalCostUsd;
            usage.push(...(caught.telemetry.usage ?? []));
            degradation ??= caught.telemetry.degradation ?? null;
          } catch (chargeError) {
            error = chargeError;
          }
        }
        const terminal = error instanceof DispatchError &&
          /^(?:budget_exhausted|cancelled|unauthorized_call):/.test(error.message);
        if (!tolerant || terminal) throw error;
        return { outcome: "failure", text: boundedMessage(error instanceof Error ? error.message : String(error)) };
      } finally {
        if (rootStepReservation !== null) {
          this.availableTurns += rootStepReservation.remainingTurns;
        }
      }
    };

    const calls = frame.component.node.llm_calls;
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index]!;
      if (call.conditional) {
        if (!call.when) throw new DispatchError(`conditional step '${call.name}' has no 'when' guard`);
        const preceding = index > 0 ? calls[index - 1]! : null;
        const precedingIdentity: StepIdentity | null = preceding ? { name: preceding.name, produces: preceding.produces } : null;
        const decision = classifyConditionalStep(call.when, call.consumes, precedingIdentity, { artifacts, outcomes });
        if (decision.kind === "skip") continue;
        if (decision.kind === "repair") {
          const repair = await runRepairLoop(DEFAULT_MAX_REPAIR_ATTEMPTS, async () => {
            const result = await execute(call, true);
            outcomes[call.name] = result.outcome;
            artifacts[artifactKey(stepOf(frame.component, call))] = result.text;
            if (result.outcome === "success") finalText = result.text;
            return { failed: result.outcome === "failure" };
          });
          if (!repair.recovered) throw new DispatchError(`callee_failed: repair step '${call.name}' did not recover`);
          continue;
        }
      }
      const result = await execute(call, failureTargets.has(call.name));
      outcomes[call.name] = result.outcome;
      artifacts[artifactKey(stepOf(frame.component, call))] = result.text;
      if (result.outcome === "success") finalText = result.text;
    }
    return { text: finalText, turns, totalCostUsd, usage, degradation };
  }

  private enqueueInvocation(
    frame: InvocationFrame,
    step: LlmCall,
    alias: string,
    request: unknown,
  ): Promise<ComponentInvocationResult> {
    let release!: () => void;
    const predecessor = frame.queue;
    frame.queue = new Promise<void>((resolve) => { release = resolve; });
    return predecessor.then(() => this.invoke(frame, step, alias, request)).finally(release);
  }

  private async invoke(
    frame: InvocationFrame,
    step: LlmCall,
    alias: string,
    request: unknown,
  ): Promise<ComponentInvocationResult> {
    this.throwIfCancelled();
    const aliases = this.aliasesFor(frame, step);
    const callee = aliases.get(alias);
    if (!callee) {
      this.cancel();
      throw new DispatchError(
        `unauthorized_call: the requested alias is not authorized for trusted step '${frame.component.id}.${step.name}'`,
      );
    }
    const normalized = normalizeComponentRequest(request, this.limits.maxRequestBytes);
    if ("error" in normalized) return normalized.error;
    if (frame.depth + 1 > this.limits.maxDepth || this.attempts >= this.limits.maxAttempts) {
      return errorResult("budget_exhausted", "The root component-call budget is exhausted.");
    }
    if (frame.ancestry.includes(callee.id)) {
      this.cancel();
      throw new DispatchError(`unauthorized_call: recursive re-entry into component '${callee.id}' was rejected`);
    }
    const desiredDescendantTurns =
      this.maxDescendantDepth(callee.id) * this.limits.maxTurnsPerChild;
    const heldForDescendants = Math.min(
      desiredDescendantTurns,
      Math.max(0, this.availableTurns - 1),
    );
    const available = Math.min(
      this.availableTurns - heldForDescendants,
      this.limits.maxTurnsPerChild,
    );
    if (available < 1) return errorResult("budget_exhausted", "The root model-turn budget is exhausted.");

    this.attempts += 1;
    this.availableTurns -= available;
    const reservation: AttemptReservation = { reservedTurns: available, remainingTurns: available };
    const callId = this.newId();
    const admittedAt = this.now();
    const trace: ComponentCallTrace = {
      call_id: callId,
      parent_call_id: frame.callId,
      caller_mount: frame.component.id,
      trusted_step_id: step.name,
      alias,
      callee_mount: callee.id,
      attempt: this.attempts,
      depth: frame.depth + 1,
      admitted_at: admittedAt,
      completed_at: admittedAt,
      status: "error",
      request_bytes: normalized.bytes,
      result_bytes: 0,
      model_turns: 0,
      total_cost_usd: 0,
      token_usage: null,
      degradation: null,
    };
    this.componentCalls.push(trace);
    const turnsBefore = this.totalTurnsObserved;
    const costBefore = this.totalCostUsd;
    const usageBefore = this.allUsage.length;

    try {
      const child = await this.executeComponent({
        component: callee,
        callId,
        parentCallId: frame.callId,
        ancestry: [...frame.ancestry, callee.id],
        depth: frame.depth + 1,
        reservation,
        queue: Promise.resolve(),
      }, normalized.value);
      trace.model_turns = this.totalTurnsObserved - turnsBefore;
      trace.total_cost_usd = this.totalCostUsd - costBefore;
      trace.token_usage = aggregateTokenUsage(this.allUsage.slice(usageBefore));
      trace.degradation = child.degradation ? boundedMessage(child.degradation) : null;
      const result = normalizeComponentResult(child.text, callee.node.effect.render_blocks, this.limits.maxResultBytes);
      trace.result_bytes = result.bytes;
      trace.completed_at = this.now();
      if (this.cancelledAt !== null && trace.completed_at >= this.cancelledAt) {
        trace.status = "late_discarded";
        return errorResult("cancelled", "The component call was cancelled.");
      }
      trace.status = result.value.status === "ok" ? "ok" : result.value.status;
      return result.value;
    } catch (error) {
      trace.completed_at = this.now();
      trace.model_turns = this.totalTurnsObserved - turnsBefore;
      trace.total_cost_usd = this.totalCostUsd - costBefore;
      trace.token_usage = aggregateTokenUsage(this.allUsage.slice(usageBefore));
      if (error instanceof ComponentStepExecutionError && error.telemetry.degradation) {
        trace.degradation = boundedMessage(error.telemetry.degradation);
      }
      if (this.cancelledAt !== null && trace.completed_at >= this.cancelledAt) {
        trace.status = "late_discarded";
        return errorResult("cancelled", "The component call was cancelled.");
      }
      trace.status = "error";
      if (error instanceof DispatchError && error.message.startsWith("budget_exhausted:")) {
        return errorResult("budget_exhausted", "The root model-turn budget is exhausted.");
      }
      if (error instanceof ComponentStepExecutionError && error.retryable) {
        return errorResult("transient_transport", "The child transport did not complete.", true);
      }
      if (error instanceof DispatchError) {
        return errorResult("callee_failed", "The child run did not complete.");
      }
      return errorResult("transient_transport", "The child transport did not complete.", true);
    } finally {
      this.availableTurns += reservation.remainingTurns;
    }
  }
}
