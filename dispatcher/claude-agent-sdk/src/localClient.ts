/**
 * Minimal OpenAI-compatible chat client for the hybrid-staged path (spike-hybrid-llm.md D4/D6).
 *
 * A local step (provider `openai_compat`, e.g. ollama's `http://localhost:11434/v1`) is executed by
 * calling `POST {endpoint}/chat/completions` directly — NOT through the Claude SDK, whose `agents[].model`
 * is a restricted alias union that loud-fails on a local model id (SDK-NOTES.md #1). ollama speaks the
 * OpenAI Chat Completions shape, not the Anthropic Messages shape, so this is a distinct, deliberately
 * tiny client — no streaming, no tools, no retries. It is the "third provider-aware back-end" embryo the
 * spike flags (§7 risk #1): enough to prove a per-step local model can be marshaled into a cloud run,
 * not a production LLM client.
 *
 * Live-gated: exercised only when an ollama (or other OpenAI-compat) endpoint is reachable. The request
 * SHAPING is unit-tested via {@link buildChatRequest} with no network.
 */
import type { StepMessage } from "./route.js";

export interface ChatRequest {
  model: string;
  messages: StepMessage[];
  stream: false;
  /** Deterministic-leaning default; a local step is a bounded transform, not open-ended generation. */
  temperature: number;
}

/** Build the JSON body for an OpenAI-compatible `/chat/completions` call. Pure (no network). */
export function buildChatRequest(model: string, messages: StepMessage[]): ChatRequest {
  return { model, messages, stream: false, temperature: 0 };
}

/** Extract the assistant text from an OpenAI-compatible completion response. Pure. */
export function extractCompletionText(body: unknown): string {
  const choices = (body as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("openai_compat response has no choices");
  }
  const content = (choices[0] as { message?: { content?: unknown } })?.message?.content;
  if (typeof content !== "string") {
    throw new Error("openai_compat response choice has no message.content string");
  }
  return content;
}

export interface CallLocalOptions {
  endpoint: string;
  model: string;
  messages: StepMessage[];
  /** Optional bearer token (ollama ignores it; other OpenAI-compat servers may require it). */
  apiKey?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Call an OpenAI-compatible chat endpoint and return the assistant text. Live-gated (needs a reachable
 * endpoint); the request/response shaping is covered by {@link buildChatRequest} /
 * {@link extractCompletionText} tests, and a stubbed `fetchImpl` can drive this end-to-end offline.
 */
export async function callOpenAiCompat(opts: CallLocalOptions): Promise<string> {
  const url = `${opts.endpoint.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) headers["authorization"] = `Bearer ${opts.apiKey}`;
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(buildChatRequest(opts.model, opts.messages)),
  });
  if (!res.ok) {
    throw new Error(`openai_compat call to ${url} failed: ${res.status} ${res.statusText}`);
  }
  return extractCompletionText(await res.json());
}
