/**
 * Drive the Agent SDK `query()` loop and capture what the file target cannot: a `{ blocks, summary }`
 * render envelope AND a per-step usage trace. The agent loop, permissions, sandbox, and
 * tool calls are all borrowed from the SDK — this module only assembles options, attaches the
 * runtime guardrail, consumes the message stream, and hands the envelope to `warble render`.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  HookCallbackMatcher,
  ModelUsage,
  NonNullableUsage,
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  classifyConditionalStep,
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  runRepairLoop,
  type StepIdentity,
  type StepOutcome,
} from "./conditional.js";
import { DispatchError } from "./error.js";
import { ChatEventMapper, type WarbleChatEvent } from "./events.js";
import { makeReadOnlyGuard, type Denial } from "./guardrails.js";
import { runHybridTool } from "./hybridTool.js";
import { callOpenAiCompat } from "./localClient.js";
import type { DispatchPlan, RenderGate } from "./options.js";
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
  /** Set when a best-effort `render_contract` failed at runtime (`warble render` exited non-zero)
   *  and the turn degraded instead of hard-failing (`render.onFailure === "degrade"`): `htmlPath`
   *  stays `null`, `finalText` is still the agent's answer, and this carries why the render was
   *  skipped. `null` on every run that never hit a render failure — a required/safety-critical
   *  render failure still throws (`DispatchError`/`DispatchSessionError`) and never reaches here. */
  renderDegraded: { reason: string } | null;
}

export interface RunConfig {
  outDir: string;
  warbleBin: string;
  /** Optional dashboard title passed through to `warble render`. */
  title?: string;
  /** Resume a prior turn's session (multi-turn continuity, session.ts). Mutually exclusive in practice
   *  with a fresh turn — omit for turn 1. */
  resume?: string;
  /** Opt-in streaming sink (`chat --stream-json`, cli.ts): called once per `WarbleChatEvent` as the
   *  message stream is consumed, not batched after the fact. Only wired on the main (single/split) SDK
   *  loop below — the hybrid-staged executor passes through with no events. */
  onEvent?: (event: WarbleChatEvent) => void;
}

/**
 * A dispatch failure that still carries the SDK's session id, when the result message had one —
 * e.g. `error_max_turns`: the run failed, but the conversation itself is still resumable. A caller
 * that wants to continue the SAME session with more turns (rather than re-dispatching a fresh
 * prompt) needs this id; a plain `DispatchError` would discard it. `sessionId` is null only when
 * the SDK never produced a result message at all (no session to resume).
 */
export class DispatchSessionError extends DispatchError {
  constructor(
    message: string,
    readonly sessionId: string | null,
  ) {
    super(message);
    this.name = "DispatchSessionError";
  }
}

/**
 * Realize a `gate.kind === "realize"` render, applying the resolved `onFailure` policy on a runtime
 * failure (`warble render` exiting non-zero): `"degrade"` (best-effort `render_contract`) catches the
 * error and reports it back instead of throwing, so the turn still succeeds with the agent's own
 * `finalText`; `"fail"` (required/safety-critical, or the facet absent — the additive default) rethrows
 * exactly as before this change. Exported so the branch can be exercised offline (no live SDK / release
 * binary needed): a deliberately-unresolvable `warbleBin` makes `renderEnvelope` fail deterministically.
 */
export function realizeRender(
  gate: RenderGate,
  finalText: string,
  outPath: string,
  renderOpts: { warbleBin: string; title?: string },
): { htmlPath: string | null; renderDegraded: { reason: string } | null } {
  try {
    renderEnvelope(finalText, outPath, renderOpts);
    return { htmlPath: outPath, renderDegraded: null };
  } catch (err) {
    // best-effort render_contract: degrade to the agent's own text instead of failing the whole turn
    // (capability-model.md — only safety-critical/required capabilities never silently degrade).
    // `onFailure` absent/"fail" preserves the prior hard-fail behavior exactly.
    if (gate.onFailure !== "degrade") throw err;
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`warble-agent-sdk: render_contract degraded (best-effort) — ${reason}\n`);
    return { htmlPath: null, renderDegraded: { reason } };
  }
}

