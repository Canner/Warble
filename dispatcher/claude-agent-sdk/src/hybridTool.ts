/**
 * Alternative hybrid realization: per-step model calls as a TOOL the orchestrator invokes (spike
 * follow-up to `runHybridStaged`). Instead of Warble driving the step sequence itself, a single SDK
 * `query()` loop runs an orchestrator (the `orchestrator` tier, e.g. sonnet) that calls one neutral
 * `dispatch_step` tool per step, in order. Warble supplies only the tool; the SDK loop owns the
 * sequencing — so orchestration is *borrowed* again (vision invariant #3), and the local model becomes
 * "just another borrowed action" alongside `wren`.
 *
 * Provider stays OUT of the driver prompt: the prompt names step names + the consumes/produces
 * marshaling only. The `dispatch_step` handler reads each step's resolved binding and routes it —
 * local (`openai_compat`) → a direct ollama call; cloud (`anthropic`) → a scoped nested `query()` on
 * that step's tier model (with the read-only wren tools, so a strong SQL step still runs on Opus).
 *
 * Trade-off vs `runHybridStaged`: here the step order + marshaling are LLM-driven (the orchestrator
 * decides), so it is less deterministic than the staged executor — the same axis the all-cloud
 * sdk-split path already lives on. Selected at runtime via `WARBLE_HYBRID_MODE=tool`.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage, SDKResultMessage, SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { DispatchError } from "./error.js";
import { makeReadOnlyGuard } from "./guardrails.js";
import { callOpenAiCompat } from "./localClient.js";
import { DESTRUCTIVE_BASH_DENY, type DispatchPlan } from "./options.js";
import type { StagedStep } from "./route.js";
import type { RunResult, RunConfig, Trace, StepUsage } from "./run.js";

function isResult(msg: SDKMessage): msg is SDKResultMessage {
  return msg.type === "result";
}
function isAssistant(msg: SDKMessage): msg is SDKAssistantMessage {
  return msg.type === "assistant";
}
function requireFinalText(result: SDKResultMessage | undefined): string {
  if (result === undefined) throw new DispatchError("the query() stream ended without a result message");
  if (result.subtype !== "success") {
    throw new DispatchError(`agent run failed (${result.subtype}): ${result.errors.join("; ")}`);
  }
  return result.result;
}
function cloudPreamble(cwd: string): string {
  return [
    `You are bound to the wren project at \`${cwd}\` (your working directory).`,
    "All data access MUST go through the `wren` CLI — never raw SQL clients.",
  ].join("\n");
}

/** The user turn for one step: the question plus whatever the orchestrator marshaled in as `inputs`. */
function stepUserPrompt(question: string, inputsText: string): string {
  return inputsText ? `Question: ${question}\n\nInputs from the previous step:\n${inputsText}` : `Question: ${question}`;
}

/**
 * The orchestrator's system prompt — PROVIDER-AGNOSTIC. Lists the steps in order by name and the
 * produces→consumes marshaling; it never says which step is local vs cloud (that is the handler's job,
 * from the binding). So the same prompt shape is emitted whether the binding is all-cloud or hybrid.
 */
export function buildToolDriverPrompt(steps: readonly StagedStep[]): string {
  const producers = new Map<string, string>();
  for (const s of steps) if (s.produces) producers.set(s.produces, s.name);
  const lines = steps.map((s, i) => {
    const parts = [`${i + 1}. Call the \`dispatch_step\` tool with step="${s.name}".`];
    if (s.consumes.length > 0) {
      const srcs = s.consumes
        .map((slot) => {
          const p = producers.get(slot);
          return p ? `the text step "${p}" returned` : `"${slot}"`;
        })
        .join(", ");
      parts.push(`Pass ${srcs} as the tool's \`inputs\` argument.`);
    }
    if (s.conditional) parts.push("(Only if the previous step's output indicates the query failed and needs repair.)");
    return parts.join(" ");
  });
  return [
    "You orchestrate a multi-step data task by calling the `dispatch_step` tool exactly once per step, in order.",
    "You have NO other tools and you must NOT try to answer yourself — each step runs on its own configured model behind the tool.",
    "",
    "Steps, in order:",
    "",
    ...lines,
    "",
    "Marshal each step's returned text into the next step's `inputs` exactly as noted above. Your FINAL " +
      "message MUST be the last executed step's returned text verbatim — do not summarize it or add commentary.",
  ].join("\n");
}

interface CloudCtx {
  cwd: string;
  env: Record<string, string>;
  maxTurns: number;
  canUseTool: Options["canUseTool"];
}

