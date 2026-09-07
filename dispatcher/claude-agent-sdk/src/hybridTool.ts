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
import type {
  CanUseTool,
  Options,
  SDKMessage,
  SDKResultMessage,
  SDKAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { DispatchError } from "./error.js";
import {
  fingerprintSurfaces,
  promptSurfacesOf,
  promptSurfacesOfMessages,
} from "./fingerprint.js";
import { composeCanUseTool, composeHooks, makeReadOnlyGuard } from "./guardrails.js";
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
        .map((artifact) => {
          const p = producers.get(artifact);
          return p ? `the text step "${p}" returned` : `"${artifact}"`;
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

/** The in-process MCP server the hybrid-tool path registers its step dispatcher on. */
const MCP_SERVER_NAME = "warble";
/** The step dispatcher's own name, as registered. */
const DISPATCH_STEP_NAME = "dispatch_step";
/** How the SDK addresses it once registered. One constant so the registration, the auto-approval
 *  list and the orchestrator's permission callback cannot drift apart. */
const DISPATCH_STEP_TOOL = `mcp__${MCP_SERVER_NAME}__${DISPATCH_STEP_NAME}`;

interface CloudCtx {
  /** Carried so a cloud step can report the fingerprint of the options it actually sends. */
  cfg: RunConfig;
  cwd: string;
  env: Record<string, string>;
  maxTurns: number;
  /** Already composed by the caller: the embedder's callback, then the guardrail floor. */
  canUseTool: Options["canUseTool"];
  /** Already composed by the caller: the embedder's `hooks` merged with `makeReadOnlyGuard`'s
   *  `PreToolUse` matchers (`[]` of the latter for non-setup components). */
  hooks: Options["hooks"];
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
    // Read never reaches `canUseTool` for an in-cwd path in the real SDK (see guardrails.ts); this
    // hook is the live enforcement point for the +Setup dotenv-read gap's Read side.
    hooks: ctx.hooks,
    env: ctx.env,
  };
  ctx.cfg.onPromptFingerprint?.(fingerprintSurfaces(promptSurfacesOf(options)));
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
  const { canUseTool, denials, hooks } = makeReadOnlyGuard({
    readOnly: plan.meta.readOnly,
    writeScope: null,
    cwd,
    setupScope: plan.meta.setupScope,
  });

  const venvBin = join(cwd, ".venv", "bin");
  const pathEnv = existsSync(venvBin) ? `${venvBin}:${process.env.PATH ?? ""}` : (process.env.PATH ?? "");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: pathEnv };

  // Composed once, here, so every cloud step this driver spawns enforces the same thing: the
  // embedder's callback first, then the guardrail floor (see `composeCanUseTool`).
  const stepCanUseTool = composeCanUseTool(plan.options.canUseTool, canUseTool);
  const stepHooks = composeHooks(plan.options.hooks, hooks);

  /**
   * The orchestrator turn's own callback: warble's step-dispatch tool is allowed outright, and
   * everything else falls through to the composed embedder+floor pair above.
   *
   * Why this branch exists rather than leaning on `allowedTools`: the SDK documents that list as
   * auto-approval, which reads as "the callback is not consulted for these" — but nothing in this
   * repository exercises that for an MCP tool name, and the floor's final arm is fail-closed on any
   * name it does not recognise. If the callback *is* consulted, an unhandled `mcp__…` name would be
   * denied and every run of this path would break outright. One branch makes the outcome the same
   * whichever way the SDK behaves, instead of resting a whole run path on an assumption about
   * someone else's library that no test here can see.
   *
   * This is not a gap in the floor. It names warble's own in-process orchestration primitive, which
   * exists only on this turn, and grants nothing about the shell, the filesystem or the data path —
   * the step it spawns is itself guarded by the same composed pair.
   */
  const driverCanUseTool: CanUseTool = async (toolName, input, options) =>
    toolName === DISPATCH_STEP_TOOL
      ? { behavior: "allow", updatedInput: input }
      : stepCanUseTool(toolName, input, options);

  const steps = plan.meta.stagedSteps;
  const question = plan.prompt;
  const maxTurns = plan.options.maxTurns ?? 40;
  const traceSteps: StepUsage[] = [];

  const dispatchStep = tool(
    DISPATCH_STEP_NAME,
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
      // transport is the per-provider adapter-registry follow-up work.
      if (step.provider === "openai_compat") {
        if (!step.endpoint) throw new DispatchError(`local step '${step.name}' has no endpoint`);
        const localMessages = [
          { role: "system" as const, content: step.prompt },
          { role: "user" as const, content: stepUserPrompt(question, inputsText) },
        ];
        // A local step posts messages instead of building SDK options, so it needs the
        // message-shaped primitive — but it is still a turn, and still reported.
        cfg.onPromptFingerprint?.(fingerprintSurfaces(promptSurfacesOfMessages(localMessages)));
        text = await callOpenAiCompat({
          endpoint: step.endpoint,
          model: step.model,
          messages: localMessages,
        });
        process.stderr.write(`warble hybrid-tool: step '${step.name}' → local ${step.model}\n`);
      } else {
        text = await runCloudStep(step, question, inputsText, { cfg, cwd, env, maxTurns, canUseTool: stepCanUseTool, hooks: stepHooks });
        process.stderr.write(`warble hybrid-tool: step '${step.name}' → cloud ${step.model}\n`);
      }
      traceSteps.push({ model: `${step.provider}:${step.model}`, parent_tool_use_id: step.name, usage: null });
      return { content: [{ type: "text" as const, text }] };
    },
  );

  const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: "0.0.0", tools: [dispatchStep] });
  const driverModel = plan.options.model ?? "sonnet";
  const driverOptions: Options = {
    cwd,
    permissionMode: "default",
    maxTurns,
    model: driverModel,
    systemPrompt: buildToolDriverPrompt(steps),
    mcpServers: { warble: server },
    allowedTools: [DISPATCH_STEP_TOOL],
    env,
    // The floor is composed in here too, even though the driver prompt asks this turn to do nothing
    // but call `dispatch_step`. `allowedTools` does not restrict the toolset — the SDK documents it
    // as "auto-allowed without prompting" and says to use `tools` to restrict — and `tools` is not
    // set here, so the default built-in set (Bash, Write, Edit, …) is on the table for this turn.
    // Composing the floor is therefore the difference between the prompt asking the model not to
    // reach for them and something actually stopping it.
    //
    // This tightens behaviour rather than preserving it: before, no `canUseTool` reached this turn
    // at all. That is the intended direction — a guardrail floor applying where it previously did
    // not — and it is why this is not spread conditionally like an embedder-only passthrough.
    canUseTool: driverCanUseTool,
    hooks: stepHooks,
  };

  // The driver's own prompt is composed here from the step list and appears nowhere in the plan, so
  // this is the only place it can be fingerprinted truthfully.
  cfg.onPromptFingerprint?.(fingerprintSurfaces(promptSurfacesOf(driverOptions)));
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
  return {
    finalText,
    trace,
    htmlPath: null,
    denials,
    sessionId: result?.session_id ?? null,
    renderDegraded: null,
  };
}
