import assert from "node:assert/strict";
import test from "node:test";

import type { BirdClient } from "../src/bird-client.js";
import {
  BIRD_MCP_TOOL_NAMES,
  BIRD_MAX_TURNS_MESSAGE,
  WarbleBirdAgent,
  buildBirdAgentOptions,
} from "../src/agent.js";
import { BirdToolRuntime } from "../src/tools.js";
import type { BirdSessionState } from "../src/types.js";
import type { WrenPlanner } from "../src/wren-planner.js";

function state(): BirdSessionState {
  return {
    task_id: "alien_1",
    db_name: "alien",
    user_query: "find it",
    current_phase: 1,
    budget_remaining: 10,
    initial_budget: 10,
    total_reward: 0,
    dialogue_history: [],
    tool_trajectory: [],
    adk_events: [],
    phase1_completed: false,
    phase2_completed: false,
    task_done: false,
  };
}

test("agent options remove built-ins and expose exactly the nine BIRD MCP tools", () => {
  const mcpServer = { type: "sdk", name: "fake" } as never;
  const options = buildBirdAgentOptions({
    baseOptions: {
      cwd: "/wrong",
      systemPrompt: "generic wren CLI preamble",
      tools: ["Read", "Bash"],
      allowedTools: ["Read"],
      disallowedTools: [],
    },
    cwd: "/projects/alien",
    mcpServer,
    systemPrompt: "dedicated BIRD prompt",
  });

  assert.deepEqual(options.tools, []);
  assert.deepEqual([...options.allowedTools ?? []].sort(), [...BIRD_MCP_TOOL_NAMES].sort());
  assert.ok(options.disallowedTools?.includes("Bash"));
  assert.ok(options.disallowedTools?.includes("Read"));
  assert.ok(options.mcpServers?.bird);
  assert.equal(options.cwd, "/projects/alien");
  assert.equal(options.maxTurns, 60);
  assert.equal(options.systemPrompt, "dedicated BIRD prompt");
  assert.equal("resume" in options, false);

  const resumed = buildBirdAgentOptions({
    baseOptions: {},
    cwd: "/projects/alien",
    mcpServer,
    systemPrompt: "dedicated BIRD prompt",
    resumeSessionId: "sdk-session-1",
  });
  assert.equal(resumed.resume, "sdk-session-1");
});

test("WarbleBirdAgent uses the task project, exact message, and SDK resume anchor", async () => {
  const session = state();
  const prepareCalls: unknown[] = [];
  const queryCalls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  let sessionNumber = 0;
  const agent = new WarbleBirdAgent({
    state: session,
    ir: "{}",
    irPath: "/eval/bird-ir.json",
    planner: {
      projectPath: (dbName: string) => `/projects/${dbName}`,
      plan: async (_dbName: string, sql: string) => sql,
    },
    mcpServer: { type: "sdk", name: "fake" } as never,
    prepareDispatch: (input) => {
      prepareCalls.push(input);
      return {
        target: "claude-agent-sdk",
        components: [
          {
            id: "bird_interact",
            node: { prompt_fragment: "dedicated BIRD prompt" },
            report: [],
            plan: { prompt: input.question ?? "", options: { cwd: "/wrong" }, meta: {} },
          },
        ],
      } as never;
    },
    query: (input) => {
      queryCalls.push(input as never);
      sessionNumber += 1;
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "done",
          session_id: `sdk-${sessionNumber}`,
        };
      })() as never;
    },
  });

  await agent.run("first message");
  await agent.run("follow-up message");

  assert.deepEqual(queryCalls.map((call) => call.prompt), ["first message", "follow-up message"]);
  assert.equal(queryCalls[0]?.options.cwd, "/projects/alien");
  assert.equal(queryCalls[0]?.options.systemPrompt, "dedicated BIRD prompt");
  assert.equal("resume" in (queryCalls[0]?.options ?? {}), false);
  assert.equal(queryCalls[1]?.options.resume, "sdk-1");
  assert.equal(session.sdk_session_id, "sdk-2");
  assert.equal((prepareCalls[0] as { project: string }).project, "/projects/alien");
  assert.equal((prepareCalls[1] as { question: string }).question, "follow-up message");
});

test("persists the SDK resume anchor before a failed stream can be retried", async () => {
  const session = state();
  const queryOptions: Array<Record<string, unknown>> = [];
  let attempt = 0;
  const agent = new WarbleBirdAgent({
    state: session,
    ir: "{}",
    irPath: "/eval/bird-ir.json",
    planner: {
      projectPath: () => "/projects/alien",
      plan: async (_dbName, sql) => sql,
    },
    mcpServer: {} as never,
    prepareDispatch: ((input: { question?: string }) => ({
      target: "claude-agent-sdk",
      components: [
        {
          id: "bird_interact",
          node: { prompt_fragment: "dedicated BIRD prompt" },
          report: [],
          plan: { prompt: input.question ?? "", options: {}, meta: {} },
        },
      ],
    })) as never,
    query: ((input: { options: Record<string, unknown> }) => {
      queryOptions.push(input.options);
      attempt += 1;
      return (async function* () {
        if (attempt === 1) {
          yield { type: "assistant", session_id: "sdk-retry" };
          throw new Error("provider interrupted");
        }
        yield {
          type: "result",
          subtype: "success",
          result: "recovered",
          session_id: "sdk-retry",
        };
      })();
    }) as never,
  });

  await assert.rejects(agent.run("first"), /provider interrupted/);
  assert.equal(session.sdk_session_id, "sdk-retry");
  assert.deepEqual(await agent.run("retry"), {
    message: "recovered",
    sessionId: "sdk-retry",
  });
  assert.equal(queryOptions[1]?.resume, "sdk-retry");
});