/** Extract the final assistant text from the result message (success subtype). */
function requireFinalText(result: SDKResultMessage | undefined): string {
  if (result === undefined) {
    throw new DispatchSessionError("the query() stream ended without a result message", null);
  }
  if (result.subtype !== "success") {
    // Every non-success result arm carries `errors: string[]`.
    throw new DispatchSessionError(
      `agent run failed (${result.subtype}): ${result.errors.join("; ")}`,
      result.session_id ?? null,
    );
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
  const { canUseTool, denials, hooks } = makeReadOnlyGuard({
    readOnly: plan.meta.readOnly,
    writeScope,
    cwd,
    setupScope: plan.meta.setupScope,
  });

  // P2: make the bound project queryable at run time without a manual
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
    // Read never reaches `canUseTool` for an in-cwd path in the real SDK (see guardrails.ts); this
    // hook is the live enforcement point for the +Setup dotenv-read gap's Read side.
    hooks: { ...plan.options.hooks, PreToolUse: [...(plan.options.hooks?.PreToolUse ?? []), ...hooks] },
    env,
    ...(cfg.resume ? { resume: cfg.resume } : {}),
  };

  const mapper = new ChatEventMapper(plan.meta.verb);
  const messages: SDKMessage[] = [];
  for await (const message of query({ prompt: plan.prompt, options })) {
    messages.push(message);
    if (cfg.onEvent) for (const event of mapper.next(message)) cfg.onEvent(event);
  }

  const result = messages.find(isResult);
  const finalText = requireFinalText(result);
  // requireFinalText throws on a failed/missing result before this line, so the closing step event
  // is only emitted on success. A failed turn surfaces to the consumer via the process exit / error
  // path, not a step_finish(ok:false) event; mapper.finish(false, …) is exercised only by unit tests.
  if (cfg.onEvent) for (const event of mapper.finish(true)) cfg.onEvent(event);
  const trace = aggregateTrace(messages, plan.meta, denials);
  const sessionId = result?.session_id ?? null;

  writeFileSync(join(cfg.outDir, "result.txt"), finalText, "utf8");
  writeFileSync(join(cfg.outDir, "trace.json"), JSON.stringify(trace, null, 2) + "\n", "utf8");

  let htmlPath: string | null = null;
  let renderDegraded: { reason: string } | null = null;
  if (gate.kind === "realize" && gate.flavor === "programmatic") {
    const out = join(cfg.outDir, "dashboard.html");
    const realized = realizeRender(gate, finalText, out, {
      warbleBin: cfg.warbleBin,
      ...(cfg.title ? { title: cfg.title } : {}),
    });
    htmlPath = realized.htmlPath;
    renderDegraded = realized.renderDegraded;
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

  return { finalText, trace, htmlPath, denials, sessionId, renderDegraded };
}

// --- hybrid-staged executor (spike D4) — live-gated ---------------------------------------------
//
// Drives one isolated invocation per step on that step's provider, marshaling `produces`→`consumes`
// between them (route.ts `buildStepMessages`). Cloud steps run a scoped `query()` (with the read-only
// data tools so a strong step can actually run SQL through `wren`); local steps hit the OpenAI-compat
// endpoint directly (localClient.ts). This is the generalization of the file target's isolated subagent
// invocation across providers — the mechanism the spike proves. Requires a reachable local endpoint
// AND a Claude subscription for the mixed run, so it is exercised live, not in the offline suite.
//
// This deterministic guard evaluation fires ONLY on the hybrid-staged path — the back-end drives the
// step sequence itself here, so it owns the run/skip/repair decision. On the single / sdk-split paths
// the SDK owns the loop, so `when` is carried through and judged emergently by the model from the
// prompt text instead (intentional — those paths have no separate deterministic scheduler).
//
// Conditional steps (`conditional: true`) are realized deterministically via conditional.ts's guard
// evaluator, not punted:
//   - guarded-skip (R2): a step's `when` guard is evaluated against the outcomes/slots recorded so
//     far; false → the step is skipped and its `produces` slot is simply never set, which
//     `buildStepMessages` already marshals to downstream consumers as an explicit "not produced"
//     note rather than a crash (cascade-optional).
//   - repair fold-into-loop (R1): an `on_failure` guard whose target is the adjacent preceding step,
//     consuming that step's own output (the `generate_sql`→`repair_sql` shape), turns a failure of
//     that preceding step into a bounded repair turn instead of an immediate throw. Exhausting
//     `DEFAULT_MAX_REPAIR_ATTEMPTS` without recovery is a loud `DispatchError`, never a silent skip.
//     Note: the repair-fold shape only checks that the preceding step's `produces` is in the
//     conditional step's `consumes`; it does NOT require the repair step's own `produces` to match
//     the target's slot. The repair prompt is trusted to re-emit the same artifact contract.
//
// Step tolerance: a step must run *tolerantly* (capture its failure and continue, instead of throwing
// and aborting the whole run) whenever some other step's `on_failure` guard names it as the target —
// otherwise its failure would abort before that guard could ever observe `outcomes[target] ===
// "failure"`. This covers the repair target AND any non-adjacent (or adjacent-but-non-consuming)
// guarded-skip target. Every step no guard depends on keeps the original eager-throw behavior.

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

interface StepExecResult {
  outcome: StepOutcome;
  text: string;
}

interface StepExecContext {
  cwd: string;
  canUseTool: Options["canUseTool"];
  /** From `makeReadOnlyGuard`'s `hooks` — see that function's doc comment. `[]` for non-setup components. */
  hooks: HookCallbackMatcher[];
  env: Record<string, string>;
  plan: DispatchPlan;
  steps: StepUsage[];
  recordCost: (cost: number) => void;
}

/**
 * Execute one staged step (local or cloud) and marshal its result. When `tolerant` is false (every
 * step no later guard depends on), a failure propagates exactly as before this change:
 * `requireFinalText`/`callOpenAiCompat` throw and the run aborts. When `tolerant` is true (this step
 * is named by some later `on_failure` guard, or is itself a repair attempt), a failure is caught and
 * returned as `{ outcome: "failure", text }` instead — the caller decides what happens next (let a
 * guarded step observe the failure, fold into a repair turn, or exhaust and loud-fail).
 */
async function executeStep(
  step: StagedStep,
  slots: Readonly<Record<string, string>>,
  ctx: StepExecContext,
  tolerant: boolean,
): Promise<StepExecResult> {
  const messages = buildStepMessages(step, ctx.plan.prompt, slots);
  const userPrompt = messages.find((m) => m.role === "user")?.content ?? ctx.plan.prompt;

  try {
    // `provider` is an open string, but this back-end only knows two runtime routes today: the
    // built-in `openai_compat` local call below, else the cloud `query()` path. A novel provider
    // therefore falls through to cloud — wiring arbitrary providers to their own transport is the
    // per-provider adapter-registry follow-up (a separate ticket), not this binding-layer change.
    if (step.provider === "openai_compat") {
      if (!step.endpoint) throw new DispatchError(`local step '${step.name}' has no endpoint`);
      const text = await callOpenAiCompat({ endpoint: step.endpoint, model: step.model, messages });
      ctx.steps.push({ model: `openai_compat:${step.model}`, parent_tool_use_id: step.name, usage: null });
      process.stderr.write(`warble hybrid: step '${step.name}' → local ${step.model}\n`);
      return { outcome: "success", text };
    }

    // Anthropic step: an isolated query() with the read-only data tools so it can run SQL via wren.
    const stepOptions: Options = {
      cwd: ctx.cwd,
      permissionMode: "default",
      maxTurns: ctx.plan.options.maxTurns ?? 40,
      model: step.model,
      systemPrompt: `${hybridCloudPreamble(ctx.cwd)}\n\n${step.prompt}`,
      tools: ctx.plan.options.tools,
      allowedTools: ctx.plan.options.allowedTools,
      disallowedTools: ctx.plan.options.disallowedTools,
      canUseTool: ctx.canUseTool,
      // Read never reaches `canUseTool` for an in-cwd path in the real SDK (see guardrails.ts); this
      // hook is the live enforcement point for the +Setup dotenv-read gap's Read side.
      hooks: { PreToolUse: ctx.hooks },
      env: ctx.env,
    };
    const msgs: SDKMessage[] = [];
    for await (const message of query({ prompt: userPrompt, options: stepOptions })) {
      msgs.push(message);
    }
    for (const m of msgs.filter(isAssistant)) {
      ctx.steps.push({ model: m.message.model, parent_tool_use_id: step.name, usage: m.message.usage });
    }
    const result = msgs.find(isResult);
    const text = requireFinalText(result);
    if (result && result.subtype === "success") ctx.recordCost(result.total_cost_usd);
    process.stderr.write(`warble hybrid: step '${step.name}' → cloud ${step.model}\n`);
    return { outcome: "success", text };
  } catch (err) {
    if (!tolerant) throw err;
    const text = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `warble hybrid: step '${step.name}' failed (tolerant — a later guard depends on its outcome): ${text}\n`,
    );
    return { outcome: "failure", text };
  }
}

