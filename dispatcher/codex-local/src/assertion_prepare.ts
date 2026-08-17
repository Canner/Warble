import { CodexDispatchError } from "./error.js";
import { assertDispatchableComponentIdentity } from "./dispatch_registry.js";
import {
  parseIr,
  SUPPORTED_IR_VERSION,
  TARGET,
  type ComponentNode,
  type WarbleIr,
} from "./ir.js";
import {
  ASSERTION_CAPABILITIES,
  type CapabilityResolution,
  guardrailMatches,
  hasExactCapabilities,
  resolveAssertionCapabilities,
} from "./target_profile.js";

export interface AssertionWhenGuard {
  guard: "on_flag";
  target: string;
}

export interface PreparedAssertionStep {
  name: string;
  tier: "cheap";
  model: string;
  prompt: string;
  consumes: [string];
  produces: string;
  when: AssertionWhenGuard;
}

export interface PreparedAssertionComponent {
  target: typeof TARGET;
  profile: string;
  node: ComponentNode;
  componentId: string;
  modelBinding: string;
  cadenceBinding: string;
  /** Effective compiler-resolved values from IR `binds`, never caller overrides. */
  pinnedModel: string;
  pinnedCadenceMs: number;
  step: PreparedAssertionStep;
  capabilities: CapabilityResolution[];
  verdictType: string;
  emittedSignals: string[];
}

export interface PrepareAssertionInput {
  ir: string | WarbleIr;
  component: string;
  /** Concrete cheap-model binding.  No persistent Codex home/session is involved. */
  model: string;
}

export function parseDurationMs(value: string, field = "duration"): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new CodexDispatchError(`${field} must be a positive duration such as '24h'`);
  const amount = Number(match[1]);
  const unit = match[2]!;
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
  const result = amount * multiplier;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new CodexDispatchError(`${field} must be a bounded positive duration`);
  }
  return result;
}

function hasStatusRenderBlock(node: ComponentNode): boolean {
  return (
    node.effect.render_blocks.length === 1 &&
    typeof node.effect.render_blocks[0] === "object" &&
    node.effect.render_blocks[0] !== null &&
    !Array.isArray(node.effect.render_blocks[0]) &&
    (node.effect.render_blocks[0] as Record<string, unknown>)["type"] === "status"
  );
}

