import { test } from "node:test";
import assert from "node:assert/strict";

import { aggregateTrace } from "../src/run.js";
import { makeReadOnlyGuard } from "../src/guardrails.js";

// aggregateTrace is pure — exercise it with synthetic SDK messages (no live query() needed).
// Cast through unknown: we only touch the fields aggregateTrace reads.
function assistant(model: string, parent: string | null, inputTokens: number): unknown {
  return {
    type: "assistant",
    parent_tool_use_id: parent,
    message: { model, usage: { input_tokens: inputTokens, output_tokens: 10 } },
  };
}

function result(): unknown {
  return {
    type: "result",
    subtype: "success",
    result: '{ "blocks": [], "summary": "ok" }',
    total_cost_usd: 0.12,
    duration_ms: 3400,
    duration_api_ms: 3000,
    num_turns: 4,
    usage: { input_tokens: 100, output_tokens: 40 },
    modelUsage: {
      opus: { inputTokens: 60, outputTokens: 20, costUSD: 0.1 },
      haiku: { inputTokens: 40, outputTokens: 20, costUSD: 0.02 },
    },
  };
}

test("aggregateTrace captures per-step usage + per-model (≈per-tier) cost from the message stream", () => {
  const messages = [
    assistant("opus", null, 60), // driver / plan step
    assistant("haiku", "tool_123", 40), // subagent turn (has a parent tool use id)
    result(),
  ] as never[];

  const trace = aggregateTrace(
    messages,
    { target: "claude-agent-sdk:local", verb: "generate_dashboard", model: "sonnet", split: true },
    [],
  );

  assert.equal(trace.steps.length, 2);
  assert.equal(trace.steps[0]!.model, "opus");
  assert.equal(trace.steps[1]!.parent_tool_use_id, "tool_123");
  assert.equal(trace.run?.total_cost_usd, 0.12);
  assert.equal(trace.run?.num_turns, 4);
  // per-tier cost granularity the headless file target cannot produce:
  assert.equal(trace.modelUsage["opus"]!.costUSD, 0.1);
  assert.equal(trace.modelUsage["haiku"]!.costUSD, 0.02);
});

test("aggregateTrace with no result message yields run=null (still returns steps/denials)", () => {
  const trace = aggregateTrace(
    [assistant("opus", null, 10)] as never[],
    { target: "t", verb: "v", model: "opus", split: false },
    [{ tool: "Bash", reason: "blocked", command: "rm -rf /" }],
  );
  assert.equal(trace.run, null);
  assert.equal(trace.steps.length, 1);
  assert.equal(trace.denials[0]!.command, "rm -rf /");
});

// --- guardrail runtime enforcement (the differentiator) ----------------------------------------

test("read-only guard: allows `wren` bash, denies non-wren + destructive + Write", async () => {
  const { canUseTool, denials } = makeReadOnlyGuard({ readOnly: true, writeScope: null, cwd: "/proj" });

  assert.equal((await canUseTool("Bash", { command: 'wren --sql "select 1"' }, opts())).behavior, "allow");
  assert.equal((await canUseTool("Read", { file_path: "x" }, opts())).behavior, "allow");

  const psql = await canUseTool("Bash", { command: "psql -c 'select 1'" }, opts());
  assert.equal(psql.behavior, "deny");

  const rm = await canUseTool("Bash", { command: "wren --sql x && rm -rf /" }, opts());
  assert.equal(rm.behavior, "deny");

  const redirect = await canUseTool("Bash", { command: "wren --sql x > /tmp/out" }, opts());
  assert.equal(redirect.behavior, "deny");

  const write = await canUseTool("Write", { file_path: "dashboard.html" }, opts());
  assert.equal(write.behavior, "deny");

  // every denial is recorded (proves enforcement fired) and carries a reason
  assert.ok(denials.length >= 4);
  assert.ok(denials.every((d) => d.reason.length > 0));
});

test("read-only guard: prompt flavor allows Write inside scope, denies outside", async () => {
  const { canUseTool } = makeReadOnlyGuard({ readOnly: true, writeScope: ".", cwd: "/proj" });
  assert.equal((await canUseTool("Write", { file_path: "dashboard.html" }, opts())).behavior, "allow");
  assert.equal((await canUseTool("Write", { file_path: "/etc/passwd" }, opts())).behavior, "deny");
});

function opts() {
  return { signal: new AbortController().signal, toolUseID: "t1" };
}
