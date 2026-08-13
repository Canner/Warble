import { CodexDispatchError } from "./error.js";
import type { PreparedEnrichComponent } from "./enrich_prepare.js";
import { CodexSessionRuntime } from "./session.js";
import type { CodexSessionEvent, SessionIsolationOptions } from "./session_types.js";
import { parseStepTerminal, shouldRunStep, type StepOutcome } from "./step_engine.js";

/** One step's dispatch-time evidence: whether it ran (an on_failure guard may skip it) and, if it
 * ran, whether its terminal matched its declared `produces` slot. Mirrors `run.ts`'s
 * `SetupStepRunOutcome` — kept as a separate type (not imported from `run.ts`) so Setup and Enrich
 * stay two independent engines, by design. */
export interface EnrichStepRunOutcome {
  name: string;
  ran: boolean;
  ok: boolean;
  value?: unknown;
}

export interface EnrichRunResult {
  target: "codex:local";
  component: string;
  /** The last step that actually ran's raw terminal text — unchanged for every existing
   * single-step component, since there the last step run is the only step run. */
  finalText: string;
  /** The parsed terminal object of the last step that actually ran. */
  value: unknown;
  events: CodexSessionEvent[];
  steps: EnrichStepRunOutcome[];
}

/**
 * Execute a read-only enrichment component's steps, in order, through one persistent Codex
 * app-server session. The Codex thread is created before the first model turn begins; this
 * preserves durable session history before any metered work can occur, while the host remains
 * owner of enrichment run bookkeeping. Every step of one dispatch shares the same thread — see
 * `session.ts`'s `CodexSessionRuntime.turn`, which now takes the current step and its marshalled
 * `consumes` inputs — with produces/consumes marshalled between turns exactly as `run.ts`'s
 * `runSetup` marshals them between one-shot processes, and the same recoverable-vs-fatal
 * on_failure evaluation (`shouldRunStep`/`parseStepTerminal`).
 */
export async function runEnrich(
  prepared: PreparedEnrichComponent,
  request: string,
  options: SessionIsolationOptions,
): Promise<EnrichRunResult> {
  if (request.trim().length === 0) throw new CodexDispatchError("enrichment request must not be empty");
  const events: CodexSessionEvent[] = [];
  // `CodexSessionRuntime` fans every event for the whole session's lifetime out through one
  // `onEvent` callback fixed at `connect()` time — there is no per-turn subscription. So each
  // step's answer is captured into this one mutable slot, reset immediately before that step's
  // turn starts, and read immediately after that turn completes; the loop below never has two
  // turns in flight at once, so there is no risk of one step reading another's answer.
  let currentAnswer: string | null = null;
  const onEvent = (event: CodexSessionEvent): void => {
    events.push(event);
    if (event.t === "answer") currentAnswer = event.text;
    options.onEvent?.(event);
  };
  const runtime = await CodexSessionRuntime.connect(prepared, { ...options, onEvent });
  try {
    const session = await runtime.start();
    const slots: Record<string, unknown> = {};
    const outcomes = new Map<string, StepOutcome>();
    const steps: EnrichStepRunOutcome[] = [];
    let lastFinalText: string | null = null;
    let lastValue: unknown;

    for (const step of prepared.steps) {
      if (!shouldRunStep(step.when, outcomes)) {
        outcomes.set(step.name, { ran: false });
        steps.push({ name: step.name, ran: false, ok: false });
        continue;
      }
      const inputs = Object.fromEntries(step.consumes.map((name) => [name, slots[name]]));
      currentAnswer = null;
      const turn = await runtime.turn(session, request, step, inputs);
      const completed = await runtime.waitForTurn(turn, options.timeoutMs ?? 120_000);
      if (completed.status !== "completed" || currentAnswer === null) {
        throw new CodexDispatchError(`enrichment step '${step.name}' did not complete with a terminal answer`);
      }
      const finalText: string = currentAnswer;
      // Same recoverable-vs-fatal rule as `run.ts`'s `runSetup`: a step's produces-mismatch is
      // only survivable when some later step's on_failure guard actually names it; otherwise it
      // fails the whole dispatch exactly as the original single-turn transport always did.
      const hasGuardedConsumer = prepared.steps.some((candidate) => candidate.when?.target === step.name);
      let record: Record<string, unknown>;
      try {
        record = parseStepTerminal(finalText, step.produces);
      } catch (error) {
        if (hasGuardedConsumer && error instanceof CodexDispatchError) {
          outcomes.set(step.name, { ran: true, ok: false });
          steps.push({ name: step.name, ran: true, ok: false });
          lastFinalText = finalText;
          continue;
        }
        throw error;
      }
      const value = record[step.produces];
      slots[step.produces] = value;
      outcomes.set(step.name, { ran: true, ok: true, value });
      steps.push({ name: step.name, ran: true, ok: true, value });
      lastFinalText = finalText;
      lastValue = record;
    }

    if (lastFinalText === null) {
      // Unreachable for any component `validateStepTopology` accepts — see `run.ts`'s identical
      // backstop for why: the only conditional step allowed is the last one, targeting a strictly
      // earlier step, so a component can only be conditional-only when it has zero steps, which
      // `prepareEnrich` already rejects.
      throw new CodexDispatchError("enrichment dispatch completed without running any step");
    }
    return {
      target: prepared.target,
      component: prepared.componentId,
      finalText: lastFinalText,
      value: lastValue,
      events,
      steps,
    };
  } finally {
    await runtime.close();
  }
}
