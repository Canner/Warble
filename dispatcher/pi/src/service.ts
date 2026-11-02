#!/usr/bin/env node
/** Private, versioned host IPC. This is not an MCP endpoint. */
import { createInterface } from "node:readline";
import { admitClosure } from "./admission.js";
import type { AdmittedComponent, AdmittedClosure } from "./admission.js";
import { DEFAULT_LIMITS, newReport, runPrivate } from "./runner.js";
import type { PrivateModel, PrivateTool, RunReport } from "./runner.js";
import { SERVICE_PROTOCOL, ServicePolicy, invocationAbortMs, parseLimits, planExecution } from "./service-policy.js";
import type { ExecutionLimits } from "./service-policy.js";
import { PrivateFailure } from "./private-failure.js";
import { record } from "./selection.js";

const lines = createInterface({ input: process.stdin });
const send = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n");
let policy: ServicePolicy | undefined, closure: AdmittedClosure | undefined, model: PrivateModel;
let declarations: Omit<PrivateTool, "validate" | "execute">[] = [];
let limits: ExecutionLimits = {};
let initialized = false, sequence = 0;
const active = new Map<string, AbortController>();
const cancelled = new Map<number, string>();
const pending = new Map<number, { owner: string; resolve: (v: unknown) => void; reject: (e: Error) => void }>();

