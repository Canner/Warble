import { CodexDispatchError } from "./error.js";
import { CodexAppServerTransport } from "./app_server_transport.js";
import {
  buildAskAppServerArgs,
  createAskAgentConfigBundle,
  type AskAgentConfigBundle,
} from "./ask_config.js";
import type { PreparedAskComponent, PreparedAskStep } from "./ask_prepare.js";
import {
  SESSION_REFERENCE_VERSION,
  type CodexSessionReference,
  type CodexTurnReference,
  type SessionIsolationOptions,
} from "./session_types.js";
import { validateDashboardRenderEnvelope } from "./render_contract.js";

interface JsonRecord {
  [key: string]: unknown;
}

export interface CodexAskStepResult {
  step: string;
  agentRole: string;
  agentThreadId: string;
  model: string;
  produced: string;
  ok: boolean;
  value: unknown;
  artifacts: CodexAskArtifactReference[];
}

export interface CodexAskArtifactReference {
  version: typeof SESSION_REFERENCE_VERSION;
  kind: "mcp_tool_result";
  parentThreadId: string;
  parentTurnId: string;
  agentThreadId: string;
  step: string;
  agentRole: string;
  itemId: string;
  server: string;
  tool: string;
  ok: boolean;
}

export interface CodexRenderArtifactReference {
  version: typeof SESSION_REFERENCE_VERSION;
  kind: "render_envelope";
  parentThreadId: string;
  parentTurnId: string;
  agentThreadId: string;
  step: string;
  agentRole: string;
  verified: boolean;
  blockTypes: string[];
}

export type CodexAskEvent =
  | { t: "session_started" | "session_resumed"; session: CodexSessionReference }
  | { t: "turn_started" | "turn_completed"; turn: CodexTurnReference }
  | {
      t: "agent_started";
      parentThreadId: string;
      parentTurnId: string;
      step: string;
      agentRole: string;
      agentThreadId: string;
      model: string;
    }
  | {
      t: "step_finished";
      parentThreadId: string;
      parentTurnId: string;
      step: string;
      agentRole: string;
      agentThreadId: string;
      ok: boolean;
    }
  | { t: "artifact"; reference: CodexAskArtifactReference }
  | { t: "render_artifact"; reference: CodexRenderArtifactReference }
  | {
      t: "render_degraded";
      parentThreadId: string;
      parentTurnId: string;
      reason: "invalid_render_envelope";
    }
  | {
      t: "session_recoverable";
      threadId: string | null;
      reason: "transport_disconnect" | "app_server_crash" | "turn_timeout" | "turn_cancelled";
    }
  | { t: "session_failed"; threadId: string | null; reason: "protocol_violation" };

export interface CodexAskRuntimeOptions extends SessionIsolationOptions {
  turnTimeoutMs?: number;
  onAskEvent?: (event: CodexAskEvent) => void;
}

export interface CodexAskRunResult {
  target: "codex:local";
  component: string;
  session: CodexSessionReference;
  turn: CodexTurnReference;
  finalText: string;
  value: unknown;
  steps: CodexAskStepResult[];
  artifact: CodexRenderArtifactReference | null;
  renderDegraded: boolean;
}

interface SpawnRecord {
  callId: string;
  expected: PreparedAskStep;
  agentThreadId: string | null;
  model: string | null;
  waited: boolean;
}

interface ActiveRun {
  threadId: string;
  turnId: string;
  started: boolean;
  completed: boolean;
  status: CodexTurnReference["status"];
  spawns: SpawnRecord[];
  pendingItems: Map<string, string>;
  finalText: string | null;
  stopReason: "turn_timeout" | "turn_cancelled" | null;
  stopCompleted: (() => void) | null;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface StepEnvelope {
  warble_step: string;
  produces: string;
  ok: boolean;
  value: unknown;
  error: string | null;
}

const PASSIVE_PARENT_ITEMS = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "plan",
  "subAgentActivity",
  "contextCompaction",
]);

