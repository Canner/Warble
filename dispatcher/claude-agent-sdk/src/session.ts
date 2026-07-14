/**
 * Multi-turn chat session over a SINGLE prepared profile component (Phase 1.3, G1 — single-profile
 * multi-turn only; multi-profile routing / `route_by_semantic_domain` is explicitly out of scope
 * here and is left to a later phase of this back-end's runtime-UX work).
 *
 * Two layers, split for offline testability:
 *   - PURE state + heuristics (this file's top half): `SessionState`, `distillFollowup`,
 *     `decideClarify`. No SDK import, no network — unit-testable with plain data.
 *   - Thin LIVE driver (bottom half): `ChatSession` / `createChatSession`, which just resumes
 *     `runDispatch` (run.ts) turn over turn via the SDK's `resume: session_id` mechanism.
 *
 * Design invariant: stickiness/routing/intent-resolution is an LLM decision — it is NEVER encoded as
 * a data-flow DSL here. `distillFollowup` does not decide anything;
 * it only threads the PRIOR turn's already-resolved intent forward as guidance text prepended to the
 * next question, so a follow-up like "break it down by region" can reuse the prior filter without the
 * agent re-deriving it from scratch. The actual resolution (what the filters/dimensions ARE) remains
 * the agent's job each turn — this module only carries forward what was resolved last time.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { DispatchPlan } from "./options.js";
import { runDispatch, type RunConfig, type Trace } from "./run.js";

// --- resolved intent (structured carry-forward) --------------------------------------------------

/**
 * A minimal structured snapshot of what a turn resolved — filters/dimensions/measures/grain — used
 * only to thread context into the NEXT turn's prompt. Nothing here is inferred by this module: a
 * caller who has parsed it out of the agent's own answer (or a render envelope) supplies it via
 * `ChatSession.ask(question, { intent })`. Sessions with no supplied intent simply skip distillation.
 */
export interface ResolvedIntent {
  filters: string[];
  dimensions: string[];
  measures: string[];
  grain?: string;
}

const BREAKDOWN_RE = /\bby\s+([a-z][a-z0-9_]*(?:\s*(?:,|and)\s*[a-z][a-z0-9_]*)*)/i;
const FILTER_OVERRIDE_RE = /\b(where|only|instead of|excluding|filtered?\s+to)\b/i;

