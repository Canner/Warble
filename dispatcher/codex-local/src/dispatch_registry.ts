import { CodexDispatchError } from "./error.js";
import type { ComponentNode } from "./ir.js";

/**
 * Refuses a component on IR grounds alone, before any family-specific shape check runs: this
 * target only ever executes `skill`-realized components (`realization_kind: skill | tool |
 * gated-tool` — every family's own shape validator already requires exactly `skill` too, so this
 * mirrors that, just earlier and uniformly). A `tool`/`gated-tool` component is host-owned by
 * definition — it names a lifecycle contract this target has no approval channel or write
 * authority to run, regardless of what required_capabilities it happens to declare.
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
  if (node.realization_kind !== "skill") {
    throw new CodexDispatchError(
      `component '${node.id}' is host-executed and cannot be dispatched by codex:local: ` +
        `realization_kind '${node.realization_kind}' is not 'skill'`,
    );
  }
}
