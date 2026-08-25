import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { BirdClient } from "./bird-client.js";
import { PREVIEW_LIMIT } from "./preview-truncation.js";
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

/**
 * The declared shape of one string argument, permissive enough that the MCP server can never
 * bounce a call the official run would have charged for.
 *
 * `validateToolInput` runs before `executeToolHandler` in the SDK's MCP server, so an argument the
 * schema refuses never reaches `BirdToolRuntime.invoke` and never touches the ledger. Official
 * charges in `before_tool_callback`, by tool NAME, before `FunctionTool.run_async` has looked at
 * the arguments at all. A schema stricter than the official signature is therefore a free retry
 * where the official run records a paid action — and for `submit_sql` at three coins or less the
 * charge sets the budget to -1, so the free retry undoes a forced exit and the two runs end
 * differently.
 *
 * A bare `z.unknown()` would be permissive too, but the schema is also what advertises the
 * argument to the model, and the SDK's JSON Schema conversion drops property-level `.describe()`.
 * The union is what keeps the declared type visible: it advertises
 * `{"anyOf": [{"type": "string"}, {}]}` and keeps the argument in `required`, where `z.unknown()`
 * advertises `{}`. The prose that would have been a property description lives in the tool
 * description instead, which is the one model-facing channel that survives.
 */
const declaredStringArgument = z.union([z.string(), z.unknown()]);

/**
 * The mandatory parameters of each official tool function, in signature order.
 *
 * ADK refuses a call missing any parameter that has no default — inside `FunctionTool.run_async`,
 * after `before_tool_callback` has already charged for it — and names every missing one,
 * newline-joined, in the order `inspect.signature` yields them. Mirroring the official signatures
 * is what lets `get_column_meaning` called with neither argument name both, in that order, the way
 * the official run does. `tool_context` has no default either, but ADK injects it before the
 * check, so it is never reported missing.
 */
const REQUIRED_ARGUMENTS: Readonly<Record<BirdToolName, readonly string[]>> = Object.freeze({
  execute_sql: ["sql"],
  get_schema: [],
  get_all_column_meanings: [],
  get_column_meaning: ["table_name", "column_name"],
  get_all_external_knowledge_names: [],
  get_knowledge_definition: ["knowledge_name"],
  get_all_knowledge_definitions: [],
  ask_user: ["question"],
  submit_sql: ["sql"],
});

/**
 * The arguments as the model actually sent them.
 *
 * The MCP server hands the handler the object its own schema produced, and an argument the model
 * omitted arrives there as a materialized key holding `undefined` rather than as an absent one
 * (measured against the vendored converter). JSON carries no `undefined`, so such a key can only
 * be an artefact of that normalization. Dropping it is what lets the mandatory-argument check be
 * the plain key-presence check ADK performs, and keeps a phantom argument the model never wrote
 * out of the recorded trajectory. `null` is a value the model really did send — Python's `None`,
 * present as far as ADK is concerned — and stays.
 */
function sentArguments(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== undefined),
  );
}

function missingArguments(
  tool: BirdToolName,
  args: Readonly<Record<string, unknown>>,
): string[] {
  return REQUIRED_ARGUMENTS[tool].filter((argument) => !(argument in args));
}

/** ADK's refusal text, verbatim from `FunctionTool.run_async` in google-adk 1.0.0. */
function missingArgumentsMessage(tool: BirdToolName, missing: readonly string[]): string {
  return (
    `Invoking \`${tool}()\` failed as the following mandatory input parameters ` +
    `are not present:\n${missing.join("\n")}\nYou could retry calling this tool, ` +
    "but it is IMPORTANT for you to provide all the mandatory parameters."
  );
}

/**
 * One declared argument, read after the charge, refusing the non-string the official tool forwards.
 *
 * The official `before_tool_callback` charges by tool name and hands whatever the model sent to a
 * plain Python function, so `submit_sql("")` is a paid submission that the scorer marks wrong —
 * and at a budget of three coins or less, the paid forced exit that ends the task. Refusing the
 * empty string here would turn that scored ending into a free retry with a different outcome.
 *
 * A non-string is the one argument this package cannot forward, and so the one deliberate
 * divergence in observation text. ADK does not type-check: it posts the raw value, the DB
 * environment's `SubmitSQLRequest.sql: str` rejects it, and the official agent reads back a
 * charged submission whose `message` came out empty. `BirdClient.submit` takes a `string`, and
 * coercing would post SQL the model never wrote to the authoritative scorer, so throwing from
 * inside `#invokeSerial` produces the same charged, wasted submission with an observation that
 * says why. The charge, the trajectory entry and the forced exit are identical either way.
 *
 * A MISSING argument never reaches here: ADK refuses that before the tool body runs, with its own
 * message, which `#invokeSerial` reproduces in the same position.
 */
