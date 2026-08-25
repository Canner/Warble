import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { BirdClient } from "./bird-client.js";
import {
  applySubmitResponse,
  beginAction,
  formatBirdBudget,
} from "./protocol.js";
import type {
  BirdSessionState,
  BirdToolName,
  SubmitSqlResponse,
  ToolTrajectoryEntry,
} from "./types.js";
import { isQueryLikeStatement, type WrenPlanner } from "./wren-planner.js";

const RESULT_PREVIEW_LIMIT = 2_000;
const SECRET_KEY = /(password|passwd|secret|token|credential|connection|url)/i;

function redact(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redact(childValue, childKey),
      ]),
    );
  }
  return value;
}

function requiredString(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function pythonJsonDumpsStrings(values: readonly string[]): string {
  const asciiStrings = values.map((value) => {
    const json = JSON.stringify(value);
    let output = "";
    for (let index = 0; index < json.length; index += 1) {
      const codeUnit = json.charCodeAt(index);
      output +=
        codeUnit >= 0x80
          ? `\\u${codeUnit.toString(16).padStart(4, "0")}`
          : json[index];
    }
    return output;
  });
  return `[${asciiStrings.join(", ")}]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function submitObservation(
  state: Readonly<BirdSessionState>,
  response: Readonly<SubmitSqlResponse>,
): string {
  const parts = [response.message.replaceAll("[exec_err_flg] ", "")];
  if ((response.reward ?? 0) > 0) parts.push(`Reward: ${response.reward}`);
  if (response.has_follow_up) {
    parts.push(
      `Follow-up question: ${response.follow_up_query ?? "None"}`,
    );
  }
  const budget =
    state.budget_remaining < 0
      ? "-1"
      : formatBirdBudget(state.budget_remaining);
  parts.push(`Budget remaining: ${budget} bird-coins`);
  return parts.join("\n");
}

function appendBudgetNote(
  state: Readonly<BirdSessionState>,
  result: string,
): string {
  if (state.budget_remaining < 0) return result;
  return (
    `${result}\n\n[SYSTEM NOTE: Remaining budget: ` +
    `${formatBirdBudget(state.budget_remaining)}/` +
    `${formatBirdBudget(state.initial_budget)}]`
  );
}

export class BirdToolRuntime {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: BirdSessionState,
    private readonly client: BirdClient,
    private readonly planner: WrenPlanner,
  ) {}

  async invoke(
    name: BirdToolName,
    args: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    const action = this.#tail.then(() => this.#invokeSerial(name, args));
    this.#tail = action.then(
      () => undefined,
      () => undefined,
    );
    return action;
  }

  async #invokeSerial(
    name: BirdToolName,
    args: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    if (this.state.task_done || this.state.budget_remaining < 0) {
      return "The BIRD session is complete; no further tool actions are allowed.";
    }
    const decision = beginAction(this.state, name);
    if (decision.kind === "reject") {
      const rejected = this.state.rejected_actions ?? [];
      rejected.push({
        tool: name,
        charged: false,
        budget: decision.budgetBefore,
        reason: decision.message,
      });
      this.state.rejected_actions = rejected;
      return decision.message;
    }

    const phase = this.state.current_phase;
    this.state.budget_remaining = decision.budgetAfter;
    let semanticSql: string | undefined;
    let nativeSql: string | undefined;
    let plannedSql = false;
    let result: string;

    try {
      switch (name) {
        case "execute_sql": {
          semanticSql = requiredString(args, "sql");
          plannedSql = isQueryLikeStatement(semanticSql);
          nativeSql = await this.#planWhenQueryLike(semanticSql);
          const response = await this.client.execute(this.state.task_id, nativeSql);
          result = response.success
            ? response.result
            : `SQL Error: ${response.error || "Execution failed (no details)"}`;
          break;
        }
        case "get_schema":
          result = await this.client.getSchema(this.state.task_id);
          break;
        case "get_all_column_meanings":
          result = await this.client.getAllColumnMeanings(this.state.task_id);
          break;
        case "get_column_meaning":
          result = await this.client.getColumnMeaning(
            this.state.task_id,
            requiredString(args, "table_name"),
            requiredString(args, "column_name"),
          );
          break;
        case "get_all_external_knowledge_names":
          result = pythonJsonDumpsStrings(
            await this.client.getAllKnowledgeNames(this.state.task_id),
          );
          break;
        case "get_knowledge_definition":
          result = await this.client.getKnowledge(
            this.state.task_id,
            requiredString(args, "knowledge_name"),
          );
          break;
        case "get_all_knowledge_definitions":
          result = await this.client.getKnowledge(this.state.task_id);
          break;
        case "ask_user": {
          const question = requiredString(args, "question");
          const answer = await this.client.askUser(this.state.task_id, question);
          this.state.dialogue_history.push({ role: "agent", content: question });
          this.state.dialogue_history.push({ role: "user", content: answer });
          result = answer;
          break;
        }
        case "submit_sql": {
          semanticSql = requiredString(args, "sql");
          plannedSql = isQueryLikeStatement(semanticSql);
          nativeSql = await this.#planWhenQueryLike(semanticSql);
          const response = await this.client.submit(this.state.task_id, nativeSql);
          const next = applySubmitResponse(this.state, response);
          Object.assign(this.state, next);
          result = submitObservation(this.state, response);
          if (
            response.passed &&
            response.phase_completed === 1 &&
            response.has_follow_up
          ) {
            try {
              await this.client.phaseTransition(this.state.task_id);
            } catch {
              // The pinned official tool keeps the authoritative pass visible.
            }
          }
          break;
        }
      }
    } catch (error) {
      result = `Error: ${errorMessage(error)}`;
    }

    const visibleResult = appendBudgetNote(this.state, result);
    const entry: ToolTrajectoryEntry = {
      type: "tool",
      tool: name,
      args: redact(args) as Record<string, unknown>,
      result: result.slice(0, RESULT_PREVIEW_LIMIT),
      cost: decision.cost,
      budget_before: decision.budgetBefore,
      budget_after: decision.budgetAfter,
      phase,
      ...(semanticSql === undefined ? {} : { semantic_sql: semanticSql }),
      ...(nativeSql === undefined || !plannedSql
        ? {}
        : { native_sql: nativeSql }),
    };
    this.state.tool_trajectory.push(entry);
    return visibleResult;
  }

  async #planWhenQueryLike(sql: string): Promise<string> {
    if (!isQueryLikeStatement(sql)) return sql;
    return this.planner.plan(this.state.db_name, sql);
  }
}

function textResult(text: string): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text }] };
}

export function createBirdMcpServer(runtime: BirdToolRuntime) {
  const definitions = [
    tool(
      "execute_sql",
      "Execute SQL against the task database. Query SQL is planned through Wren first.",
      { sql: z.string().min(1) },
      async (args) => textResult(await runtime.invoke("execute_sql", args)),
    ),
    tool(
      "get_schema",
      "Get the task database schema.",
      {},
      async (args) => textResult(await runtime.invoke("get_schema", args)),
    ),
    tool(
      "get_all_column_meanings",
      "Get meanings for all database columns.",
      {},
      async (args) =>
        textResult(await runtime.invoke("get_all_column_meanings", args)),
    ),
    tool(
      "get_column_meaning",
      "Get the meaning of one database column.",
      { table_name: z.string().min(1), column_name: z.string().min(1) },
      async (args) => textResult(await runtime.invoke("get_column_meaning", args)),
    ),
    tool(
      "get_all_external_knowledge_names",
      "List all available external knowledge names.",
      {},
      async (args) =>
        textResult(
          await runtime.invoke("get_all_external_knowledge_names", args),
        ),
    ),
    tool(
      "get_knowledge_definition",
      "Get one external knowledge definition.",
      { knowledge_name: z.string().min(1) },
      async (args) =>
        textResult(await runtime.invoke("get_knowledge_definition", args)),
    ),
    tool(
      "get_all_knowledge_definitions",
      "Get all external knowledge definitions.",
      {},
      async (args) =>
        textResult(await runtime.invoke("get_all_knowledge_definitions", args)),
    ),
    tool(
      "ask_user",
      "Ask the BIRD user simulator a clarification question.",
      { question: z.string().min(1) },
      async (args) => textResult(await runtime.invoke("ask_user", args)),
    ),
    tool(
      "submit_sql",
      "Submit final SQL for authoritative BIRD scoring.",
      { sql: z.string().min(1) },
      async (args) => textResult(await runtime.invoke("submit_sql", args)),
    ),
  ];

  return createSdkMcpServer({
    name: "bird-interact",
    version: "0.1.0",
    tools: definitions,
  });
}
