import { buildIsolationConfig, buildPrompt } from "./config.js";
import { CodexDispatchError } from "./error.js";
import { CodexAppServerTransport } from "./app_server_transport.js";
import type { PreparedSetupComponent } from "./prepare.js";
import type { PreparedEnrichComponent } from "./enrich_prepare.js";
import {
  SESSION_REFERENCE_VERSION,
  type CodexArtifactReference,
  type CodexHistoryItem,
  type CodexHistoryTurn,
  type CodexSessionEvent,
  type CodexSessionHistory,
  type CodexSessionReference,
  type CodexTurnReference,
  type SessionIsolationOptions,
  type SessionTurnStatus,
} from "./session_types.js";

interface JsonRecord {
  [key: string]: unknown;
}

interface ActiveTurn {
  started: boolean;
  pendingTools: Set<string>;
  successfulTools: number;
  hasAnswer: boolean;
}

interface TurnWaiter {
  resolve: (turn: CodexTurnReference) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const FORBIDDEN_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "webSearch",
  "imageGeneration",
  "collabAgentToolCall",
  "subAgentActivity",
  "dynamicToolCall",
  "imageView",
  "sleep",
  "enteredReviewMode",
  "exitedReviewMode",
]);

const PASSIVE_ITEM_TYPES = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "plan",
  "compacted",
  "contextCompaction",
]);

const IGNORED_NOTIFICATIONS = new Set([
  "skills/changed",
  "thread/name/updated",
  "thread/goal/updated",
  "thread/goal/cleared",
  "thread/settings/updated",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "thread/compacted",
  "turn/diff/updated",
  "turn/plan/updated",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/mcpToolCall/progress",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "mcpServer/startupStatus/updated",
  "account/updated",
  "account/rateLimits/updated",
  "app/list/updated",
  "remoteControl/status/changed",
  "fs/changed",
  "model/rerouted",
  "model/verification",
  "model/safetyBuffering/updated",
  "turn/moderationMetadata",
  "warning",
  "guardianWarning",
  "deprecationNotice",
]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown, context: string): JsonRecord {
  if (!isRecord(value)) throw new CodexDispatchError(`${context} requires an object`);
  return value;
}

function requiredString(record: JsonRecord, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexDispatchError(`${context} requires string ${key}`);
  }
  return value;
}

function sessionReference(thread: JsonRecord): CodexSessionReference {
  return {
    version: SESSION_REFERENCE_VERSION,
    target: "codex:local",
    threadId: requiredString(thread, "id", "thread"),
    forkedFromThreadId:
      typeof thread["forkedFromId"] === "string" ? thread["forkedFromId"] : null,
  };
}

function turnStatus(value: unknown): SessionTurnStatus {
  switch (value) {
    case "inProgress":
      return "in_progress";
    case "completed":
    case "interrupted":
    case "failed":
      return value;
    default:
      throw new CodexDispatchError("turn requires a recognized status");
  }
}

function turnReference(threadId: string, turn: JsonRecord): CodexTurnReference {
  return {
    threadId,
    turnId: requiredString(turn, "id", "turn"),
    status: turnStatus(turn["status"]),
  };
}

function validateReference(reference: CodexSessionReference): void {
  if (
    reference.version !== SESSION_REFERENCE_VERSION ||
    reference.target !== "codex:local" ||
    reference.threadId.length === 0
  ) {
    throw new CodexDispatchError("invalid codex session reference");
  }
}

export class CodexSessionRuntime {
  private transport!: CodexAppServerTransport;
  private session: CodexSessionReference | null = null;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly waiters = new Map<string, TurnWaiter[]>();
  private disconnected = false;

  private constructor(
    private readonly prepared: PreparedSetupComponent | PreparedEnrichComponent,
    private readonly options: SessionIsolationOptions,
  ) {}

  static async connect(
    prepared: PreparedSetupComponent | PreparedEnrichComponent,
    options: SessionIsolationOptions,
  ): Promise<CodexSessionRuntime> {
    const runtime = new CodexSessionRuntime(prepared, options);
    runtime.transport = await CodexAppServerTransport.start(
      prepared,
      options,
      (method, params) => runtime.onNotification(method, params),
      (error) => runtime.onDisconnect(error),
    );
    return runtime;
  }

