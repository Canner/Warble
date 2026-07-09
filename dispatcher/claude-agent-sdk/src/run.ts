/**
 * Drive the Agent SDK `query()` loop and capture what the file target cannot: a `{ blocks, summary }`
 * render envelope AND a per-step usage trace (plan §4.5). The agent loop, permissions, sandbox, and
 * tool calls are all borrowed from the SDK — this module only assembles options, attaches the
 * runtime guardrail, consumes the message stream, and hands the envelope to `warble render`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
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
import type { DispatchPlan } from "./options.js";
import { renderEnvelope } from "./render.js";

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
}

export interface RunConfig {
  outDir: string;
  warbleBin: string;
  /** Optional dashboard title passed through to `warble render`. */
  title?: string;
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
  mkdirSync(cfg.outDir, { recursive: true });

  const cwd = plan.options.cwd ?? process.cwd();
  const gate = plan.meta.render;
  const writeScope = gate.kind === "realize" && gate.flavor === "prompt" ? gate.scope : null;
  const { canUseTool, denials } = makeReadOnlyGuard({
    readOnly: plan.meta.readOnly,
    writeScope,
    cwd,
  });

  const options: Options = { ...plan.options, canUseTool };

  const messages: SDKMessage[] = [];
  for await (const message of query({ prompt: plan.prompt, options })) {
    messages.push(message);
  }

  const result = messages.find(isResult);
  const finalText = requireFinalText(result);
  const trace = aggregateTrace(messages, plan.meta, denials);

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
  }

  return { finalText, trace, htmlPath, denials };
}
