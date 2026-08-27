import { CodexDispatchError } from "./error.js";

export const TARGET = "codex:local" as const;
export const SUPPORTED_IR_VERSION = "0.6" as const;

export interface LlmCall {
  name: string;
  tier: string;
  prompt: string;
  consumes: string[];
  produces: string | null;
  conditional: boolean;
  when: unknown;
}

export interface Guardrail {
  name: string;
  locked: boolean;
  scope?: string;
  threshold?: number;
}

/** Additive IR facets used by assertion-capable targets.  They deliberately retain the authored
 * values rather than interpreting them in the parser: a target must legalize the complete shape
 * it consumes, and must not silently discard binding or outcome information. */
export interface IrParam {
  name: string;
  bind?: string;
  default?: unknown;
  source?: string;
}

export interface PreconditionCheck {
  predicate: string;
  outcome: string;
}

export interface PreconditionResult {
  status: string;
  checks: PreconditionCheck[];
}

/** Effective profile values resolved by the front-end compiler.  Runtime-injected parameters are
 * deliberately excluded from this additive IR facet, so a pinned target can distinguish authored
 * binding from caller-supplied operation evidence. */
export type IrBindValue = string | number | boolean | null;
export type IrBinds = Record<string, IrBindValue>;

export interface ComponentNode {
  id: string;
  verb: string;
  type: string;
  realization_kind: string;
  llm_calls: LlmCall[];
  required_capabilities: string[];
  guardrails: Guardrail[];
  trigger: { kind: string };
  effect: {
    outcome: { kind: string; verdict_type?: string; emits?: string[] };
    render_blocks: unknown[];
  };
  context_binding: {
    binding_mode: string;
    project: string;
  };
  params: IrParam[];
  binds: IrBinds | null;
  precondition_result: PreconditionResult | null;
}

function parseParams(value: unknown, componentId: string): IrParam[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new CodexDispatchError(`component '${componentId}' params must be an array`);
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry["name"] !== "string") {
      throw new CodexDispatchError(`component '${componentId}' has a malformed param`);
    }
    if (entry["bind"] !== undefined && typeof entry["bind"] !== "string") {
      throw new CodexDispatchError(`component '${componentId}' param '${entry["name"]}' has a malformed bind`);
    }
    if (entry["source"] !== undefined && typeof entry["source"] !== "string") {
      throw new CodexDispatchError(`component '${componentId}' param '${entry["name"]}' has a malformed source`);
    }
    return {
      name: entry["name"],
      ...(typeof entry["bind"] === "string" ? { bind: entry["bind"] } : {}),
      ...(entry["default"] !== undefined ? { default: entry["default"] } : {}),
      ...(typeof entry["source"] === "string" ? { source: entry["source"] } : {}),
    };
  });
}

function parsePrecondition(value: unknown, componentId: string): PreconditionResult | null {
  if (value === undefined) return null;
  if (!isRecord(value) || typeof value["status"] !== "string" || !Array.isArray(value["checks"])) {
    throw new CodexDispatchError(`component '${componentId}' has a malformed precondition_result`);
  }
  const checks = value["checks"].map((entry) => {
    if (!isRecord(entry) || typeof entry["predicate"] !== "string" || typeof entry["outcome"] !== "string") {
      throw new CodexDispatchError(`component '${componentId}' has a malformed precondition check`);
    }
    return { predicate: entry["predicate"], outcome: entry["outcome"] };
  });
  return { status: value["status"], checks };
}

function parseBinds(value: unknown, componentId: string): IrBinds | null {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new CodexDispatchError(`component '${componentId}' binds must be an object`);
  const binds: IrBinds = {};
  for (const [name, bound] of Object.entries(value)) {
    if (name.trim().length === 0 || name.length > 128) {
      throw new CodexDispatchError(`component '${componentId}' has an invalid bind name`);
    }
    if (
      bound !== null &&
      typeof bound !== "string" &&
      typeof bound !== "number" &&
      typeof bound !== "boolean"
    ) {
      throw new CodexDispatchError(`component '${componentId}' bind '${name}' must be a JSON scalar`);
    }
    binds[name] = bound;
  }
  return binds;
}

export interface WarbleIr {
  warble_ir_version: string;
  profile: string;
  components: ComponentNode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new CodexDispatchError(`${field} must be an array of strings`);
  }
  return value;
}