function stringArgument(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

/**
 * Why a plan that is not a string is treated as a planning failure.
 *
 * `WrenPlanner.plan` declares `Promise<string>`, but the declaration is erased at runtime and the
 * interface is implemented by test doubles and, in time, by other planners. A non-string plan
 * carries no more usable SQL than a rejected one, so it becomes the failure both call sites
 * already handle: a submission falls back to the semantic SQL rather than posting `undefined` to
 * the authoritative scorer, and an `execute_sql` becomes a charged error the agent can read. The
 * value itself stays out of the message — printing it is exactly what `errorMessage` exists to
 * survive.
 */
function requirePlannedSql(planned: unknown): string {
  if (typeof planned !== "string") {
    throw new Error(`Wren planner returned ${typeof planned} instead of SQL`);
  }
  return planned;
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

/**
 * The refusal a rejected or malformed action produces, in the two encodings the official run
 * leaves behind.
 *
 * `google-adk` skips the tool whenever it has an `{"error": ...}` dict in hand — returned by
 * `before_tool_callback` when the budget is short, or by `FunctionTool.run_async` when a mandatory
 * argument is absent — but still runs `after_tool_callback` with that dict as the tool response.
 * The official callback records `json.dumps(dict)` in `tool_trajectory` and returns `str(dict)` to
 * the model, so a refused action is a real entry in the ledger and reaches the agent wrapped in
 * Python mapping syntax. Returning the bare sentence and recording nothing makes the persisted
 * trajectory and the model-visible dialogue diverge from the official run on every refused turn.
 *
 * Neither encoding needs a general Python serializer, but the repr does need Python's escapes:
 * `str(dict)` renders the line breaks in ADK's missing-argument text as the two-character `\n`
 * escape, not as line breaks. The apostrophe case is escaped for completeness and is unreachable —
 * Python would switch to double-quote delimiters for a string containing one, and both message
 * templates are fixed and pinned by the differential, so a template that grew an apostrophe would
 * be caught rather than silently mis-encoded.
 */
function pythonErrorDict(message: string): { readonly repr: string; readonly json: string } {
  const escaped = message
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  return {
    repr: `{'error': '${escaped}'}`,
    json: `{"error": ${JSON.stringify(message)}}`,
  };
}

/**
 * The text of a caught rejection, for a value nothing guarantees is an `Error`.
 *
 * `String(value)` is not total: a null-prototype object has no `Symbol.toPrimitive`, `toString` or
 * `valueOf` to reach and throws `Cannot convert object to primitive value`, and an object whose
 * `toString` throws propagates that. `ProcessWrenPlanner` only ever rejects with a
 * `WrenPlanningError`, but `WrenPlanner` is an interface that doubles and future planners also
 * implement. This function is on the fallback path of the submit guard below, and a fallback that
 * throws would escape to the outer `catch`, lose a submission whose coin is already spent, and
 * reproduce the exact failure that guard exists to prevent.
 */
function errorMessage(error: unknown): string {
  try {
    const text: unknown = error instanceof Error ? error.message : error;
    return typeof text === "string" ? text : String(text);
  } catch {
    return "<unprintable error>";
  }
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
    rawArgs: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    if (this.state.task_done || this.state.budget_remaining < 0) {
      return "The BIRD session is complete; no further tool actions are allowed.";
    }
    const args = sentArguments(rawArgs);
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
      const refusal = pythonErrorDict(decision.message);
      // `after_tool_callback` reads its cost from the tool name, not from what was charged, so
      // the official entry carries the full price beside an unmoved budget.
      this.state.tool_trajectory.push({
        type: "tool",
        tool: name,
        args: redact(args) as Record<string, unknown>,
        result: refusal.json,
        cost: decision.requiredCost,
        budget_before: decision.budgetBefore,
        budget_after: decision.budgetAfter,
        phase: this.state.current_phase,
      });
      return appendBudgetNote(this.state, refusal.repr);
    }

    const phase = this.state.current_phase;
    this.state.budget_remaining = decision.budgetAfter;

    /**
     * ADK's own argument gate, in the one position that matters: after the charge.
     *
     * `handle_function_calls_async` runs `before_tool_callback` first and unconditionally, then
     * `FunctionTool.run_async`, which refuses a call whose mandatory arguments are absent without
     * running the tool body — and `after_tool_callback` still records that refusal at the tool's
     * full cost. So a `submit_sql` with no `sql` at three coins is a paid action that drives the
     * budget to -1 and ends the task. Performing this check any earlier, in the MCP schema, is the
     * free retry that undoes that ending. It is not added to `rejected_actions`, which means an
     * UNCHARGED refusal; this one is charged, and the ledger that records it is the trajectory.
     */
    const missing = missingArguments(name, args);
    if (missing.length > 0) {
      const refusal = pythonErrorDict(missingArgumentsMessage(name, missing));
      this.state.tool_trajectory.push({
        type: "tool",
        tool: name,
        args: redact(args) as Record<string, unknown>,
        result: refusal.json,
        cost: decision.cost,
        budget_before: decision.budgetBefore,
        budget_after: decision.budgetAfter,
        phase,
      });
      return appendBudgetNote(this.state, refusal.repr);
    }

    let semanticSql: string | undefined;
    let nativeSql: string | undefined;
    let plannerError: string | undefined;
    let plannedSql = false;
    let result: string;

    try {
      switch (name) {
        case "execute_sql": {
          semanticSql = stringArgument(args, "sql");
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
            stringArgument(args, "table_name"),
            stringArgument(args, "column_name"),
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
            stringArgument(args, "knowledge_name"),
          );
          break;
        case "get_all_knowledge_definitions":
          result = await this.client.getKnowledge(this.state.task_id);
          break;
        case "ask_user": {
          const question = stringArgument(args, "question");
          const answer = await this.client.askUser(this.state.task_id, question);
          this.state.dialogue_history.push({ role: "agent", content: question });
          this.state.dialogue_history.push({ role: "user", content: answer });
          result = answer;
          break;
        }
        case "submit_sql": {
          semanticSql = stringArgument(args, "sql");
          plannedSql = isQueryLikeStatement(semanticSql);
          let submittedSql = semanticSql;
          /**
           * Wren planning is a Warble-only step, so it must never be the reason a submission
           * misses the scorer. The charge landed before this line and a submit at three coins or
           * less has already set the budget to -1, which blocks every later tool: letting a
           * `dry-plan` outage escape here would end the task with nothing submitted and score 0 on
           * SQL the benchmark never saw. The official agent has no planner and posts what the model
           * wrote, so the semantic form is the faithful fallback rather than a guess. `nativeSql`
           * stays unset, which is how this package already records a submission that bypassed
           * planning; `planner_error` says why it bypassed it.
           */
          if (plannedSql) {
            try {
              nativeSql = requirePlannedSql(
                await this.planner.plan(this.state.db_name, semanticSql),
              );
              submittedSql = nativeSql;
            } catch (error) {
              plannerError = errorMessage(error);
            }
          }
          const response = await this.client.submit(this.state.task_id, submittedSql);
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
      result: result.slice(0, PREVIEW_LIMIT),
      cost: decision.cost,
      budget_before: decision.budgetBefore,
      budget_after: decision.budgetAfter,
      phase,
      ...(semanticSql === undefined ? {} : { semantic_sql: semanticSql }),
      ...(nativeSql === undefined || !plannedSql
        ? {}
        : { native_sql: nativeSql }),
      ...(plannerError === undefined ? {} : { planner_error: plannerError }),
    };
    this.state.tool_trajectory.push(entry);
    return visibleResult;
  }

  async #planWhenQueryLike(sql: string): Promise<string> {
    if (!isQueryLikeStatement(sql)) return sql;
    return requirePlannedSql(await this.planner.plan(this.state.db_name, sql));
  }
}

function textResult(text: string): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text }] };
}

