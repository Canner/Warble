import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  ComponentInvocationRuntime,
  ComponentStepExecutionError,
  DEFAULT_COMPONENT_INVOCATION_LIMITS,
  type ComponentInvocationLimits,
  type ComponentStepRun,
  type ComponentStepRunner,
} from "./componentInvocation.js";
import type { PreparedComponent, PreparedDispatch } from "./dispatch.js";
import { DispatchError } from "./error.js";
import { fingerprintSurfaces, promptSurfacesOf } from "./fingerprint.js";
import { composeCanUseTool, composeHooks, makeReadOnlyGuard, type Denial } from "./guardrails.js";
import { buildPreamble, type DispatchPlan } from "./options.js";
import { realizeRender, type RunConfig, type RunResult, type StepUsage, type Trace } from "./run.js";
import { renderEnvelope } from "./render.js";

const MCP_SERVER_NAME = "warble_components";

function isResult(message: SDKMessage): message is SDKResultMessage {
  return message.type === "result";
}

function isAssistant(message: SDKMessage): message is SDKAssistantMessage {
  return message.type === "assistant";
}

function requireFinalText(result: SDKResultMessage | undefined): string {
  if (!result) throw new DispatchError("component step ended without a result message");
  if (result.subtype !== "success") {
    if (result.subtype === "error_max_turns" || result.subtype === "error_max_budget_usd") {
      throw new DispatchError("budget_exhausted: child model limit reached");
    }
    throw new DispatchError(`component step failed (${result.subtype})`);
  }
  return result.result;
}

function stepTelemetry(messages: readonly SDKMessage[], result: SDKResultMessage | undefined) {
  const assistant = messages.filter(isAssistant);
  return {
    text: "",
    turns: result?.num_turns ?? assistant.length,
    totalCostUsd: result?.total_cost_usd ?? 0,
    usage: assistant.map((message) => ({
      model: message.message.model,
      usage: message.message.usage,
    })),
    degradation: null,
  };
}

function componentStepPrompt(run: ComponentStepRun): string {
  const consumed = run.step.consumes.map((name) => {
    const value = run.artifacts[name];
    return value === undefined
      ? `Input '${name}' was not produced by an earlier step.`
      : `Input '${name}':\n${value}`;
  });
  return [
    `Request: ${run.request.request}`,
    `Structured input: ${JSON.stringify(run.request.input)}`,
    ...consumed,
  ].join("\n\n");
}

