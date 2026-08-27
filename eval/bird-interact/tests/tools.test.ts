import assert from "node:assert/strict";
import test from "node:test";

import type { BirdClient, ExecuteSqlResponse } from "../src/bird-client.js";
import { TOOL_COSTS } from "../src/protocol.js";
import { BirdToolRuntime, createBirdMcpServer } from "../src/tools.js";
import type {
  BirdSessionState,
  BirdToolName,
  SubmitSqlResponse,
} from "../src/types.js";
import type { WrenPlanner } from "../src/wren-planner.js";

function state(budget = 20): BirdSessionState {
  return {
    task_id: "alien_1",
    db_name: "alien",
    user_query: "find it",
    current_phase: 1,
    budget_remaining: budget,
    initial_budget: budget,
    total_reward: 0,
    dialogue_history: [],
    tool_trajectory: [],
    adk_events: [],
    phase1_completed: false,
    phase2_completed: false,
    task_done: false,
  };
}

class FakePlanner implements WrenPlanner {
  calls: Array<{ dbName: string; sql: string }> = [];
  fail = false;
  wait: Promise<void> | undefined;
  entered: (() => void) | undefined;

  projectPath(dbName: string): string {
    return `/projects/${dbName}`;
  }

  async plan(dbName: string, sql: string): Promise<string> {
    this.calls.push({ dbName, sql });
    this.entered?.();
    await this.wait;
    if (this.fail) throw new Error("planner unavailable");
    return `NATIVE(${sql})`;
  }
}

class FakeClient implements BirdClient {
  calls: Array<{ method: string; args: unknown[]; budget: number }> = [];
  submitResponse: SubmitSqlResponse = { passed: false, message: "try again" };
  executeResponse: ExecuteSqlResponse = { success: true, result: "rows", error: null };
  failMethod: string | undefined;

  constructor(private readonly currentState: BirdSessionState) {}

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args, budget: this.currentState.budget_remaining });
    if (this.failMethod === method) throw new Error(`upstream ${method} secret-detail`);
  }

  async execute(taskId: string, sql: string): Promise<ExecuteSqlResponse> {
    this.record("execute", [taskId, sql]);
    return this.executeResponse;
  }
  async getSchema(taskId: string): Promise<string> {
    this.record("getSchema", [taskId]);
    return "schema";
  }
  async getAllColumnMeanings(taskId: string): Promise<string> {
    this.record("getAllColumnMeanings", [taskId]);
    return "meanings";
  }
  async getColumnMeaning(taskId: string, table: string, column: string): Promise<string> {
    this.record("getColumnMeaning", [taskId, table, column]);
    return "meaning";
  }
  async getAllKnowledgeNames(taskId: string): Promise<string[]> {
    this.record("getAllKnowledgeNames", [taskId]);
    return ["k1", "k2"];
  }
  async getKnowledge(taskId: string, name?: string): Promise<string> {
    this.record("getKnowledge", name === undefined ? [taskId] : [taskId, name]);
    return name === undefined ? "all knowledge" : `knowledge ${name}`;
  }
  async askUser(taskId: string, question: string): Promise<string> {
    this.record("askUser", [taskId, question]);
    return "answer";
  }
  async phaseTransition(taskId: string): Promise<void> {
    this.record("phaseTransition", [taskId]);
  }
  async submit(taskId: string, sql: string): Promise<SubmitSqlResponse> {
    this.record("submit", [taskId, sql]);
    return this.submitResponse;
  }
}

function setup(budget = 20): {
  session: BirdSessionState;
  client: FakeClient;
  planner: FakePlanner;
  runtime: BirdToolRuntime;
} {
  const session = state(budget);
  const client = new FakeClient(session);
  const planner = new FakePlanner();
  return {
    session,
    client,
    planner,
    runtime: new BirdToolRuntime(session, client, planner),
  };
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: {
    content?: ReadonlyArray<{ type: string; text?: string }>;
    isError?: boolean;
    tools?: ReadonlyArray<{ name: string; description: string; inputSchema: unknown }>;
  };
  error?: { code: number; message: string };
}

