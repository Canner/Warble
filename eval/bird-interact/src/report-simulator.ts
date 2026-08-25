/**
 * Whether the official user simulator was actually answering.
 *
 * `user_simulator/server.py` calls its model with a hardcoded `temperature=0`. A model that
 * rejects that value fails EVERY call, and the server falls through to a canned non-answer. The
 * run still completes with error-free result rows and a valid-looking protocol trace — and
 * scores near zero, because BIRD deliberately deletes one required knowledge entry per task and
 * `ask_user` is the only way to recover it. A broken simulator is indistinguishable from a weak
 * agent unless something looks, so this looks, every time.
 */

/** The exact string `user_simulator/server.py` returns when it could not generate a response. */
export const CANNED_USER_RESPONSE = "I'm not sure I understand your question.";

export type SimulatorVerdict = "healthy" | "degraded" | "void";

export interface SimulatorHealth {
  readonly llmCallFailures: number;
  readonly asks: number;
  readonly cannedResponses: number;
  readonly verdict: SimulatorVerdict;
}

export function countLlmCallFailures(log: string): number {
  return log.split("LLM call failed").length - 1;
}

/**
 * `void` on any LLM failure, or when every ask in the run got the canned answer — with no ask
 * answered, the knowledge-recovery channel the benchmark depends on was closed and no score
 * from the run means anything. `degraded` when only some asks were canned.
 */
export function assessSimulator(input: {
  readonly log: string;
  readonly answers: readonly string[];
}): SimulatorHealth {
  const llmCallFailures = countLlmCallFailures(input.log);
  const asks = input.answers.length;
  const cannedResponses = input.answers.filter((a) => a.trim() === CANNED_USER_RESPONSE).length;
  const verdict: SimulatorVerdict =
    llmCallFailures > 0 || (asks > 0 && cannedResponses === asks)
      ? "void"
      : cannedResponses > 0
        ? "degraded"
        : "healthy";
  return { llmCallFailures, asks, cannedResponses, verdict };
}
