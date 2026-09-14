import { CodexDispatchError } from "./error.js";
import type { PreparedTurnComponent } from "./turn_prepare.js";
import { CodexSessionRuntime } from "./session.js";
import type { CodexSessionEvent, SessionIsolationOptions } from "./session_types.js";
import { parseStepTerminal, shouldRunStep, type StepOutcome } from "./step_engine.js";

/** One step's dispatch-time evidence: whether it ran (an on_failure guard may skip it) and, if it
 * ran, whether its terminal matched its declared `produces` artifact. Mirrors `run.ts`'s
 * `ExecStepRunOutcome` — kept as a separate type (not imported from `run.ts`) so Setup and Enrich
 * stay two independent engines, by design. */
export interface TurnStepRunOutcome {
  name: string;
  ran: boolean;
  ok: boolean;
  value?: unknown;
}

export interface TurnRunResult {
  target: "codex:local";
  component: string;
  /** The last step that actually ran's raw terminal text — unchanged for every existing
   * single-step component, since there the last step run is the only step run. */
  finalText: string;
  /** The parsed terminal object of the last step that actually ran. */
  value: unknown;
  events: CodexSessionEvent[];
  steps: TurnStepRunOutcome[];
}

/**
 * Execute steps in separate processes and durable threads. Only host-marshalled declared
 * inputs cross step boundaries; prompts, raw tool results and undeclared history do not.
 * A caller can resume a single step's thread under its unchanged binding, but cannot reuse it
 * for another step. Conditional failure handling remains host-owned.
 */
export async function runTurn(
  prepared: PreparedTurnComponent,
  request: string,
  options: SessionIsolationOptions,
): Promise<TurnRunResult> {
  if (request.trim().length === 0) throw new CodexDispatchError("enrichment request must not be empty");
  const events: CodexSessionEvent[] = [];
  // `CodexSessionRuntime` fans every event for the whole session's lifetime out through one
  // `onEvent` callback fixed at `connect()` time — there is no per-turn subscription. So each
  // step's answer is captured into this one mutable artifact, reset immediately before that step's
  // turn starts, and read immediately after that turn completes; the loop below never has two
  // turns in flight at once, so there is no risk of one step reading another's answer.
  let currentAnswer: string | null = null;
  const onEvent = (event: CodexSessionEvent): void => {
    events.push(event);
    if (event.t === "answer") currentAnswer = event.text;
    options.onEvent?.(event);
  };
  {
    const artifacts: Record<string, unknown> = {};
    const outcomes = new Map<string, StepOutcome>();
    const steps: TurnStepRunOutcome[] = [];
    let lastFinalText: string | null = null;
    let lastValue: unknown;

    for (const step of prepared.steps) {
      if (!shouldRunStep(step.when, outcomes)) {
        outcomes.set(step.name, { ran: false });
        steps.push({ name: step.name, ran: false, ok: false });
        continue;
      }
      const inputs = Object.fromEntries(step.consumes.map((name) => [name, artifacts[name]]));
      currentAnswer = null;
      const runtime = await CodexSessionRuntime.connect({ ...prepared, steps: [step], enabledTools: [...step.enabledTools] }, { ...options, onEvent });
      try {
        const session = await runtime.start();
        const turn = await runtime.turn(session, request, step, inputs);
        const completed = await runtime.waitForTurn(turn, options.timeoutMs ?? 120_000);
        if (completed.status !== "completed" || currentAnswer === null) {
          throw new CodexDispatchError(`enrichment step '${step.name}' did not complete with a terminal answer`);
        }
      } finally {
        await runtime.close();
      }
      const finalText: string = currentAnswer;
      // Same recoverable-vs-fatal rule as `run.ts`'s `runExec`: a step's produces-mismatch is
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
      artifacts[step.produces] = value;
      outcomes.set(step.name, { ran: true, ok: true, value });
      steps.push({ name: step.name, ran: true, ok: true, value });
      lastFinalText = finalText;
      lastValue = record;
    }

    if (lastFinalText === null) {
      // Unreachable for any component `validateStepTopology` accepts — see `run.ts`'s identical
      // backstop for why: the only conditional step allowed is the last one, targeting a strictly
      // earlier step, so a component can only be conditional-only when it has zero steps, which
      // `prepareTurn` already rejects.
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
  }
}