function validateAssertionShape(node: ComponentNode): {
  modelBinding: string;
  cadenceBinding: string;
  pinnedModel: string;
  pinnedCadenceMs: number;
} {
  assertDispatchableComponentIdentity(node);
  if (
    node.type !== "assertive" ||
    node.realization_kind !== "tool" ||
    node.trigger.kind !== "scheduled" ||
    node.effect.outcome.kind !== "assertion"
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: requires assertive/tool/scheduled/assertion`,
    );
  }
  if (node.context_binding.binding_mode !== "pinned") {
    throw new CodexDispatchError(`component '${node.id}' wall-hit: requires a pinned context binding`);
  }
  if (
    typeof node.effect.outcome.verdict_type !== "string" ||
    node.effect.outcome.verdict_type.trim().length === 0 ||
    !Array.isArray(node.effect.outcome.emits) ||
    node.effect.outcome.emits.length === 0 ||
    node.effect.outcome.emits.some((signal) => signal.trim().length === 0) ||
    new Set(node.effect.outcome.emits).size !== node.effect.outcome.emits.length ||
    !hasStatusRenderBlock(node)
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: assertion requires verdict_type, unique emitted signals, and one status block`,
    );
  }
  if (!hasExactCapabilities(node.required_capabilities, ASSERTION_CAPABILITIES)) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: supports exactly scheduler, sql_execution:read_only, notify_channel, and llm:cheap capabilities`,
    );
  }
  if (
    node.guardrails.length !== 2 ||
    !guardrailMatches(node.guardrails[0], "read_only_execution", { requireScopeAbsent: true }) ||
    !guardrailMatches(node.guardrails[1], "alert_routing", { requireScopeAbsent: true })
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: requires locked read_only_execution and unlocked alert_routing guardrails`,
    );
  }
  if (
    node.precondition_result === null ||
    node.precondition_result.status !== "pass" ||
    node.precondition_result.checks.length === 0 ||
    node.precondition_result.checks.some((check) => check.outcome !== "pass")
  ) {
    throw new CodexDispatchError(`component '${node.id}' wall-hit: assertion preconditions must be resolved pass checks`);
  }
  const modelParams = node.params.filter((param) => param.bind === "required");
  const cadenceParams = node.params.filter(
    (param) => param.bind === "optional" && typeof param.default === "string",
  );
  if (modelParams.length !== 1 || cadenceParams.length !== 1) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: requires exactly one required model binding and one optional cadence binding`,
    );
  }
  // The parameter default is only the authored fallback.  `binds` is the compiler's effective
  // pinned profile map (for example genbi-monitor binds 48h over a 24h component default), and
  // therefore is the only value the runtime may execute.
  parseDurationMs(cadenceParams[0]!.default as string, `${node.id}.${cadenceParams[0]!.name}`);
  if (node.binds === null) {
    throw new CodexDispatchError(`component '${node.id}' wall-hit: pinned assertion requires effective binds`);
  }
  const modelBinding = modelParams[0]!.name;
  const cadenceBinding = cadenceParams[0]!.name;
  const bindNames = Object.keys(node.binds);
  if (
    bindNames.length !== 2 ||
    !Object.prototype.hasOwnProperty.call(node.binds, modelBinding) ||
    !Object.prototype.hasOwnProperty.call(node.binds, cadenceBinding) ||
    typeof node.binds[modelBinding] !== "string" ||
    node.binds[modelBinding].trim().length === 0 ||
    typeof node.binds[cadenceBinding] !== "string"
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: effective binds must contain exactly the pinned model and cadence strings`,
    );
  }
  const pinnedCadenceMs = parseDurationMs(
    node.binds[cadenceBinding] as string,
    `${node.id}.binds.${cadenceBinding}`,
  );
  if (node.llm_calls.length !== 1) {
    throw new CodexDispatchError(`component '${node.id}' wall-hit: assertion supports exactly one conditional cheap step`);
  }
  const step = node.llm_calls[0]!;
  const when = step.when;
  if (
    !step.conditional ||
    step.tier !== "cheap" ||
    step.produces === null ||
    step.consumes.length !== 1 ||
    typeof when !== "object" ||
    when === null ||
    Array.isArray(when) ||
    (when as Record<string, unknown>)["guard"] !== "on_flag" ||
    typeof (when as Record<string, unknown>)["target"] !== "string" ||
    (when as Record<string, string>)["target"] !== `${step.consumes[0]}.stale`
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: assertion requires a cheap on_flag(<consumed freshness reading>.stale) step`,
    );
  }
  return {
    modelBinding,
    cadenceBinding,
    pinnedModel: node.binds[modelBinding] as string,
    pinnedCadenceMs,
  };
}

export function matchesAssertionContractShape(node: ComponentNode): boolean {
  try {
    validateAssertionShape(node);
    return true;
  } catch (error) {
    if (error instanceof CodexDispatchError) return false;
    throw error;
  }
}

export function assertionContractMismatchReason(node: ComponentNode): string | null {
  try {
    validateAssertionShape(node);
    return null;
  } catch (error) {
    if (error instanceof CodexDispatchError) return error.message;
    throw error;
  }
}

export function prepareAssertion(input: PrepareAssertionInput): PreparedAssertionComponent {
  if (input.model.trim().length === 0) throw new CodexDispatchError("assertion model binding must not be empty");
  const ir = typeof input.ir === "string" ? parseIr(input.ir) : input.ir;
  if (ir.warble_ir_version !== SUPPORTED_IR_VERSION) {
    throw new CodexDispatchError(
      `unsupported warble_ir_version '${ir.warble_ir_version}' (supported: ${SUPPORTED_IR_VERSION})`,
    );
  }
  const node = ir.components.find((candidate) => candidate.id === input.component);
  if (!node) throw new CodexDispatchError(`component '${input.component}' was not found in profile '${ir.profile}'`);
  const shape = validateAssertionShape(node);
  const call = node.llm_calls[0]!;
  const when = call.when as Record<string, string>;
  return {
    target: TARGET,
    profile: ir.profile,
    node,
    componentId: node.id,
    modelBinding: shape.modelBinding,
    cadenceBinding: shape.cadenceBinding,
    pinnedModel: shape.pinnedModel,
    pinnedCadenceMs: shape.pinnedCadenceMs,
    step: {
      name: call.name,
      tier: "cheap",
      model: input.model,
      prompt: call.prompt,
      consumes: [call.consumes[0]!],
      produces: call.produces!,
      when: { guard: "on_flag", target: when["target"]! },
    },
    capabilities: resolveAssertionCapabilities(node.required_capabilities),
    verdictType: node.effect.outcome.verdict_type!,
    emittedSignals: [...node.effect.outcome.emits!],
  };
}
