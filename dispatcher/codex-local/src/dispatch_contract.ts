import { CodexDispatchError } from "./error.js";
import type { ComponentNode, WarbleIr } from "./ir.js";
import { askContractMismatchReason, matchesAskContractShape } from "./ask_prepare.js";
import {
  assertionContractMismatchReason,
  matchesAssertionContractShape,
} from "./assertion_prepare.js";
import { assertDispatchableComponentIdentity } from "./dispatch_registry.js";
import { enrichContractMismatchReason, matchesEnrichContractShape } from "./enrich_prepare.js";
import { setupContractMismatchReason, matchesSetupContractShape } from "./prepare.js";

/**
 * The public CLI is intentionally profile-agnostic. These are implementation contracts selected
 * from a parsed component's declared IR shape, never from a command spelling, profile name, or
 * component identity.
 */
export type DispatchContract = "setup" | "ask" | "enrich" | "assertion";

function selectedComponent(ir: WarbleIr, component: string): ComponentNode {
  const node = ir.components.find((candidate) => candidate.id === component);
  if (!node) {
    throw new CodexDispatchError(`component '${component}' was not found in profile '${ir.profile}'`);
  }
  return node;
}

/**
 * Select the native execution contract only when exactly one complete structural contract matches.
 * This check runs before configuration, preparation, or a runtime launch.
 */
export function classifyDispatchContract(ir: WarbleIr, component: string): DispatchContract {
  const node = selectedComponent(ir, component);
  assertDispatchableComponentIdentity(node);
  const matches = [
    ...(matchesSetupContractShape(node) ? (["setup"] as const) : []),
    ...(matchesAskContractShape(node) ? (["ask"] as const) : []),
    ...(matchesEnrichContractShape(node) ? (["enrich"] as const) : []),
    ...(matchesAssertionContractShape(node) ? (["assertion"] as const) : []),
  ];
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    // No single family shape matched. Rather than collapse to one generic sentence, surface each
    // family validator's own specific wall-hit reason so the diagnostic still names the concrete
    // structural expectation that failed (e.g. a guardrail contract mismatch), not just the fact
    // that nothing matched.
    const reasons = [
      setupContractMismatchReason(node),
      askContractMismatchReason(node),
      enrichContractMismatchReason(node),
      assertionContractMismatchReason(node),
    ].filter((reason): reason is string => reason !== null);
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: no supported codex:local execution contract matches its complete IR shape` +
        (reasons.length > 0 ? ` (${reasons.join(" | ")})` : ""),
    );
  }
  throw new CodexDispatchError(
    `component '${node.id}' wall-hit: ambiguous codex:local execution contracts (${matches.join(", ")})`,
  );
}

/**
 * Setup is the sole whole-profile manifest/describe contract. Other shapes are scoped dispatches
 * and therefore require an explicit --component selection.
 */
export function supportsSetupAggregate(ir: WarbleIr): boolean {
  // Scan the complete profile for host-only identities before testing whether it is an aggregate.
  // Otherwise a preceding non-Setup node could short-circuit `.every()` and leave a forged
  // reserved identity unchecked on the generic manifest/describe path.
  for (const node of ir.components) assertDispatchableComponentIdentity(node);
  return ir.components.length > 0 && ir.components.every(matchesSetupContractShape);
}