interface ConnectableMcpServer {
  connect(transport: LoopbackTransport): Promise<void>;
}

/**
 * The SDK's in-process MCP transport, reproduced so a test can reach the tools the way the agent
 * reaches them instead of calling `BirdToolRuntime.invoke` behind the server's back.
 *
 * `createSdkMcpServer` connects its server to `SdkControlServerTransport`, whose whole contract is
 * `start`/`send`/`close` plus an `onmessage` the CLI drives with the model's JSON-RPC. The layer
 * that exists only on that path is `validateToolInput`, which runs before `executeToolHandler` and
 * is where a call the official run would have charged for can die uncharged. Every other test in
 * this file calls the runtime directly, which is behind that layer and structurally blind to it.
 */
class LoopbackTransport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  readonly #pending = new Map<number, (message: JsonRpcMessage) => void>();
  #nextId = 0;

  async start(): Promise<void> {}
  async close(): Promise<void> {}

  async send(message: JsonRpcMessage): Promise<void> {
    if (message.id === undefined) return;
    const settle = this.#pending.get(message.id);
    this.#pending.delete(message.id);
    settle?.(message);
  }

  request(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
    this.#nextId += 1;
    const id = this.#nextId;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.onmessage?.({ jsonrpc: "2.0", id, method, params });
    });
  }
}

async function connectBirdServer(runtime: BirdToolRuntime): Promise<LoopbackTransport> {
  const transport = new LoopbackTransport();
  const server: ConnectableMcpServer = createBirdMcpServer(runtime).instance;
  await server.connect(transport);
  return transport;
}

/** What the agent would see for one `tools/call`, error text included. */
async function callOverMcp(
  runtime: BirdToolRuntime,
  params: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const transport = await connectBirdServer(runtime);
  const message = await transport.request("tools/call", params);
  const first = message.result?.content?.[0];
  return {
    text: first?.text ?? message.error?.message ?? JSON.stringify(message.result),
    isError: message.result?.isError === true,
  };
}

/** ADK's missing-argument refusal as `str(dict)` renders it to the model. */
function adkMissingRepr(tool: string, ...missing: readonly string[]): string {
  return (
    `{'error': 'Invoking \`${tool}()\` failed as the following mandatory input parameters ` +
    `are not present:\\n${missing.join("\\n")}\\nYou could retry calling this tool, ` +
    "but it is IMPORTANT for you to provide all the mandatory parameters.'}"
  );
}

test("all nine tools charge first and call the pinned client operation", async () => {
  const cases: Array<{
    tool: BirdToolName;
    args: Record<string, unknown>;
    method: string;
    clientArgs: unknown[];
  }> = [
    { tool: "execute_sql", args: { sql: "SELECT 1" }, method: "execute", clientArgs: ["alien_1", "NATIVE(SELECT 1)"] },
    { tool: "get_schema", args: {}, method: "getSchema", clientArgs: ["alien_1"] },
    { tool: "get_all_column_meanings", args: {}, method: "getAllColumnMeanings", clientArgs: ["alien_1"] },
    { tool: "get_column_meaning", args: { table_name: "t", column_name: "c" }, method: "getColumnMeaning", clientArgs: ["alien_1", "t", "c"] },
    { tool: "get_all_external_knowledge_names", args: {}, method: "getAllKnowledgeNames", clientArgs: ["alien_1"] },
    { tool: "get_knowledge_definition", args: { knowledge_name: "k1" }, method: "getKnowledge", clientArgs: ["alien_1", "k1"] },
    { tool: "get_all_knowledge_definitions", args: {}, method: "getKnowledge", clientArgs: ["alien_1"] },
    { tool: "ask_user", args: { question: "which?" }, method: "askUser", clientArgs: ["alien_1", "which?"] },
    { tool: "submit_sql", args: { sql: "SELECT 2" }, method: "submit", clientArgs: ["alien_1", "NATIVE(SELECT 2)"] },
  ];

  for (const item of cases) {
    const { session, client, runtime } = setup();
    const result = await runtime.invoke(item.tool, item.args);
    const call = client.calls.find((candidate) => candidate.method === item.method);
    assert.ok(call, `${item.tool} did not call ${item.method}`);
    assert.deepEqual(call.args, item.clientArgs);
    assert.equal(call.budget, 20 - TOOL_COSTS[item.tool]);
    assert.equal(session.budget_remaining, 20 - TOOL_COSTS[item.tool]);
    assert.match(
      result,
      new RegExp(
        `\\[SYSTEM NOTE: Remaining budget: ${session.budget_remaining.toFixed(1)}/20.0\\]$`,
      ),
    );
    assert.equal(session.tool_trajectory.at(-1)?.tool, item.tool);
  }
});