async function callback(owner: string, name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const abort = () => { pending.delete(id); cancelled.set(id, owner); if (cancelled.size > 128) cancelled.delete(cancelled.keys().next().value!); reject(Error("cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    pending.set(id, { owner, resolve: v => { signal.removeEventListener("abort", abort); resolve(v); }, reject });
    send({ type: "tool_call", id, owner, name, args });
  });
}
async function execute(owner: string, node: AdmittedComponent, request: string, signal: AbortSignal, root: boolean, report: RunReport): Promise<unknown> {
  const tools: PrivateTool[] = declarations.filter(t => node.actions.includes(t.action)).map(t => ({ ...t,
    validate: args => !!args && typeof args === "object" && !Array.isArray(args),
    execute: (args, childSignal) => callback(owner, t.name, args, childSignal),
  }));
  if (root) for (const [alias, child] of closure!.children) tools.push({ name: alias,
    capability: "component_invocation", action: "delegate", zone: "private", readOnly: true,
    description: "Delegate a bounded data task to the private component. Pass its evidence or clarification token unchanged.",
    parameters: { type: "object", properties: { request: { type: "string", maxLength: 8192 } }, required: ["request"], additionalProperties: false },
    validate: args => record(args, ["request"]) && typeof args.request === "string" && args.request.length <= 8192,
    execute: async (args, childSignal) => {
      const allowed = await callback(owner, "__delegate", { component: child.id }, childSignal);
      if (allowed !== true) throw Error("delegation_denied");
      // Preserve the original task envelope independently of the model's paraphrase.
      // Both remain data; the child component defines how to interpret its context.
      return execute(owner, child, JSON.stringify({ parent_request: request,
        delegated_request: (args as { request: string }).request }), childSignal, false, report);
    },
  });
  const plan = planExecution(limits, root), own = newReport();
  const childModel = limits.enableThinking === undefined ? model : { ...model, enableThinking: limits.enableThinking };
  try {
    return await runPrivate({ instructions: node.instructions, request, context: [], model: childModel,
      tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      maxTurns: plan.maxTurns, maxRequestBytes: DEFAULT_LIMITS.maxRequestBytes,
      maxOutputBytes: DEFAULT_LIMITS.maxOutputBytes, maxResponseBytes: 8 * DEFAULT_LIMITS.maxOutputBytes, evidenceOutput: true,
      ...(plan.childDeadlineMs === undefined ? {} : { deadlineAt: Date.now() + plan.childDeadlineMs }),
      ...(limits.maxTokens === undefined ? {} : { maxTokens: limits.maxTokens }),
      ...(limits.providerMaxRetries === undefined ? {} : { providerMaxRetries: limits.providerMaxRetries }),
      ...(limits.providerMaxRetryDelayMs === undefined ? {} : { providerMaxRetryDelayMs: limits.providerMaxRetryDelayMs }) },
      tools, { ...DEFAULT_LIMITS, timeoutMs: plan.runnerTimeoutMs, maxTurns: plan.maxTurns, maxToolCalls: plan.maxToolCalls,
        providerMaxRetries: plan.providerMaxRetries }, signal, own);
  } finally {
    report.calls.push(...own.calls); report.turns += own.turns; report.toolCalls += own.toolCalls;
  }
}

async function dispatch(m: any): Promise<void> {
  if (!m || typeof m.id !== "string" || m.id.length > 128) throw Error("protocol");
  try {
    if (m.op === "init") {
      if (initialized || m.protocol !== SERVICE_PROTOCOL) throw Error("protocol");
      const parsed = parseLimits(m.limits);
      if ("error" in parsed) { send({ id: m.id, error: "invalid_limits", diagnostic: parsed.error }); return; }
      limits = parsed;
      policy = new ServicePolicy(m.policies);
      if (m.ir !== null) {
        closure = admitClosure(m.ir, m.entry, true);
        model = m.model;
        if (model?.zone !== "private" || !model.id || !model.apiKey || !/^https?:\/\//.test(model.baseUrl)) throw Error("invalid_model");
        if (model.enableThinking !== undefined && typeof model.enableThinking !== "boolean") throw Error("invalid_model");
        declarations = m.tools;
        if (!Array.isArray(declarations) || new Set(declarations.map(t => t.name)).size !== declarations.length) throw Error("invalid_tools");
        for (const node of [closure.root, ...closure.children.values()]) {
          if (node.actions.some(a => !declarations.some(t => t.action === a && t.readOnly === true && t.zone === "private" && node.capabilities.includes(t.capability)))) throw Error("missing_tool");
        }
      }
      initialized = true;
      send({ id: m.id, value: { protocol: SERVICE_PROTOCOL, ir: "0.9", schema: "1" } });
    } else if (!initialized) throw Error("not_initialized");
    else if (m.op === "authorize") send({ id: m.id, value: policy!.authorize(m.request) });
    else if (m.op === "cancel") { active.get(m.owner)?.abort(); send({ id: m.id, value: true }); }
    else if (m.op === "invoke") {
      if (!closure || active.has(m.id) || active.size >= 8 || typeof m.request !== "string" || m.request.length > 16384) throw Error("invalid_invocation");
      const controller = new AbortController(); active.set(m.id, controller);
      const timer = setTimeout(() => controller.abort(), invocationAbortMs(limits));
      const report = newReport();
      try { send({ id: m.id, value: await execute(m.id, closure.root, m.request, controller.signal, true, report), calls: report.calls }); }
      catch (error) {
        if (!(error instanceof PrivateFailure)) throw error;
        send({ id: m.id, error: "service_unavailable", diagnostic: error.code,
          calls: report.calls, turns: report.turns, toolCalls: report.toolCalls });
      }
      finally { clearTimeout(timer); controller.abort(); active.delete(m.id); }
    } else throw Error("unknown_operation");
  } catch (error) { send({ id: m.id, error: "service_unavailable",
    ...(error instanceof PrivateFailure ? { diagnostic: error.code } : {}) }); }
}
lines.on("line", line => {
  try {
    if (Buffer.byteLength(line) > 1048576) throw Error("size");
    const m = JSON.parse(line);
    if (m.type === "tool_result") {
      if (cancelled.get(m.id) === m.owner) { cancelled.delete(m.id); return; }
      const call = pending.get(m.id);
      if (!call || call.owner !== m.owner) throw Error("unknown_tool_result");
      pending.delete(m.id);
      if (m.error) call.reject(Error("tool_denied")); else call.resolve(m.value);
    } else void dispatch(m).catch(() => process.exit(1));
  } catch { for (const a of active.values()) a.abort(); process.exitCode = 1; lines.close(); process.stdin.destroy(); }
});
lines.on("close", () => { for (const a of active.values()) a.abort(); });
