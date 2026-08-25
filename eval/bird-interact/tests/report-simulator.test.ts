import assert from "node:assert/strict";
import test from "node:test";

import { CANNED_USER_RESPONSE, assessSimulator, countLlmCallFailures } from "../src/report-simulator.js";

const real = "The metric is SNQI, calculated as SnrRatio minus 0.1 times ABS(NoiseFloorDbm).";

test("counts every LLM failure line in the simulator log", () => {
  assert.equal(countLlmCallFailures(""), 0);
  assert.equal(
    countLlmCallFailures("LLM call failed: litellm.BadRequestError\nLLM call failed: again\n"),
    2,
  );
});

test("one LLM failure voids the run even when some answers look real", () => {
  const health = assessSimulator({ log: "LLM call failed: boom\n", attempts: 2, answers: [real, real] });
  assert.equal(health.verdict, "void");
  assert.equal(health.llmCallFailures, 1);
});

test("an all-canned ask set voids the run with no log evidence at all", () => {
  const health = assessSimulator({
    log: "",
    attempts: 2,
    answers: [CANNED_USER_RESPONSE, CANNED_USER_RESPONSE],
  });
  assert.deepEqual(health, {
    llmCallFailures: 0,
    asks: 2,
    answered: 2,
    cannedResponses: 2,
    verdict: "void",
  });
});

test("a partially canned ask set is degraded, not void", () => {
  const health = assessSimulator({ log: "", attempts: 2, answers: [real, CANNED_USER_RESPONSE] });
  assert.equal(health.verdict, "degraded");
  assert.equal(health.cannedResponses, 1);
});

test("a clean log with real answers is healthy, and so is a run that never asked", () => {
  assert.equal(assessSimulator({ log: "INFO ready\n", attempts: 1, answers: [real] }).verdict, "healthy");
  assert.equal(assessSimulator({ log: "", attempts: 0, answers: [] }).verdict, "healthy");
});

test("the canned answer is matched after trimming surrounding whitespace", () => {
  assert.equal(
    assessSimulator({ log: "", attempts: 1, answers: [`  ${CANNED_USER_RESPONSE}\n`] }).verdict,
    "void",
  );
});

/**
 * The failure this whole section exists for, in its purest form.
 *
 * A `ask_user` that errors — transport, HTTP 500, the simulator's own `404 Task not initialized` —
 * is charged and recorded, and `tools.ts` writes NO dialogue turn for it. Grading on answers alone
 * therefore saw a run that answered nothing as a run with nothing to answer, and called it
 * `healthy`; `--log-level warning` means the log need not carry the failures either.
 */
test("a run whose every attempted ask came back with nothing is void, not healthy", () => {
  const health = assessSimulator({ log: "", attempts: 3, answers: [] });
  assert.equal(health.verdict, "void", "no answer to any attempted ask is the void case");
  assert.equal(health.asks, 3, "the attempts are the denominator, not the answers");
  assert.equal(health.answered, 0);
  assert.equal(health.cannedResponses, 0, "an unanswered ask is not a canned one");
});

test("an attempted ask that produced nothing degrades a run whose other asks were real", () => {
  const health = assessSimulator({ log: "", attempts: 2, answers: [real] });
  assert.equal(health.verdict, "degraded", "some real and some not is degraded");
  assert.equal(health.asks, 2);
  assert.equal(health.answered, 1);
});

test("one real answer among unanswered and canned attempts is still degraded, never void", () => {
  const health = assessSimulator({ log: "", attempts: 3, answers: [real, CANNED_USER_RESPONSE] });
  assert.equal(health.verdict, "degraded");
  assert.equal(health.asks, 3);
  assert.equal(health.cannedResponses, 1);
});

/**
 * An answer with no attempt recorded beside it means the trace under-counted, which the builder
 * already names as a defect. The reading that cannot understate what was asked is the larger of
 * the two, so an all-canned dialogue still voids the run even when no `ask_user` call was recorded.
 */
test("recorded answers raise the ask count when the trace recorded fewer attempts", () => {
  const health = assessSimulator({ log: "", attempts: 0, answers: [CANNED_USER_RESPONSE] });
  assert.equal(health.asks, 1);
  assert.equal(health.verdict, "void");
});