test("an unaffordable non-submit is uncharged and unexecuted but still recorded", async () => {
  const { session, client, runtime } = setup(0.25);
  const result = await runtime.invoke("get_schema", {});

  assert.equal(
    result,
    "{'error': 'Budget exhausted (0.2 remaining). " +
      "You MUST call submit_sql now with your best SQL.'}\n\n" +
      "[SYSTEM NOTE: Remaining budget: 0.2/0.2]",
  );
  assert.equal(session.budget_remaining, 0.25);
  assert.deepEqual(client.calls, []);
  assert.deepEqual(session.tool_trajectory, [
    {
      type: "tool",
      tool: "get_schema",
      args: {},
      result:
        '{"error": "Budget exhausted (0.2 remaining). ' +
        'You MUST call submit_sql now with your best SQL."}',
      cost: 1,
      budget_before: 0.25,
      budget_after: 0.25,
      phase: 1,
    },
  ]);
  assert.equal(session.rejected_actions?.at(-1)?.charged, false);
});

test("the MCP server charges every malformed call the official run would have charged", async () => {
  const malformed: Array<{ tool: BirdToolName; params: Record<string, unknown> }> = [
    { tool: "submit_sql", params: { name: "submit_sql", arguments: {} } },
    { tool: "submit_sql", params: { name: "submit_sql", arguments: { sql: 123 } } },
    { tool: "submit_sql", params: { name: "submit_sql", arguments: { sql: null } } },
    { tool: "submit_sql", params: { name: "submit_sql", arguments: { sql: "" } } },
    { tool: "submit_sql", params: { name: "submit_sql", arguments: { sql: { a: 1 } } } },
    { tool: "ask_user", params: { name: "ask_user", arguments: {} } },
    { tool: "ask_user", params: { name: "ask_user", arguments: { question: 7 } } },
    { tool: "execute_sql", params: { name: "execute_sql", arguments: { sql: false } } },
    {
      tool: "get_column_meaning",
      params: { name: "get_column_meaning", arguments: { table_name: "t" } },
    },
  ];

  for (const item of malformed) {
    const { session, runtime } = setup();
    const shape = JSON.stringify(item.params);

    const { text, isError } = await callOverMcp(runtime, item.params);

    assert.equal(isError, false, `${shape} bounced before the ledger could charge`);
    assert.doesNotMatch(text, /Input validation error/, shape);
    assert.equal(
      session.budget_remaining,
      20 - TOOL_COSTS[item.tool],
      `${shape} was a free retry`,
    );
    assert.equal(session.tool_trajectory.at(-1)?.cost, TOOL_COSTS[item.tool], shape);
  }
});

/**
 * The trade-off the permissive schema makes, pinned: the model must still be told that each
 * argument is a required string. The SDK drops property-level `.describe()` on the way to JSON
 * Schema, so the union's first branch and the tool description are the only channels that survive
 * to say so, and a later simplification to a bare `z.unknown()` would silently close both.
 */