const IGNORED_NOTIFICATIONS = new Set([
  "thread/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/plan/updated",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "skills/changed",
  "mcpServer/startupStatus/updated",
  "account/updated",
  "account/rateLimits/updated",
  "remoteControl/status/changed",
  "model/rerouted",
  "configWarning",
  "warning",
]);

const CHILD_THREAD_NOTIFICATIONS = new Set([
  "turn/started",
  "item/started",
  "item/completed",
  "turn/completed",
]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, context: string): JsonRecord {
  if (!isRecord(value)) throw new CodexDispatchError(`${context} requires an object`);
  return value;
}

function string(recordValue: JsonRecord, key: string, context: string): string {
  const value = recordValue[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexDispatchError(`${context} requires string ${key}`);
  }
  return value;
}

function sessionReference(thread: JsonRecord): CodexSessionReference {
  return {
    version: SESSION_REFERENCE_VERSION,
    target: "codex:local",
    threadId: string(thread, "id", "thread"),
    forkedFromThreadId:
      typeof thread["forkedFromId"] === "string" ? thread["forkedFromId"] : null,
  };
}

function turnStatus(value: unknown): CodexTurnReference["status"] {
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

function turnReference(threadId: string, value: unknown): CodexTurnReference {
  const turn = record(value, "turn");
  return { threadId, turnId: string(turn, "id", "turn"), status: turnStatus(turn["status"]) };
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

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseEnvelope(text: string, step: PreparedAskStep): StepEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CodexDispatchError(`agent '${step.role}' returned a non-JSON step envelope`);
  }
  const envelope = record(value, `agent '${step.role}' envelope`);
  const keys = Object.keys(envelope).sort();
  const expectedKeys = ["error", "ok", "produces", "value", "warble_step"];
  if (canonical(keys) !== canonical(expectedKeys)) {
    throw new CodexDispatchError(`agent '${step.role}' returned an unexpected envelope shape`);
  }
  if (
    envelope["warble_step"] !== step.name ||
    envelope["produces"] !== step.produces ||
    typeof envelope["ok"] !== "boolean" ||
    (envelope["error"] !== null && typeof envelope["error"] !== "string")
  ) {
    throw new CodexDispatchError(`agent '${step.role}' returned a mismatched step envelope`);
  }
  if (envelope["ok"] === true && envelope["error"] !== null) {
    throw new CodexDispatchError(`agent '${step.role}' marked success with an error`);
  }
  if (envelope["ok"] === false && envelope["error"] === null) {
    throw new CodexDispatchError(`agent '${step.role}' marked failure without an error`);
  }
  return envelope as unknown as StepEnvelope;
}

function parseStepRequest(text: string, step: PreparedAskStep): JsonRecord {
  const prefix = "WARBLE_STEP_REQUEST\n";
  if (!text.startsWith(prefix)) {
    throw new CodexDispatchError(`agent '${step.role}' input lacks the Warble step envelope`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text.slice(prefix.length));
  } catch {
    throw new CodexDispatchError(`agent '${step.role}' input has malformed JSON`);
  }
  const request = record(value, `agent '${step.role}' input`);
  if (
    request["step"] !== step.name ||
    typeof request["request"] !== "string" ||
    !isRecord(request["inputs"])
  ) {
    throw new CodexDispatchError(`agent '${step.role}' input does not match its IR step`);
  }
  return request;
}