async function runHybridStaged(plan: DispatchPlan, cfg: RunConfig): Promise<RunResult> {
  mkdirSync(cfg.outDir, { recursive: true });
  const cwd = plan.options.cwd ?? process.cwd();
  const { canUseTool, denials, hooks } = makeReadOnlyGuard({
    readOnly: plan.meta.readOnly,
    writeScope: null,
    cwd,
    setupScope: plan.meta.setupScope,
  });

  const venvBin = join(cwd, ".venv", "bin");
  const pathEnv = existsSync(venvBin)
    ? `${venvBin}:${process.env.PATH ?? ""}`
    : (process.env.PATH ?? "");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: pathEnv };

  const slots: Record<string, string> = {};
  const outcomes: Record<string, StepOutcome> = {};
  const steps: StepUsage[] = [];
  let finalText = "";
  let totalCost = 0;
  const startedAll = Date.now();
  const execCtx: StepExecContext = {
    cwd,
    canUseTool,
    hooks,
    env,
    plan,
    steps,
    recordCost: (cost) => {
      totalCost += cost;
    },
  };

  const stagedSteps = plan.meta.stagedSteps;

  // Steps that some `on_failure` guard depends on must run tolerantly (see the header note): capture
  // their failure and record it so the guard can fire, rather than throwing and aborting the run.
  const failureGuardTargets = new Set<string>();
  for (const s of stagedSteps) {
    if (s.conditional && s.when !== null && s.when.guard === "on_failure") {
      failureGuardTargets.add(s.when.target);
    }
  }

  for (let i = 0; i < stagedSteps.length; i++) {
    const step = stagedSteps[i]!;

    if (step.conditional) {
      if (step.when === null) {
        throw new DispatchError(`conditional step '${step.name}' has no 'when' guard`);
      }
      const preceding = i > 0 ? stagedSteps[i - 1]! : null;
      const precedingIdentity: StepIdentity | null =
        preceding === null ? null : { name: preceding.name, produces: preceding.produces };
      const decision = classifyConditionalStep(step.when, step.consumes, precedingIdentity, {
        slots,
        outcomes,
      });

      if (decision.kind === "skip") {
        process.stderr.write(`warble hybrid: guard false — skipping conditional step '${step.name}'\n`);
        continue;
      }

      if (decision.kind === "repair") {
        // Seed with the target's own failure text so the loud-fail below carries the real cause even
        // if every repair attempt itself throws before producing anything more specific.
        let lastFailureText = slots[decision.target.produces ?? decision.target.name] ?? "";
        const { recovered, attempts } = await runRepairLoop(DEFAULT_MAX_REPAIR_ATTEMPTS, async () => {
          const attempt = await executeStep(step, slots, execCtx, true);
          outcomes[step.name] = attempt.outcome;
          slots[slotKey(step)] = attempt.text;
          if (attempt.outcome === "success") finalText = attempt.text;
          else lastFailureText = attempt.text;
          return { failed: attempt.outcome === "failure" };
        });
        if (!recovered) {
          throw new DispatchError(
            `repair step '${step.name}' did not recover '${decision.target.name}' after ${attempts} ` +
              `attempt(s); last failure: ${lastFailureText}`,
          );
        }
        process.stderr.write(
          `warble hybrid: step '${step.name}' recovered '${decision.target.name}' (attempt ${attempts})\n`,
        );
        continue;
      }
      // decision.kind === "run": guard true — fall through to the normal execution below.
    }

    // A later `on_failure` guard depending on this step means its failure must be observable, not
    // fatal — run it tolerantly. Every other step keeps eager-throw.
    const outcome = await executeStep(step, slots, execCtx, failureGuardTargets.has(step.name));
    outcomes[step.name] = outcome.outcome;
    slots[slotKey(step)] = outcome.text;
    if (outcome.outcome === "success") finalText = outcome.text;
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

  return { finalText, trace, htmlPath: null, denials, sessionId: null, renderDegraded: null };
}