  async start(): Promise<CodexSessionReference> {
    this.ensureConnected();
    if (this.session !== null) {
      throw new CodexDispatchError("a session is already loaded; use a new runtime to start another");
    }
    const result = requiredRecord(
      await this.transport.request("thread/start", {
        model: this.prepared.model,
        cwd: this.options.cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        config: buildIsolationConfig(this.prepared),
        ephemeral: false,
        historyMode: "legacy",
        environments: [],
        runtimeWorkspaceRoots: [],
        selectedCapabilityRoots: [],
        dynamicTools: [],
        experimentalRawEvents: false,
      }),
      "thread/start response",
    );
    const reference = sessionReference(requiredRecord(result["thread"], "thread/start thread"));
    this.session = reference;
    this.emit({ t: "session_started", session: reference });
    return reference;
  }

  async resume(reference: CodexSessionReference): Promise<CodexSessionReference> {
    validateReference(reference);
    this.ensureConnected();
    this.requireNoActiveTurns("resume");
    if (this.session !== null && this.session.threadId !== reference.threadId) {
      throw new CodexDispatchError(
        "a different session is already loaded; use a new runtime to resume another",
      );
    }
    const result = requiredRecord(
      await this.transport.request("thread/resume", {
        threadId: reference.threadId,
        model: this.prepared.model,
        cwd: this.options.cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        config: buildIsolationConfig(this.prepared),
        runtimeWorkspaceRoots: [],
      }),
      "thread/resume response",
    );
    const resumed = sessionReference(requiredRecord(result["thread"], "thread/resume thread"));
    if (resumed.threadId !== reference.threadId) {
      throw new CodexDispatchError("thread/resume returned a different thread id");
    }
    this.session = resumed;
    this.emit({ t: "session_resumed", session: resumed });
    return resumed;
  }

  async read(reference: CodexSessionReference): Promise<CodexSessionHistory> {
    validateReference(reference);
    this.ensureConnected();
    const result = requiredRecord(
      await this.transport.request("thread/read", { threadId: reference.threadId, includeTurns: true }),
      "thread/read response",
    );
    const thread = requiredRecord(result["thread"], "thread/read thread");
    const readReference = sessionReference(thread);
    if (readReference.threadId !== reference.threadId) {
      throw new CodexDispatchError("thread/read returned a different thread id");
    }
    const turns = Array.isArray(thread["turns"])
      ? thread["turns"].map((turn) => this.projectHistoryTurn(reference.threadId, turn))
      : [];
    return { session: readReference, turns };
  }

  async turn(reference: CodexSessionReference, input: string): Promise<CodexTurnReference> {
    this.requireCurrent(reference);
    if (input.length === 0) throw new CodexDispatchError("turn input must not be empty");
    const result = requiredRecord(
      await this.transport.request("turn/start", {
        threadId: reference.threadId,
        input: [{ type: "text", text: buildPrompt(this.prepared, input), text_elements: [] }],
        approvalPolicy: "never",
        environments: [],
        runtimeWorkspaceRoots: [],
      }),
      "turn/start response",
    );
    const turn = turnReference(reference.threadId, requiredRecord(result["turn"], "turn/start turn"));
    if (turn.status !== "in_progress") {
      throw new CodexDispatchError("turn/start did not return an in-progress turn");
    }
    this.ensureActiveTurn(turn.turnId);
    return turn;
  }