export function buildAskDriverPrompt(prepared: PreparedAskComponent, request: string): string {
  const steps = prepared.steps.map((step, index) => {
    const inputDescription =
      step.consumes.length === 0
        ? "an empty inputs object"
        : `inputs containing only ${step.consumes.join(", ")} copied exactly from the prior agent value`;
    return `${index + 1}. Spawn agent_type=${step.role} for step=${step.name} with ${inputDescription}. Wait for it before any later spawn.`;
  });
  const executionRules =
    prepared.executionKind === "answer_query"
      ? [
          `If '${prepared.steps[1]!.name}' returns ok=true, do not spawn '${prepared.steps[2]!.role}'.`,
          `If it returns ok=false, spawn '${prepared.steps[2]!.role}' exactly once; if repair fails, fail loudly.`,
        ]
      : [
          "Every declared dashboard step is required. If either child returns ok=false, fail loudly and stop.",
          "Do not write files in the parent or children; the final validated render envelope is the consumer-persistable artifact output.",
        ];
  return [
    `Execute Warble component '${prepared.componentId}' by named child-agent delegation only.`,
    "Do not perform any IR step in the parent and do not use business MCP tools in the parent.",
    "For every child, send a message consisting of WARBLE_STEP_REQUEST on the first line followed by exactly one JSON object:",
    '{"step":"<step>","request":"<original request>","inputs":{"<slot>":<prior value>}}',
    "Each child returns a JSON envelope. Copy its value exactly into the next declared input slot.",
    "Spawn without an explicit model override: the named custom-agent config owns the model.",
    "",
    ...steps,
    "",
    ...executionRules,
    "Your final message must be only the final successful child envelope value as JSON, with no prose.",
    "",
    `Original request: ${request}`,
  ].join("\n");
}

export class CodexAskRuntime {
  private transport!: CodexAppServerTransport;
  private bundle!: AskAgentConfigBundle;
  private session: CodexSessionReference | null = null;
  private active: ActiveRun | null = null;
  private startingTurn = false;
  private pendingTurnNotifications: Array<readonly [method: string, params: unknown]> = [];
  private disconnected = false;

  private constructor(
    private readonly prepared: PreparedAskComponent,
    private readonly options: CodexAskRuntimeOptions,
  ) {}

  static async connect(
    prepared: PreparedAskComponent,
    options: CodexAskRuntimeOptions,
  ): Promise<CodexAskRuntime> {
    const runtime = new CodexAskRuntime(prepared, options);
    runtime.bundle = createAskAgentConfigBundle(prepared);
    try {
      runtime.transport = await CodexAppServerTransport.startWithArgs(
        [...(options.codexArgsPrefix ?? []), ...buildAskAppServerArgs(runtime.bundle)],
        options,
        (method, params) => runtime.onNotification(method, params),
        (error) => runtime.onDisconnect(error),
      );
      return runtime;
    } catch (error) {
      runtime.bundle.cleanup();
      throw error;
    }
  }

