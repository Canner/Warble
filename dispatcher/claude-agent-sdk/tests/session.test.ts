import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appendTurn,
  buildTurnPrompt,
  createSessionState,
  decideClarify,
  DEFAULT_CLARIFY_THRESHOLD,
  distillFollowup,
  lastResolvedIntent,
  lastSessionId,
  type ResolvedIntent,
  type SessionState,
  type Turn,
} from "../src/session.js";

function turn(over: Partial<Turn>): Turn {
  return {
    question: "orders overview",
    prompt: "orders overview",
    intent: null,
    sessionId: null,
    finalText: "…",
    ...over,
  };
}

// --- session state accumulation -----------------------------------------------------------------

test("session state accumulates turns and carries the last session_id forward", () => {
  let state: SessionState = createSessionState();
  assert.equal(state.turns.length, 0);
  assert.equal(lastSessionId(state), null);

  state = appendTurn(state, turn({ question: "completed orders", sessionId: "sess-1" }));
  assert.equal(state.turns.length, 1);
  assert.equal(lastSessionId(state), "sess-1"); // turn 2 would resume turn 1

  state = appendTurn(state, turn({ question: "break it down by region", sessionId: "sess-2" }));
  assert.equal(state.turns.length, 2);
  assert.equal(lastSessionId(state), "sess-2"); // turn 3 would resume turn 2, not turn 1
  // appendTurn is pure — earlier state snapshot is untouched
  assert.equal(state.turns[0]!.sessionId, "sess-1");
});

// `ChatSession`'s resume-anchor precedence — `lastSessionId(state) ?? initialResumeSessionId ?? null`
// (session.ts's `ask()`) — is exercised here at the pure-state level, since `ChatSession` itself calls
// the live `runDispatch` with no injection seam (untested by the offline suite, per cli.ts's docstring
// on `chat`). Empty state falls through to a caller-seeded session id; once a real turn has run, that
// turn's own session id takes over, exactly as if no seed had ever been supplied.
test("resume-anchor precedence: an empty session state falls through to a seeded initial session id, but a real turn's own session id wins once one exists", () => {
  const empty: SessionState = createSessionState();
  const seeded = "seeded-from-earlier-process";
  assert.equal(lastSessionId(empty) ?? seeded, seeded);

  const withTurn = appendTurn(empty, turn({ sessionId: "sess-real" }));
  assert.equal(lastSessionId(withTurn) ?? seeded, "sess-real");
});

test("lastResolvedIntent tracks the most recently supplied intent, null when none supplied", () => {
  let state: SessionState = createSessionState();
  assert.equal(lastResolvedIntent(state), null);

  const intent: ResolvedIntent = { filters: ["status = 'completed'"], dimensions: [], measures: ["count"] };
  state = appendTurn(state, turn({ intent }));
  assert.deepEqual(lastResolvedIntent(state), intent);

  state = appendTurn(state, turn({ intent: null }));
  assert.equal(lastResolvedIntent(state), null); // most recent turn tracked no intent
});

// --- distillFollowup: carry filters, swap dimensions ---------------------------------------------

test("distillFollowup reuses the prior filter and swaps the dimension for a breakdown follow-up", () => {
  const prevIntent: ResolvedIntent = {
    filters: ["status = 'completed'"],
    dimensions: ["month"],
    measures: ["order_count"],
  };
  const distilled = distillFollowup(prevIntent, "break it down by region");

  assert.match(distilled, /status = 'completed'/); // carried filter reused
  assert.match(distilled, /region/); // new breakdown swapped in
  assert.doesNotMatch(distilled, /breakdown swapped to: month/); // old dimension is not the new one
  assert.match(distilled, /break it down by region/); // original question preserved verbatim
});

test("distillFollowup carries dimensions forward when the follow-up names no new breakdown", () => {
  const prevIntent: ResolvedIntent = {
    filters: ["status = 'completed'"],
    dimensions: ["region"],
    measures: [],
  };
  const distilled = distillFollowup(prevIntent, "what about last quarter");

  assert.match(distilled, /status = 'completed'/);
  assert.match(distilled, /dimension\(s\): region/);
});

test("distillFollowup drops the carried filter when the follow-up signals its own override", () => {
  const prevIntent: ResolvedIntent = {
    filters: ["status = 'completed'"],
    dimensions: ["region"],
    measures: [],
  };
  const distilled = distillFollowup(prevIntent, "now only where status = 'shipped'");

  assert.doesNotMatch(distilled, /status = 'completed'/);
});

test("distillFollowup with no carried context at all returns the question unchanged", () => {
  const empty: ResolvedIntent = { filters: [], dimensions: [], measures: [] };
  assert.equal(distillFollowup(empty, "orders overview"), "orders overview");
});

test("buildTurnPrompt: turn 1 is the raw question; turn N is distilled when an intent was carried", () => {
  let state: SessionState = createSessionState();
  assert.equal(buildTurnPrompt(state, "completed orders"), "completed orders");

  const intent: ResolvedIntent = { filters: ["status = 'completed'"], dimensions: ["month"], measures: [] };
  state = appendTurn(state, turn({ question: "completed orders", intent }));
  const prompt = buildTurnPrompt(state, "break it down by region");
  assert.match(prompt, /status = 'completed'/);
  assert.match(prompt, /region/);
});

// --- clarify policy -------------------------------------------------------------------------------

test("decideClarify: below threshold returns a clarify outcome with a question", () => {
  const outcome = decideClarify("show me the numbers", 0.2);
  assert.equal(outcome.kind, "clarify");
  if (outcome.kind === "clarify") {
    assert.match(outcome.question, /show me the numbers/);
  }
});

test("decideClarify: at/above threshold returns an answer outcome", () => {
  assert.deepEqual(decideClarify("completed orders by region", 0.9), { kind: "answer" });
  assert.deepEqual(
    decideClarify("completed orders by region", DEFAULT_CLARIFY_THRESHOLD),
    { kind: "answer" },
  );
});

test("decideClarify respects a caller-supplied threshold", () => {
  assert.equal(decideClarify("q", 0.6, 0.8).kind, "clarify");
  assert.equal(decideClarify("q", 0.6, 0.5).kind, "answer");
});
