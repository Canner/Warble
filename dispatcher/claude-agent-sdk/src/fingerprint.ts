/**
 * A fingerprint of the prompts a dispatch actually assembled.
 *
 * **Why the IR's own hash is not enough any more.** Until IR 0.7 compile finished every string, so
 * hashing the IR identified what a model would be told. Named slots changed that deliberately: the
 * IR carries every variant and dispatch selects one, so two runs can share an IR hash and have sent
 * different prompts. Anything recording only the IR hash now records something narrower than it
 * appears to — see `docs/spec/ir-schema.md` on slots.
 *
 * What is covered is the text that reaches a model. What is deliberately **not** covered is the
 * question — it is the caller's text and varies per turn by design, so folding it in would make
 * every turn unique and destroy the one property the fingerprint exists for: telling two runs of the
 * same behaviour apart from two runs of different behaviour.
 */
import { createHash } from "node:crypto";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

import type { DispatchPlan } from "./options.js";

/** Hash algorithm named in the output so a stored fingerprint stays readable if this ever changes. */
const ALGORITHM = "sha256";

/**
 * One digest per surface, plus the total.
 *
 * **Per surface as well as in total, on purpose.** The total answers "did anything change"; only the
 * per-surface digests answer "which prompt changed", and that is the question a trace disagreeing
 * with its own hash actually raises. The cost is a few dozen bytes per run.
 */
export interface PromptFingerprint {
  algorithm: typeof ALGORITHM;
  /** Digest over every surface: name-sorted, with each name hashed alongside its text. */
  digest: string;
  /** Per-surface digest, keyed by a stable surface name. */
  surfaces: Record<string, string>;
}

function sha256(text: string): string {
  return createHash(ALGORITHM).update(text, "utf8").digest("hex");
}

/**
 * Fingerprint an arbitrary surface map. The core; both helpers below funnel through it.
 *
 * The total digest hashes each surface's **name and text together**, name-sorted. Including the name
 * is what stops two different arrangements of the same strings — a prompt moved from one subagent to
 * another, say — from colliding; sorting is what makes the result independent of key order.
 */
export function fingerprintSurfaces(surfaces: Record<string, string>): PromptFingerprint {
  const perSurface: Record<string, string> = {};
  const parts: string[] = [];
  for (const name of Object.keys(surfaces).sort()) {
    const text = surfaces[name]!;
    perSurface[name] = sha256(text);
    // The length prefixes keep the concatenation unambiguous: without them a (name, text) pair could
    // be re-split at a different boundary, and two distinct sets of surfaces could hash the same.
    parts.push(`${name.length}:${name} ${text.length}:${text}`);
  }
  return { algorithm: ALGORITHM, digest: sha256(parts.join(" ")), surfaces: perSurface };
}

/**
 * The prompt surfaces of the `query()` options a host is about to send.
 *
 * **This is the primitive, not {@link promptSurfaces}.** A host may assemble its own options from a
 * plan rather than sending the plan's verbatim — the BIRD-Interact adapter does exactly that,
 * replacing the system prompt with the component's `prompt_fragment` — and fingerprinting the plan
 * in that case would record something other than what was sent. A fingerprint describing a prompt
 * nobody received is worse than no fingerprint, because it reads as evidence.
 *
 * So take it as late as possible: over the options that actually reach `query()`.
 */
export function promptSurfacesOf(options: Options): Record<string, string> {
  const surfaces: Record<string, string> = {};
  const system = options.systemPrompt;
  if (typeof system === "string") surfaces["driver.systemPrompt"] = system;
  for (const [name, agent] of Object.entries(options.agents ?? {})) {
    surfaces[`subagent.${name}`] = agent.prompt;
  }
  return surfaces;
}

/**
 * The prompt surfaces a plan **itself** determines — what the single and split paths send verbatim.
 *
 * Surfaces are **named, not positional**, so a plan that gains or loses a subagent changes which
 * keys exist rather than silently shifting every digest after the insertion point.
 *
 * **What this deliberately does NOT cover, and why it would be wrong to.** A staged step is not sent
 * as its `prompt`: the executor prepends a runtime preamble built from the working directory, and
 * the hybrid-tool path sends a driver prompt it composes from the step list, which appears nowhere in
 * the plan's options. Recording a `step.<name>` digest of the bare `prompt` here would produce a
 * fingerprint that does not match the bytes sent — the exact failure this module's header calls worse
 * than no fingerprint, because it reads as evidence. Reproducing the assembly here instead would
 * duplicate it and drift.
 *
 * So those paths are fingerprinted where the bytes exist: `runDispatch` reports one fingerprint per
 * turn it sends, through `RunConfig.onPromptFingerprint`. Use that for anything staged or hybrid; use
 * this for a plan whose options go out as built.
 *
 * One surface that looks missing and is not: on the single-tier (collapse) path a component's
 * `prompt_fragment` is folded into `systemPrompt`, and `llm_calls[].prompt` is not read at all. So a
 * one-step component's step text is covered through the driver surface rather than a step surface.
 */
export function promptSurfaces(plan: DispatchPlan): Record<string, string> {
  return promptSurfacesOf(plan.options);
}

/** Fingerprint the prompts a plan assembled. See {@link promptSurfaces} on when this is the wrong one. */
export function fingerprintPrompts(plan: DispatchPlan): PromptFingerprint {
  return fingerprintSurfaces(promptSurfaces(plan));
}
