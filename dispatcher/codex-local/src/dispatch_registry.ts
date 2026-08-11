import { CodexDispatchError } from "./error.js";
import type { ComponentNode } from "./ir.js";

// These identities belong to host-owned, approval-capable lifecycle contracts. They are never
// legal targets for this dispatcher, regardless of an untrusted IR attempting to rewrite their
// component shape, capabilities, guardrails, or context binding.
const RESERVED_HOST_EXECUTED_COMPONENT_IDS = new Set(["apply_enrichment"]);

export function assertDispatchableComponentIdentity(node: ComponentNode): void {
  if (RESERVED_HOST_EXECUTED_COMPONENT_IDS.has(node.id)) {
    throw new CodexDispatchError(
      `component '${node.id}' is host-executed and cannot be dispatched by codex:local`,
    );
  }
}
