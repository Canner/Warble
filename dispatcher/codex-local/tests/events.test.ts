import assert from "node:assert/strict";
import { test } from "node:test";

import { CodexDispatchError, CodexJsonlMapper } from "../src/index.js";

function line(value: unknown): string {
  return JSON.stringify(value);
}

test("maps Codex JSONL into stable step/tool/answer events", () => {
  const mapper = new CodexJsonlMapper("connect");
  const events = [
    ...mapper.nextLine(line({ type: "thread.started", thread_id: "thread-1" })),
    ...mapper.nextLine(line({ type: "turn.started" })),
    ...mapper.nextLine(
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
    ...mapper.nextLine(
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
    ...mapper.nextLine(
      line({
        type: "item.completed",
        item: { id: "message-1", type: "agent_message", text: "done" },
      }),
    ),
    ...mapper.nextLine(line({ type: "turn.completed" })),
  ];
  assert.deepEqual(events, [
    { t: "step_start", id: "connect", name: "connect" },
    {
      t: "tool_call",
      id: "tool-1",
      name: "setup.probe_setup",
      input: { component: "connect_source" },
    },
    { t: "tool_result", id: "tool-1", ok: true, summary: '{"ok":true}' },
    { t: "answer", text: "done" },
    { t: "step_finish", id: "connect", ok: true },
  ]);
  assert.deepEqual(mapper.result(), {
    finalText: "done",
    threadStarted: true,
    turnCompleted: true,
  });
});

test("forbidden shell/file/web items loud-fail even if Codex emits one", () => {
  for (const forbidden of ["command_execution", "file_change", "web_search"]) {
    const mapper = new CodexJsonlMapper("connect");
    mapper.nextLine(line({ type: "thread.started", thread_id: "thread-1" }));
    mapper.nextLine(line({ type: "turn.started" }));
    assert.throws(
      () =>
        mapper.nextLine(
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
  const malformed = new CodexJsonlMapper("connect");
  assert.throws(() => malformed.nextLine("not-json"), /non-JSONL/);

  const incomplete = new CodexJsonlMapper("connect");
  incomplete.nextLine(line({ type: "thread.started", thread_id: "thread-1" }));
  incomplete.nextLine(line({ type: "turn.started" }));
  assert.throws(() => incomplete.result(), /without turn.completed/);
});

test("turn failure and required MCP tool failure loud-fail even if a terminal event exists", () => {
  const turnFailure = new CodexJsonlMapper("connect");
  turnFailure.nextLine(line({ type: "thread.started", thread_id: "thread-1" }));
  turnFailure.nextLine(line({ type: "turn.started" }));
  turnFailure.nextLine(line({ type: "turn.failed", error: { message: "model failed" } }));
  assert.throws(() => turnFailure.result(), /codex turn failed/);

  const toolFailure = new CodexJsonlMapper("connect");
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
  toolFailure.nextLine(line({ type: "turn.completed" }));
  assert.throws(() => toolFailure.result(), /required MCP tool failed/);
});
