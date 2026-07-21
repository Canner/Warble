/**
 * Warble's own, consumer-agnostic chat-event vocabulary — the NDJSON records `chat --stream-json`
 * (cli.ts) emits to stdout, one JSON object per line, as a turn runs. This module owns the mapping
 * FROM the Agent SDK's `SDKMessage` stream TO this vocabulary; it knows nothing about any particular
 * consumer's own event types — a consumer maps `WarbleChatEvent` to whatever shape it needs on its own
 * side (out of scope here).
 *
 * Step bracketing: rather than trying to derive nested Task-subagent step boundaries from
 * `parent_tool_use_id` transitions (fragile — a subagent's tool calls interleave with the driver's,
 * and the SDK gives no explicit "subagent started/finished" message), `ChatEventMapper` emits a
 * SINGLE enclosing `step_start` (id = the dispatched verb) on the first message that produces a tool
 * call, and a matching `step_finish` when the caller reports the turn is done (`finish()`). Every
 * `tool_call`/`tool_result` the turn produces is grouped under that one step. Simple and correct beats
 * clever-but-fragile here — a consumer that wants finer-grained nesting can still use each event's
 * `parent`/`depth` fields (populated from `parent_tool_use_id`) to distinguish driver-turn tool calls
 * from subagent-turn tool calls within the single step.
 *
 * The mapper does NOT emit `answer` — that line is assembled by the CLI from the turn's final text
 * once the whole message stream has been consumed (see cli.ts's `runChatCmd`).
 */

export type WarbleChatEvent =
  | {
      readonly t: "step_start";
      readonly id: string;
      readonly name: string;
      readonly parent: string | null;
      readonly depth: number;
    }
  | {
      readonly t: "step_finish";
      readonly id: string;
      readonly ok: boolean;
      readonly detail?: string;
    }
  | {
      readonly t: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly input?: unknown;
      readonly parent: string | null;
      readonly depth: number;
    }
  | {
      readonly t: "tool_result";
      readonly id: string;
      readonly ok: boolean;
      readonly summary?: string;
      readonly error?: string;
    }
  | {
      readonly t: "answer";
      readonly text: string;
    };

// --- SDK message/content-block shapes (local, minimal) -------------------------------------------
//
// `@anthropic-ai/claude-agent-sdk`'s own `.d.ts` types its assistant/user message `content` against
// `@anthropic-ai/sdk`'s real content-block unions, but that package is not a resolvable dependency in
// this workspace (its `package.json` declares no dependencies of its own) — under this project's
// `skipLibCheck: true`, that gap silently collapses `content`'s element type to `any` rather than
// surfacing as a build error, so the compiler cannot be relied on to narrow these shapes for us. The
// interfaces below are this module's own minimal, runtime-checked contract for exactly the fields it
// reads (per Anthropic's documented content-block shapes), validated with type guards rather than
// compiler narrowing.

interface SdkMessageLike {
  readonly type: string;
  readonly parent_tool_use_id?: string | null;
  readonly message?: { readonly content?: unknown };
}

interface ToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input?: unknown;
}

interface ToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content?: unknown;
  readonly is_error?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isToolUseBlock(block: unknown): block is ToolUseBlock {
  return (
    isRecord(block) &&
    block["type"] === "tool_use" &&
    typeof block["id"] === "string" &&
    typeof block["name"] === "string"
  );
}

function isToolResultBlock(block: unknown): block is ToolResultBlock {
  return isRecord(block) && block["type"] === "tool_result" && typeof block["tool_use_id"] === "string";
}

const SUMMARY_MAX_LENGTH = 240;

function truncate(text: string, max: number = SUMMARY_MAX_LENGTH): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Render a tool_result block's `content` — a string, an array of `{type:"text",text}`-shaped blocks
 *  (the common case), or anything else — down to a short display string. */
function summarizeResultContent(content: unknown): string {
  if (typeof content === "string") return truncate(content);
  if (Array.isArray(content)) {
    const text = content
      .map((b) => (isRecord(b) && typeof b["text"] === "string" ? (b["text"] as string) : ""))
      .filter((s) => s.length > 0)
      .join(" ");
    if (text.length > 0) return truncate(text);
  }
  return truncate(JSON.stringify(content ?? null));
}

/**
 * Stateful mapper: feed one `SDKMessage` at a time — the same objects `run.ts`'s `query()` loop
 * iterates, in arrival order — and get back zero or more `WarbleChatEvent`s, in order. Tracks
 * in-flight `tool_use` ids (so a later `tool_result` can be paired with the tool name it belongs to,
 * and so a `tool_result` for an id this mapper never saw start is dropped rather than fabricated).
 */
export class ChatEventMapper {
  private readonly stepId: string;
  private stepStarted = false;
  private readonly pendingToolNames = new Map<string, string>();

  /** `name` becomes the enclosing step's `name` (the dispatched verb, e.g. "answer_query"). */
  constructor(name: string) {
    this.stepId = name;
  }

  /** Feed one SDK message; returns the events it produces, in arrival order. */
  next(message: SdkMessageLike): WarbleChatEvent[] {
    if (message.type === "assistant") return this.onAssistant(message);
    if (message.type === "user") return this.onUser(message);
    return [];
  }

  /** Call once the turn is done (successfully or not) to close the enclosing step, if one was opened. */
  finish(ok: boolean, detail?: string): WarbleChatEvent[] {
    if (!this.stepStarted) return [];
    return [{ t: "step_finish", id: this.stepId, ok, ...(detail !== undefined ? { detail } : {}) }];
  }

  private startStepIfNeeded(): WarbleChatEvent[] {
    if (this.stepStarted) return [];
    this.stepStarted = true;
    return [{ t: "step_start", id: this.stepId, name: this.stepId, parent: null, depth: 0 }];
  }

  private onAssistant(message: SdkMessageLike): WarbleChatEvent[] {
    const content = message.message?.content;
    if (!Array.isArray(content)) return [];
    const parent = message.parent_tool_use_id ?? null;
    const depth = parent ? 1 : 0;

    const events: WarbleChatEvent[] = [];
    for (const block of content) {
      if (!isToolUseBlock(block)) continue;
      events.push(...this.startStepIfNeeded());
      this.pendingToolNames.set(block.id, block.name);
      events.push({
        t: "tool_call",
        id: block.id,
        name: block.name,
        ...(block.input !== undefined ? { input: block.input } : {}),
        parent,
        depth,
      });
    }
    return events;
  }

  private onUser(message: SdkMessageLike): WarbleChatEvent[] {
    const content = message.message?.content;
    if (!Array.isArray(content)) return [];

    const events: WarbleChatEvent[] = [];
    for (const block of content) {
      if (!isToolResultBlock(block)) continue;
      const name = this.pendingToolNames.get(block.tool_use_id);
      if (name === undefined) continue; // no matching tool_use ever seen — drop rather than fabricate
      this.pendingToolNames.delete(block.tool_use_id);
      const ok = block.is_error !== true;
      const text = summarizeResultContent(block.content);
      events.push({
        t: "tool_result",
        id: block.tool_use_id,
        ok,
        ...(ok ? { summary: text } : { error: text }),
      });
    }
    return events;
  }
}
