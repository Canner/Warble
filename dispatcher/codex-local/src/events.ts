import { CodexDispatchError } from "./error.js";

export type WarbleCodexEvent =
  | { t: "step_start"; id: string; name: string }
  | { t: "tool_call"; id: string; name: string; input?: unknown }
  | { t: "tool_result"; id: string; ok: boolean; summary?: string; error?: string }
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

function toolName(item: JsonRecord): string {
  const server = typeof item["server"] === "string" ? item["server"] : "";
  const tool = typeof item["tool"] === "string" ? item["tool"] : "";
  if (tool.length > 0) return server.length > 0 ? `${server}.${tool}` : tool;
  return typeof item["name"] === "string" ? item["name"] : "mcp_tool";
}

function summarize(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
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

  constructor(private readonly stepId: string) {}

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
    if (type === "thread.started") {
      this.threadStarted = true;
      return [];
    }
    if (type === "turn.started") {
      if (this.started) throw new CodexDispatchError("codex emitted duplicate turn.started");
      this.started = true;
      return [{ t: "step_start", id: this.stepId, name: this.stepId }];
    }
    if (type === "item.started" || type === "item.completed") {
      return this.onItem(type, parsed);
    }
    if (type === "turn.failed" || type === "error") {
      const detail = summarize(parsed["error"] ?? parsed["message"] ?? parsed);
      return this.finish(false, detail);
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
    if (this.toolFailureDetail !== null) {
      throw new CodexDispatchError(`required MCP tool failed: ${this.toolFailureDetail}`);
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
      if (eventType === "item.started") {
        const name = toolName(item);
        this.pendingTools.set(id, name);
        return [
          {
            t: "tool_call",
            id,
            name,
            ...(item["arguments"] !== undefined ? { input: item["arguments"] } : {}),
          },
        ];
      }
      const name = this.pendingTools.get(id);
      if (name === undefined) {
        throw new CodexDispatchError(`mcp_tool_call '${id}' completed without starting`);
      }
      this.pendingTools.delete(id);
      const failed = item["status"] === "failed" || item["error"] !== undefined;
      const detail = summarize(failed ? item["error"] : item["result"]);
      if (failed) this.toolFailureDetail = `${name}: ${detail}`;
      return [
        {
          t: "tool_result",
          id,
          ok: !failed,
          ...(failed ? { error: detail } : { summary: detail }),
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