/**
 * The nine tools the agent may call, with the schemas the MCP server validates against and the
 * descriptions the model reads.
 *
 * Those schemas are part of the budget ledger rather than a validation nicety: the SDK rejects an
 * argument the schema refuses before `BirdToolRuntime.invoke` can charge for it, while the
 * official `before_tool_callback` charges by tool name and leaves the arguments to ADK and to the
 * tool body. `declaredStringArgument` is what keeps that line, and the runtime reproduces both of
 * the refusals the official run makes after charging.
 *
 * Each description names its arguments and their type because the SDK's JSON Schema conversion
 * drops property-level descriptions, so this text is the only prose the model gets about them.
 */
export function birdToolDefinitions(runtime: BirdToolRuntime) {
  return [
    tool(
      "execute_sql",
      "Execute SQL against the task database. Query SQL is planned through Wren first. " +
        "Argument: sql, the PostgreSQL query, as a string.",
      { sql: declaredStringArgument },
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
      "Get the meaning of one database column. " +
        "Arguments: table_name and column_name, both strings.",
      { table_name: declaredStringArgument, column_name: declaredStringArgument },
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
      "Get one external knowledge definition. " +
        "Argument: knowledge_name, the entry to look up, as a string.",
      { knowledge_name: declaredStringArgument },
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
      "Ask the BIRD user simulator a clarification question. " +
        "Argument: question, the clarification to ask, as a string.",
      { question: declaredStringArgument },
      async (args) => textResult(await runtime.invoke("ask_user", args)),
    ),
    tool(
      "submit_sql",
      "Submit final SQL for authoritative BIRD scoring. " +
        "Argument: sql, the final PostgreSQL query, as a string.",
      { sql: declaredStringArgument },
      async (args) => textResult(await runtime.invoke("submit_sql", args)),
    ),
  ];
}

export function createBirdMcpServer(runtime: BirdToolRuntime) {
  return createSdkMcpServer({
    name: "bird-interact",
    version: "0.1.0",
    tools: birdToolDefinitions(runtime),
  });
}