test("the advertised schema still declares each argument as a required string", async () => {
  const { runtime } = setup();
  const transport = await connectBirdServer(runtime);

  const listed = await transport.request("tools/list", {});

  const tools = listed.result?.tools ?? [];
  assert.equal(tools.length, 9);
  const submit = tools.find((entry) => entry.name === "submit_sql");
  assert.deepEqual(submit?.inputSchema, {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { sql: { anyOf: [{ type: "string" }, {}] } },
    required: ["sql"],
  });
  for (const entry of tools) {
    const schema = entry.inputSchema as { required?: readonly string[] };
    for (const argument of schema.required ?? []) {
      assert.match(
        entry.description,
        new RegExp(argument),
        `${entry.name} no longer names ${argument} anywhere the model can read it`,
      );
    }
  }
});

/**
 * The residual this design cannot close, pinned so it stays measured rather than forgotten: a
 * `tools/call` carrying no `arguments` key at all is refused by the object schema itself, before
 * any property schema is consulted, and the zero-argument tools that declare no properties bounce
 * it too. No property schema can accept it. The tool-use API always produces an input object for
 * a tool call, so this is a malformed request rather than a call the official run would have
 * charged for.
 */
test("a tools/call with no arguments key is a protocol error, not a free retry", async () => {
  for (const name of ["submit_sql", "get_schema"] as const) {
    const { session, runtime } = setup();

    const { text, isError } = await callOverMcp(runtime, { name });

    assert.equal(isError, true, name);
    assert.match(text, /Input validation error/, name);
    assert.equal(session.budget_remaining, 20, name);
    assert.deepEqual(session.tool_trajectory, [], name);
  }
});

test("an empty submit is charged and scored instead of retried for free", async () => {
  const { session, client, runtime } = setup(3);

  const result = await runtime.invoke("submit_sql", { sql: "" });

  assert.deepEqual(client.calls.map((call) => call.args), [["alien_1", ""]]);
  assert.equal(session.budget_remaining, -1);
  assert.equal(session.tool_trajectory.at(-1)?.cost, 3);
  assert.equal(result, "try again\nBudget remaining: -1 bird-coins");
});

test("a missing argument is charged by tool name and refused the way ADK refuses it", async () => {
  const forced = setup(3);

  const forcedResult = await callOverMcp(forced.runtime, { name: "submit_sql", arguments: {} });

  assert.equal(forcedResult.text, adkMissingRepr("submit_sql", "sql"));
  assert.deepEqual(forced.client.calls, []);
  assert.equal(forced.session.budget_remaining, -1);
  assert.deepEqual(forced.session.tool_trajectory, [
    {
      type: "tool",
      tool: "submit_sql",
      args: {},
      result:
        '{"error": "Invoking `submit_sql()` failed as the following mandatory input ' +
        'parameters are not present:\\nsql\\nYou could retry calling this tool, but it is ' +
        'IMPORTANT for you to provide all the mandatory parameters."}',
      cost: 3,
      budget_before: 3,
      budget_after: -1,
      phase: 1,
    },
  ]);
  assert.equal(forced.session.rejected_actions, undefined);

  const affordable = setup(6);

  const affordableResult = await callOverMcp(affordable.runtime, {
    name: "submit_sql",
    arguments: {},
  });

  assert.equal(
    affordableResult.text,
    `${adkMissingRepr("submit_sql", "sql")}\n\n[SYSTEM NOTE: Remaining budget: 3.0/6.0]`,
  );
  assert.equal(affordable.session.budget_remaining, 3);

  const both = setup(6);

  const bothResult = await callOverMcp(both.runtime, { name: "get_column_meaning", arguments: {} });

  assert.equal(
    bothResult.text,
    `${adkMissingRepr("get_column_meaning", "table_name", "column_name")}\n\n` +
      "[SYSTEM NOTE: Remaining budget: 5.5/6.0]",
  );
  assert.deepEqual(both.client.calls, []);
});

