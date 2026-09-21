import { randomUUID } from "node:crypto";
import { CodexAppServerTransport } from "./app_server_transport.js";
import { buildIsolationConfig } from "./config.js";
import { CodexDispatchError } from "./error.js";
import type { PreparedTurnComponent } from "./turn_prepare.js";
import type { PreparedOrchestrateStep } from "./orchestrate_prepare.js";
import type { SessionIsolationOptions } from "./session_types.js";
import { parseStepTerminal } from "./step_engine.js";
import {
  assertPreparedInvocation, invocationError, isRecord, jsonBytes, normalizeInvocationRequest,
  normalizeInvocationResult, type InvocationErrorCode, type InvocationNode, type InvocationRequest,
  type InvocationResult, type PreparedInvocation,
} from "./component_invocation.js";

const NAMESPACE = "warble_components";
const REQUEST_SCHEMA = { type: "object", properties: { request: { type: "string", minLength: 1 }, input: { type: "object" } }, required: ["request"], additionalProperties: false };
export interface ComponentCallTrace {
  callId: string; parentCallId: string | null; caller: string; step: string; alias: string;
  callee: string; depth: number; attempt: number; status: "running" | "ok" | "refused" | "error" | "late_discarded";
  requestBytes: number; resultBytes: number; steps: number;
}
export interface ComponentUsage { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningOutputTokens: number; totalTokens: number }
export interface ComponentRunResult {
  target: "codex:local"; component: string; finalText: string; value: unknown;
  componentCalls: ComponentCallTrace[]; steps: number; attempts: number;
  /** Observed app-server telemetry only; no model-round or dollar-limit claim. */
  usage: ComponentUsage;
}
export interface ComponentRunOptions extends SessionIsolationOptions {
  signal?: AbortSignal;
  onTrace?: (event: ComponentCallTrace) => void;
}
class Failure extends CodexDispatchError {
  constructor(readonly code: InvocationErrorCode | "unauthorized_call") { super(`component invocation ${code}`); }
}
interface Frame { id: string | null; node: InvocationNode; ancestry: string[]; steps: number; queue: Promise<unknown> }
const zeroUsage = (): ComponentUsage => ({inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0});
const PASSIVE = new Set(["userMessage", "agentMessage", "reasoning", "plan", "compacted", "contextCompaction"]);
const IGNORED = new Set(["thread/started", "thread/status/changed", "thread/name/updated", "thread/settings/updated", "mcpServer/startupStatus/updated", "account/updated", "account/rateLimits/updated", "skills/changed", "app/list/updated", "warning", "deprecationNotice", "model/rerouted", "model/verification", "model/safetyBuffering/updated", "turn/plan/updated", "turn/diff/updated", "turn/moderationMetadata", "item/agentMessage/delta", "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded", "item/reasoning/textDelta", "item/plan/delta", "item/mcpToolCall/progress"]);

