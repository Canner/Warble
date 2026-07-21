import { test } from "node:test";
import assert from "node:assert/strict";

import { ChatEventMapper, type WarbleChatEvent } from "../src/events.js";

// Synthetic SDK messages — same minimal shape ChatEventMapper reads (see events.ts's doc comment on
// why it can't lean on the SDK's own content-block types here). Cast through unknown/never like
// run.test.ts's own synthetic messages.
function assistantText(text: string, parent: string | null = null): unknown {
  return { type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "text", text }] } };
}

function assistantToolUse(id: string, name: string, input: unknown, parent: string | null = null): unknown {
  return {
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id, name, input }] },
  };
}

function userToolResult(toolUseId: string, content: unknown, isError = false): unknown {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
  };
}

function other(type: string): unknown {
  return { type };
}

test("no events until the first tool_use — plain assistant text produces nothing", () => {
  const mapper = new ChatEventMapper("answer_query");
  const events = mapper.next(assistantText("thinking…") as never);
  assert.deepEqual(events, []);
});

test("first tool_use opens the enclosing step, then emits the tool_call", () => {
  const mapper = new ChatEventMapper("answer_query");
  const events = mapper.next(assistantToolUse("tool_1", "wren_query", { sql: "select 1" }) as never);

  assert.deepEqual(events, [
    { t: "step_start", id: "answer_query", name: "answer_query", parent: null, depth: 0 },
    {
      t: "tool_call",
      id: "tool_1",
      name: "wren_query",
      input: { sql: "select 1" },
      parent: null,
      depth: 0,
    },
  ] satisfies WarbleChatEvent[]);
});

test("a second tool_use does not re-open the step", () => {
  const mapper = new ChatEventMapper("answer_query");
  mapper.next(assistantToolUse("tool_1", "wren_query", {}) as never);
  const events = mapper.next(assistantToolUse("tool_2", "wren_schema", {}) as never);

  assert.deepEqual(events, [
    { t: "tool_call", id: "tool_2", name: "wren_schema", input: {}, parent: null, depth: 0 },
  ] satisfies WarbleChatEvent[]);
});

test("a matching tool_result pairs with its tool_use and reports success", () => {
  const mapper = new ChatEventMapper("answer_query");
  mapper.next(assistantToolUse("tool_1", "wren_query", { sql: "select 1" }) as never);
  const events = mapper.next(userToolResult("tool_1", [{ type: "text", text: "42" }]) as never);

  assert.deepEqual(events, [
    { t: "tool_result", id: "tool_1", ok: true, summary: "42" },
  ] satisfies WarbleChatEvent[]);
});

test("an is_error tool_result reports failure with the error text, not a summary", () => {
  const mapper = new ChatEventMapper("answer_query");
  mapper.next(assistantToolUse("tool_1", "wren_query", {}) as never);
  const events = mapper.next(userToolResult("tool_1", "syntax error near SELECT", true) as never);

  assert.deepEqual(events, [
    { t: "tool_result", id: "tool_1", ok: false, error: "syntax error near SELECT" },
  ] satisfies WarbleChatEvent[]);
});

test("a tool_result for an id never seen as tool_use is dropped, not fabricated", () => {
  const mapper = new ChatEventMapper("answer_query");
  const events = mapper.next(userToolResult("unknown_tool_id", "whatever") as never);
  assert.deepEqual(events, []);
});

test("Task-subagent tool calls (parent_tool_use_id set) carry parent + depth 1", () => {
  const mapper = new ChatEventMapper("answer_query");
  mapper.next(assistantToolUse("task_1", "Task", { prompt: "..." }) as never); // opens the driver-level tool call
  const events = mapper.next(assistantToolUse("tool_2", "wren_query", {}, "task_1") as never);

  assert.deepEqual(events, [
    { t: "tool_call", id: "tool_2", name: "wren_query", input: {}, parent: "task_1", depth: 1 },
  ] satisfies WarbleChatEvent[]);
});

test("message kinds the mapper doesn't handle (system/result/etc.) produce no events", () => {
  const mapper = new ChatEventMapper("answer_query");
  assert.deepEqual(mapper.next(other("result") as never), []);
  assert.deepEqual(mapper.next(other("system") as never), []);
});

test("finish() before any step was opened produces nothing", () => {
  const mapper = new ChatEventMapper("answer_query");
  assert.deepEqual(mapper.finish(true), []);
});

test("finish(true) after a step opened closes it with ok: true and no detail", () => {
  const mapper = new ChatEventMapper("answer_query");
  mapper.next(assistantToolUse("tool_1", "wren_query", {}) as never);
  assert.deepEqual(mapper.finish(true), [
    { t: "step_finish", id: "answer_query", ok: true },
  ] satisfies WarbleChatEvent[]);
});

test("finish(false, detail) closes the step with ok: false and the given detail", () => {
  const mapper = new ChatEventMapper("answer_query");
  mapper.next(assistantToolUse("tool_1", "wren_query", {}) as never);
  assert.deepEqual(mapper.finish(false, "agent run failed"), [
    { t: "step_finish", id: "answer_query", ok: false, detail: "agent run failed" },
  ] satisfies WarbleChatEvent[]);
});

test("end-to-end sequence: tool_use -> tool_result -> finish, in order, with result pairing", () => {
  const mapper = new ChatEventMapper("answer_query");
  const all: WarbleChatEvent[] = [];
  const feed = (m: unknown): void => {
    all.push(...mapper.next(m as never));
  };

  feed(assistantText("Let me check that."));
  feed(assistantToolUse("tool_1", "wren_query", { sql: "select 1" }));
  feed(userToolResult("tool_1", [{ type: "text", text: "1 row" }]));
  all.push(...mapper.finish(true));

  assert.deepEqual(all, [
    { t: "step_start", id: "answer_query", name: "answer_query", parent: null, depth: 0 },
    {
      t: "tool_call",
      id: "tool_1",
      name: "wren_query",
      input: { sql: "select 1" },
      parent: null,
      depth: 0,
    },
    { t: "tool_result", id: "tool_1", ok: true, summary: "1 row" },
    { t: "step_finish", id: "answer_query", ok: true },
  ] satisfies WarbleChatEvent[]);
});

test("a long tool_result summary is truncated", () => {
  const mapper = new ChatEventMapper("answer_query");
  mapper.next(assistantToolUse("tool_1", "wren_query", {}) as never);
  const longText = "x".repeat(500);
  const events = mapper.next(userToolResult("tool_1", longText) as never);
  const resultEvent = events[0] as Extract<WarbleChatEvent, { t: "tool_result" }>;

  assert.equal(resultEvent.ok, true);
  assert.ok(resultEvent.summary !== undefined && resultEvent.summary.length <= 240);
  assert.ok(resultEvent.summary!.endsWith("…"));
});