/**
 * The one deliberate divergence from the official observation. ADK forwards a non-string
 * untouched, and the DB environment's `SubmitSQLRequest.sql: str` rejects it, so the official
 * agent sees a charged submission whose `message` came back empty. `BirdClient.submit` takes a
 * `string`, and coercing would post SQL the model never wrote to the authoritative scorer, so
 * this package says why instead. The charge, the trajectory entry and the forced exit — what the
 * ledger is measured on — are the same either way.
 */
test("a non-string argument is charged and wasted rather than retried for free", async () => {
  const { session, client, runtime } = setup(3);

  const { text, isError } = await callOverMcp(runtime, {
    name: "submit_sql",
    arguments: { sql: 123 },
  });

  assert.equal(isError, false);
  assert.equal(text, "Error: sql must be a string");
  assert.deepEqual(client.calls, []);
  assert.equal(session.budget_remaining, -1);
  assert.equal(session.tool_trajectory.at(-1)?.cost, 3);
});

test("a planner outage on the final submit still reaches the official scorer", async () => {
  const { session, client, planner, runtime } = setup(3);
  planner.fail = true;

  const result = await runtime.invoke("submit_sql", { sql: "SELECT 1" });

  assert.deepEqual(client.calls.map((call) => call.args), [["alien_1", "SELECT 1"]]);
  assert.equal(result, "try again\nBudget remaining: -1 bird-coins");
  assert.equal(session.budget_remaining, -1);
  const entry = session.tool_trajectory.at(-1);
  assert.equal(entry?.semantic_sql, "SELECT 1");
  assert.equal(entry?.native_sql, undefined);
  assert.match(entry?.planner_error ?? "", /planner unavailable/);
});

/**
 * The submit fallback is only worth as much as the code that reaches it. `errorMessage` is on that
 * path, and `String(value)` is not total: a null-prototype object has nothing to coerce through
 * and throws `Cannot convert object to primitive value`, while a hostile `toString` propagates.
 * Either one escaping to the outer `catch` drops the submission whose coin is already spent, which
 * is the exact failure the fallback exists to prevent. Not reachable from `ProcessWrenPlanner`,
 * which only ever rejects with a `WrenPlanningError` — but `WrenPlanner` is an interface.
 */
test("an unprintable planner rejection still reaches the official scorer", async () => {
  const rejections: Array<{ label: string; value: unknown }> = [
    { label: "null-prototype object", value: Object.create(null) },
    {
      label: "object whose toString throws",
      value: {
        toString(): string {
          throw new Error("nested");
        },
      },
    },
  ];

  for (const rejection of rejections) {
    const { session, client, planner, runtime } = setup(3);
    planner.plan = async () => {
      throw rejection.value;
    };

    const result = await runtime.invoke("submit_sql", { sql: "SELECT 1" });

    assert.deepEqual(
      client.calls.map((call) => call.args),
      [["alien_1", "SELECT 1"]],
      `${rejection.label} lost the submission`,
    );
    assert.equal(result, "try again\nBudget remaining: -1 bird-coins");
    assert.equal(session.budget_remaining, -1);
    assert.equal(
      session.tool_trajectory.at(-1)?.planner_error,
      "<unprintable error>",
      rejection.label,
    );
  }
});

/**
 * The same contract read the other way: `plan` declares `Promise<string>`, the declaration is
 * erased at runtime, and a plan that is not a string used to be posted to the scorer as
 * `undefined`. It carries no more usable SQL than a rejection does, so it becomes one — and each
 * call site keeps the outcome it already documents.
 */
