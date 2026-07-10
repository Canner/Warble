/**
 * Drive the Agent SDK `query()` loop and capture what the file target cannot: a `{ blocks, summary }`
 * render envelope AND a per-step usage trace (plan §4.5). The agent loop, permissions, sandbox, and
 * tool calls are all borrowed from the SDK — this module only assembles options, attaches the
 * runtime guardrail, consumes the message stream, and hands the envelope to `warble render`.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  ModelUsage,
  NonNullableUsage,
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { DispatchError } from "./error.js";
import { makeReadOnlyGuard, type Denial } from "./guardrails.js";
import { runHybridTool } from "./hybridTool.js";
import { callOpenAiCompat } from "./localClient.js";
import type { DispatchPlan } from "./options.js";
import { renderEnvelope } from "./render.js";
import { buildStepMessages, type StagedStep } from "./route.js";

// --- trace (per-step cost/latency → eval) -------------------------------------------------------

/** One assistant turn's usage. `parent_tool_use_id` distinguishes driver turns from subagent turns. */
export interface StepUsage {
  model: string;
  parent_tool_use_id: string | null;
  usage: unknown;
}

export interface Trace {
  target: string;
  verb: string;
  model: string;
  split: boolean;
  run: {
    total_cost_usd: number;
    duration_ms: number;
    duration_api_ms: number;
    num_turns: number;
  } | null;
  usage: NonNullableUsage | null;
  /** Per-model usage — and since each tier maps to a distinct model, this is per-tier cost. */
  modelUsage: Record<string, ModelUsage>;
  /** Per assistant turn (per-step granularity the headless file target can't produce). */
  steps: StepUsage[];
  denials: Denial[];
}

function isResult(msg: SDKMessage): msg is SDKResultMessage {
  return msg.type === "result";
}

function isAssistant(msg: SDKMessage): msg is SDKAssistantMessage {
  return msg.type === "assistant";
}

/** Pure: fold the captured message stream + guardrail denials into a trace. */
export function aggregateTrace(
  messages: readonly SDKMessage[],
  meta: { target: string; verb: string; model: string; split: boolean },
  denials: Denial[],
): Trace {
  const steps: StepUsage[] = messages.filter(isAssistant).map((m) => ({
    model: m.message.model,
    parent_tool_use_id: m.parent_tool_use_id,
    usage: m.message.usage,
  }));

  const result = messages.find(isResult);
  const run =
    result === undefined
      ? null
      : {
          total_cost_usd: result.total_cost_usd,
          duration_ms: result.duration_ms,
          duration_api_ms: result.duration_api_ms,
          num_turns: result.num_turns,
        };

  return {
    target: meta.target,
    verb: meta.verb,
    model: meta.model,
    split: meta.split,
    run,
    usage: result?.usage ?? null,
    modelUsage: result?.modelUsage ?? {},
    steps,
    denials,
  };
}

// --- drive --------------------------------------------------------------------------------------

export interface RunResult {
  finalText: string;
  trace: Trace;
  htmlPath: string | null;
  denials: Denial[];
  /** The SDK's session id for this run, if the result carried one (multi-turn resume anchor). */
  sessionId: string | null;
}

export interface RunConfig {
  outDir: string;
  warbleBin: string;
  /** Optional dashboard title passed through to `warble render`. */
  title?: string;
  /** Resume a prior turn's session (multi-turn continuity, session.ts). Mutually exclusive in practice
   *  with a fresh turn — omit for turn 1. */
  resume?: string;
}

/** Extract the final assistant text from the result message (success subtype). */
function requireFinalText(result: SDKResultMessage | undefined): string {
  if (result === undefined) {
    throw new DispatchError("the query() stream ended without a result message");
  }
  if (result.subtype !== "success") {
    // Every non-success result arm carries `errors: string[]`.
    throw new DispatchError(`agent run failed (${result.subtype}): ${result.errors.join("; ")}`);
  }
  return result.result;
}

/**
 * Run a dispatch plan against the live Agent SDK, then render + trace. Writes `result.txt`,
 * `trace.json`, and (programmatic realize flavor) `dashboard.html` into `outDir`.
 */