function parseCall(value: unknown, componentId: string): LlmCall {
  if (!isRecord(value)) {
    throw new CodexDispatchError(`component '${componentId}' has a malformed llm_call`);
  }
  const { name, tier, prompt } = value;
  if (
    typeof name !== "string" ||
    typeof tier !== "string" ||
    typeof prompt !== "string" ||
    typeof value["conditional"] !== "boolean" ||
    (value["produces"] !== null && typeof value["produces"] !== "string")
  ) {
    throw new CodexDispatchError(
      `component '${componentId}' llm_call has malformed name/tier/prompt/conditional/produces`,
    );
  }
  return {
    name,
    tier,
    prompt,
    consumes: stringArray(value["consumes"] ?? [], `${componentId}.${name}.consumes`),
    produces: value["produces"],
    conditional: value["conditional"],
    when: value["when"] ?? null,
  };
}

function parseGuardrail(value: unknown, componentId: string): Guardrail {
  if (
    !isRecord(value) ||
    typeof value["name"] !== "string" ||
    typeof value["locked"] !== "boolean"
  ) {
    throw new CodexDispatchError(`component '${componentId}' has a malformed guardrail`);
  }
  return {
    name: value["name"],
    locked: value["locked"],
    ...(typeof value["scope"] === "string" ? { scope: value["scope"] } : {}),
    ...(typeof value["threshold"] === "number" ? { threshold: value["threshold"] } : {}),
  };
}

function parseComponent(value: unknown): ComponentNode {
  if (!isRecord(value) || typeof value["id"] !== "string") {
    throw new CodexDispatchError("IR component must be an object with a string id");
  }
  const id = value["id"];
  const trigger = value["trigger"];
  const effect = value["effect"];
  const outcome = isRecord(effect) ? effect["outcome"] : null;
  const context = value["context_binding"];
  const verdictType = isRecord(outcome) ? outcome["verdict_type"] : undefined;
  const emits = isRecord(outcome) ? outcome["emits"] : undefined;
  if (
    typeof value["verb"] !== "string" ||
    typeof value["type"] !== "string" ||
    typeof value["realization_kind"] !== "string" ||
    !Array.isArray(value["llm_calls"]) ||
    !Array.isArray(value["guardrails"]) ||
    !isRecord(trigger) ||
    typeof trigger["kind"] !== "string" ||
    !isRecord(effect) ||
    !isRecord(outcome) ||
    typeof outcome["kind"] !== "string" ||
    (verdictType !== undefined && typeof verdictType !== "string") ||
    (emits !== undefined && (!Array.isArray(emits) || !emits.every((entry) => typeof entry === "string"))) ||
    !Array.isArray(effect["render_blocks"]) ||
    !isRecord(context) ||
    typeof context["binding_mode"] !== "string" ||
    typeof context["project"] !== "string"
  ) {
    throw new CodexDispatchError(`component '${id}' is missing required IR fields`);
  }
  return {
    id,
    verb: value["verb"],
    type: value["type"],
    realization_kind: value["realization_kind"],
    llm_calls: value["llm_calls"].map((call) => parseCall(call, id)),
    required_capabilities: stringArray(
      value["required_capabilities"] ?? [],
      `${id}.required_capabilities`,
    ),
    guardrails: value["guardrails"].map((guard) => parseGuardrail(guard, id)),
    trigger: { kind: trigger["kind"] },
    effect: {
      outcome: {
        kind: outcome["kind"],
        ...(typeof verdictType === "string" ? { verdict_type: verdictType } : {}),
        ...(Array.isArray(emits) ? { emits: emits as string[] } : {}),
      },
      render_blocks: effect["render_blocks"],
    },
    context_binding: {
      binding_mode: context["binding_mode"],
      project: context["project"],
    },
    params: parseParams(value["params"], id),
    binds: parseBinds(value["binds"], id),
    precondition_result: parsePrecondition(value["precondition_result"], id),
  };
}

export function parseIr(raw: string): WarbleIr {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new CodexDispatchError(`invalid IR JSON: ${String(error)}`);
  }
  if (
    !isRecord(value) ||
    typeof value["warble_ir_version"] !== "string" ||
    typeof value["profile"] !== "string" ||
    !Array.isArray(value["components"])
  ) {
    throw new CodexDispatchError("IR requires warble_ir_version, profile, and components");
  }
  if (value["warble_ir_version"] !== SUPPORTED_IR_VERSION) {
    throw new CodexDispatchError(
      `unsupported warble_ir_version '${value["warble_ir_version"]}' (supported: ${SUPPORTED_IR_VERSION})`,
    );
  }
  return {
    warble_ir_version: value["warble_ir_version"],
    profile: value["profile"],
    components: value["components"].map(parseComponent),
  };
}
