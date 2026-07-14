/**
 * Per-step provider routing — the hybrid-LLM spike's core (spike-hybrid-llm.md D4, vision §9.2).
 *
 * The IR only knows *tiers*; the `--models-config` binding (models.ts) resolves each tier to a
 * `{ provider, endpoint, model }`. When every step's provider is `anthropic`, the existing single
 * `query()` loop (options.ts: single / sdk-split path) realizes the component and this module changes
 * nothing. When ANY step binds to a non-Anthropic provider (e.g. ollama over OpenAI-compat), that step
 * CANNOT ride the SDK `agents[].model` mechanism — that field is a restricted `sonnet|opus|haiku|inherit`
 * alias union and loud-fails on anything else (SDK-NOTES.md #1). So the back-end must drive the steps
 * itself: run each step as an isolated invocation on its own provider and marshal state between them via
 * the IR's `consumes`/`produces` contract. That staged executor is the "hybrid-staged" mode.
 *
 * This module is PURE (no SDK, no network): it resolves the per-step bindings, decides the routing
 * mode, and builds the marshaling messages. The actual per-step execution (a `query()` for cloud
 * steps, an OpenAI-compat call for local steps) lives in run.ts. Keeping the decision pure is what
 * lets the whole hybrid contract be unit-tested offline, with no ollama and no Claude subscription.
 *
 * Invariant (spike D2): none of this is in the IR, the components, or the profile — hybrid is entirely
 * a layer-3 binding + back-end realization concern. The same compiled IR runs all-cloud or hybrid; only
 * the injected `--models-config` differs.
 */
import type { LlmCall, ComponentNode, WhenGuard } from "./ir.js";
import type { ModelConfig, Provider } from "./models.js";

/** A step with its tier resolved to a concrete `{provider, endpoint, model}` binding + its IO contract. */
export interface StagedStep {
  name: string;
  tier: string;
  provider: Provider;
  endpoint: string | null;
  model: string;
  consumes: string[];
  produces: string | null;
  prompt: string;
  conditional: boolean;
  /** The closed-vocabulary guard deciding run/skip/repair for a `conditional` step; `null` when
   *  `conditional` is false. Realized by run.ts's staged executor (see conditional.ts). */
  when: WhenGuard | null;
}

/**
 * How a component's steps are realized:
 *  - `single`        — one tier (or a tier collapse), one Anthropic `query()`. Existing path.
 *  - `sdk-split`     — >1 Anthropic tier, per-step subagents in one `query()` via `agents`. Existing path.
 *  - `hybrid-staged` — ≥1 non-Anthropic provider; the back-end drives steps itself, one isolated
 *                      invocation per step, marshaling `produces`→`consumes`. New (D4).
 */
export type RoutingMode = "single" | "sdk-split" | "hybrid-staged";

export interface RoutingPlan {
  mode: RoutingMode;
  /** Per-step resolved bindings (order = IR order). */
  steps: StagedStep[];
  /** Distinct providers across the steps, order-preserving. */
  providers: Provider[];
}

/** Resolve every `llm_call`'s tier to a concrete binding, preserving IR order. Pure. */
export function resolveStagedSteps(node: ComponentNode, models: ModelConfig): StagedStep[] {
  return node.llm_calls.map((call: LlmCall) => {
    const binding = models.binding(call.tier);
    return {
      name: call.name,
      tier: call.tier,
      provider: binding.provider,
      endpoint: binding.endpoint,
      model: binding.model,
      consumes: call.consumes,
      produces: call.produces,
      prompt: call.prompt,
      conditional: call.conditional,
      when: call.when,
    };
  });
}

/** Distinct providers across resolved steps, order-preserving. */
export function distinctProviders(steps: readonly StagedStep[]): Provider[] {
  const seen = new Set<Provider>();
  const out: Provider[] = [];
  for (const s of steps) {
    if (!seen.has(s.provider)) {
      seen.add(s.provider);
      out.push(s.provider);
    }
  }
  return out;
}

/** True when any step binds to a non-Anthropic provider — the trigger for the hybrid-staged path. */
export function usesLocalProvider(steps: readonly StagedStep[]): boolean {
  return steps.some((s) => s.provider !== "anthropic");
}

/**
 * Decide the routing mode for a component under a binding. `anthropicSplit` is the existing
 * per-step-tier split decision (owned by options.ts, passed in to keep a single source of truth):
 * it only applies when every provider is Anthropic.
 */
export function planProviderRouting(
  node: ComponentNode,
  models: ModelConfig,
  anthropicSplit: boolean,
): RoutingPlan {
  const steps = resolveStagedSteps(node, models);
  const providers = distinctProviders(steps);
  let mode: RoutingMode;
  if (usesLocalProvider(steps)) {
    mode = "hybrid-staged";
  } else if (anthropicSplit) {
    mode = "sdk-split";
  } else {
    mode = "single";
  }
  return { mode, steps, providers };
}

/** A chat message for an isolated per-step invocation (both providers speak this shape). */
export interface StepMessage {
  role: "system" | "user";
  content: string;
}

/**
 * Build the messages for one staged step: the step's own prompt as the system message, and the user
 * message = the question plus each consumed slot's value marshaled in by name (the `produces`→`consumes`
 * hand-off). This is the same isolated-invocation contract the IR already carries for the file target's
 * subagents (ir.ts `consumes`/`produces`), generalized here across providers.
 */
export function buildStepMessages(
  step: StagedStep,
  question: string,
  slots: Readonly<Record<string, string>>,
): StepMessage[] {
  const parts: string[] = [`Question: ${question}`];
  for (const slot of step.consumes) {
    const value = slots[slot];
    parts.push(
      value === undefined
        ? `\n[input '${slot}' was not produced by an earlier step]`
        : `\nInput '${slot}':\n${value}`,
    );
  }
  return [
    { role: "system", content: step.prompt },
    { role: "user", content: parts.join("\n") },
  ];
}
