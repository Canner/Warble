/**
 * Whether the official user simulator was actually answering.
 *
 * `user_simulator/server.py` calls its model with a hardcoded `temperature=0`. A model that
 * rejects that value fails EVERY call, and the server falls through to a canned non-answer. The
 * run still completes with error-free result rows and a valid-looking protocol trace — and
 * scores near zero, because BIRD deliberately deletes one required knowledge entry per task and
 * `ask_user` is the only way to recover it. A broken simulator is indistinguishable from a weak
 * agent unless something looks, so this looks, every time.
 *
 * **The denominator is asks ATTEMPTED, never asks answered.** `tools.ts` pushes the agent/user
 * dialogue pair only after a SUCCESSFUL `askUser`: a transport error, an HTTP 500, or the
 * simulator's own `404 Task not initialized` leaves the charged tool call in the trajectory and no
 * dialogue turn at all. Grading on answers alone therefore graded a run whose every ask errored as
 * `healthy` — it had answered none of the zero asks it appeared to receive — while the same task
 * record carried `ask_user` calls that went nowhere. Nor does the log save it: the smoke starts
 * uvicorn at `--log-level warning`, so those failures need not reach `user-simulator.log` either.
 * An attempted ask that produced no answer is evidence the simulator did not answer.
 */

/**
 * The exact string `user_simulator/server.py` returns when it could not generate a response.
 *
 * Compared exactly, so ANY drift in what the simulator falls back to would leave a broken
 * simulator's canned replies counting as real answers — the run grades `healthy` and publishes its
 * scores, which is the outcome this whole file exists to prevent. `tests/upstream-contract.test.ts`
 * holds this string against the value the pinned checkout actually returns, so a reworded sentence,
 * a suffix inside the literal and a suffix concatenated on outside it all fail the build instead of
 * disarming the gate quietly. The comparison stays exact on purpose: loosening it here to tolerate
 * a suffix upstream has not written would start scoring real answers as canned.
 */
export const CANNED_USER_RESPONSE = "I'm not sure I understand your question.";

/**
 * The exact text `user_simulator/server.py` logs when a call to its model raised.
 *
 * Named rather than written inline below so the contract test can pin THIS string, the one the
 * count is actually taken with. A literal re-copied into the test would only pin the copy to
 * itself. It is counted as a substring because the line carries the exception after it.
 *
 * `tests/upstream-contract.test.ts` requires the phrase to survive in text the official file
 * EVALUATES, not merely to appear somewhere in it: a rewording that leaves the old phrase behind in
 * a comment or a docstring would otherwise keep the pin green while every real failure counted as
 * zero — and a count of zero is a broken simulator grading `healthy` and publishing its scores.
 */
export const LLM_CALL_FAILURE_LOG = "LLM call failed";

export type SimulatorVerdict = "healthy" | "degraded" | "void";

export interface SimulatorHealth {
  readonly llmCallFailures: number;
  /** Asks the run ATTEMPTED — charged `ask_user` calls, whether or not anything came back. */
  readonly asks: number;
  /** How many of those attempts produced an answer at all. */
  readonly answered: number;
  /** How many of the answers were exactly the canned non-answer. */
  readonly cannedResponses: number;
  readonly verdict: SimulatorVerdict;
}

export function countLlmCallFailures(log: string): number {
  return log.split(LLM_CALL_FAILURE_LOG).length - 1;
}

/**
 * `void` on any LLM failure, or when a run that attempted at least one ask got no REAL answer back
 * — canned, unanswered, or a mix of the two are the same finding: the knowledge-recovery channel
 * the benchmark depends on was closed, and no score from the run means anything. `degraded` when
 * some attempts produced a real answer and some did not. `healthy` only when every attempted ask
 * came back real, which includes a run that never asked.
 */
export function assessSimulator(input: {
  readonly log: string;
  /** Charged `ask_user` calls across the run, errored ones included. */
  readonly attempts: number;
  /** The answers that actually came back; an ask that produced none contributes nothing here. */
  readonly answers: readonly string[];
}): SimulatorHealth {
  const llmCallFailures = countLlmCallFailures(input.log);
  const answered = input.answers.length;
  // An answer is itself evidence that an ask happened, so the count can never be below it: a run
  // whose trace recorded fewer calls than its dialogue recorded answers is already a named defect,
  // and taking the larger of the two is the reading that cannot understate what was asked.
  const asks = Math.max(input.attempts, answered);
  const cannedResponses = input.answers.filter((a) => a.trim() === CANNED_USER_RESPONSE).length;
  const realAnswers = answered - cannedResponses;
  const unanswered = asks - answered;
  const verdict: SimulatorVerdict =
    llmCallFailures > 0 || (asks > 0 && realAnswers === 0)
      ? "void"
      : cannedResponses + unanswered > 0
        ? "degraded"
        : "healthy";
  return { llmCallFailures, asks, answered, cannedResponses, verdict };
}
