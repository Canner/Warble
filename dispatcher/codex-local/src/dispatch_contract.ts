import { CodexDispatchError } from "./error.js";
import type { ComponentNode, WarbleIr } from "./ir.js";

/**
 * The public CLI is intentionally profile-agnostic. These are implementation contracts selected
 * from a parsed component's declared IR shape, never from a command spelling, profile name, or
 * component identity.
 */
export type DispatchContract = "setup" | "ask" | "enrich";

function hasGuardrail(node: ComponentNode, name: string): boolean {
  return node.guardrails.some((guardrail) => guardrail.name === name);
}

function selectedComponent(ir: WarbleIr, component: string): ComponentNode {
  const node = ir.components.find((candidate) => candidate.id === component);
  if (!node) {
    throw new CodexDispatchError(`component '${component}' was not found in profile '${ir.profile}'`);
  }
  return node;
}

/**
 * Select the native execution contract from structural IR markers. The family-specific preparers
 * remain the authority for the complete shape/capability validation and will wall-hit malformed
 * components before any runtime is launched.
 */
export function classifyDispatchContract(ir: WarbleIr, component: string): DispatchContract {
  const node = selectedComponent(ir, component);

  if (hasGuardrail(node, "setup_execution")) return "setup";
  if (node.context_binding.binding_mode === "runtime_selected") return "ask";
  if (node.context_binding.binding_mode === "pinned") return "enrich";

  throw new CodexDispatchError(
    `component '${node.id}' wall-hit: no supported codex:local execution contract matches its IR shape`,
  );
}

/**
 * Setup is the sole whole-profile manifest/describe contract. Other shapes are scoped dispatches
 * and therefore require an explicit --component selection.
 */
export function supportsSetupAggregate(ir: WarbleIr): boolean {
  return ir.components.length > 0 && ir.components.every((node) => hasGuardrail(node, "setup_execution"));
}
