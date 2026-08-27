import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { BirdClient, ExecuteSqlResponse } from "../src/bird-client.js";
import { birdBeforeModelObservation } from "../src/agent.js";
import { BirdToolRuntime, createBirdMcpServer } from "../src/tools.js";
import type { BirdSessionState, BirdToolName, SubmitSqlResponse } from "../src/types.js";
import type { WrenPlanner } from "../src/wren-planner.js";

const execFileAsync = promisify(execFile);
const checkout = process.env.BIRD_INTERACT_CHECKOUT;

interface DifferentialCase {
  id: string;
  tool: BirdToolName;
  args: Record<string, unknown>;
  state?: Partial<BirdSessionState>;
  response: Record<string, unknown>;
}

interface DifferentialFixture {
  base_state: BirdSessionState;
  cases: DifferentialCase[];
}

class FixtureClient implements BirdClient {
  calls = 0;
  postCalls: Array<{ path: string; json: Record<string, unknown> }> = [];

  constructor(private readonly response: Record<string, unknown>) {}

  private called(path: string, json: Record<string, unknown>): void {
    this.calls += 1;
    this.postCalls.push({ path, json });
    if (typeof this.response._raise === "string") {
      throw new Error(this.response._raise);
    }
  }
  async execute(taskId: string, sql: string): Promise<ExecuteSqlResponse> {
    this.called("/execute", { task_id: taskId, sql });
    return this.response as unknown as ExecuteSqlResponse;
  }
  async getSchema(taskId: string): Promise<string> {
    this.called("/schema", { task_id: taskId });
    return String(this.response.schema);
  }
  async getAllColumnMeanings(taskId: string): Promise<string> {
    this.called("/all_column_meanings", { task_id: taskId });
    return String(this.response.column_meanings);
  }
  async getColumnMeaning(
    taskId: string,
    tableName: string,
    columnName: string,
  ): Promise<string> {
    this.called("/column_meaning", {
      task_id: taskId,
      table_name: tableName,
      column_name: columnName,
    });
    return String(this.response.meaning);
  }
  async getAllKnowledgeNames(taskId: string): Promise<string[]> {
    this.called("/knowledge_names", { task_id: taskId });
    return this.response.names as string[];
  }
  async getKnowledge(taskId: string, knowledgeName?: string): Promise<string> {
    this.called(
      "/knowledge",
      knowledgeName === undefined
        ? { task_id: taskId }
        : { task_id: taskId, knowledge_name: knowledgeName },
    );
    return String(this.response.knowledge);
  }
  async askUser(taskId: string, question: string): Promise<string> {
    this.called("/ask", { task_id: taskId, question });
    return String(this.response.answer);
  }
  async phaseTransition(taskId: string): Promise<void> {
    this.called("/phase_transition", { task_id: taskId });
  }
  async submit(taskId: string, sql: string): Promise<SubmitSqlResponse> {
    this.called("/submit", { task_id: taskId, sql });
    return this.response as unknown as SubmitSqlResponse;
  }
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: { content?: ReadonlyArray<{ type: string; text?: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

interface ConnectableMcpServer {
  connect(transport: LoopbackTransport): Promise<void>;
}

/**
 * The SDK's in-process MCP transport, mirroring `SdkControlServerTransport`.
 *
 * Duplicated from `tools.test.ts` because this package keeps each test file self-contained, and
 * carried here rather than skipped because the alternative — calling `BirdToolRuntime.invoke`
 * directly, as this oracle used to — puts `validateToolInput` outside what the oracle can see. A
 * schema that refuses an argument the official run charges for would then be invisible to the one
 * test whose whole job is to notice a divergence from the official run.
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

/**
 * What the agent would read back from one tool call — the refusal text included.
 *
 * A bounced call returns the MCP error rather than throwing, so a schema-level divergence lands
 * in the `observation` diff for its case instead of aborting the run with a stack trace.
 */
async function observeOverMcp(
  runtime: BirdToolRuntime,
  tool: BirdToolName,
  args: Record<string, unknown>,
): Promise<string> {
  const transport = new LoopbackTransport();
  const server: ConnectableMcpServer = createBirdMcpServer(runtime).instance;
  await server.connect(transport);
  const message = await transport.request("tools/call", { name: tool, arguments: args });
  const first = message.result?.content?.[0];
  return first?.text ?? message.error?.message ?? JSON.stringify(message.result);
}

async function replayNode(fixture: DifferentialFixture): Promise<unknown[]> {
  const planner: WrenPlanner = {
    projectPath: (dbName) => `/projects/${dbName}`,
    plan: async (_dbName, sql) => sql,
  };
  const output: unknown[] = [];
  for (const item of fixture.cases) {
    const state = {
      ...structuredClone(fixture.base_state),
      ...structuredClone(item.state ?? {}),
      dialogue_history: [],
      tool_trajectory: [],
      adk_events: [],
    } as BirdSessionState;
    const client = new FixtureClient(item.response);
    const observation = await observeOverMcp(
      new BirdToolRuntime(state, client, planner),
      item.tool,
      item.args,
    );
    output.push({
      id: item.id,
      observation,
      executed: client.calls > 0,
      post_calls: client.postCalls,
      rejected: (state.rejected_actions?.length ?? 0) > 0,
      cost: state.tool_trajectory.at(-1)?.cost ?? 0,
      trajectory_result: state.tool_trajectory.at(-1)?.result ?? null,
      budget_remaining: state.budget_remaining,
      current_phase: state.current_phase,
      phase1_completed: state.phase1_completed,
      phase2_completed: state.phase2_completed,
      total_reward: state.total_reward,
      dialogue_history: state.dialogue_history,
      task_done: state.task_done,
      terminal_observation: birdBeforeModelObservation(state),
      model_turns: state.model_turns,
    });
  }
  const combinedState = {
    ...structuredClone(fixture.base_state),
    task_done: true,
    budget_remaining: -1,
    model_turns: 60,
  } as BirdSessionState;
  output.push({
    id: "model_limit_precedes_terminal_state",
    terminal_observation: birdBeforeModelObservation(combinedState),
    model_turns: combinedState.model_turns,
  });
  return output;
}

test(
  "Warble transitions match the pinned official callbacks and tools",
  { skip: checkout === undefined ? "set BIRD_INTERACT_CHECKOUT to run the mandatory oracle" : false },
  async () => {
    assert.ok(checkout);
    const actions = resolve(import.meta.dirname, "fixtures/differential-actions.json");
    const fixture = JSON.parse(await readFile(actions, "utf8")) as DifferentialFixture;
    const nodeResult = await replayNode(fixture);
    const driver = resolve(import.meta.dirname, "../scripts/reference_driver.py");
    const { stdout } = await execFileAsync(
      "python3",
      [driver, "--official-checkout", checkout, "--actions", actions],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    const officialResult = JSON.parse(stdout) as unknown[];
    // Case by case before the whole replay: one `deepEqual` over the full array elides the middle
    // of its diff, so a divergence in the twentieth transition renders as a wall of the nineteen
    // that matched, while a single case diffs down to the fields that moved and carries its own
    // `id`. No message argument, because passing one replaces that diff with the message. The
    // array comparison still runs, and is what catches a missing, extra or reordered case.
    for (const [index, official] of officialResult.entries()) {
      assert.deepEqual(nodeResult[index], official);
    }
    assert.deepEqual(nodeResult, officialResult);
  },
);
