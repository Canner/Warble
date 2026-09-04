/**
 * Deterministic realization of a `conditional` step's closed-vocabulary `when` guard (IR v0.3+:
 * `on_failure` / `on_flag` / `on_missing`, see `docs/spec/ir-schema.md`), for the hybrid-staged
 * executor (`run.ts`).
 *
 * Two shapes fall out of the same three-value vocabulary, keyed structurally (never on a component's
 * id/verb):
 *
 *  - **repair fold-into-loop**: an `on_failure` guard whose `target` is the step immediately before
 *    it, where that preceding step's `produces` is also this step's sole/consumed input (the
 *    `generate_sql` → `repair_sql` shape). This is not a plain run/skip — a failed target step is
 *    RETRIED via the conditional step as a bounded error-recovery turn, capped at
 *    `DEFAULT_MAX_REPAIR_ATTEMPTS`. Exhausting the bound is a loud-fail (`run.ts` throws), never a
 *    silent skip — an unbounded retry loop or a swallowed failure are both worse than stopping.
 *  - **guarded-skip**: every other guard shape (`on_flag`, `on_missing`, or an `on_failure` that
 *    isn't the adjacent-repair shape) is a plain deterministic decision: guard true → run the step,
 *    guard false → skip it. A skipped step's `produces` artifact is simply never set in `artifacts`, and
 *    `route.ts`'s `buildStepMessages` already marshals an absent artifact as an explicit "not produced"
 *    note rather than crashing — so the artifact is optional for whatever consumes it downstream
 *    (cascade). No new marshaling code is needed for that half of the contract; this module only
 *    supplies the run/skip/repair decision itself.
 *
 * Pure and synchronous (no SDK, no network): every function here is exercised with synthetic state,
 * which is what makes the decision layer offline-testable and lets it double as the deterministic
 * reference this back-end contributes to the shared cross-target conformance fixtures.
 */
import { DispatchError } from "./error.js";
import type { WhenGuard } from "./ir.js";

export type StepOutcome = "success" | "failure";

/** The subset of a step's identity this module needs: its name (an `on_failure` target) and the
 *  artifact its output would land in (an `on_failure`-repair shape also requires it to be consumed). */
export interface StepIdentity {
  name: string;
  produces: string | null;
}

export interface GuardState {
  /** Every artifact value produced by steps run so far, keyed by their `produces` name. */
  artifacts: Readonly<Record<string, string>>;
  /** Every step's outcome recorded so far, keyed by step name. */
  outcomes: Readonly<Record<string, StepOutcome>>;
}

export type ConditionalDecision =
  | { kind: "run" }
  | { kind: "skip" }
  | { kind: "repair"; target: StepIdentity };

/** Default bound on repair attempts. Not (yet) an IR field — `max_attempts` is not part of the
 *  schema this back-end reads — so this is a back-end-local runtime constant; a future IR facet
 *  could override it per step without changing this module's contract. */
export const DEFAULT_MAX_REPAIR_ATTEMPTS = 1;

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Resolve a dotted `artifact.field.nested` path against the parsed JSON of `artifacts[artifact]`. Any failure
 *  along the way (artifact absent, not JSON, path doesn't resolve) reads as `false`/absent — a guard
 *  never throws on a shape mismatch, it just doesn't fire. */
function readFlag(artifacts: Readonly<Record<string, string>>, target: string): boolean {
  const [artifactName, ...path] = target.split(".");
  if (artifactName === undefined) return false;
  const raw = artifacts[artifactName];
  if (raw === undefined) return false;
  let cur: unknown = tryParseJson(raw);
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return false;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur === true;
}

/**
 * Evaluate a guard's truth value directly (R2 — guarded-skip). Does not special-case the R1 repair
 * shape; callers that need to distinguish repair-fold from a plain `on_failure` skip should use
 * {@link classifyConditionalStep} instead.
 */
export function evaluateGuard(when: WhenGuard, state: GuardState): boolean {
  switch (when.guard) {
    case "on_failure":
      return state.outcomes[when.target] === "failure";
    case "on_flag":
      return readFlag(state.artifacts, when.target);
    case "on_missing":
      return state.artifacts[when.target] === undefined;
    default:
      // The compiler validates guard names against the closed vocabulary before this IR ever
      // reaches a back-end (core/src/compile.rs); an unrecognized value here means a hand-edited or
      // future-versioned IR slipped through — loud-fail rather than silently treating it as false.
      throw new DispatchError(
        `unknown guard '${when.guard}' (closed vocabulary: on_failure, on_flag, on_missing)`,
      );
  }
}

/**
 * Structural test for the R1 repair shape: an `on_failure` guard whose target is `precedingStep`,
 * where that step's sole produced artifact is also consumed by the conditional step. Returns the
 * target's identity when the shape matches, else `null` (falls back to R2 guarded-skip).
 */
export function repairFoldTarget(
  when: WhenGuard,
  consumes: readonly string[],
  precedingStep: StepIdentity | null,
): StepIdentity | null {
  if (when.guard !== "on_failure" || precedingStep === null) return null;
  if (when.target !== precedingStep.name) return null;
  if (precedingStep.produces === null || !consumes.includes(precedingStep.produces)) return null;
  return precedingStep;
}

/**
 * The single entry point run.ts uses to decide what a conditional step does next: fold into a
 * bounded repair turn (R1), run (R2 guard true), or skip (R2 guard false / R1 target didn't fail).
 */
export function classifyConditionalStep(
  when: WhenGuard,
  consumes: readonly string[],
  precedingStep: StepIdentity | null,
  state: GuardState,
): ConditionalDecision {
  const target = repairFoldTarget(when, consumes, precedingStep);
  if (target !== null) {
    return state.outcomes[target.name] === "failure" ? { kind: "repair", target } : { kind: "skip" };
  }
  return evaluateGuard(when, state) ? { kind: "run" } : { kind: "skip" };
}

export interface RepairAttemptResult {
  failed: boolean;
}

/**
 * Drive a bounded repair loop: call `attempt` up to `maxAttempts` times, stopping at the first
 * non-failing attempt. Never loops unboundedly and never swallows a fully-exhausted failure —
 * exhaustion is reported back (`recovered: false`) so the caller can loud-fail (`run.ts` throws a
 * `DispatchError`); this function itself does not throw on exhaustion, only on a rejected attempt.
 */
export async function runRepairLoop(
  maxAttempts: number,
  attempt: (attemptNumber: number) => Promise<RepairAttemptResult>,
): Promise<{ recovered: boolean; attempts: number }> {
  for (let i = 1; i <= maxAttempts; i++) {
    const result = await attempt(i);
    if (!result.failed) return { recovered: true, attempts: i };
  }
  return { recovered: false, attempts: maxAttempts };
}
