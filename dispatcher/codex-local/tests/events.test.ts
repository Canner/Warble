import assert from "node:assert/strict";
import { test } from "node:test";

import { CodexDispatchError, CodexJsonlMapper } from "../src/index.js";

function line(value: unknown): string {
  return JSON.stringify(value);
}

function mapper(): CodexJsonlMapper {
  return new CodexJsonlMapper("connect", "setup", ["probe_setup"]);
}

test("maps Codex JSONL into stable step/tool/answer events", () => {
  const subject = mapper();
  const events = [
    ...subject.nextLine(line({ type: "thread.started", thread_id: "thread-1" })),
    ...subject.nextLine(line({ type: "turn.started" })),
    ...subject.nextLine(
      line({
        type: "item.started",
        item: {
          id: "tool-1",
          type: "mcp_tool_call",
          server: "setup",
          tool: "probe_setup",
          arguments: { component: "connect_source" },
        },
      }),
    ),
    ...subject.nextLine(
      line({
        type: "item.completed",
        item: {
          id: "tool-1",
          type: "mcp_tool_call",
          server: "setup",
          tool: "probe_setup",
          status: "completed",
          result: { ok: true },
        },
      }),
    ),
    ...subject.nextLine(
      line({
        type: "item.completed",
        item: { id: "message-1", type: "agent_message", text: "done" },
      }),
    ),
    ...subject.nextLine(line({ type: "turn.completed" })),
  ];
  assert.deepEqual(events, [
    { t: "step_start", id: "connect", name: "connect" },
    {
      t: "tool_call",
      id: "tool-1",
      name: "setup.probe_setup",
    },
    { t: "tool_result", id: "tool-1", ok: true },
    { t: "answer", text: "done" },
    { t: "step_finish", id: "connect", ok: true },
  ]);
  assert.deepEqual(subject.result(), {
    finalText: "done",
    threadStarted: true,
    turnCompleted: true,
  });
});

test("forbidden shell/file/web items loud-fail even if Codex emits one", () => {
  for (const forbidden of ["command_execution", "file_change", "web_search"]) {
    const subject = mapper();
    subject.nextLine(line({ type: "thread.started", thread_id: "thread-1" }));
    subject.nextLine(line({ type: "turn.started" }));
    assert.throws(
      () =>
        subject.nextLine(
          line({
            type: "item.completed",
            item: { id: "bad-1", type: forbidden, status: "completed" },
          }),
        ),
      (error: unknown) =>
        error instanceof CodexDispatchError &&
        error.message.includes(`forbidden '${forbidden}'`),
    );
  }
});

test("malformed JSON and incomplete terminal protocol loud-fail", () => {
  const malformed = mapper();
  assert.throws(() => malformed.nextLine("not-json"), /non-JSONL/);

  const incomplete = mapper();
  incomplete.nextLine(line({ type: "thread.started", thread_id: "thread-1" }));
  incomplete.nextLine(line({ type: "turn.started" }));
  assert.throws(() => incomplete.result(), /without turn.completed/);
});

test("turn failure and required MCP tool failure loud-fail even if a terminal event exists", () => {
  const turnFailure = mapper();
  turnFailure.nextLine(line({ type: "thread.started", thread_id: "thread-1" }));
  turnFailure.nextLine(line({ type: "turn.started" }));
  const failureEvents = turnFailure.nextLine(
    line({ type: "turn.failed", error: { message: "postgres://user:secret@example.test/db" } }),
  );
  assert.doesNotMatch(JSON.stringify(failureEvents), /secret/);
  assert.throws(
    () => turnFailure.result(),
    (error: unknown) =>
      error instanceof CodexDispatchError &&
      /codex turn failed/.test(error.message) &&
      !error.message.includes("secret"),
  );

  const runtimeError = mapper();
  runtimeError.nextLine(line({ type: "thread.started", thread_id: "thread-1" }));
  runtimeError.nextLine(line({ type: "turn.started" }));
  const runtimeEvents = runtimeError.nextLine(
    line({ type: "error", message: "token=secret-value" }),
  );
  assert.doesNotMatch(JSON.stringify(runtimeEvents), /secret-value/);
  assert.throws(
    () => runtimeError.result(),
    (error: unknown) =>
      error instanceof CodexDispatchError &&
      /codex runtime error/.test(error.message) &&
      !error.message.includes("secret-value"),
  );

  const toolFailure = mapper();
  toolFailure.nextLine(line({ type: "thread.started", thread_id: "thread-1" }));
  toolFailure.nextLine(line({ type: "turn.started" }));
  toolFailure.nextLine(
    line({
      type: "item.started",
      item: { id: "tool-1", type: "mcp_tool_call", server: "setup", tool: "probe_setup" },
    }),
  );
  toolFailure.nextLine(
    line({
      type: "item.completed",
      item: {
        id: "tool-1",
        type: "mcp_tool_call",
        server: "setup",
        tool: "probe_setup",
        status: "failed",
        error: "fixture failure",
      },
    }),
  );
  toolFailure.nextLine(
    line({
      type: "item.completed",
      item: { id: "message-1", type: "agent_message", text: "could not connect" },
    }),
  );
  assert.throws(
    () => toolFailure.nextLine(line({ type: "turn.completed" })),
    /required MCP tool failed/,
  );
});

