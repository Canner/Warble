/**
 * The capability resolution pass — dispatch's "capability linker" (`docs/spec/capability-model.md`).
 *
 * TS sibling of the Rust file target's `resolve.rs`: same algorithm, same semantics. Given an IR
 * component node and a target's capability profile, resolve every capability the node requires
 * (declared + implied) into a report, or abort loudly naming the unsupported capability + target
 * (no silent degradation).
 */
import { DispatchError } from "./error.js";
import { distinctTiers, type ComponentNode } from "./ir.js";
import {
  isKnownTarget,
  knownTargetNames,
  localProfile,
  type CapabilityEntry,
  type CapabilityOutcome,
  type CapabilityProfile,
  type Criticality,
  type ProvidedBy,
} from "./targets.js";

export interface ResolvedCapability {
  capability: string;
  outcome: CapabilityOutcome;
  provided_by: ProvidedBy;
  criticality: Criticality;
  note?: string;
}

export type ResolutionReport = ResolvedCapability[];

/**
 * Entry used for a capability absent from the target profile entirely — unknown means it cannot be
 * guaranteed, so it fails as safety-critical.
 */
function unknownCapabilityEntry(): CapabilityEntry {
  return {
    outcome: "fail",
    via: null,
    provided_by: "none",
    criticality: "safety-critical",
    note: "capability is not declared in the target's capability profile — unknown means it cannot be guaranteed",
  };
}

/** Capabilities implied by IR shape beyond the node's declared `required_capabilities`. */
function impliedCapabilities(node: ComponentNode): string[] {
  const implied: string[] = [];

  if (node.realization_kind === "skill" && distinctTiers(node.llm_calls).length > 1) {
    implied.push("llm:per_step_tier");
  }

  switch (node.trigger.kind) {
    case "scheduled":
      implied.push("scheduler");
      break;
    case "event":
      implied.push("event_bus");
      break;
    case "one_shot":
      break;
  }

  // Emitting a signal is the producer side of the event transport, symmetric to a `event` trigger
  // consuming one — both borrow `event_bus`. Shape-derived, never per-component. The notify_channel
  // for concrete on-breach actions is a *declared* capability, not implied here.
  if ((node.effect.outcome.emits?.length ?? 0) > 0) {
    implied.push("event_bus");
  }

  if (node.effect.render_blocks.length > 0) {
    implied.push("render_contract");
  }

  // A `mutation` outcome implies the write surface + the checkpoint/rollback mechanism it is
  // borrowed from — shape-derived from the outcome enum, analogous to `emits` ⇒ `event_bus`. Does
  // NOT imply human_approval/blast_radius: those are declared per-guardrail, not implied by shape.
  if (node.effect.outcome.kind === "mutation") {
    implied.push("write_authz");
    implied.push("version_control");
  }

  return implied;
}

/** Union of declared + implied required capabilities, de-duplicated, order-preserving. */
export function collectRequiredCapabilities(node: ComponentNode): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const cap of [...node.required_capabilities, ...impliedCapabilities(node)]) {
    if (!seen.has(cap)) {
      seen.add(cap);
      out.push(cap);
    }
  }
  return out;
}

/**
 * Resolve every capability required by `node` against `profile`. Returns the report on success;
 * throws (loud-fail) naming the capability + target if any required capability resolves to `fail`.
 */
export function resolveCapabilities(
  node: ComponentNode,
  targetId: string,
  profile: CapabilityProfile,
): ResolutionReport {
  const fallback = unknownCapabilityEntry();

  const report: ResolutionReport = collectRequiredCapabilities(node).map((capability) => {
    const e = profile[capability] ?? fallback;
    const resolved: ResolvedCapability = {
      capability,
      outcome: e.outcome,
      provided_by: e.provided_by,
      criticality: e.criticality,
    };
    if (e.note !== null) resolved.note = e.note;
    return resolved;
  });

  const failed = report.find((r) => r.outcome === "fail");
  if (failed) {
    const reason = failed.note ?? "unsupported on this target";
    throw new DispatchError(
      `${failed.capability}: fail on ${targetId} (${reason}) — component '${node.verb}' cannot be dispatched`,
    );
  }

  return report;
}

/**
 * Resolve one node's required capabilities against `targetId`, erroring on any `fail` outcome
 * (no silent degradation). Callers must not dispatch when this throws.
 */
export function resolveNodeCapabilities(node: ComponentNode, targetId: string): ResolutionReport {
  if (!isKnownTarget(targetId)) {
    throw new DispatchError(
      `target '${targetId}' has no capability profile (known targets: ${knownTargetNames().join(", ")})`,
    );
  }
  return resolveCapabilities(node, targetId, localProfile());
}
