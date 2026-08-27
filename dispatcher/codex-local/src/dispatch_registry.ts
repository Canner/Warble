import { CodexDispatchError } from "./error.js";
import type { ComponentNode } from "./ir.js";

/**
 * Refuses a component on IR grounds alone, before any family-specific shape check runs: this
 * target executes ordinary `skill` components and the narrowly realized `tool` assertion arm.
 * `tool` is not generally executable: the assertion validator must still prove the complete
 * assertive/tool/scheduled/assertion shape and its exact borrowed-capability closure. A
 * `gated-tool` component remains host-owned by definition because this target has no approval
 * channel or write authority.
 *
 * A component's id/verb carries no dispatch meaning (invariant #1): a genuinely host-owned
 * component wall-hits under any name, and a `skill`-realized component that declares only
 * capabilities a family here can honestly realize is dispatchable under any name — including one
 * that collides with a host-owned component's. Rejecting on capability content beyond
 * `realization_kind` is left to each family's own shape validator, which already enforces its
 * exact allowed capability set and reports which specific capability/shape expectation failed;
 * duplicating that check here would only replace those precise, family-scoped diagnostics with a
 * generic message.
 */
export function assertDispatchableComponentIdentity(node: ComponentNode): void {
  if (node.realization_kind !== "skill" && node.realization_kind !== "tool") {
    throw new CodexDispatchError(
      `component '${node.id}' is host-executed and cannot be dispatched by codex:local: ` +
        `realization_kind '${node.realization_kind}' is neither 'skill' nor the assertion 'tool' arm`,
    );
  }
}