export async function runDispatch(plan: DispatchPlan, cfg: RunConfig): Promise<RunResult> {
  // Hybrid (spike D4): steps span providers. Two realizations, selected at runtime:
  //   - staged (default): the back-end drives the step sequence itself (deterministic; good for eval).
  //   - tool (WARBLE_HYBRID_MODE=tool): one orchestrator query() calls a `dispatch_step` tool per step,
  //     so sequencing is borrowed from the SDK loop again (see hybridTool.ts).
  // Routed here so the SDK-single/split path is untouched.
  if (plan.meta.mode === "hybrid-staged") {
    return process.env["WARBLE_HYBRID_MODE"] === "tool"
      ? runHybridTool(plan, cfg)
      : runHybridStaged(plan, cfg);
  }

  mkdirSync(cfg.outDir, { recursive: true });

  const cwd = plan.options.cwd ?? process.cwd();
  const gate = plan.meta.render;
  const writeScope = gate.kind === "realize" && gate.flavor === "prompt" ? gate.scope : null;
  const { canUseTool, denials } = makeReadOnlyGuard({
    readOnly: plan.meta.readOnly,
    writeScope,
    cwd,
  });

  // P2 (design-notes follow-up 2): make the bound project queryable at run time without a manual
  // PATH dance. The SDK spawns tool subprocesses (and Task subagents) with `env`; when omitted it
  // defaults to the parent `process.env`, but that default does not reliably reach split subagents.
  // We set it explicitly and prepend the project's `.venv/bin` (the eval-runner convention) so the
  // agent's `wren` resolves from the bound project first, then the ambient PATH.
  const venvBin = join(cwd, ".venv", "bin");
  const pathEnv = existsSync(venvBin)
    ? `${venvBin}:${process.env.PATH ?? ""}`
    : (process.env.PATH ?? "");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: pathEnv };

  const options: Options = {
    ...plan.options,
    canUseTool,
    env,
    ...(cfg.resume ? { resume: cfg.resume } : {}),
  };

  const messages: SDKMessage[] = [];
  for await (const message of query({ prompt: plan.prompt, options })) {
    messages.push(message);
  }

  const result = messages.find(isResult);
  const finalText = requireFinalText(result);
  const trace = aggregateTrace(messages, plan.meta, denials);
  const sessionId = result?.session_id ?? null;

  writeFileSync(join(cfg.outDir, "result.txt"), finalText, "utf8");
  writeFileSync(join(cfg.outDir, "trace.json"), JSON.stringify(trace, null, 2) + "\n", "utf8");

  let htmlPath: string | null = null;
  if (gate.kind === "realize" && gate.flavor === "programmatic") {
    const out = join(cfg.outDir, "dashboard.html");
    renderEnvelope(finalText, out, {
      warbleBin: cfg.warbleBin,
      ...(cfg.title ? { title: cfg.title } : {}),
    });
    htmlPath = out;
  } else if (plan.meta.assertion) {
    // +Assertive: the read-only verdict envelope's `status` block renders deterministically through
    // the same `warble render` path as GenBI's dashboard — one renderer, many outcomes.
    const out = join(cfg.outDir, "status.html");
    renderEnvelope(finalText, out, {
      warbleBin: cfg.warbleBin,
      ...(cfg.title ? { title: cfg.title } : {}),
    });
    htmlPath = out;
  }

  return { finalText, trace, htmlPath, denials, sessionId };
}

// --- hybrid-staged executor (spike D4) — live-gated ---------------------------------------------
//
// Drives one isolated invocation per step on that step's provider, marshaling `produces`→`consumes`
// between them (route.ts `buildStepMessages`). Cloud steps run a scoped `query()` (with the read-only
// data tools so a strong step can actually run SQL through `wren`); local steps hit the OpenAI-compat
// endpoint directly (localClient.ts). This is the generalization of the file target's isolated subagent
// invocation across providers — the mechanism the spike proves. Requires a reachable local endpoint
// AND a Claude subscription for the mixed run, so it is exercised live, not in the offline suite.

