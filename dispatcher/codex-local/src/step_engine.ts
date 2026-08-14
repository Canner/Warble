import { CodexDispatchError } from "./error.js";
import type { ComponentNode, LlmCall } from "./ir.js";

/**
 * The only `when` dialect this transport (and the Ask path) evaluates: a step runs only when an
 * earlier step in the same component failed. `target` names that earlier step.
 */
export interface OnFailureGuard {
  guard: "on_failure";
  target: string;
}

/**
 * Parses a step's `conditional`/`when` pair the same way Ask's `parseWhen` does: unconditional
 * steps must carry no guard, conditional steps must carry exactly `{guard: "on_failure", target}`.
 * Kept transport-neutral (no Ask import) so Setup/Enrich stay separate engines from Ask while
 * reading identically to it, satisfying AC#2 without merging the three families.
 */
export function parseStepWhen(step: LlmCall): OnFailureGuard | null {
  if (!step.conditional) {
    if (step.when !== null) {
      throw new CodexDispatchError(`step '${step.name}' is unconditional but has a when guard`);
    }
    return null;
  }
  if (
    typeof step.when !== "object" ||
    step.when === null ||
    Array.isArray(step.when) ||
    (step.when as Record<string, unknown>)["guard"] !== "on_failure" ||
    typeof (step.when as Record<string, unknown>)["target"] !== "string"
  ) {
    throw new CodexDispatchError(`step '${step.name}' wall-hit: repair requires on_failure(target)`);
  }
  return {
    guard: "on_failure",
    target: (step.when as Record<string, string>)["target"]!,
  };
}

export interface StepTopology {
  when: OnFailureGuard | null;
}

/**
 * Validates the full step sequence's shape once every step has been individually accepted:
 *
 * - step names are unique (addressing by name, for both marshalling and on_failure targets,
 *   requires this — it is also what turns the old "grows a second step by cloning the same step"
 *   fixture into a genuine reject rather than an accidental accept);
 * - every step has a produced slot (the per-step generalization of the old single-step
 *   "requires a produced slot" wall-hit — each step's completion is judged by whether it produced
 *   what it declared, so every step needs that signal, not only the last one);
 * - every `consumes` name is satisfiable by some strictly earlier step's `produces` (unchanged
 *   general rule from the single-step transport, now with more than one possible producer);
 * - an on_failure guard's target is the name of a strictly earlier step (no forward/self
 *   reference — a target must already have run, or been skipped, by the time the guard is
 *   evaluated);
 * - a conditional (on_failure-guarded) step must be the LAST step in the component. This is not
 *   a hardcoded Setup/Enrich shape rule; it mirrors the one thing that keeps Ask's repair step
 *   safe to skip — nothing downstream ever consumes a step that might not run. Without this rule
 *   a validator could bless a component whose executor cannot honestly know what to feed a later
 *   consumer when its producer was skipped, which is exactly the defect the validator's
 *   accept-set-equals-execute-set invariant exists to prevent.
 */
export function validateStepTopology(node: ComponentNode): StepTopology[] {
  const names = new Set<string>();
  for (const step of node.llm_calls) {
    if (names.has(step.name)) {
      throw new CodexDispatchError(
        `component '${node.id}' wall-hit: step name '${step.name}' is declared more than once`,
      );
    }
    names.add(step.name);
  }
  const topology: StepTopology[] = [];
  const produced = new Set<string>();
  for (let index = 0; index < node.llm_calls.length; index += 1) {
    const step = node.llm_calls[index]!;
    for (const consumed of step.consumes) {
      if (!produced.has(consumed)) {
        throw new CodexDispatchError(
          `component '${node.id}' wall-hit: step '${step.name}' consumes '${consumed}' but no earlier step produces it`,
        );
      }
    }
    if (step.produces === null) {
      throw new CodexDispatchError(
        `component '${node.id}' wall-hit: this transport requires a produced slot; step '${step.name}' produces none`,
      );
    }
    produced.add(step.produces);
    const when = parseStepWhen(step);
    if (when !== null) {
      if (index !== node.llm_calls.length - 1) {
        throw new CodexDispatchError(
          `component '${node.id}' wall-hit: conditional step '${step.name}' must be the last step; a step nothing downstream can safely consume from must not have output others rely on`,
        );
      }
      if (!names.has(when.target) || !node.llm_calls.slice(0, index).some((earlier) => earlier.name === when.target)) {
        throw new CodexDispatchError(
          `component '${node.id}' wall-hit: step '${step.name}' on_failure target '${when.target}' is not an earlier step`,
        );
      }
    }
    topology.push({ when });
  }
  return topology;
}

/**
 * Parses a step's terminal text the way both Setup and Enrich judge whether a step "succeeded":
 * valid JSON, a single-key object whose key is exactly the step's declared `produces` name, with
 * a non-null value. Shared so Setup gains the same produces-field discipline Enrich already had,
 * and so a step's on_failure guard (see `validateStepTopology`) and a step's marshalled output
 * are judged by the identical rule.
 */
export function parseStepTerminal(text: string, produces: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CodexDispatchError("step terminal is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CodexDispatchError("step terminal must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== produces || record[produces] === null) {
    throw new CodexDispatchError(`step terminal requires exactly the produced field '${produces}'`);
  }
  return record;
}

/** A step's outcome after this dispatch has attempted (or skipped) it. */
export type StepOutcome =
  | { ran: true; ok: true; value: unknown }
  | { ran: true; ok: false }
  | { ran: false };

/**
 * Decides, from the prior steps' recorded outcomes, whether a step with the given guard should
 * run this dispatch. `null` (unconditional) always runs. An on_failure guard runs only when its
 * target step ran and did not succeed — mirroring Ask's on_failure(target) direction (skip on
 * success, run on failure) while judging "failure" in terms this transport can honestly observe
 * (produces-field match) rather than borrowing Ask's structured-envelope `ok` field, which this
 * transport's steps have no contract to emit.
 */
export function shouldRunStep(when: OnFailureGuard | null, outcomes: ReadonlyMap<string, StepOutcome>): boolean {
  if (when === null) return true;
  const target = outcomes.get(when.target);
  return target !== undefined && target.ran && !target.ok;
}

/**
 * Resolves the model bound to a step's tier from a `PrepareInput.model` value that may be either
 * a single string (every step in the component runs at that one tier/model — the shape every
 * existing single-step fixture already uses) or a per-tier map (needed once a component declares
 * steps at more than one tier). Kept generic on the tier string itself: the validator already
 * deleted the tier whitelist, so this must not reintroduce one.
 */
export function resolveStepModel(model: string | Record<string, string>, tier: string, componentId: string): string {
  const resolved = typeof model === "string" ? model : model[tier];
  if (resolved === undefined || resolved.trim().length === 0) {
    throw new CodexDispatchError(
      `component '${componentId}' wall-hit: no model binding for tier '${tier}'`,
    );
  }
  return resolved;
}