  async start(): Promise<CodexSessionReference> {
    this.ensureConnected();
    if (this.session !== null) throw new CodexDispatchError("an Ask session is already loaded");
    const result = record(
      await this.transport.request("thread/start", {
        model: this.prepared.models.orchestrator,
        cwd: this.options.cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        config: this.bundle.parentConfig,
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
    this.session = sessionReference(record(result["thread"], "thread/start thread"));
    this.emit({ t: "session_started", session: this.session });
    return this.session;
  }

  async resume(reference: CodexSessionReference): Promise<CodexSessionReference> {
    validateReference(reference);
    this.ensureConnected();
    if (this.active !== null) throw new CodexDispatchError("cannot resume while an Ask turn is active");
    const result = record(
      await this.transport.request("thread/resume", {
        threadId: reference.threadId,
        model: this.prepared.models.orchestrator,
        cwd: this.options.cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        config: this.bundle.parentConfig,
        runtimeWorkspaceRoots: [],
      }),
      "thread/resume response",
    );
    const resumed = sessionReference(record(result["thread"], "thread/resume thread"));
    if (resumed.threadId !== reference.threadId) {
      throw new CodexDispatchError("thread/resume returned a different thread id");
    }
    this.session = resumed;
    this.emit({ t: "session_resumed", session: resumed });
    return resumed;
  }

  async run(
    reference: CodexSessionReference,
    request: string,
    signal?: AbortSignal,
  ): Promise<CodexAskRunResult> {
    validateReference(reference);
    this.ensureConnected();
    if (this.session?.threadId !== reference.threadId) {
      throw new CodexDispatchError("Ask session reference is not loaded; resume it first");
    }
    if (this.active !== null) throw new CodexDispatchError("an Ask turn is already active");
    if (request.trim().length === 0) throw new CodexDispatchError("Ask request must not be empty");
    if (signal?.aborted) throw new CodexDispatchError("Ask turn was cancelled before start");
    let resolveRun!: () => void;
    let rejectRun!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    let turn: CodexTurnReference;
    this.startingTurn = true;
    this.pendingTurnNotifications = [];
    try {
      const result = record(
        await this.transport.request("turn/start", {
          threadId: reference.threadId,
          input: [{ type: "text", text: buildAskDriverPrompt(this.prepared, request), text_elements: [] }],
          approvalPolicy: "never",
          environments: [],
          runtimeWorkspaceRoots: [],
        }),
        "turn/start response",
      );
      turn = turnReference(reference.threadId, result["turn"]);
      if (turn.status !== "in_progress") {
        throw new CodexDispatchError("turn/start did not return an in-progress turn");
      }
      this.active = {
        threadId: reference.threadId,
        turnId: turn.turnId,
        started: false,
        completed: false,
        status: "in_progress",
        spawns: [],
        pendingItems: new Map(),
        finalText: null,
        stopReason: null,
        stopCompleted: null,
        resolve: resolveRun,
        reject: rejectRun,
      };
    } catch (error) {
      this.startingTurn = false;
      this.pendingTurnNotifications = [];
      throw error;
    }
    this.startingTurn = false;
    const pendingNotifications = this.pendingTurnNotifications;
    this.pendingTurnNotifications = [];
    for (const [method, params] of pendingNotifications) {
      this.onNotification(method, params);
    }
    const timeoutMs = this.options.turnTimeoutMs ?? 120_000;
    const timer = setTimeout(() => {
      void this.stopTurn(turn, "turn_timeout");
    }, timeoutMs);
    const cancel = (): void => {
      void this.stopTurn(turn, "turn_cancelled");
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      await completion;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      const active = this.active;
      if (active === null || active.turnId !== turn.turnId) {
        throw new CodexDispatchError("Ask turn state was displaced");
      }
      const steps = await this.validateChildren(active, request);
      const finalStep = steps.at(-1);
      if (!finalStep?.ok) throw new CodexDispatchError("Ask run has no successful final step");
      if (!isRecord(finalStep.value)) {
        throw new CodexDispatchError("Ask final value must be a JSON object");
      }
      let parentFinal: unknown;
      try {
        parentFinal = JSON.parse(active.finalText ?? "");
      } catch {
        throw new CodexDispatchError("Ask parent final message is not JSON");
      }
      if (canonical(parentFinal) !== canonical(finalStep.value)) {
        throw new CodexDispatchError("Ask parent final message does not match the final child value");
      }
      let artifact: CodexRenderArtifactReference | null = null;
      let renderDegraded = false;
      if (this.prepared.executionKind === "generate_dashboard") {
        try {
          const envelope = validateDashboardRenderEnvelope(finalStep.value, this.prepared.node);
          artifact = {
            version: SESSION_REFERENCE_VERSION,
            kind: "render_envelope",
            parentThreadId: active.threadId,
            parentTurnId: active.turnId,
            agentThreadId: finalStep.agentThreadId,
            step: finalStep.step,
            agentRole: finalStep.agentRole,
            verified: envelope.verified,
            blockTypes: envelope.blocks.map((block) => String(block["type"])),
          };
          this.emit({ t: "render_artifact", reference: artifact });
        } catch (error) {
          if (!(error instanceof CodexDispatchError)) throw error;
          renderDegraded = true;
          this.emit({
            t: "render_degraded",
            parentThreadId: active.threadId,
            parentTurnId: active.turnId,
            reason: "invalid_render_envelope",
          });
        }
      }
      const completed: CodexTurnReference = {
        threadId: active.threadId,
        turnId: active.turnId,
        status: active.status,
      };
      this.emit({ t: "turn_completed", turn: completed });
      return {
        target: "codex:local",
        component: this.prepared.componentId,
        session: reference,
        turn: completed,
        finalText: JSON.stringify(finalStep.value),
        value: finalStep.value,
        steps,
        artifact,
        renderDegraded,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      this.startingTurn = false;
      this.pendingTurnNotifications = [];
      this.active = null;
    }
  }

  async restartAndResume(reference: CodexSessionReference): Promise<CodexSessionReference> {
    if (this.active !== null) throw new CodexDispatchError("cannot restart while an Ask turn is active");
    await this.transport.close();
    this.transport = await CodexAppServerTransport.startWithArgs(
      [...(this.options.codexArgsPrefix ?? []), ...buildAskAppServerArgs(this.bundle)],
      this.options,
      (method, params) => this.onNotification(method, params),
      (error) => this.onDisconnect(error),
    );
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
    this.active?.reject(new CodexDispatchError("Ask runtime closed during an active turn"));
    this.active = null;
    await this.transport.close();
    this.bundle.cleanup();
  }

  private onNotification(method: string, paramsValue: unknown): void {
    try {
      if (IGNORED_NOTIFICATIONS.has(method)) return;
      const params = record(paramsValue, `${method} notification`);
      if (this.active === null && this.startingTurn) {
        this.pendingTurnNotifications.push([method, paramsValue]);
        return;
      }
      if (method === "error") {
        if (params["willRetry"] === true) return;
        throw new CodexDispatchError("app-server reported a terminal Ask error");
      }
      const active = this.active;
      if (active === null) throw new CodexDispatchError(`unexpected '${method}' without an active Ask turn`);
      const notificationThreadId = params["threadId"];
      if (
        typeof notificationThreadId === "string" &&
        notificationThreadId !== active.threadId
      ) {
        const knownChild = active.spawns.some(
          (spawn) => spawn.agentThreadId === notificationThreadId,
        );
        if (knownChild && CHILD_THREAD_NOTIFICATIONS.has(method)) return;
        throw new CodexDispatchError("Ask notification belongs to an unknown thread");
      }
      if (method === "turn/started") {
        const turn = turnReference(string(params, "threadId", method), params["turn"]);
        if (turn.threadId !== active.threadId || turn.turnId !== active.turnId || active.started) {
          throw new CodexDispatchError("Ask turn start notification does not match active state");
        }
        active.started = true;
        this.emit({ t: "turn_started", turn });
        return;
      }
      if (method === "item/started" || method === "item/completed") {
        this.onItem(method, params, active);
        return;
      }
      if (method === "turn/completed") {
        const turn = turnReference(string(params, "threadId", method), params["turn"]);
        if (!active.started || turn.threadId !== active.threadId || turn.turnId !== active.turnId) {
          throw new CodexDispatchError("Ask turn completion does not match active state");
        }
        if (active.stopReason !== null && turn.status === "interrupted") {
          active.completed = true;
          active.status = turn.status;
          active.stopCompleted?.();
          return;
        }
        if (active.pendingItems.size > 0) {
          throw new CodexDispatchError("Ask turn completed with pending collaboration items");
        }
        if (turn.status !== "completed" || active.finalText === null) {
          throw new CodexDispatchError("Ask parent turn did not complete with a final answer");
        }
        active.completed = true;
        active.status = turn.status;
        active.resolve();
        return;
      }
      throw new CodexDispatchError(`unsupported app-server notification '${method}'`);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.active?.reject(failure);
      this.onDisconnect(
        failure instanceof CodexDispatchError ? failure : new CodexDispatchError(failure.message),
      );
      void this.transport.close();
    }
  }

  private onItem(
    method: "item/started" | "item/completed",
    params: JsonRecord,
    active: ActiveRun,
  ): void {
    if (string(params, "threadId", method) !== active.threadId || string(params, "turnId", method) !== active.turnId) {
      throw new CodexDispatchError("Ask item belongs to a different parent turn");
    }
    const item = record(params["item"], `${method} item`);
    const type = string(item, "type", `${method} item`);
    if (type === "collabAgentToolCall") {
      this.onCollabItem(method, item, active);
      return;
    }
    if (!PASSIVE_PARENT_ITEMS.has(type)) {
      throw new CodexDispatchError(`isolation violation: Ask parent emitted forbidden '${type}'`);
    }
    if (method === "item/completed" && type === "agentMessage") {
      active.finalText = string(item, "text", type);
    }
  }

  private onCollabItem(
    method: "item/started" | "item/completed",
    item: JsonRecord,
    active: ActiveRun,
  ): void {
    const id = string(item, "id", "collaboration item");
    const tool = string(item, "tool", "collaboration item");
    if (tool !== "spawnAgent" && tool !== "wait") {
      throw new CodexDispatchError(`Ask parent used unsupported collaboration tool '${tool}'`);
    }
    if (method === "item/started") {
      if (item["status"] !== "inProgress" || active.pendingItems.has(id)) {
        throw new CodexDispatchError("collaboration item has an invalid start state");
      }
      active.pendingItems.set(id, tool);
      return;
    }
    if (active.pendingItems.get(id) !== tool) {
      throw new CodexDispatchError("collaboration item completed without a matching start");
    }
    active.pendingItems.delete(id);
    if (item["status"] !== "completed") {
      throw new CodexDispatchError(`collaboration '${tool}' failed`);
    }
    if (tool === "spawnAgent") {
      const previous = active.spawns.at(-1);
      if (previous && !previous.waited) {
        throw new CodexDispatchError("Ask parent spawned the next agent before waiting for the prior one");
      }
      const expected = this.prepared.steps[active.spawns.length];
      if (!expected) throw new CodexDispatchError("Ask parent spawned too many agents");
      const receiverIds = item["receiverThreadIds"];
      if (!Array.isArray(receiverIds) || receiverIds.length !== 1 || typeof receiverIds[0] !== "string") {
        throw new CodexDispatchError("spawnAgent must return exactly one child thread");
      }
      const model = string(item, "model", "spawnAgent");
      if (model !== expected.model) {
        throw new CodexDispatchError(`agent '${expected.role}' ran on the wrong model`);
      }
      const spawn: SpawnRecord = {
        callId: id,
        expected,
        agentThreadId: receiverIds[0],
        model,
        waited: false,
      };
      active.spawns.push(spawn);
      this.emit({
        t: "agent_started",
        parentThreadId: active.threadId,
        parentTurnId: active.turnId,
        step: expected.name,
        agentRole: expected.role,
        agentThreadId: receiverIds[0],
        model,
      });
      return;
    }
    const current = active.spawns.at(-1);
    if (!current?.agentThreadId || current.waited) {
      throw new CodexDispatchError("wait did not follow exactly one active child spawn");
    }
    const receiverIds = item["receiverThreadIds"];
    if (!Array.isArray(receiverIds) || receiverIds.length !== 1 || receiverIds[0] !== current.agentThreadId) {
      throw new CodexDispatchError("wait targeted a different child thread");
    }
    const states = record(item["agentsStates"], "wait agentsStates");
    const childState = record(states[current.agentThreadId], "wait child state");
    if (childState["status"] !== "completed") {
      throw new CodexDispatchError("wait completed before the child agent succeeded");
    }
    current.waited = true;
  }

  private async validateChildren(active: ActiveRun, originalRequest: string): Promise<CodexAskStepResult[]> {
    const minimumSteps = 2;
    const maximumSteps = this.prepared.executionKind === "answer_query" ? 3 : 2;
    if (
      active.spawns.length < minimumSteps ||
      active.spawns.length > maximumSteps ||
      active.spawns.some((spawn) => !spawn.waited)
    ) {
      throw new CodexDispatchError("Ask parent did not complete the required named-agent sequence");
    }
    const results: CodexAskStepResult[] = [];
    const slots: Record<string, unknown> = {};
    for (const [index, spawn] of active.spawns.entries()) {
      const step = this.prepared.steps[index]!;
      if (spawn.expected !== step || spawn.agentThreadId === null || spawn.model !== step.model) {
        throw new CodexDispatchError("Ask child sequence does not match the IR");
      }
      const child = record(
        await this.transport.request("thread/read", {
          threadId: spawn.agentThreadId,
          includeTurns: true,
        }),
        "child thread/read response",
      );
      const thread = record(child["thread"], "child thread/read thread");
      if (
        thread["id"] !== spawn.agentThreadId ||
        thread["parentThreadId"] !== active.threadId ||
        thread["agentRole"] !== step.role
      ) {
        throw new CodexDispatchError(`child thread attribution failed for agent '${step.role}'`);
      }
      const turns = thread["turns"];
      if (!Array.isArray(turns) || turns.length !== 1) {
        throw new CodexDispatchError(`agent '${step.role}' must have exactly one turn`);
      }
      const turn = record(turns[0], `agent '${step.role}' turn`);
      if (turn["status"] !== "completed" || !Array.isArray(turn["items"])) {
        throw new CodexDispatchError(`agent '${step.role}' turn did not complete`);
      }
      let inputText: string | null = null;
      let answerText: string | null = null;
      const artifacts: CodexAskArtifactReference[] = [];
      for (const itemValue of turn["items"]) {
        const item = record(itemValue, `agent '${step.role}' item`);
        const type = string(item, "type", `agent '${step.role}' item`);
        if (type === "userMessage") {
          const content = item["content"];
          if (!Array.isArray(content) || !isRecord(content[0]) || typeof content[0]["text"] !== "string") {
            throw new CodexDispatchError(`agent '${step.role}' user input is malformed`);
          }
          inputText = content[0]["text"];
        } else if (type === "agentMessage") {
          answerText = string(item, "text", `agent '${step.role}' answer`);
        } else if (type === "mcpToolCall") {
          const server = string(item, "server", "child MCP item");
          const tool = string(item, "tool", "child MCP item");
          if (server !== this.prepared.mcp.name || !step.enabledTools.includes(tool)) {
            throw new CodexDispatchError(`agent '${step.role}' used a non-allowlisted MCP tool`);
          }
          const status = string(item, "status", "child MCP item");
          if (status !== "completed" && status !== "failed") {
            throw new CodexDispatchError(`agent '${step.role}' has an unfinished MCP tool`);
          }
          const reference: CodexAskArtifactReference = {
            version: SESSION_REFERENCE_VERSION,
            kind: "mcp_tool_result",
            parentThreadId: active.threadId,
            parentTurnId: active.turnId,
            agentThreadId: spawn.agentThreadId,
            step: step.name,
            agentRole: step.role,
            itemId: string(item, "id", "child MCP item"),
            server,
            tool,
            ok: status === "completed" && (item["error"] === null || item["error"] === undefined),
          };
          artifacts.push(reference);
          this.emit({ t: "artifact", reference });
        } else if (!new Set(["reasoning", "plan"]).has(type)) {
          throw new CodexDispatchError(`agent '${step.role}' emitted forbidden '${type}'`);
        }
      }
      if (inputText === null || answerText === null) {
        throw new CodexDispatchError(`agent '${step.role}' lacks input or final answer`);
      }
      const request = parseStepRequest(inputText, step);
      if (request["request"] !== originalRequest) {
        throw new CodexDispatchError(`agent '${step.role}' did not receive the original request`);
      }
      const inputs = request["inputs"] as JsonRecord;
      if (Object.keys(inputs).sort().join(",") !== [...step.consumes].sort().join(",")) {
        throw new CodexDispatchError(`agent '${step.role}' received the wrong input slots`);
      }
      for (const consumed of step.consumes) {
        if (canonical(inputs[consumed]) !== canonical(slots[consumed])) {
          throw new CodexDispatchError(`agent '${step.role}' input '${consumed}' was not marshalled exactly`);
        }
      }
      const envelope = parseEnvelope(answerText, step);
      if (index === 0 && !envelope.ok) {
        throw new CodexDispatchError(`required step '${step.name}' failed`);
      }
      if (
        this.prepared.executionKind === "generate_dashboard" &&
        !envelope.ok
      ) {
        throw new CodexDispatchError(`required step '${step.name}' failed`);
      }
      if (this.prepared.executionKind === "answer_query" && index === 1 && !envelope.ok && active.spawns.length !== 3) {
        throw new CodexDispatchError("generate failure did not trigger the repair agent");
      }
      if (this.prepared.executionKind === "answer_query" && index === 1 && envelope.ok && active.spawns.length !== 2) {
        throw new CodexDispatchError("repair agent ran even though generation succeeded");
      }
      if (this.prepared.executionKind === "answer_query" && index === 2 && (!step.conditional || envelope.ok === false)) {
        throw new CodexDispatchError("bounded repair attempt did not recover generation");
      }
      if (step.requireSuccessfulTool && artifacts.length === 0) {
        throw new CodexDispatchError(`agent '${step.role}' completed without its required MCP tool attempt`);
      }
      if (envelope.ok && step.requireSuccessfulTool && !artifacts.some((artifact) => artifact.ok)) {
        throw new CodexDispatchError(`agent '${step.role}' claimed success without a successful MCP tool`);
      }
      slots[step.produces] = envelope.value;
      const result: CodexAskStepResult = {
        step: step.name,
        agentRole: step.role,
        agentThreadId: spawn.agentThreadId,
        model: step.model,
        produced: step.produces,
        ok: envelope.ok,
        value: envelope.value,
        artifacts,
      };
      results.push(result);
      this.emit({
        t: "step_finished",
        parentThreadId: active.threadId,
        parentTurnId: active.turnId,
        step: step.name,
        agentRole: step.role,
        agentThreadId: spawn.agentThreadId,
        ok: envelope.ok,
      });
    }
    return results;
  }

  private async stopTurn(
    turn: CodexTurnReference,
    reason: "turn_timeout" | "turn_cancelled",
  ): Promise<void> {
    if (this.active?.turnId !== turn.turnId || this.active.stopReason !== null) return;
    this.active.stopReason = reason;
    const transport = this.transport;
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    this.active.stopCompleted = resolveStopped;
    try {
      await transport.request("turn/interrupt", {
        threadId: turn.threadId,
        turnId: turn.turnId,
      });
    } catch {
      // Closing the process tree below is the hard stop.
    }
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      stopped,
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, this.options.terminationGraceMs ?? 1_000);
      }),
    ]);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    await transport.close();
    if (this.active?.turnId !== turn.turnId) return;
    const error = new CodexDispatchError(
      reason === "turn_timeout"
        ? `Ask turn '${turn.turnId}' timed out`
        : `Ask turn '${turn.turnId}' was cancelled`,
    );
    this.active.reject(error);
    this.onDisconnect(undefined, reason);
  }

  private onDisconnect(
    protocolError?: CodexDispatchError,
    reasonOverride?: "turn_timeout" | "turn_cancelled",
  ): void {
    if (this.disconnected) return;
    this.disconnected = true;
    if (protocolError) {
      this.emit({ t: "session_failed", threadId: this.session?.threadId ?? null, reason: "protocol_violation" });
      this.active?.reject(protocolError);
    } else {
      this.emit({
        t: "session_recoverable",
        threadId: this.session?.threadId ?? null,
        reason: reasonOverride ?? (this.active ? "app_server_crash" : "transport_disconnect"),
      });
      this.active?.reject(new CodexDispatchError("app-server disconnected during an Ask turn"));
    }
  }

  private ensureConnected(): void {
    if (this.disconnected) throw new CodexDispatchError("app-server transport disconnected; resume required");
  }

  private emit(event: CodexAskEvent): void {
    this.options.onAskEvent?.(event);
  }
}
