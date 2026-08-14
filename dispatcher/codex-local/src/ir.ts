import { CodexDispatchError } from "./error.js";

export const TARGET = "codex:local" as const;
export const SUPPORTED_IR_VERSION = "0.5" as const;

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
    outcome: { kind: string };
    render_blocks: unknown[];
  };
  context_binding: {
    binding_mode: string;
    project: string;
  };
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
      outcome: { kind: outcome["kind"] },
      render_blocks: effect["render_blocks"],
    },
    context_binding: {
      binding_mode: context["binding_mode"],
      project: context["project"],
    },
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