test("enforces thread/turn ordering and rejects every post-terminal event", () => {
  const duplicateThread = mapper();
  duplicateThread.nextLine(line({ type: "thread.started", thread_id: "thread-1" }));
  assert.throws(
    () => duplicateThread.nextLine(line({ type: "thread.started", thread_id: "thread-2" })),
    /duplicate or out-of-order thread.started/,
  );

  const outOfOrder = mapper();
  assert.throws(
    () => outOfOrder.nextLine(line({ type: "turn.started" })),
    /before thread.started/,
  );
  outOfOrder.nextLine(line({ type: "thread.started", thread_id: "thread-1" }));
  assert.throws(
    () =>
      outOfOrder.nextLine(
        line({ type: "item.completed", item: { type: "agent_message", text: "early" } }),
      ),
    /before turn.started/,
  );

  const terminal = mapper();
  terminal.nextLine(line({ type: "thread.started", thread_id: "thread-1" }));
  terminal.nextLine(line({ type: "turn.started" }));
  terminal.nextLine(
    line({
      type: "item.started",
      item: { id: "tool-1", type: "mcp_tool_call", server: "setup", tool: "probe_setup" },
    }),
  );
  terminal.nextLine(
    line({
      type: "item.completed",
      item: {
        id: "tool-1",
        type: "mcp_tool_call",
        server: "setup",
        tool: "probe_setup",
        status: "completed",
        result: { ok: true },
      },
    }),
  );
  terminal.nextLine(
    line({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
  );
  terminal.nextLine(line({ type: "turn.completed" }));
  assert.throws(
    () =>
      terminal.nextLine(
        line({ type: "item.completed", item: { type: "agent_message", text: "late" } }),
      ),
    /after the terminal turn event/,
  );
});

test("rejects non-allowlisted MCP identities, zero calls, and pending calls", () => {
  for (const item of [
    { id: "tool-1", type: "mcp_tool_call", server: "decoy", tool: "probe_setup" },
    { id: "tool-1", type: "mcp_tool_call", server: "setup", tool: "not_allowlisted" },
  ]) {
    const subject = mapper();
    subject.nextLine(line({ type: "thread.started", thread_id: "thread-1" }));
    subject.nextLine(line({ type: "turn.started" }));
    assert.throws(
      () => subject.nextLine(line({ type: "item.started", item })),
      /non-allowlisted MCP tool/,
    );
  }

  const zeroCalls = mapper();
  zeroCalls.nextLine(line({ type: "thread.started", thread_id: "thread-1" }));
  zeroCalls.nextLine(line({ type: "turn.started" }));
  zeroCalls.nextLine(
    line({ type: "item.completed", item: { type: "agent_message", text: "fabricated" } }),
  );
  assert.throws(
    () => zeroCalls.nextLine(line({ type: "turn.completed" })),
    /without a successful allowlisted MCP tool call/,
  );

  const pending = mapper();
  pending.nextLine(line({ type: "thread.started", thread_id: "thread-1" }));
  pending.nextLine(line({ type: "turn.started" }));
  pending.nextLine(
    line({
      type: "item.started",
      item: { id: "tool-1", type: "mcp_tool_call", server: "setup", tool: "probe_setup" },
    }),
  );
  assert.throws(
    () => pending.nextLine(line({ type: "turn.completed" })),
    /pending MCP tool calls/,
  );
});

test("never emits raw MCP arguments, results, or error details", () => {
  const subject = mapper();
  const secret = "postgres://user:secret@example.test/db";
  subject.nextLine(line({ type: "thread.started", thread_id: "thread-1" }));
  subject.nextLine(line({ type: "turn.started" }));
  const started = subject.nextLine(
    line({
      type: "item.started",
      item: {
        id: "tool-1",
        type: "mcp_tool_call",
        server: "setup",
        tool: "probe_setup",
        arguments: { dsn: secret },
      },
    }),
  );
  const completed = subject.nextLine(
    line({
      type: "item.completed",
      item: {
        id: "tool-1",
        type: "mcp_tool_call",
        server: "setup",
        tool: "probe_setup",
        status: "completed",
        result: { dsn: secret },
      },
    }),
  );
  assert.doesNotMatch(JSON.stringify([...started, ...completed]), /secret/);
  assert.deepEqual(started, [{ t: "tool_call", id: "tool-1", name: "setup.probe_setup" }]);
  assert.deepEqual(completed, [{ t: "tool_result", id: "tool-1", ok: true }]);

  const failed = mapper();
  failed.nextLine(line({ type: "thread.started", thread_id: "thread-1" }));
  failed.nextLine(line({ type: "turn.started" }));
  failed.nextLine(
    line({
      type: "item.started",
      item: { id: "tool-2", type: "mcp_tool_call", server: "setup", tool: "probe_setup" },
    }),
  );
  const failureEvent = failed.nextLine(
    line({
      type: "item.completed",
      item: {
        id: "tool-2",
        type: "mcp_tool_call",
        server: "setup",
        tool: "probe_setup",
        status: "failed",
        error: secret,
      },
    }),
  );
  assert.doesNotMatch(JSON.stringify(failureEvent), /secret/);
  assert.deepEqual(failureEvent, [
    { t: "tool_result", id: "tool-2", ok: false, error: "allowlisted MCP tool failed" },
  ]);
});