/** Composed runs never resume, write provenance, render, or persist child output. */
export async function runComponentInvocation(plan: PreparedInvocation, request: unknown, options: ComponentRunOptions): Promise<ComponentRunResult> {
  assertPreparedInvocation(plan);
  const normalized = normalizeInvocationRequest(request, plan.limits.maxRequestBytes);
  if (!normalized) throw new Failure("invalid_request");
  const controller = new AbortController();
  let fatal: Failure | null = null;
  const cancel = () => controller.abort();
  const timeout = options.timeoutMs ?? plan.limits.timeoutMs;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > plan.limits.timeoutMs) throw new CodexDispatchError("invalid invocation timeout");
  options.signal?.addEventListener("abort", cancel, {once: true});
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(cancel, timeout);
  const transports = new Set<CodexAppServerTransport>();
  const pending = new Set<Promise<unknown>>();
  const calls: ComponentCallTrace[] = [];
  const usage = zeroUsage();
  let steps = 0, attempts = 0;
  const check = () => { if (fatal) throw fatal; if (controller.signal.aborted) throw new Failure("cancelled"); };
  const security: () => never = () => { fatal = new Failure("unauthorized_call"); cancel(); throw fatal; };
  const trace = (entry: ComponentCallTrace) => { options.onTrace?.({...entry}); };

  async function invoke(frame: Frame, step: PreparedOrchestrateStep, alias: string, payload: unknown): Promise<InvocationResult> {
    check();
    const edges = frame.node.aliases[step.name];
    if (!edges || !Object.hasOwn(edges, alias)) security();
    const id = edges[alias]!;
    const child = plan.nodes[id];
    if (!child || frame.ancestry.includes(id)) security();
    const input = normalizeInvocationRequest(payload, plan.limits.maxRequestBytes);
    if (!input) return invocationError("invalid_request");
    const depth = frame.ancestry.length;
    if (depth > plan.limits.maxDepth || attempts >= plan.limits.maxAttempts || steps >= plan.limits.maxSteps) return invocationError("budget_exhausted");
    attempts++;
    const childFrame: Frame = {id: randomUUID(), node: child, ancestry: [...frame.ancestry, id], steps: 0, queue: Promise.resolve()};
    const entry: ComponentCallTrace = {callId: childFrame.id!, parentCallId: frame.id, caller: frame.node.prepared.componentId, step: step.name, alias, callee: id, depth, attempt: attempts, status: "running", requestBytes: jsonBytes(input), resultBytes: 0, steps: 0};
    calls.push(entry); trace(entry);
    try {
      const value = await execute(childFrame, input);
      check();
      const result = normalizeInvocationResult(value, child, plan.limits.maxResultBytes);
      entry.status = result.status; entry.resultBytes = jsonBytes(result);
      return result;
    } catch (error) {
      if (fatal) throw fatal;
      if (controller.signal.aborted) { entry.status = "late_discarded"; return invocationError("cancelled"); }
      entry.status = "error";
      return invocationError(error instanceof Failure ? error.code as InvocationErrorCode : "callee_failed");
    } finally {
      entry.steps = childFrame.steps;
      if (controller.signal.aborted) entry.status = "late_discarded";
      trace(entry);
    }
  }

  async function execute(frame: Frame, input: InvocationRequest): Promise<unknown> {
    const artifacts: Record<string, unknown> = Object.create(null);
    const outcomes = new Map<string, boolean>();
    let final: unknown;
    for (const step of frame.node.prepared.steps) {
      check();
      if (step.when && outcomes.get(step.when.target) !== false) continue;
      if (steps >= plan.limits.maxSteps || (frame.id !== null && frame.steps >= plan.limits.maxStepsPerChild)) throw new Failure("budget_exhausted");
      // Admission is synchronous before creating any process, including failed starts.
      steps++; frame.steps++;
      let active = true;
      const aliases = Object.keys(frame.node.aliases[step.name] ?? {});
      const handler = (alias: string, payload: unknown) => {
        if (!active) security();
        const operation = frame.queue.then(() => {
          if (!active) security();
          return invoke(frame, step, alias, payload);
        });
        frame.queue = operation.catch(() => undefined);
        pending.add(operation); void operation.finally(() => pending.delete(operation)).catch(() => undefined);
        return operation;
      };
      try {
        const text = await runStep(frame.node, step, input, Object.fromEntries(step.consumes.map((key) => [key, artifacts[key]])), aliases, handler);
        check();
        if (Buffer.byteLength(text, "utf8") > plan.limits.maxResultBytes) throw new Failure("invalid_result");
        let record: Record<string, unknown>;
        try { record = parseStepTerminal(text, step.produces); } catch { throw new Failure("invalid_result"); }
        final = record[step.produces];
        if (isRecord(final) && final.status === "refused") return final;
        if (isRecord(final) && (final.status === "error" || final.ok === false)) throw new Failure("callee_failed");
        artifacts[step.produces] = final;
        outcomes.set(step.name, true);
      } catch (error) {
        check();
        if (error instanceof Failure && (error.code === "budget_exhausted" || error.code === "unauthorized_call" || error.code === "cancelled")) throw error;
        if (!frame.node.prepared.steps.some((next) => next.when?.target === step.name)) throw error;
        // Repair gets a sanitized failed artifact, never raw provider output or an exception.
        artifacts[step.produces] = {status: "error", code: "callee_failed"};
        outcomes.set(step.name, false);
        final = undefined;
      } finally { active = false; }
    }
    if (final === undefined) throw new Failure("callee_failed");
    return final;
  }

  async function runStep(node: InvocationNode, step: PreparedOrchestrateStep, input: InvocationRequest, artifacts: Record<string, unknown>, aliases: string[], invokeAlias: (alias: string, payload: unknown) => Promise<InvocationResult>): Promise<string> {
    check();
    const single: PreparedTurnComponent = { target: plan.target, profile: plan.profile, node: node.prepared.node, componentId: node.prepared.componentId, steps: [step], capabilities: node.prepared.capabilities, enabledTools: [...step.enabledTools], mcp: node.prepared.mcp };
    let transport: CodexAppServerTransport | undefined;
    let transportFailure: Failure | null = null;
    let threadId: string | null = null, turnId: string | null = null, started = false, ended = false, answer: string | null = null;
    let successfulTools = 0;
    const tools = new Map<string, {kind: string; name: string; handled: boolean}>();
    const requestIds = new Set<string>();
    const stepUsage = zeroUsage();
    const buffered: Array<[string, unknown]> = [];
    let ready = false;
    let resolveDone!: (answer: string) => void, rejectDone!: (error: unknown) => void;
    const done = new Promise<string>((resolve, reject) => {resolveDone = resolve; rejectDone = reject;});
    void done.catch(() => undefined);
    const stop = () => { rejectDone(fatal ?? new Failure("cancelled")); if (transport) void transport.close(); };
    controller.signal.addEventListener("abort", stop, {once: true});
    const invalid: () => never = () => security();
    const consume = (method: string, raw: unknown): void => {
      if (IGNORED.has(method)) return;
      if (!isRecord(raw)) invalid();
      if (method === "thread/tokenUsage/updated") {
        if (threadId !== raw.threadId || turnId !== raw.turnId) invalid();
        const total = isRecord(raw.tokenUsage) ? raw.tokenUsage.total : null;
        if (!isRecord(total)) invalid();
        for (const key of Object.keys(stepUsage) as Array<keyof ComponentUsage>) {
          const value = total[key];
          if (!Number.isSafeInteger(value) || (value as number) < stepUsage[key]) invalid();
          stepUsage[key] = value as number;
        }
        return;
      }
      if (raw.threadId !== threadId) invalid();
      if (method === "turn/started") {
        if (started || !isRecord(raw.turn) || raw.turn.id !== turnId || raw.turn.status !== "inProgress") invalid();
        started = true; return;
      }
      if (!started || ended) invalid();
      if (method === "turn/completed") {
        if (!isRecord(raw.turn) || raw.turn.id !== turnId || tools.size) invalid();
        ended = true;
        if (raw.turn.status !== "completed" || answer === null || (step.requireSuccessfulTool && successfulTools === 0)) rejectDone(new Failure("callee_failed"));
        else resolveDone(answer);
        return;
      }
      if (raw.turnId !== turnId) invalid();
      if (method === "error") {
        if (raw.willRetry === true) return;
        rejectDone(new Failure("callee_failed")); return;
      }
      if (method !== "item/started" && method !== "item/completed") invalid();
      const item = raw.item;
      if (!isRecord(item) || typeof item.type !== "string" || typeof item.id !== "string") invalid();
      if (PASSIVE.has(item.type)) {
        if (method === "item/completed" && item.type === "agentMessage") {
          if (typeof item.text !== "string") invalid();
          if (Buffer.byteLength(item.text, "utf8") > plan.limits.maxResultBytes) {rejectDone(new Failure("invalid_result")); return;}
          answer = item.text;
        }
        return;
      }
      if (item.type !== "mcpToolCall" && item.type !== "dynamicToolCall") invalid();
      if (item.type === "mcpToolCall") {
        if (item.server !== single.mcp.name || typeof item.tool !== "string" || !step.enabledTools.includes(item.tool)) invalid();
      } else if (item.namespace !== NAMESPACE || typeof item.tool !== "string" || !aliases.includes(item.tool)) invalid();
      if (method === "item/started") {
        if (tools.has(item.id) || item.status !== "inProgress") invalid();
        tools.set(item.id, {kind: item.type, name: item.tool as string, handled: false});
      } else {
        const pendingTool = tools.get(item.id);
        if (!pendingTool || pendingTool.kind !== item.type || pendingTool.name !== item.tool || !["completed", "failed"].includes(String(item.status))) invalid();
        if (item.type === "dynamicToolCall" && !pendingTool.handled) invalid();
        tools.delete(item.id);
        if (item.type === "mcpToolCall" && item.status === "completed" && (item.error === null || item.error === undefined)) successfulTools++;
      }
    };
    const onNotification = (method: string, params: unknown): void => {
      if (!ready) buffered.push([method, params]);
      else consume(method, params);
    };
    let releaseReady!: () => void;
    const readyPromise = new Promise<void>((resolve) => {releaseReady = resolve;});
    try {
      transport = await CodexAppServerTransport.start(single, options, onNotification, (error) => {
        if (error) { fatal = new Failure("unauthorized_call"); cancel(); }
        transportFailure = error ? fatal : new Failure("transient_transport");
        rejectDone(transportFailure);
      }, async (method, raw) => {
        await readyPromise;
        check();
        if (method !== "item/tool/call" || !isRecord(raw) || !started || ended || raw.threadId !== threadId || raw.turnId !== turnId || raw.namespace !== NAMESPACE || typeof raw.tool !== "string" || typeof raw.callId !== "string" || !aliases.includes(raw.tool) || requestIds.has(raw.callId)) invalid();
        const item = tools.get(raw.callId);
        if (!item || item.kind !== "dynamicToolCall" || item.name !== raw.tool || item.handled) invalid();
        requestIds.add(raw.callId);
        const result = await invokeAlias(raw.tool, raw.arguments);
        check(); item.handled = true;
        return {contentItems: [{type: "inputText", text: JSON.stringify(result)}], success: result.status === "ok"};
      });
      transports.add(transport); check();
      const config = {...buildIsolationConfig(single), "features.code_mode.direct_only_tool_namespaces": [`mcp__${single.mcp.name.replace(/[^A-Za-z0-9_]/g,"_")}`, NAMESPACE]};
      const start = await transport.request("thread/start", {
        model: step.model, cwd: options.cwd, approvalPolicy: "never", sandbox: "read-only", config,
        ephemeral: true, historyMode: "legacy", environments: [], runtimeWorkspaceRoots: [], selectedCapabilityRoots: [], experimentalRawEvents: false,
        dynamicTools: aliases.length ? [{type: "namespace", name: NAMESPACE, description: "Authorized isolated component calls for this step.", tools: aliases.map((name) => ({type: "function", name, description: `Invoke the authorized ${name} alias.`, inputSchema: REQUEST_SCHEMA}))}] : [],
      });
      if (!isRecord(start) || !isRecord(start.thread) || typeof start.thread.id !== "string") invalid();
      threadId = start.thread.id;
      check();
      const prompt = [
        "Execute exactly the compiled step below. Use only your configured MCP tools and declared component aliases.",
        "Return only a JSON object with exactly the declared produces key. Put the terminal value under that key.",
        `Produces key: ${JSON.stringify(step.produces)}`,
        step.requireSuccessfulTool ? "At least one successful configured MCP tool call is required." : "MCP tool use is optional.",
        `Declared aliases: ${JSON.stringify(aliases)}`,
        `Component context: ${node.context}`, `Component brief: ${node.brief}`,
        `Step contract: ${step.prompt}`, `Request: ${JSON.stringify(input)}`, `Declared inputs: ${JSON.stringify(artifacts)}`,
        ...(node.prepared.executionKind === "render_envelope" && step.name === node.prepared.steps.at(-1)?.name ? [`Final value must satisfy this render contract: ${JSON.stringify(node.prepared.node.effect.render_blocks)}; use {blocks, verified, summary?} and positional scalar/null row arrays.`] : []),
      ].join("\n\n");
      const turn = await transport.request("turn/start", {threadId, input: [{type: "text", text: prompt, text_elements: []}], approvalPolicy: "never", environments: [], runtimeWorkspaceRoots: []});
      if (!isRecord(turn) || !isRecord(turn.turn) || typeof turn.turn.id !== "string" || turn.turn.status !== "inProgress") invalid();
      turnId = turn.turn.id;
      ready = true;
      for (const [method, params] of buffered) consume(method, params);
      buffered.length = 0; releaseReady();
      check();
      return await done;
    } catch (error) {
      check();
      if (error instanceof Failure) throw error;
      if (transportFailure) throw transportFailure;
      throw new Failure("callee_failed");
    } finally {
      releaseReady();
      controller.signal.removeEventListener("abort", stop);
      if (transport) { await transport.close(); transports.delete(transport); }
      for (const key of Object.keys(usage) as Array<keyof ComponentUsage>) usage[key] += stepUsage[key];
    }
  }

  try {
    check();
    const frame: Frame = {id: null, node: plan.nodes[plan.root]!, ancestry: [plan.root], steps: 0, queue: Promise.resolve()};
    const value = await execute(frame, normalized);
    check();
    const normalizedResult = normalizeInvocationResult(value, frame.node, plan.limits.maxResultBytes);
    if (normalizedResult.status !== "ok") throw new Failure(normalizedResult.status === "error" ? normalizedResult.code : "callee_failed");
    const finalValue = normalizedResult.output.kind === "value" ? normalizedResult.output.value : value;
    return {target: plan.target, component: plan.root, finalText: JSON.stringify(finalValue), value: finalValue, componentCalls: calls, steps, attempts, usage};
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); cancel();
    await Promise.allSettled([...transports].map((transport) => transport.close()));
    await Promise.allSettled([...pending]);
  }
}