/** A short preamble so a cloud step knows it is bound to the wren project and must query through `wren`. */
function hybridCloudPreamble(cwd: string): string {
  return [
    `You are bound to the wren project at \`${cwd}\` (your working directory).`,
    "All data access MUST go through the `wren` CLI — never raw SQL clients.",
  ].join("\n");
}

/** Marshal-forward key for a step's output: its declared `produces` slot, or its name as a fallback. */
function slotKey(step: StagedStep): string {
  return step.produces ?? step.name;
}

async function runHybridStaged(plan: DispatchPlan, cfg: RunConfig): Promise<RunResult> {
  mkdirSync(cfg.outDir, { recursive: true });
  const cwd = plan.options.cwd ?? process.cwd();
  const { canUseTool, denials } = makeReadOnlyGuard({
    readOnly: plan.meta.readOnly,
    writeScope: null,
    cwd,
  });

  const venvBin = join(cwd, ".venv", "bin");
  const pathEnv = existsSync(venvBin)
    ? `${venvBin}:${process.env.PATH ?? ""}`
    : (process.env.PATH ?? "");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: pathEnv };

  const slots: Record<string, string> = {};
  const steps: StepUsage[] = [];
  let finalText = "";
  let totalCost = 0;
  const startedAll = Date.now();

  for (const step of plan.meta.stagedSteps) {
    // POC scope: conditional steps (e.g. answer_query.repair_sql) need a runtime signal to fire; the
    // staged executor runs the unconditional chain and logs the skip (no silent cap, spike §6).
    if (step.conditional) {
      process.stderr.write(
        `warble hybrid: skipping conditional step '${step.name}' (POC runs the unconditional chain)\n`,
      );
      continue;
    }

    const messages = buildStepMessages(step, plan.prompt, slots);
    const userPrompt = messages.find((m) => m.role === "user")?.content ?? plan.prompt;

    if (step.provider === "openai_compat") {
      if (!step.endpoint) throw new DispatchError(`local step '${step.name}' has no endpoint`);
      const text = await callOpenAiCompat({
        endpoint: step.endpoint,
        model: step.model,
        messages,
      });
      slots[slotKey(step)] = text;
      finalText = text;
      steps.push({ model: `openai_compat:${step.model}`, parent_tool_use_id: step.name, usage: null });
      process.stderr.write(`warble hybrid: step '${step.name}' → local ${step.model}\n`);
      continue;
    }

    // Anthropic step: an isolated query() with the read-only data tools so it can run SQL via wren.
    const stepOptions: Options = {
      cwd,
      permissionMode: "default",
      maxTurns: plan.options.maxTurns ?? 40,
      model: step.model,
      systemPrompt: `${hybridCloudPreamble(cwd)}\n\n${step.prompt}`,
      tools: plan.options.tools,
      allowedTools: plan.options.allowedTools,
      disallowedTools: plan.options.disallowedTools,
      canUseTool,
      env,
    };
    const msgs: SDKMessage[] = [];
    for await (const message of query({ prompt: userPrompt, options: stepOptions })) {
      msgs.push(message);
    }
    const result = msgs.find(isResult);
    const text = requireFinalText(result);
    slots[slotKey(step)] = text;
    finalText = text;
    if (result && result.subtype === "success") totalCost += result.total_cost_usd;
    for (const m of msgs.filter(isAssistant)) {
      steps.push({ model: m.message.model, parent_tool_use_id: step.name, usage: m.message.usage });
    }
    process.stderr.write(`warble hybrid: step '${step.name}' → cloud ${step.model}\n`);
  }

  const trace: Trace = {
    target: plan.meta.target,
    verb: plan.meta.verb,
    model: plan.meta.model,
    split: false,
    run: {
      total_cost_usd: totalCost,
      duration_ms: Date.now() - startedAll,
      duration_api_ms: 0,
      num_turns: steps.length,
    },
    usage: null,
    modelUsage: {},
    steps,
    denials,
  };

  writeFileSync(join(cfg.outDir, "result.txt"), finalText, "utf8");
  writeFileSync(join(cfg.outDir, "trace.json"), JSON.stringify(trace, null, 2) + "\n", "utf8");

  return { finalText, trace, htmlPath: null, denials, sessionId: null };
}
