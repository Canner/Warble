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
  const health = assessSimulator({ log: "LLM call failed: boom\n", answers: [real, real] });
  assert.equal(health.verdict, "void");
  assert.equal(health.llmCallFailures, 1);
});

test("an all-canned ask set voids the run with no log evidence at all", () => {
  const health = assessSimulator({ log: "", answers: [CANNED_USER_RESPONSE, CANNED_USER_RESPONSE] });
  assert.deepEqual(health, { llmCallFailures: 0, asks: 2, cannedResponses: 2, verdict: "void" });
});

test("a partially canned ask set is degraded, not void", () => {
  const health = assessSimulator({ log: "", answers: [real, CANNED_USER_RESPONSE] });
  assert.equal(health.verdict, "degraded");
  assert.equal(health.cannedResponses, 1);
});

test("a clean log with real answers is healthy, and so is a run that never asked", () => {
  assert.equal(assessSimulator({ log: "INFO ready\n", answers: [real] }).verdict, "healthy");
  assert.equal(assessSimulator({ log: "", answers: [] }).verdict, "healthy");
});

test("the canned answer is matched after trimming surrounding whitespace", () => {
  assert.equal(assessSimulator({ log: "", answers: [`  ${CANNED_USER_RESPONSE}\n`] }).verdict, "void");
});
