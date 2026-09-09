import { CodexDispatchError } from "./error.js";

export const TARGET = "codex:local" as const;
export const SUPPORTED_IR_VERSION = "0.8" as const;

export interface ComponentCall {
  alias: string;
  component: string;
}

export interface LlmCall {
  name: string;
  tier: string;
  prompt: string;
  consumes: string[];
  produces: string | null;
  conditional: boolean;
  when: unknown;
  component_calls: ComponentCall[];
}

export interface Guardrail {
  name: string;
  locked: boolean;
  scope?: string;
  threshold?: number;
}

export interface ComponentNode {
  id: string;
  entrypoint: boolean;
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
  slots?: unknown[];
}

export interface WarbleIr {
  warble_ir_version: string;
  profile: string;
  components: ComponentNode[];
  slots?: unknown[];
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

/** Retain unsupported slot declarations so the executable preparation guard can reject them. */
function slotsField(value: Record<string, unknown>, field: string): { slots?: unknown[] } {
  if (value["slots"] === undefined) return {};
  if (!Array.isArray(value["slots"])) {
    throw new CodexDispatchError(`${field}.slots must be an array`);
  }
  return { slots: value["slots"] };
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
  const componentCallsRaw = value["component_calls"] === undefined ? [] : value["component_calls"];
  if (!Array.isArray(componentCallsRaw)) {
    throw new CodexDispatchError(`${componentId}.${name}.component_calls must be an array`);
  }
  return {
    name,
    tier,
    prompt,
    consumes: stringArray(value["consumes"] ?? [], `${componentId}.${name}.consumes`),
    produces: value["produces"],
    conditional: value["conditional"],
    when: value["when"] ?? null,
    component_calls: componentCallsRaw.map((entry: unknown, index: number) => {
      if (
        !isRecord(entry) ||
        typeof entry["alias"] !== "string" ||
        typeof entry["component"] !== "string"
      ) {
        throw new CodexDispatchError(
          `${componentId}.${name}.component_calls[${index}] must contain string alias/component`,
        );
      }
      return { alias: entry["alias"], component: entry["component"] };
    }),
  };
}

/**
 * Resolve only the selected roots' transitive closure, then reject a reachable invocation because
 * codex:local does not install a generic child-run handler yet. Unreachable siblings cannot
 * participate in this scoped executable preflight.
 */
export function assertNoComponentCompositionForRoots(
  ir: WarbleIr,
  rootIds: readonly string[],
): void {
  const byId = new Map(ir.components.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const walk = (id: string, root: boolean): void => {
    if (visited.has(id)) return;
    const node = byId.get(id);
    if (!node) {
      throw new CodexDispatchError(`component '${id}' was not found in profile '${ir.profile}'`);
    }
    if (root && !node.entrypoint) {
      throw new CodexDispatchError(
        `component '${id}' is entrypoint:false and cannot be selected as a root entry`,
      );
    }
    visited.add(id);
    for (const call of node.llm_calls) {
      for (const componentCall of call.component_calls) {
        const callee = byId.get(componentCall.component);
        if (!callee) {
          throw new CodexDispatchError(
            `component '${node.id}' step '${call.name}' alias '${componentCall.alias}' references ` +
              `missing mounted component '${componentCall.component}'`,
          );
        }
        walk(callee.id, false);
        throw new CodexDispatchError(
          `step '${call.name}' on component '${node.id}' authorizes component call alias ` +
            `'${componentCall.alias}' to '${componentCall.component}', but component_invocation ` +
            `resolves fail on ${TARGET} (wall-hit)`,
        );
      }
    }
  };
  for (const rootId of rootIds) walk(rootId, true);
}

/** Whole-profile executable preparation starts only advertised entries and their closure union. */
export function assertNoComponentComposition(ir: WarbleIr): void {
  assertNoComponentCompositionForRoots(
    ir,
    ir.components.filter((node) => node.entrypoint).map((node) => node.id),
  );
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
  if (typeof value["entrypoint"] !== "boolean") {
    throw new CodexDispatchError(`component '${id}'.entrypoint must be a boolean`);
  }
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
    entrypoint: value["entrypoint"],
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
    ...slotsField(value, `component '${id}'`),
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
    ...slotsField(value, "IR root"),
  };
}

/** Normalize wire strings and caller-parsed objects through the same strict reader. */
export function parseIrInput(input: WarbleIr | string): WarbleIr {
  if (typeof input === "string") return parseIr(input);
  let raw: string | undefined;
  try {
    raw = JSON.stringify(input);
  } catch (error) {
    throw new CodexDispatchError(`invalid IR object: ${String(error)}`);
  }
  if (raw === undefined) throw new CodexDispatchError("invalid IR object: value is not serializable");
  return parseIr(raw);
}

/**
 * Refuse an IR that declares prompt slots (introduced in IR 0.7).
 *
 * This back-end carries step prompt text but has no slot resolution, so a slotted profile would put
 * a literal `{{ slot.… }}` in front of the model — silently, because the compiler's template check
 * passes such a reference as valid syntax and simply assumed something downstream would consume it.
 *
 * Refusing is not the end state; it is the honest interim one. The two back-ends the driven-harness
 * work needs resolve slots today, and this one is scheduled to. Until then a loud failure is the
 * difference between "this target cannot run that profile yet" and a prompt nobody inspects.
 */
export function assertNoSlots(ir: { slots?: unknown[]; components: { id: string; slots?: unknown[] }[] }): void {
  const owners: string[] = [];
  if (Array.isArray(ir.slots) && ir.slots.length > 0) owners.push("the profile");
  for (const node of ir.components) {
    if (Array.isArray(node.slots) && node.slots.length > 0) owners.push(`component '${node.id}'`);
  }
  if (owners.length > 0) {
    throw new CodexDispatchError(
      `this target cannot resolve prompt slots yet, and ${owners.join(", ")} declares them. ` +
        `Dispatching anyway would send the literal '{{ slot.… }}' placeholder to the model.`,
    );
  }
}
