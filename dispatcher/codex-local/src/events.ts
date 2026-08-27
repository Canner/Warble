import { CodexDispatchError } from "./error.js";

export type WarbleCodexEvent =
  | { t: "step_start"; id: string; name: string }
  | { t: "tool_call"; id: string; name: string }
  | { t: "tool_result"; id: string; ok: boolean; error?: string }
  | { t: "answer"; text: string }
  | { t: "step_finish"; id: string; ok: boolean; detail?: string };

interface JsonRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function itemOf(event: JsonRecord): JsonRecord | null {
  return isRecord(event["item"]) ? event["item"] : null;
}

function itemType(item: JsonRecord): string {
  return typeof item["type"] === "string" ? item["type"] : "";
}

function toolIdentity(item: JsonRecord): { server: string; tool: string; name: string } {
  const server = typeof item["server"] === "string" ? item["server"] : "";
  const tool = typeof item["tool"] === "string" ? item["tool"] : "";
  if (server.length === 0 || tool.length === 0) {
    throw new CodexDispatchError("mcp_tool_call requires string server and tool fields");
  }
  return { server, tool, name: `${server}.${tool}` };
}

const FORBIDDEN_ITEM_TYPES = new Set([
  "command_execution",
  "file_change",
  "web_search",
  "image_generation",
  "collab_agent_tool_call",
]);

export class CodexJsonlMapper {
  private started = false;
  private finished = false;
  private threadStarted = false;
  private finalText: string | null = null;
  private failureDetail: string | null = null;
  private toolFailureDetail: string | null = null;
  private readonly pendingTools = new Map<string, string>();
  private successfulToolCount = 0;
  private readonly enabledTools: ReadonlySet<string>;

  constructor(
    private readonly stepId: string,
    private readonly expectedMcpServer: string | null,
    enabledTools: readonly string[],
    private readonly requireSuccessfulTool = true,
  ) {
    this.enabledTools = new Set(enabledTools);
  }