test("a planner that resolves a non-string falls back instead of submitting garbage", async () => {
  const submit = setup(3);
  submit.planner.plan = async () => undefined as unknown as string;

  const submitted = await submit.runtime.invoke("submit_sql", { sql: "SELECT 1" });

  assert.deepEqual(
    submit.client.calls.map((call) => call.args),
    [["alien_1", "SELECT 1"]],
  );
  assert.equal(submitted, "try again\nBudget remaining: -1 bird-coins");
  assert.equal(submit.session.tool_trajectory.at(-1)?.native_sql, undefined);
  assert.match(
    submit.session.tool_trajectory.at(-1)?.planner_error ?? "",
    /Wren planner returned undefined instead of SQL/,
  );

  const execute = setup(5);
  execute.planner.plan = async () => undefined as unknown as string;

  const executed = await execute.runtime.invoke("execute_sql", { sql: "SELECT 1" });

  assert.match(executed, /Wren planner returned undefined instead of SQL/);
  assert.deepEqual(execute.client.calls, []);
  assert.equal(execute.session.budget_remaining, 4);
});

/**
 * The deliberate asymmetry with the submit path above: an `execute_sql` observation the agent
 * never receives costs it one coin and a turn, and the planner error tells it what to do next. A
 * submission is the artifact the benchmark scores, so it is sent unplanned rather than withheld.
 */
test("an execute_sql planner failure remains charged and never reaches BIRD", async () => {
  const { session, client, planner, runtime } = setup(5);
  planner.fail = true;

  const result = await runtime.invoke("execute_sql", { sql: "SELECT 1" });

  assert.match(result, /planner unavailable/);
  assert.equal(session.budget_remaining, 4);
  assert.deepEqual(client.calls, []);
  assert.equal(session.tool_trajectory.length, 1);
});

test("query SQL records semantic and native forms while Management bypasses Wren", async () => {
  const query = setup();
  await query.runtime.invoke("execute_sql", { sql: "/* note */ SELECT 1" });
  assert.equal(query.session.tool_trajectory[0]?.semantic_sql, "/* note */ SELECT 1");
  assert.equal(query.session.tool_trajectory[0]?.native_sql, "NATIVE(/* note */ SELECT 1)");

  const executeManagement = setup();
  await executeManagement.runtime.invoke("execute_sql", { sql: "DELETE FROM t" });
  assert.deepEqual(executeManagement.planner.calls, []);
  assert.deepEqual(executeManagement.client.calls[0]?.args, ["alien_1", "DELETE FROM t"]);

  const submitManagement = setup();
  await submitManagement.runtime.invoke("submit_sql", { sql: "UPDATE t SET c = 1" });
  assert.deepEqual(submitManagement.planner.calls, []);
  assert.deepEqual(submitManagement.client.calls[0]?.args, ["alien_1", "UPDATE t SET c = 1"]);
});

test("identity Wren plans still record native SQL as proof of planning", async () => {
  const query = setup();
  query.planner.plan = async (_dbName, sql) => sql;

  await query.runtime.invoke("execute_sql", { sql: "SELECT 1" });

  assert.equal(query.session.tool_trajectory[0]?.semantic_sql, "SELECT 1");
  assert.equal(query.session.tool_trajectory[0]?.native_sql, "SELECT 1");
});

test("ask_user records both sides of the dialogue", async () => {
  const { session, runtime } = setup();
  await runtime.invoke("ask_user", { question: "which one?" });
  assert.deepEqual(session.dialogue_history, [
    { role: "agent", content: "which one?" },
    { role: "user", content: "answer" },
  ]);
});

test("knowledge names use the exact Python json.dumps observation", async () => {
  const { client, runtime } = setup();
  client.getAllKnowledgeNames = async () => ["k1", "知識"];

  const result = await runtime.invoke("get_all_external_knowledge_names", {});

  assert.equal(
    result,
    '["k1", "\\u77e5\\u8b58"]\n\n[SYSTEM NOTE: Remaining budget: 19.5/20.0]',
  );
});

test("ask_user failure stays charged without leaving a partial dialogue turn", async () => {
  const { session, client, runtime } = setup();
  client.failMethod = "askUser";

  const result = await runtime.invoke("ask_user", { question: "which one?" });

  assert.match(result, /^Error: upstream askUser secret-detail/);
  assert.deepEqual(session.dialogue_history, []);
  assert.equal(session.budget_remaining, 18);
});