function componentStepSystemPrompt(run: ComponentStepRun): string {
  const isLast = run.component.steps.at(-1)?.name === run.step.name;
  // Preserve the established single-step contract: that path executes the compiler-assembled
  // prompt_fragment, while a multi-step component executes each llm_calls[].prompt independently.
  // The prompt fragment may legitimately be empty, so fall back to the step prompt in that case.
  const behavior = run.component.steps.length === 1
    ? (run.component.node.prompt_fragment || run.step.prompt)
    : run.step.prompt;
  const render = run.component.node.effect.render_blocks;
  const output = !isLast
    ? "Return only this step's output for the next declared step."
    : render.length > 0
      ? [
          "Your final message must be one JSON render envelope with a blocks array and optional summary.",
          "Every block type and field must satisfy this callee-owned contract:",
          JSON.stringify(render),
          "Do not render or write an artifact; return the envelope as data only.",
        ].join("\n")
      : [
          "Your final message must be one JSON value and nothing else.",
          "If policy requires refusal, return {\"status\":\"refused\",\"message\":\"a bounded explanation\"}.",
        ].join("\n");
  return [
    buildPreamble(run.component.plan.options.cwd ?? process.cwd()),
    ...(run.component.node.brief ? [run.component.node.brief] : []),
    behavior,
    run.aliases.length > 0
      ? `This step may call only these logical component aliases: ${run.aliases.map((alias) => `\`${alias}\``).join(", ")}.`
      : "This step has no callable component aliases.",
    output,
  ].join("\n\n");
}

function componentTools(component: PreparedComponent): string[] {
  const configured = component.plan.options.tools;
  if (!Array.isArray(configured)) return ["Read"];
  // Component composition is read-only in the first slice. Task would create an ungoverned nested
  // delegation path; Write/Edit would union mutation authority into a caller step.
  return configured.filter((name) => name !== "Task" && name !== "Write" && name !== "Edit");
}

export function createSdkComponentStepRunner(cfg: Pick<ComposedRunConfig, "onPromptFingerprint" | "hostCanUseTool" | "hostHooks"> = {}): {
  runStep: ComponentStepRunner;
  denials: Denial[];
} {
  const denials: Denial[] = [];
  const runStep: ComponentStepRunner = async (run) => {
    if (run.step.provider !== "anthropic") {
      throw new DispatchError(`unsupported_callee: provider '${run.step.provider}' has no step-scoped invocation transport`);
    }
    const cwd = run.component.plan.options.cwd ?? process.cwd();
    const guard = makeReadOnlyGuard({
      readOnly: true,
      writeScope: null,
      cwd,
      setupScope: null,
    });
    const planAndFloor = composeCanUseTool(run.component.plan.options.canUseTool, guard.canUseTool);
    const originalCanUseTool = composeCanUseTool(cfg.hostCanUseTool, planAndFloor);
    const planHooks: Options["hooks"] = {
      ...cfg.hostHooks,
      ...run.component.plan.options.hooks,
      PreToolUse: [
        ...(cfg.hostHooks?.PreToolUse ?? []),
        ...(run.component.plan.options.hooks?.PreToolUse ?? []),
      ],
    };
    const hooks = composeHooks(planHooks, guard.hooks);
    const toolNames = new Set(run.aliases.map((alias) => `mcp__${MCP_SERVER_NAME}__${alias}`));
    const approvedAliasInputs = new Map<string, number>();
    const approvalKey = (name: string, input: Record<string, unknown>) => JSON.stringify([
      name,
      toolNames.has(name) && input["input"] === undefined ? { ...input, input: {} } : input,
    ]);
    const rememberApproval = (name: string, input: Record<string, unknown>) => {
      const key = approvalKey(name, input);
      approvedAliasInputs.set(key, (approvedAliasInputs.get(key) ?? 0) + 1);
    };
    const consumeApproval = (name: string, input: Record<string, unknown>) => {
      const key = approvalKey(name, input);
      const count = approvedAliasInputs.get(key) ?? 0;
      if (count < 1) return false;
      if (count === 1) approvedAliasInputs.delete(key);
      else approvedAliasInputs.set(key, count - 1);
      return true;
    };
    const canUseTool: CanUseTool = async (name, input, options) => {
      if (!toolNames.has(name)) return originalCanUseTool(name, input, options);
      if (!cfg.hostCanUseTool) return { behavior: "allow", updatedInput: input };
      const permission = await cfg.hostCanUseTool(name, input, options);
      if (permission.behavior === "allow") rememberApproval(name, permission.updatedInput);
      return permission;
    };

    const componentCalls = run.aliases.map((alias) => tool(
      alias,
      `Invoke the statically authorized '${alias}' component alias with an isolated JSON request.`,
      { request: z.string(), input: z.record(z.string(), z.unknown()).optional() },
      async (args) => {
        const name = `mcp__${MCP_SERVER_NAME}__${alias}`;
        let input: Record<string, unknown> = { request: args.request, input: args.input ?? {} };
        // Normally canUseTool records the host approval. Recheck here if an embedder invokes the
        // handler directly or another SDK path bypasses the permission callback.
        if (cfg.hostCanUseTool && !consumeApproval(name, input)) {
          const permission = await cfg.hostCanUseTool(name, input, {
            signal: run.signal,
            toolUseID: `${run.rootRunId}:${run.callId ?? "root"}:${run.step.name}:${alias}`,
          });
          if (permission.behavior !== "allow") {
            throw new DispatchError("component invocation was denied by the embedding host");
          }
          input = permission.updatedInput;
        }
        const result = await run.invoke(alias, input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      },
    ));
    const server = componentCalls.length > 0
      ? createSdkMcpServer({ name: MCP_SERVER_NAME, version: "0.0.0", tools: componentCalls })
      : null;
    const venvBin = join(cwd, ".venv", "bin");
    const path = existsSync(venvBin) ? `${venvBin}:${process.env.PATH ?? ""}` : (process.env.PATH ?? "");
    const abortController = new AbortController();
    if (run.signal.aborted) abortController.abort();
    else run.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    const options: Options = {
      cwd,
      permissionMode: "default",
      persistSession: false,
      abortController,
      maxTurns: run.maxTurns,
      model: run.step.model,
      systemPrompt: componentStepSystemPrompt(run),
      tools: componentTools(run.component),
      // Aliases must reach canUseTool; allowedTools would auto-authorize them ahead of host policy.
      allowedTools: ["Read"],
      disallowedTools: run.component.plan.options.disallowedTools,
      canUseTool,
      hooks,
      env: { ...(process.env as Record<string, string>), PATH: path },
      ...(server ? { mcpServers: { [MCP_SERVER_NAME]: server } } : {}),
    };
    cfg.onPromptFingerprint?.(fingerprintSurfaces(promptSurfacesOf(options)));
    const messages: SDKMessage[] = [];
    try {
      for await (const message of query({ prompt: componentStepPrompt(run), options })) messages.push(message);
    } catch {
      denials.push(...guard.denials);
      throw new ComponentStepExecutionError(
        "component step transport failed",
        stepTelemetry(messages, undefined),
        true,
      );
    }
    const result = messages.find(isResult);
    denials.push(...guard.denials);
    let text: string;
    try {
      text = requireFinalText(result);
    } catch (error) {
      throw new ComponentStepExecutionError(
        error instanceof Error ? error.message : "component step failed",
        stepTelemetry(messages, result),
        false,
      );
    }
    const telemetry = stepTelemetry(messages, result);
    return {
      text,
      turns: telemetry.turns,
      totalCostUsd: telemetry.totalCostUsd,
      usage: telemetry.usage,
      degradation: null,
    };
  };
  return { runStep, denials };
}

export interface ComposedRunConfig extends RunConfig {
  prepared: PreparedDispatch;
  root: PreparedComponent;
  limits?: ComponentInvocationLimits;
  signal?: AbortSignal;
  runStep?: ComponentStepRunner;
  hostCanUseTool?: Options["canUseTool"];
  hostHooks?: Options["hooks"];
}

/** Execute one prepared root and its authorized descendants. Only this root path persists output. */
export async function runComposedDispatch(plan: DispatchPlan, cfg: ComposedRunConfig): Promise<RunResult> {
  const sdk = cfg.runStep ? { runStep: cfg.runStep, denials: [] as Denial[] } : createSdkComponentStepRunner(cfg);
  const runtime = new ComponentInvocationRuntime({
    prepared: cfg.prepared,
    runStep: sdk.runStep,
    limits: {
      ...cfg.limits,
      // Composition may only preserve or lower the established DispatchInput/CLI turn limit.
      maxTurns: Math.min(
        typeof plan.options.maxTurns === "number"
          ? plan.options.maxTurns
          : DEFAULT_COMPONENT_INVOCATION_LIMITS.maxTurns,
        cfg.limits?.maxTurns ?? DEFAULT_COMPONENT_INVOCATION_LIMITS.maxTurns,
      ),
    },
    ...(cfg.signal ? { signal: cfg.signal } : {}),
  });
  const started = Date.now();
  const result = await runtime.runRoot(cfg.root.id, { request: plan.prompt, input: {} });
  if (runtime.signal.aborted) throw new DispatchError("cancelled: the root component run was cancelled");

  const traceSteps: StepUsage[] = result.usage.map((entry) => ({
    model: entry.model,
    parent_tool_use_id: null,
    usage: entry.usage,
  }));
  const trace: Trace = {
    target: plan.meta.target,
    verb: plan.meta.verb,
    model: plan.meta.model,
    split: true,
    run: {
      total_cost_usd: result.totalCostUsd,
      duration_ms: Date.now() - started,
      duration_api_ms: 0,
      num_turns: result.turns,
    },
    usage: null,
    modelUsage: {},
    steps: traceSteps,
    denials: sdk.denials.map(() => ({
      tool: "[redacted]",
      reason: "component guardrail denied a tool call",
    })),
    componentCalls: result.componentCalls,
  };

  // No directory or artifact is created until the whole root, including every child, completed.
  mkdirSync(cfg.outDir, { recursive: true });
  writeFileSync(join(cfg.outDir, "result.txt"), result.finalText, "utf8");
  writeFileSync(join(cfg.outDir, "trace.json"), JSON.stringify(trace, null, 2) + "\n", "utf8");

  let htmlPath: string | null = null;
  let renderDegraded: { reason: string } | null = null;
  const gate = plan.meta.render;
  if (gate.kind === "realize" && gate.flavor === "programmatic") {
    const rendered = realizeRender(gate, result.finalText, join(cfg.outDir, "dashboard.html"), {
      warbleBin: cfg.warbleBin,
      ...(cfg.title ? { title: cfg.title } : {}),
    });
    htmlPath = rendered.htmlPath;
    renderDegraded = rendered.renderDegraded;
  } else if (plan.meta.assertion) {
    const out = join(cfg.outDir, "status.html");
    renderEnvelope(result.finalText, out, {
      warbleBin: cfg.warbleBin,
      ...(cfg.title ? { title: cfg.title } : {}),
    });
    htmlPath = out;
  }
  return {
    finalText: result.finalText,
    trace,
    htmlPath,
    denials: trace.denials,
    sessionId: null,
    renderDegraded,
  };
}