test("turn 61 returns the official-style terminal response without querying", async () => {
  const session = state();
  session.model_turns = 60;
  let queried = false;
  const agent = new WarbleBirdAgent({
    state: session,
    ir: "{}",
    irPath: "/eval/bird-ir.json",
    planner: { projectPath: () => "/projects/alien", plan: async (_db, sql) => sql },
    mcpServer: {} as never,
    prepareDispatch: (() => {
      throw new Error("prepare should not run");
    }) as never,
    query: (() => {
      queried = true;
      return (async function* () {})();
    }) as never,
  });

  assert.deepEqual(await agent.run("too late"), {
    message: BIRD_MAX_TURNS_MESSAGE,
    sessionId: null,
  });
  assert.equal(queried, false);
  assert.equal(session.model_turns, 61);
});

test("the max-turn callback precedes terminal state at turn 61", async () => {
  const session = Object.assign(state(), {
    task_done: true,
    budget_remaining: -1,
    model_turns: 60,
  });
  const agent = new WarbleBirdAgent({
    state: session,
    ir: "{}",
    irPath: "/eval/bird-ir.json",
    planner: { projectPath: () => "/projects/alien", plan: async (_db, sql) => sql },
    mcpServer: {} as never,
  });

  assert.equal((await agent.run("again")).message, BIRD_MAX_TURNS_MESSAGE);
  assert.equal(session.model_turns, 61);
});

test("completed and exhausted sessions return controlled terminal responses", async () => {
  const cases = [
    {
      session: Object.assign(state(), { task_done: true }),
      message: "Task completed.",
    },
    {
      session: Object.assign(state(), { budget_remaining: -1 }),
      message: "Budget exhausted. Task ended.",
    },
  ];

  for (const item of cases) {
    let queried = false;
    const agent = new WarbleBirdAgent({
      state: item.session,
      ir: "{}",
      irPath: "/eval/bird-ir.json",
      planner: { projectPath: () => "/projects/alien", plan: async (_db, sql) => sql },
      mcpServer: {} as never,
      query: (() => {
        queried = true;
        return (async function* () {})();
      }) as never,
    });

    assert.equal((await agent.run("again")).message, item.message);
    assert.equal(queried, false);
    assert.equal(item.session.model_turns, 1);
  }
});

test("a terminal tool result stops before another model turn", async () => {
  const session = state();
  let reachedPostToolModel = false;
  const agent = new WarbleBirdAgent({
    state: session,
    ir: "{}",
    irPath: "/eval/bird-ir.json",
    planner: { projectPath: () => "/projects/alien", plan: async (_db, sql) => sql },
    mcpServer: {} as never,
    prepareDispatch: ((input: { question?: string }) => ({
      target: "claude-agent-sdk",
      components: [
        {
          id: "bird_interact",
          node: { prompt_fragment: "dedicated BIRD prompt" },
          report: [],
          plan: { prompt: input.question ?? "", options: {}, meta: {} },
        },
      ],
    })) as never,
    query: (() =>
      (async function* () {
        yield { type: "assistant", session_id: "sdk-terminal" };
        session.budget_remaining = -1;
        yield { type: "user", session_id: "sdk-terminal" };
        reachedPostToolModel = true;
        yield { type: "assistant", session_id: "sdk-terminal" };
      })()) as never,
  });

  assert.deepEqual(await agent.run("submit now"), {
    message: "Budget exhausted. Task ended.",
    sessionId: "sdk-terminal",
  });
  assert.equal(reachedPostToolModel, false);
  assert.equal(session.model_turns, 2);
  assert.equal(session.sdk_session_id, "sdk-terminal");
});

test("SDK error_max_turns is a controlled terminal result, not a service error", async () => {
  const session = state();
  const agent = new WarbleBirdAgent({
    state: session,
    ir: "{}",
    irPath: "/eval/bird-ir.json",
    planner: { projectPath: () => "/projects/alien", plan: async (_db, sql) => sql },
    mcpServer: {} as never,
    prepareDispatch: ((input: { question?: string }) => ({
      target: "claude-agent-sdk",
      components: [
        {
          id: "bird_interact",
          node: { prompt_fragment: "dedicated BIRD prompt" },
          report: [],
          plan: { prompt: input.question ?? "", options: {}, meta: {} },
        },
      ],
    })) as never,
    query: (() =>
      (async function* () {
        yield {
          type: "result",
          subtype: "error_max_turns",
          num_turns: 60,
          session_id: "sdk-maxed",
        };
      })()) as never,
  });

  assert.deepEqual(await agent.run("use the remaining turns"), {
    message: BIRD_MAX_TURNS_MESSAGE,
    sessionId: "sdk-maxed",
  });
  assert.equal(session.model_turns, 61);
  assert.equal(session.sdk_session_id, "sdk-maxed");
});

test("completed or negative-budget sessions cannot execute another MCP action", async () => {
  for (const closedState of [
    Object.assign(state(), { task_done: true }),
    Object.assign(state(), { budget_remaining: -1 }),
  ]) {
    let clientCalls = 0;
    const client = {
      getSchema: async () => {
        clientCalls += 1;
        return "schema";
      },
    } as unknown as BirdClient;
    const planner = {
      projectPath: () => "/projects/alien",
      plan: async (_dbName: string, sql: string) => sql,
    } satisfies WrenPlanner;
    const runtime = new BirdToolRuntime(closedState, client, planner);

    const result = await runtime.invoke("get_schema", {});

    assert.match(result, /session is complete/i);
    assert.equal(clientCalls, 0);
    assert.equal(closedState.tool_trajectory.length, 0);
  }
});
