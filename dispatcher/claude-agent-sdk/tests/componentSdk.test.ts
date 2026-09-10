import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sentOptions: Record<string, unknown>[] = [];
const registered: Array<{ name: string; description: string; handler: (args: { request: string; input?: Record<string, unknown> }) => Promise<unknown> }> = [];

mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: ({ options }: { options: Record<string, unknown> }) => {
      sentOptions.push(options);
      return (async function* () {
        yield {
          type: "assistant",
          parent_tool_use_id: null,
          message: { model: "haiku", usage: { input_tokens: 2, output_tokens: 1 }, content: [] },
        };
        yield {
          type: "result",
          subtype: "success",
          result: '{"root":true}',
          session_id: "must-not-be-exposed",
          total_cost_usd: 0.01,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          usage: { input_tokens: 2, output_tokens: 1 },
          modelUsage: {},
        };
      })();
    },
    tool: (
      name: string,
      description: string,
      _schema: unknown,
      handler: (args: { request: string; input?: Record<string, unknown> }) => Promise<unknown>,
    ) => {
      registered.push({ name, description, handler });
      return { name };
    },
    createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ type: "sdk", name, tools }),
  },
});

test("SDK step execution installs only active-step aliases in a fresh non-persisted session", async () => {
  const { createSdkComponentStepRunner, parseIr, prepareDispatch } = await import("../src/index.js");
  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = JSON.parse(readFileSync(join(here, "..", "..", "conformance-fixtures", "component-composition-unsupported.json"), "utf8")) as { ir: unknown };
  const prepared = prepareDispatch({ ir: parseIr(JSON.stringify(fixture.ir)), componentId: "caller", question: "root" });
  const caller = prepared.components[0]!;
  const callee = prepared.preparedCallees[0]!;
  const hostCalls: string[] = [];
  const sdk = createSdkComponentStepRunner({
    hostCanUseTool: async (name, input) => {
      hostCalls.push(name);
      return name === "Bash"
        ? { behavior: "deny", message: "host denial" }
        : { behavior: "allow", updatedInput: input };
    },
  });
  registered.length = 0;
  sentOptions.length = 0;
  const invoked: string[] = [];
  const output = await sdk.runStep({
    rootRunId: "root-run",
    callId: null,
    parentCallId: null,
    component: caller,
    step: caller.steps[0]!,
    request: { request: "root", input: {} },
    artifacts: {},
    aliases: ["answer"],
    signal: new AbortController().signal,
    maxTurns: 7,
    invoke: async (alias) => {
      invoked.push(alias);
      return { status: "ok", output: { kind: "value", value: 42 } };
    },
  });

  assert.equal(output.text, '{"root":true}');
  assert.equal(output.turns, 1);
  assert.deepEqual(registered.map((entry) => entry.name), ["answer"]);
  assert.ok(!registered[0]!.description.includes("callee"));
  const options = sentOptions[0]!;
  assert.equal(options["persistSession"], false);
  assert.equal(options["resume"], undefined);
  assert.equal(options["maxTurns"], 7);
  assert.deepEqual(options["tools"], ["Read"]);
  assert.deepEqual(options["allowedTools"], ["Read"]);
  assert.ok(JSON.stringify(options["mcpServers"]).includes("answer"));
  const systemPrompt = String(options["systemPrompt"]);
  assert.match(systemPrompt, /You are bound to the wren project at/);
  assert.match(systemPrompt, /Use the answer alias when needed\./);
  assert.doesNotMatch(systemPrompt, /Invoke answer only if it helps\./);

  const canUseTool = options["canUseTool"] as (name: string, input: Record<string, unknown>, extra: unknown) => Promise<{ behavior: string }>;
  assert.equal((await canUseTool("Bash", { command: "wren --sql select 1" }, {})).behavior, "deny");
  assert.deepEqual(hostCalls, ["Bash"]);
  assert.equal((await canUseTool(
    "mcp__warble_components__answer",
    { request: "child", input: {} },
    {},
  )).behavior, "allow");
  assert.deepEqual(hostCalls, ["Bash", "mcp__warble_components__answer"]);
  await registered[0]!.handler({ request: "child", input: {} });
  assert.deepEqual(invoked, ["answer"]);
  assert.deepEqual(hostCalls, ["Bash", "mcp__warble_components__answer"]);

  await sdk.runStep({
    rootRunId: "root-run",
    callId: "child-call",
    parentCallId: null,
    component: callee,
    step: callee.steps[0]!,
    request: { request: "child", input: {} },
    artifacts: {},
    aliases: [],
    signal: new AbortController().signal,
    maxTurns: 5,
    invoke: async () => assert.fail("callee has no authorized alias"),
  });
  const calleeOptions = sentOptions[1]!;
  assert.equal(calleeOptions["persistSession"], false);
  assert.equal(calleeOptions["resume"], undefined);
  assert.equal(calleeOptions["model"], callee.steps[0]!.model);
  assert.equal(calleeOptions["cwd"], callee.plan.options.cwd);
  assert.deepEqual(calleeOptions["tools"], callee.plan.options.tools);
  assert.deepEqual(calleeOptions["allowedTools"], ["Read"]);
  assert.notEqual(calleeOptions["abortController"], options["abortController"]);
  const calleePrompt = String(calleeOptions["systemPrompt"]);
  assert.match(calleePrompt, /Answer the bounded request\./);
  assert.doesNotMatch(calleePrompt, /Return one answer\./);
});

