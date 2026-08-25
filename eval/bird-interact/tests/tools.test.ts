import assert from "node:assert/strict";
import test from "node:test";

import type { BirdClient, ExecuteSqlResponse } from "../src/bird-client.js";
import { TOOL_COSTS } from "../src/protocol.js";
import { BirdToolRuntime } from "../src/tools.js";
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

test("an unaffordable non-submit is uncharged, unexecuted, and diagnostic only", async () => {
  const { session, client, runtime } = setup(0.25);
  const result = await runtime.invoke("get_schema", {});

  assert.match(result, /MUST call submit_sql/);
  assert.equal(session.budget_remaining, 0.25);
  assert.deepEqual(client.calls, []);
  assert.deepEqual(session.tool_trajectory, []);
  assert.equal(session.rejected_actions?.at(-1)?.charged, false);
});

test("planner failure remains charged and never reaches BIRD", async () => {
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