/** Cloud step: a scoped nested query() on the step's tier model, with the read-only wren tools. */
async function runCloudStep(step: StagedStep, question: string, inputsText: string, ctx: CloudCtx): Promise<string> {
  const options: Options = {
    cwd: ctx.cwd,
    permissionMode: "default",
    maxTurns: ctx.maxTurns,
    model: step.model,
    systemPrompt: `${cloudPreamble(ctx.cwd)}\n\n${step.prompt}`,
    tools: ["Read", "Bash"],
    allowedTools: ["Read"],
    disallowedTools: [...DESTRUCTIVE_BASH_DENY],
    canUseTool: ctx.canUseTool,
    env: ctx.env,
  };
  const msgs: SDKMessage[] = [];
  for await (const m of query({ prompt: stepUserPrompt(question, inputsText), options })) msgs.push(m);
  return requireFinalText(msgs.find(isResult));
}

/**
 * Run the hybrid-tool path: one orchestrator query() + a `dispatch_step` tool that routes each step to
 * its bound provider. Mirrors {@link runHybridStaged}'s outputs (result.txt / trace.json / RunResult).
 */
export async function runHybridTool(plan: DispatchPlan, cfg: RunConfig): Promise<RunResult> {
  mkdirSync(cfg.outDir, { recursive: true });
  const cwd = plan.options.cwd ?? process.cwd();
  const { canUseTool, denials } = makeReadOnlyGuard({ readOnly: plan.meta.readOnly, writeScope: null, cwd });

  const venvBin = join(cwd, ".venv", "bin");
  const pathEnv = existsSync(venvBin) ? `${venvBin}:${process.env.PATH ?? ""}` : (process.env.PATH ?? "");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: pathEnv };

  const steps = plan.meta.stagedSteps;
  const question = plan.prompt;
  const maxTurns = plan.options.maxTurns ?? 40;
  const traceSteps: StepUsage[] = [];

  const dispatchStep = tool(
    "dispatch_step",
    "Execute one named step of the task on its own configured model and return its text output.",
    { step: z.string(), inputs: z.string().optional() },
    async (args) => {
      const step = steps.find((s) => s.name === args.step);
      if (!step) {
        return { content: [{ type: "text" as const, text: `ERROR: unknown step '${args.step}'` }], isError: true };
      }
      const inputsText = args.inputs ?? "";
      let text: string;
      // `provider` is an open string, but only `openai_compat` has a local transport wired here; any
      // other provider falls through to the cloud path. Routing arbitrary providers to their own
      // transport is the per-provider adapter-registry follow-up (a separate ticket).
      if (step.provider === "openai_compat") {
        if (!step.endpoint) throw new DispatchError(`local step '${step.name}' has no endpoint`);
        text = await callOpenAiCompat({
          endpoint: step.endpoint,
          model: step.model,
          messages: [
            { role: "system", content: step.prompt },
            { role: "user", content: stepUserPrompt(question, inputsText) },
          ],
        });
        process.stderr.write(`warble hybrid-tool: step '${step.name}' → local ${step.model}\n`);
      } else {
        text = await runCloudStep(step, question, inputsText, { cwd, env, maxTurns, canUseTool });
        process.stderr.write(`warble hybrid-tool: step '${step.name}' → cloud ${step.model}\n`);
      }
      traceSteps.push({ model: `${step.provider}:${step.model}`, parent_tool_use_id: step.name, usage: null });
      return { content: [{ type: "text" as const, text }] };
    },
  );

  const server = createSdkMcpServer({ name: "warble", version: "0.0.0", tools: [dispatchStep] });
  const driverModel = plan.options.model ?? "sonnet";
  const driverOptions: Options = {
    cwd,
    permissionMode: "default",
    maxTurns,
    model: driverModel,
    systemPrompt: buildToolDriverPrompt(steps),
    mcpServers: { warble: server },
    allowedTools: ["mcp__warble__dispatch_step"],
    env,
  };

  const msgs: SDKMessage[] = [];
  for await (const m of query({ prompt: question, options: driverOptions })) msgs.push(m);
  const result = msgs.find(isResult);
  const finalText = requireFinalText(result);
  for (const m of msgs.filter(isAssistant)) {
    traceSteps.push({ model: m.message.model, parent_tool_use_id: "orchestrator", usage: m.message.usage });
  }

  const trace: Trace = {
    target: plan.meta.target,
    verb: plan.meta.verb,
    model: `hybrid-tool(driver=${driverModel})`,
    split: false,
    run:
      result && result.subtype === "success"
        ? { total_cost_usd: result.total_cost_usd, duration_ms: result.duration_ms, duration_api_ms: result.duration_api_ms, num_turns: result.num_turns }
        : null,
    usage: null,
    modelUsage: {},
    steps: traceSteps,
    denials,
  };

  writeFileSync(join(cfg.outDir, "result.txt"), finalText, "utf8");
  writeFileSync(join(cfg.outDir, "trace.json"), JSON.stringify(trace, null, 2) + "\n", "utf8");
  return { finalText, trace, htmlPath: null, denials, sessionId: result?.session_id ?? null };
}