test("the trusted invocation handler enforces host denial even when canUseTool is bypassed", async () => {
  const { createSdkComponentStepRunner, parseIr, prepareDispatch } = await import("../src/index.js");
  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = JSON.parse(readFileSync(join(here, "..", "..", "conformance-fixtures", "component-composition-unsupported.json"), "utf8")) as { ir: unknown };
  const prepared = prepareDispatch({ ir: parseIr(JSON.stringify(fixture.ir)), componentId: "caller", question: "root" });
  const caller = prepared.components[0]!;
  registered.length = 0;
  sentOptions.length = 0;
  let invoked = false;
  const hostCalls: string[] = [];
  const sdk = createSdkComponentStepRunner({
    hostCanUseTool: async (name, input) => {
      hostCalls.push(name);
      return name === "mcp__warble_components__answer"
        ? { behavior: "deny", message: "host denial" }
        : { behavior: "allow", updatedInput: input };
    },
  });
  await sdk.runStep({
    rootRunId: "root-run",
    callId: null,
    parentCallId: null,
    component: caller,
    step: caller.steps[0]!,
    request: { request: "root", input: {} },
    artifacts: {},
    aliases: ["answer"],
    signal: new AbortController().signal,
    maxTurns: 7,
    invoke: async () => {
      invoked = true;
      return { status: "ok", output: { kind: "value", value: 42 } };
    },
  });
  const options = sentOptions[0]!;
  const canUseTool = options["canUseTool"] as (name: string, input: Record<string, unknown>, extra: unknown) => Promise<{ behavior: string }>;
  assert.equal((await canUseTool(
    "mcp__warble_components__answer",
    { request: "child", input: {} },
    {},
  )).behavior, "deny");
  await assert.rejects(
    () => registered[0]!.handler({ request: "child", input: {} }),
    /denied by the embedding host/,
  );
  assert.equal(invoked, false);
  assert.deepEqual(hostCalls, [
    "mcp__warble_components__answer",
    "mcp__warble_components__answer",
  ]);
});

test("an independently prepared SQL callee retains its own read-only permission decision", async () => {
  const { createSdkComponentStepRunner, parseIr, prepareDispatch } = await import("../src/index.js");
  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = JSON.parse(readFileSync(join(here, "..", "..", "conformance-fixtures", "component-composition-unsupported.json"), "utf8")) as { ir: unknown };
  const ir = parseIr(JSON.stringify(fixture.ir));
  ir.components[1]!.required_capabilities.push("sql_execution:read_only");
  const prepared = prepareDispatch({ ir, componentId: "caller", question: "root" });
  const callee = prepared.preparedCallees[0]!;
  registered.length = 0;
  sentOptions.length = 0;
  const sdk = createSdkComponentStepRunner();
  await sdk.runStep({
    rootRunId: "root-run",
    callId: "child-call",
    parentCallId: null,
    component: callee,
    step: callee.steps[0]!,
    request: { request: "child", input: {} },
    artifacts: {},
    aliases: [],
    signal: new AbortController().signal,
    maxTurns: 5,
    invoke: async () => assert.fail("callee has no authorized alias"),
  });
  const options = sentOptions[0]!;
  assert.deepEqual(options["tools"], ["Read", "Bash"]);
  const canUseTool = options["canUseTool"] as (name: string, input: Record<string, unknown>, extra: unknown) => Promise<{ behavior: string }>;
  assert.equal((await canUseTool("Bash", { command: "wren --sql select 42" }, {})).behavior, "allow");
});