test("phase-1 follow-up transitions the simulator and remains in the same ledger", async () => {
  const { session, client, runtime } = setup();
  client.submitResponse = {
    passed: true,
    message: "phase one passed",
    reward: 0.6,
    phase_completed: 1,
    has_follow_up: true,
    follow_up_query: "now update it",
  };

  const result = await runtime.invoke("submit_sql", { sql: "SELECT 1" });

  assert.equal(
    result,
    "phase one passed\n" +
      "Reward: 0.6\n" +
      "Follow-up question: now update it\n" +
      "Budget remaining: 17.0 bird-coins\n\n" +
      "[SYSTEM NOTE: Remaining budget: 17.0/20.0]",
  );
  assert.deepEqual(client.calls.map((call) => call.method), ["submit", "phaseTransition"]);
  assert.equal(session.current_phase, 2);
  assert.equal(session.phase1_completed, true);
  assert.equal(session.task_done, false);
  assert.equal(session.total_reward, 0.6);
  assert.equal(session.tool_trajectory[0]?.phase, 1);
});

test("phase-transition failure does not hide an authoritative phase-1 pass", async () => {
  const { session, client, runtime } = setup();
  client.submitResponse = {
    passed: true,
    message: "phase one passed",
    reward: 0.6,
    phase_completed: 1,
    has_follow_up: true,
    follow_up_query: "now update it",
  };
  client.failMethod = "phaseTransition";

  const result = await runtime.invoke("submit_sql", { sql: "SELECT 1" });

  assert.match(result, /^phase one passed\nReward: 0\.6\nFollow-up question:/);
  assert.doesNotMatch(result, /^Error:/);
  assert.equal(session.phase1_completed, true);
  assert.equal(session.current_phase, 2);
});

test("parallel MCP calls execute in request order against one budget ledger", async () => {
  const { session, client, planner, runtime } = setup(4);
  let releasePlanner!: () => void;
  planner.wait = new Promise<void>((resolve) => {
    releasePlanner = resolve;
  });
  const plannerEntered = new Promise<void>((resolve) => {
    planner.entered = resolve;
  });

  const first = runtime.invoke("execute_sql", { sql: "SELECT 1" });
  await plannerEntered;
  const second = runtime.invoke("get_schema", {});
  releasePlanner();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(client.calls.map((call) => call.method), ["execute", "getSchema"]);
  assert.deepEqual(session.tool_trajectory.map((entry) => entry.tool), [
    "execute_sql",
    "get_schema",
  ]);
  assert.match(firstResult, /Remaining budget: 3\.0\/4\.0\]$/);
  assert.match(secondResult, /Remaining budget: 2\.0\/4\.0\]$/);
  assert.equal(session.budget_remaining, 2);
});

test("upstream failures stay charged and become tool-visible", async () => {
  const { session, client, runtime } = setup(4);
  client.failMethod = "getSchema";

  const result = await runtime.invoke("get_schema", {});

  assert.match(result, /upstream getSchema secret-detail/);
  assert.equal(session.budget_remaining, 3);
  assert.equal(session.tool_trajectory.length, 1);
});

test("trajectory caps result previews and recursively redacts secret arguments", async () => {
  const { session, client, runtime } = setup();
  client.executeResponse = { success: true, result: "x".repeat(3_000), error: null };

  await runtime.invoke("execute_sql", {
    sql: "SELECT 1",
    password: "do-not-persist",
    nested: { access_token: "also-secret" },
  });

  const entry = session.tool_trajectory[0];
  assert.ok(entry);
  assert.ok(entry.result.length <= 2_000);
  assert.doesNotMatch(JSON.stringify(entry.args), /do-not-persist|also-secret/);
  assert.match(JSON.stringify(entry.args), /\[REDACTED\]/);
});