/** Heuristic: does the follow-up name its own breakdown ("break it down by X", "group by X, Y")? */
function extractBreakdownDimensions(question: string): string[] | null {
  const m = question.match(BREAKDOWN_RE);
  if (!m) return null;
  const dims = m[1]!
    .split(/\s*(?:,|and)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return dims.length > 0 ? dims : null;
}

/**
 * Merge the prior turn's resolved intent with a new follow-up question into a distilled context
 * string, PREPENDED to the question as guidance for the agent — this never decides routing or
 * overrides the agent's own resolution, it only reduces the odds it drops context a human speaker
 * would have kept implicit ("break it down by region" after "completed orders" should still mean
 * completed orders, broken down by region).
 *
 * Merge policy (heuristic, intentionally simple for G1):
 *   - filters: carried forward unless the new question signals its own filter override (`where`,
 *     `only`, `excluding`, `filtered to`, `instead of`).
 *   - dimensions: swapped to whatever the new question names after "by"/"group by"; otherwise carried.
 *   - measures / grain: always carried (no override heuristic yet — every question in G1 keeps the
 *     same metric family; multi-metric follow-ups are out of scope).
 */
export function distillFollowup(prevIntent: ResolvedIntent, newQuestion: string): string {
  const newDimensions = extractBreakdownDimensions(newQuestion);
  const dimensions = newDimensions ?? prevIntent.dimensions;
  const filters = FILTER_OVERRIDE_RE.test(newQuestion) ? [] : prevIntent.filters;

  const carried: string[] = [];
  if (filters.length > 0) carried.push(`filter(s): ${filters.join(", ")}`);
  if (dimensions.length > 0) {
    carried.push(
      newDimensions
        ? `breakdown swapped to: ${dimensions.join(", ")} (was: ${prevIntent.dimensions.join(", ") || "none"})`
        : `dimension(s): ${dimensions.join(", ")}`,
    );
  }
  if (prevIntent.measures.length > 0) carried.push(`measure(s): ${prevIntent.measures.join(", ")}`);
  if (prevIntent.grain) carried.push(`grain: ${prevIntent.grain}`);

  if (carried.length === 0) return newQuestion;

  return [
    "[Context carried from the previous turn — reuse it unless this question overrides it; you " +
      "still decide the actual resolution.]",
    carried.map((c) => `- ${c}`).join("\n"),
    "",
    newQuestion,
  ].join("\n");
}

// --- clarify policy --------------------------------------------------------------------------------

export type ClarifyOutcome = { kind: "clarify"; question: string } | { kind: "answer" };

/** Below this confidence, clarify rather than guess (a clarifying question is cheaper than a
 *  wasted expensive call). Confidence itself is supplied by the caller — parsed from whatever signal
 *  the agent/router gave (an eval score, a router's own stated confidence, etc.); this function only
 *  encodes the threshold policy, it doesn't compute confidence. */
export const DEFAULT_CLARIFY_THRESHOLD = 0.55;

export function decideClarify(
  question: string,
  confidence: number,
  threshold: number = DEFAULT_CLARIFY_THRESHOLD,
): ClarifyOutcome {
  if (confidence < threshold) {
    return {
      kind: "clarify",
      question:
        `I want to make sure I answer "${question}" correctly — could you clarify which metric, ` +
        "filter, or time range you mean?",
    };
  }
  return { kind: "answer" };
}

// --- session state (pure) --------------------------------------------------------------------------

export interface Turn {
  question: string;
  /** The prompt actually sent to `query()` for this turn (post-distillation). */
  prompt: string;
  /** The turn's resolved intent, if the caller supplied one for carry-forward; null if not tracked. */
  intent: ResolvedIntent | null;
  /** The SDK's session id for this turn's run (resume anchor for the next turn), if any. */
  sessionId: string | null;
  finalText: string;
}

export interface SessionState {
  turns: readonly Turn[];
}

export function createSessionState(): SessionState {
  return { turns: [] };
}

function lastTurn(state: SessionState): Turn | undefined {
  return state.turns[state.turns.length - 1];
}

/** The resume anchor for the NEXT turn: the most recent turn's `session_id`, or null on turn 1. */
export function lastSessionId(state: SessionState): string | null {
  return lastTurn(state)?.sessionId ?? null;
}

/** The most recently resolved intent to carry forward, or null if none was ever supplied. */
export function lastResolvedIntent(state: SessionState): ResolvedIntent | null {
  return lastTurn(state)?.intent ?? null;
}

/** Pure append — returns a new state, does not mutate. */
export function appendTurn(state: SessionState, turn: Turn): SessionState {
  return { turns: [...state.turns, turn] };
}

/** Build the next turn's prompt: turn 1 = the raw question; turn N = distilled context + question. */
export function buildTurnPrompt(state: SessionState, question: string): string {
  const prevIntent = lastResolvedIntent(state);
  return prevIntent ? distillFollowup(prevIntent, question) : question;
}

// --- live driver (thin) -----------------------------------------------------------------------------

export interface TurnResult {
  finalText: string;
  sessionId: string | null;
  trace: Trace;
  /** The actual (post-distillation) prompt sent for this turn. */
  prompt: string;
}

export interface AskOptions {
  /** Supply this turn's resolved intent so it can be carried forward into the NEXT turn's prompt. */
  intent?: ResolvedIntent;
}

/**
 * A multi-turn chat session over ONE prepared component's `DispatchPlan`. Each `ask()` resumes the
 * prior turn's SDK session (`resume: session_id`) so the agent keeps the real conversation history;
 * `distillFollowup` layers a structured hint on top for callers tracking resolved intent explicitly.
 * All branching policy (distillation, clarify) lives in the pure functions above — this class is just
 * plumbing over `runDispatch`.
 */
export class ChatSession {
  private state: SessionState = createSessionState();

  constructor(
    private readonly plan: DispatchPlan,
    private readonly runCfg: RunConfig,
  ) {}

  getState(): SessionState {
    return this.state;
  }

  async ask(question: string, opts: AskOptions = {}): Promise<TurnResult> {
    const prompt = buildTurnPrompt(this.state, question);
    const resume = lastSessionId(this.state);
    const turnPlan: DispatchPlan = { ...this.plan, prompt };
    const turnOutDir = join(this.runCfg.outDir, `turn-${this.state.turns.length + 1}`);
    mkdirSync(turnOutDir, { recursive: true });

    const result = await runDispatch(turnPlan, {
      ...this.runCfg,
      outDir: turnOutDir,
      ...(resume ? { resume } : {}),
    });

    this.state = appendTurn(this.state, {
      question,
      prompt,
      intent: opts.intent ?? null,
      sessionId: result.sessionId,
      finalText: result.finalText,
    });

    return { finalText: result.finalText, sessionId: result.sessionId, trace: result.trace, prompt };
  }
}

export function createChatSession(plan: DispatchPlan, runCfg: RunConfig): ChatSession {
  return new ChatSession(plan, runCfg);
}