  nextLine(line: string): WarbleCodexEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new CodexDispatchError(`codex stdout contained non-JSONL data: ${String(error)}`);
    }
    if (!isRecord(parsed) || typeof parsed["type"] !== "string") {
      throw new CodexDispatchError("codex JSONL event requires a string type");
    }
    const type = parsed["type"];
    if (this.finished) {
      throw new CodexDispatchError(`codex emitted '${type}' after the terminal turn event`);
    }
    if (type === "thread.started") {
      if (this.threadStarted || this.started) {
        throw new CodexDispatchError("codex emitted duplicate or out-of-order thread.started");
      }
      this.threadStarted = true;
      return [];
    }
    if (type === "turn.started") {
      if (!this.threadStarted) {
        throw new CodexDispatchError("codex emitted turn.started before thread.started");
      }
      if (this.started) throw new CodexDispatchError("codex emitted duplicate turn.started");
      this.started = true;
      return [{ t: "step_start", id: this.stepId, name: this.stepId }];
    }
    if (type === "item.started" || type === "item.completed") {
      if (!this.started) {
        throw new CodexDispatchError(`codex emitted ${type} before turn.started`);
      }
      return this.onItem(type, parsed);
    }
    if (type === "turn.failed" || type === "error") {
      return this.finish(false, type === "turn.failed" ? "codex turn failed" : "codex runtime error");
    }
    if (type === "turn.completed") {
      return this.finish(true);
    }
    return [];
  }

  result(): { finalText: string; threadStarted: boolean; turnCompleted: boolean } {
    if (!this.threadStarted) throw new CodexDispatchError("codex JSONL ended without thread.started");
    if (!this.finished) throw new CodexDispatchError("codex JSONL ended without turn.completed");
    if (this.failureDetail !== null) {
      throw new CodexDispatchError(`codex turn failed: ${this.failureDetail}`);
    }
    if (this.requireSuccessfulTool && this.successfulToolCount === 0) {
      if (this.toolFailureDetail !== null) {
        throw new CodexDispatchError(`required MCP tool failed: ${this.toolFailureDetail}`);
      }
      throw new CodexDispatchError("codex turn completed without a successful allowlisted MCP tool call");
    }
    if (this.finalText === null) throw new CodexDispatchError("codex JSONL ended without an agent message");
    return {
      finalText: this.finalText,
      threadStarted: this.threadStarted,
      turnCompleted: this.finished,
    };
  }

  private onItem(
    eventType: "item.started" | "item.completed",
    event: JsonRecord,
  ): WarbleCodexEvent[] {
    const item = itemOf(event);
    if (!item) throw new CodexDispatchError(`${eventType} requires an item object`);
    const type = itemType(item);
    if (FORBIDDEN_ITEM_TYPES.has(type)) {
      throw new CodexDispatchError(
        `isolation violation: codex emitted forbidden '${type}' item`,
      );
    }
    if (type === "mcp_tool_call") {
      const id = typeof item["id"] === "string" ? item["id"] : "";
      if (id.length === 0) throw new CodexDispatchError("mcp_tool_call requires an id");
      const identity = toolIdentity(item);
      if (
        this.expectedMcpServer === null ||
        identity.server !== this.expectedMcpServer ||
        !this.enabledTools.has(identity.tool)
      ) {
        throw new CodexDispatchError(
          `isolation violation: codex emitted non-allowlisted MCP tool '${identity.name}'`,
        );
      }
      if (eventType === "item.started") {
        if (this.pendingTools.has(id)) {
          throw new CodexDispatchError(`mcp_tool_call '${id}' started more than once`);
        }
        this.pendingTools.set(id, identity.name);
        return [
          {
            t: "tool_call",
            id,
            name: identity.name,
          },
        ];
      }
      const name = this.pendingTools.get(id);
      if (name === undefined) {
        throw new CodexDispatchError(`mcp_tool_call '${id}' completed without starting`);
      }
      if (name !== identity.name) {
        throw new CodexDispatchError(
          `mcp_tool_call '${id}' completed as '${identity.name}' after starting as '${name}'`,
        );
      }
      this.pendingTools.delete(id);
      const status = item["status"];
      if (status !== "completed" && status !== "failed") {
        throw new CodexDispatchError(
          `completed mcp_tool_call '${id}' requires completed or failed status`,
        );
      }
      const failed =
        status === "failed" || (item["error"] !== undefined && item["error"] !== null);
      if (failed) this.toolFailureDetail = name;
      else this.successfulToolCount += 1;
      return [
        {
          t: "tool_result",
          id,
          ok: !failed,
          ...(failed ? { error: "allowlisted MCP tool failed" } : {}),
        },
      ];
    }
    if (eventType === "item.completed" && type === "agent_message") {
      const text = item["text"];
      if (typeof text !== "string") {
        throw new CodexDispatchError("completed agent_message requires text");
      }
      this.finalText = text;
      return [{ t: "answer", text }];
    }
    return [];
  }

  private finish(ok: boolean, detail?: string): WarbleCodexEvent[] {
    if (!this.started) {
      throw new CodexDispatchError("codex turn finished before turn.started");
    }
    if (this.finished) throw new CodexDispatchError("codex emitted duplicate terminal turn event");
    if (this.pendingTools.size > 0) {
      throw new CodexDispatchError(
        `codex turn finished with pending MCP tool calls: ${[...this.pendingTools.keys()].join(", ")}`,
      );
    }
    if (ok && this.requireSuccessfulTool && this.successfulToolCount === 0) {
      if (this.toolFailureDetail !== null) {
        throw new CodexDispatchError(`required MCP tool failed: ${this.toolFailureDetail}`);
      }
      throw new CodexDispatchError("codex turn completed without a successful allowlisted MCP tool call");
    }
    if (ok && this.finalText === null) {
      throw new CodexDispatchError("codex JSONL ended without an agent message");
    }
    this.finished = true;
    if (!ok) this.failureDetail = detail ?? "unknown failure";
    return [
      {
        t: "step_finish",
        id: this.stepId,
        ok,
        ...(detail !== undefined ? { detail } : {}),
      },
    ];
  }
}
