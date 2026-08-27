import { resolve } from "node:path";

import {
  ModelConfig,
  prepareDispatch as defaultPrepareDispatch,
  type PreparedDispatch,
  type WarbleIr,
} from "@warble/claude-agent-sdk";
import {
  query as defaultQuery,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";

import { PREVIEW_LIMIT } from "./preview-truncation.js";
import type { BirdSessionState } from "./types.js";
import type { WrenPlanner } from "./wren-planner.js";

const MAX_MODEL_TURNS = 60;

export const BIRD_MAX_TURNS_MESSAGE =
  "Maximum interaction turns reached. Task ended.";
export const BIRD_TASK_COMPLETED_MESSAGE = "Task completed.";
export const BIRD_BUDGET_EXHAUSTED_MESSAGE =
  "Budget exhausted. Task ended.";

export function birdBeforeModelObservation(
  state: BirdSessionState,
): string | null {
  const turns = (state.model_turns ?? 0) + 1;
  state.model_turns = turns;
  if (turns > MAX_MODEL_TURNS) return BIRD_MAX_TURNS_MESSAGE;
  if (state.task_done) return BIRD_TASK_COMPLETED_MESSAGE;
  if (state.budget_remaining < 0) return BIRD_BUDGET_EXHAUSTED_MESSAGE;
  return null;
}

export const BIRD_MCP_TOOL_NAMES = Object.freeze([
  "mcp__bird__execute_sql",
  "mcp__bird__get_schema",
  "mcp__bird__get_all_column_meanings",
  "mcp__bird__get_column_meaning",
  "mcp__bird__get_all_external_knowledge_names",
  "mcp__bird__get_knowledge_definition",
  "mcp__bird__get_all_knowledge_definitions",
  "mcp__bird__ask_user",
  "mcp__bird__submit_sql",
]);

const DISALLOWED_BUILT_INS = Object.freeze([
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
  "NotebookEdit",
  "Skill",
  "AskUserQuestion",
]);

export type BirdMcpServer = NonNullable<Options["mcpServers"]>[string];
type PrepareDispatch = (input: Parameters<typeof defaultPrepareDispatch>[0]) => PreparedDispatch;
type QueryInput = { prompt: string; options: Options };
type QueryFunction = (input: QueryInput) => AsyncIterable<unknown>;

export interface BuildBirdAgentOptionsInput {
  baseOptions: Options;
  cwd: string;
  mcpServer: BirdMcpServer;
  systemPrompt: string;
  resumeSessionId?: string;
  maxTurns?: number;
}

export function buildBirdAgentOptions(input: BuildBirdAgentOptionsInput): Options {
  return {
    ...input.baseOptions,
    cwd: resolve(input.cwd),
    systemPrompt: input.systemPrompt,
    maxTurns: Math.min(input.maxTurns ?? MAX_MODEL_TURNS, MAX_MODEL_TURNS),
    permissionMode: "dontAsk",
    tools: [],
    allowedTools: [...BIRD_MCP_TOOL_NAMES],
    disallowedTools: [...DISALLOWED_BUILT_INS],
    mcpServers: { bird: input.mcpServer },
    ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
  };
}

export class BirdAgentLimitError extends Error {
  constructor() {
    super(`BIRD agent reached the ${MAX_MODEL_TURNS}-turn limit`);
    this.name = "BirdAgentLimitError";
  }
}

export interface WarbleBirdAgentOptions {
  state: BirdSessionState;
  ir: WarbleIr | string;
  irPath: string;
  planner: WrenPlanner;
  mcpServer: BirdMcpServer;
  model?: string;
  prepareDispatch?: PrepareDispatch;
  query?: QueryFunction;
  /**
   * Observes the stream. A failure here is contained and never ends the run, so a listener that
   * cares about its own failures has to report them itself.
   */
  onEvent?: (event: Readonly<Record<string, unknown>>) => void | Promise<void>;
}

export interface BirdAgentRunResult {
  message: string;
  sessionId: string | null;
}

function safeEventPreview(message: unknown): Record<string, unknown> {
  if (!message || typeof message !== "object") return { type: "unknown" };
  const source = message as Record<string, unknown>;
  const preview: Record<string, unknown> = {
    type: typeof source.type === "string" ? source.type : "unknown",
  };
  for (const key of ["subtype", "session_id", "uuid"] as const) {
    if (typeof source[key] === "string") preview[key] = source[key];
  }
  if (typeof source.result === "string") {
    preview.result = source.result.slice(0, PREVIEW_LIMIT);
  }
  return preview;
}

export class WarbleBirdAgent {
  readonly #state: BirdSessionState;
  readonly #ir: WarbleIr | string;
  readonly #irPath: string;
  readonly #planner: WrenPlanner;
  readonly #mcpServer: BirdMcpServer;
  readonly #models: ModelConfig;
  readonly #prepareDispatch: PrepareDispatch;
  readonly #query: QueryFunction;
  readonly #onEvent:
    | ((event: Readonly<Record<string, unknown>>) => void | Promise<void>)
    | undefined;

  constructor(options: WarbleBirdAgentOptions) {
    this.#state = options.state;
    this.#ir = options.ir;
    this.#irPath = options.irPath;
    this.#planner = options.planner;
    this.#mcpServer = options.mcpServer;
    const model = options.model ?? "claude-sonnet-4-5-20250929";
    this.#models = ModelConfig.fromFlags(model, model, model);
    this.#prepareDispatch = options.prepareDispatch ?? defaultPrepareDispatch;
    this.#query =
      options.query ??
      ((input) => defaultQuery(input) as AsyncIterable<unknown>);
    this.#onEvent = options.onEvent;
  }

  async run(message: string): Promise<BirdAgentRunResult> {
    const usedTurns = this.#state.model_turns ?? 0;
    if (
      usedTurns >= MAX_MODEL_TURNS ||
      this.#state.task_done ||
      this.#state.budget_remaining < 0
    ) {
      const observation = birdBeforeModelObservation(this.#state);
      return {
        message: observation ?? BIRD_MAX_TURNS_MESSAGE,
        sessionId: this.#state.sdk_session_id ?? null,
      };
    }

    const project = this.#planner.projectPath(this.#state.db_name);
    const prepared = this.#prepareDispatch({
      ir: this.#ir,
      irPath: this.#irPath,
      project,
      componentId: "bird_interact",
      question: message,
      models: this.#models,
      maxTurns: MAX_MODEL_TURNS - usedTurns,
    });
    const component = prepared.components.find(
      (candidate) => candidate.id === "bird_interact",
    );
    if (!component) throw new Error("compiled IR has no bird_interact component");

    const options = buildBirdAgentOptions({
      baseOptions: component.plan.options,
      cwd: project,
      mcpServer: this.#mcpServer,
      systemPrompt: component.node.prompt_fragment,
      maxTurns: MAX_MODEL_TURNS - usedTurns,
      ...(this.#state.sdk_session_id
        ? { resumeSessionId: this.#state.sdk_session_id }
        : {}),
    });

    let finalText: string | null = null;
    let sessionId: string | null = null;
    let resultSubtype: string | null = null;
    let maxTurnsReached = false;
    let modelTurns = usedTurns;
    for await (const sdkMessage of this.#query({ prompt: message, options })) {
      const record =
        sdkMessage && typeof sdkMessage === "object"
          ? (sdkMessage as Record<string, unknown>)
          : {};
      if (typeof record.session_id === "string") {
        sessionId = record.session_id;
        this.#state.sdk_session_id = sessionId;
      }
      if (record.type === "assistant") {
        modelTurns += 1;
        if (modelTurns > MAX_MODEL_TURNS) throw new BirdAgentLimitError();
        this.#state.model_turns = modelTurns;
      }
      const event = safeEventPreview(sdkMessage);
      this.#state.adk_events.push(event);
      await this.#observe(event);
      const stoppedAfterTool =
        record.type === "user" &&
        (this.#state.task_done || this.#state.budget_remaining < 0)
          ? birdBeforeModelObservation(this.#state)
          : null;
      if (stoppedAfterTool) {
        resultSubtype = "success";
        finalText = stoppedAfterTool;
        break;
      }
      if (record.type === "result") {
        resultSubtype = typeof record.subtype === "string" ? record.subtype : null;
        if (resultSubtype === "error_max_turns") {
          maxTurnsReached = true;
          this.#state.model_turns = MAX_MODEL_TURNS;
          finalText =
            birdBeforeModelObservation(this.#state) ?? BIRD_MAX_TURNS_MESSAGE;
        } else {
          finalText = typeof record.result === "string" ? record.result : "";
        }
      }
    }

    if ((!maxTurnsReached && resultSubtype !== "success") || finalText === null) {
      throw new Error(
        `BIRD agent run failed: ${resultSubtype ?? "no result message"}`,
      );
    }
    return { message: finalText, sessionId };
  }

  /**
   * Artifact recording observes a run; it must never end one. This listener used to be awaited
   * bare inside the stream loop, so an unwritable `agent-events.jsonl` aborted the stream, the
   * service answered `500`, and the orchestrator scored a task the agent may already have solved
   * as `total_reward 0`. Both shapes a listener failure takes — a synchronous throw and a rejected
   * promise — are contained here.
   */
  async #observe(event: Readonly<Record<string, unknown>>): Promise<void> {
    try {
      await this.#onEvent?.(event);
    } catch {
      // the listener owns reporting this; the run is not ended over a record of it
    }
  }
}