  async steer(
    reference: CodexSessionReference,
    turnId: string,
    input: string,
  ): Promise<CodexTurnReference> {
    this.requireCurrent(reference);
    const result = requiredRecord(
      await this.transport.request("turn/steer", {
        threadId: reference.threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text: input, text_elements: [] }],
      }),
      "turn/steer response",
    );
    if (requiredString(result, "turnId", "turn/steer response") !== turnId) {
      throw new CodexDispatchError("turn/steer returned a different turn id");
    }
    return { threadId: reference.threadId, turnId, status: "in_progress" };
  }

  async interrupt(reference: CodexSessionReference, turnId: string): Promise<void> {
    this.requireCurrent(reference);
    await this.transport.request("turn/interrupt", { threadId: reference.threadId, turnId });
  }

  async fork(
    reference: CodexSessionReference,
    lastTurnId?: string,
  ): Promise<CodexSessionReference> {
    validateReference(reference);
    this.ensureConnected();
    this.requireNoActiveTurns("fork");
    const result = requiredRecord(
      await this.transport.request("thread/fork", {
        threadId: reference.threadId,
        ...(lastTurnId === undefined ? {} : { lastTurnId }),
        model: this.prepared.model,
        cwd: this.options.cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        config: buildIsolationConfig(this.prepared),
        ephemeral: false,
        runtimeWorkspaceRoots: [],
      }),
      "thread/fork response",
    );
    const forked = sessionReference(requiredRecord(result["thread"], "thread/fork thread"));
    if (forked.threadId === reference.threadId || forked.forkedFromThreadId !== reference.threadId) {
      throw new CodexDispatchError("thread/fork returned an invalid lineage");
    }
    this.emit({ t: "session_forked", session: forked });
    return forked;
  }

  waitForTurn(turn: CodexTurnReference, timeoutMs = this.options.timeoutMs ?? 120_000): Promise<CodexTurnReference> {
    if (turn.status !== "in_progress") return Promise.resolve(turn);
    if (this.disconnected || !this.activeTurns.has(turn.turnId)) {
      return Promise.reject(new CodexDispatchError("turn is no longer active; resume required"));
    }
    return new Promise((resolveWaiter, rejectWaiter) => {
      const timer = setTimeout(() => {
        this.removeWaiter(turn.turnId, waiter);
        const error = new CodexDispatchError(`turn '${turn.turnId}' timed out`);
        void (async () => {
          try {
            await this.interrupt(
              { version: SESSION_REFERENCE_VERSION, target: "codex:local", threadId: turn.threadId, forkedFromThreadId: null },
              turn.turnId,
            );
          } catch {
            // The transport is closed below even when best-effort interrupt fails.
          }
          this.onDisconnect(error, "turn_timeout");
          await this.transport.close();
          rejectWaiter(error);
        })();
      }, timeoutMs);
      const waiter: TurnWaiter = { resolve: resolveWaiter, reject: rejectWaiter, timer };
      const list = this.waiters.get(turn.turnId) ?? [];
      list.push(waiter);
      this.waiters.set(turn.turnId, list);
    });
  }

  async restartAndResume(reference: CodexSessionReference): Promise<CodexSessionReference> {
    if (!this.disconnected && this.activeTurns.size > 0) {
      throw new CodexDispatchError("cannot restart while a turn is active; interrupt it first");
    }
    await this.transport.close();
    const transport = await CodexAppServerTransport.start(
      this.prepared,
      this.options,
      (method, params) => this.onNotification(method, params),
      (error) => this.onDisconnect(error),
    );
    this.transport = transport;
    this.disconnected = false;
    try {
      return await this.resume(reference);
    } catch (error) {
      this.disconnected = true;
      await this.transport.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.disconnected = true;
    const error = new CodexDispatchError("session runtime closed during an active turn");
    for (const [turnId] of this.activeTurns) {
      this.settleWaiters(
        { threadId: this.session?.threadId ?? "unknown", turnId, status: "failed" },
        error,
      );
    }
    this.activeTurns.clear();
    await this.transport.close();
  }

  private onNotification(method: string, paramsValue: unknown): void {
    const params = requiredRecord(paramsValue, `${method} notification`);
    if (method === "thread/started" || IGNORED_NOTIFICATIONS.has(method)) return;
    if (method === "error") {
      const threadId = requiredString(params, "threadId", method);
      this.requireNotificationThread(threadId);
      const turnId = requiredString(params, "turnId", method);
      requiredRecord(params["error"], "error notification error");
      const active = this.activeTurns.get(turnId);
      if (!active?.started) {
        throw new CodexDispatchError("app-server error notification has no active turn");
      }
      if (params["willRetry"] === true) return;
      if (params["willRetry"] !== false) {
        throw new CodexDispatchError("app-server error notification requires willRetry");
      }
      throw new CodexDispatchError("app-server reported a terminal turn error");
    }
    if (method === "turn/started") {
      const threadId = requiredString(params, "threadId", method);
      this.requireNotificationThread(threadId);
      const turn = turnReference(threadId, requiredRecord(params["turn"], `${method} turn`));
      const active = this.ensureActiveTurn(turn.turnId);
      if (active.started) throw new CodexDispatchError("duplicate turn start notification");
      active.started = true;
      this.emit({ t: "turn_started", turn });
      this.emit({ threadId, turnId: turn.turnId, t: "step_start", id: this.prepared.step.name, name: this.prepared.step.name });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      this.onItem(method, params);
      return;
    }
    if (method === "turn/completed") {
      this.onTurnCompleted(params);
      return;
    }
    throw new CodexDispatchError(`unsupported app-server notification '${method}'`);
  }

  private onItem(method: "item/started" | "item/completed", params: JsonRecord): void {
    const threadId = requiredString(params, "threadId", method);
    this.requireNotificationThread(threadId);
    const turnId = requiredString(params, "turnId", method);
    const item = requiredRecord(params["item"], `${method} item`);
    const type = requiredString(item, "type", `${method} item`);
    if (FORBIDDEN_ITEM_TYPES.has(type)) {
      throw new CodexDispatchError(`isolation violation: app-server emitted forbidden '${type}'`);
    }
    const active = this.ensureActiveTurn(turnId);
    if (!active.started) throw new CodexDispatchError("item emitted before turn started");
    if (type === "mcpToolCall") {
      const itemId = requiredString(item, "id", type);
      const server = requiredString(item, "server", type);
      const tool = requiredString(item, "tool", type);
      if (server !== this.prepared.mcp.name || !this.prepared.enabledTools.includes(tool)) {
        throw new CodexDispatchError(`isolation violation: non-allowlisted MCP tool '${server}.${tool}'`);
      }
      if (method === "item/started") {
        if (item["status"] !== "inProgress") {
          throw new CodexDispatchError("MCP item start requires in-progress status");
        }
        if (active.pendingTools.has(itemId)) throw new CodexDispatchError("duplicate MCP item start");
        active.pendingTools.add(itemId);
        this.emit({ threadId, turnId, t: "tool_call", id: itemId, name: `${server}.${tool}` });
        return;
      }
      if (!active.pendingTools.delete(itemId)) throw new CodexDispatchError("MCP item completed without start");
      const status = requiredString(item, "status", type);
      if (status !== "completed" && status !== "failed") {
        throw new CodexDispatchError("MCP item completed with an invalid status");
      }
      const ok = status === "completed" && (item["error"] === null || item["error"] === undefined);
      if (ok) active.successfulTools += 1;
      const reference: CodexArtifactReference = {
        version: SESSION_REFERENCE_VERSION,
        kind: "mcp_tool_result",
        threadId,
        turnId,
        itemId,
        server,
        tool,
        ok,
      };
      this.emit({ t: "artifact", reference });
      this.emit({ threadId, turnId, t: "tool_result", id: itemId, ok, ...(ok ? {} : { error: "allowlisted MCP tool failed" }) });
      return;
    }
    if (!PASSIVE_ITEM_TYPES.has(type)) {
      throw new CodexDispatchError(`unsupported app-server item type '${type}'`);
    }
    if (method === "item/completed" && type === "agentMessage") {
      const text = requiredString(item, "text", type);
      active.hasAnswer = true;
      this.emit({ threadId, turnId, t: "answer", text });
    }
  }

  private onTurnCompleted(params: JsonRecord): void {
    const threadId = requiredString(params, "threadId", "turn/completed");
    this.requireNotificationThread(threadId);
    const turn = turnReference(threadId, requiredRecord(params["turn"], "turn/completed turn"));
    const active = this.activeTurns.get(turn.turnId);
    if (!active) throw new CodexDispatchError("turn completed without starting");
    if (!active.started) throw new CodexDispatchError("turn completed before start notification");
    if (active.pendingTools.size > 0) throw new CodexDispatchError("turn completed with pending MCP tools");
    if (turn.status === "completed" && (active.successfulTools === 0 || !active.hasAnswer)) {
      throw new CodexDispatchError("completed turn lacks a successful allowlisted tool or answer");
    }
    this.activeTurns.delete(turn.turnId);
    const ok = turn.status === "completed";
    this.emit({ threadId, turnId: turn.turnId, t: "step_finish", id: this.prepared.step.name, ok });
    this.emit({ t: "turn_completed", turn });
    const error = turn.status === "failed" ? new CodexDispatchError(`turn '${turn.turnId}' failed`) : null;
    this.settleWaiters(turn, error);
  }

  private projectHistoryTurn(threadId: string, value: unknown): CodexHistoryTurn {
    const turn = requiredRecord(value, "history turn");
    const reference = turnReference(threadId, turn);
    const items: CodexHistoryItem[] = [];
    if (Array.isArray(turn["items"])) {
      for (const itemValue of turn["items"]) {
        const item = requiredRecord(itemValue, "history item");
        const type = requiredString(item, "type", "history item");
        if (type === "agentMessage") {
          items.push({ type: "assistant", itemId: requiredString(item, "id", type) });
        } else if (type === "userMessage") {
          items.push({ type: "user", itemId: requiredString(item, "id", type) });
        } else if (type === "mcpToolCall") {
          const server = requiredString(item, "server", type);
          const tool = requiredString(item, "tool", type);
          if (server !== this.prepared.mcp.name || !this.prepared.enabledTools.includes(tool)) {
            throw new CodexDispatchError("history contains a non-allowlisted MCP tool");
          }
          const status = requiredString(item, "status", type);
          if (status !== "completed" && status !== "failed") {
            throw new CodexDispatchError("history MCP item has an invalid status");
          }
          items.push({
            type: "artifact",
            reference: {
              version: SESSION_REFERENCE_VERSION,
              kind: "mcp_tool_result",
              threadId,
              turnId: reference.turnId,
              itemId: requiredString(item, "id", type),
              server,
              tool,
              ok: status === "completed" && (item["error"] === null || item["error"] === undefined),
            },
          });
        } else if (FORBIDDEN_ITEM_TYPES.has(type)) {
          throw new CodexDispatchError(`history contains forbidden '${type}' item`);
        } else if (!PASSIVE_ITEM_TYPES.has(type)) {
          throw new CodexDispatchError(`history contains unsupported '${type}' item`);
        }
      }
    }
    return { id: reference.turnId, status: reference.status, items };
  }

  private ensureActiveTurn(turnId: string): ActiveTurn {
    let active = this.activeTurns.get(turnId);
    if (!active) {
      active = { started: false, pendingTools: new Set(), successfulTools: 0, hasAnswer: false };
      this.activeTurns.set(turnId, active);
    }
    return active;
  }

  private requireCurrent(reference: CodexSessionReference): void {
    validateReference(reference);
    this.ensureConnected();
    if (this.session?.threadId !== reference.threadId) {
      throw new CodexDispatchError("session reference is not loaded; resume it first");
    }
  }

  private requireNotificationThread(threadId: string): void {
    if (this.session?.threadId !== threadId) {
      throw new CodexDispatchError("app-server notification belongs to a different thread");
    }
  }

  private requireNoActiveTurns(operation: string): void {
    if (this.activeTurns.size > 0) {
      throw new CodexDispatchError(
        `cannot ${operation} while a turn is active; interrupt it first`,
      );
    }
  }

  private ensureConnected(): void {
    if (this.disconnected) throw new CodexDispatchError("app-server transport disconnected; resume required");
  }

  private onDisconnect(
    protocolError?: CodexDispatchError,
    reasonOverride?: "turn_timeout",
  ): void {
    if (this.disconnected) return;
    this.disconnected = true;
    if (protocolError && reasonOverride === undefined) {
      this.emit({
        t: "session_failed",
        threadId: this.session?.threadId ?? null,
        reason: "protocol_violation",
      });
    } else {
      const reason = reasonOverride ?? (this.activeTurns.size > 0 ? "app_server_crash" : "transport_disconnect");
      this.emit({ t: "session_recoverable", threadId: this.session?.threadId ?? null, reason });
    }
    for (const [turnId] of this.activeTurns) {
      this.settleWaiters(
        { threadId: this.session?.threadId ?? "unknown", turnId, status: "failed" },
        protocolError ?? new CodexDispatchError("app-server disconnected during an active turn"),
      );
    }
    this.activeTurns.clear();
  }

  private settleWaiters(turn: CodexTurnReference, error: Error | null): void {
    const waiters = this.waiters.get(turn.turnId) ?? [];
    this.waiters.delete(turn.turnId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      if (error) waiter.reject(error);
      else waiter.resolve(turn);
    }
  }

  private removeWaiter(turnId: string, waiter: TurnWaiter): void {
    const remaining = (this.waiters.get(turnId) ?? []).filter((candidate) => candidate !== waiter);
    if (remaining.length === 0) this.waiters.delete(turnId);
    else this.waiters.set(turnId, remaining);
  }

  private emit(event: CodexSessionEvent): void {
    this.options.onEvent?.(event);
  }
}
