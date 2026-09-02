import { test } from "node:test";
import assert from "node:assert/strict";

// OpenAI-compatible local client (hybrid-staged path). The network call is live-gated; here we
// cover request shaping, response extraction, and an end-to-end call driven by a stubbed fetch.
import {
  buildChatRequest,
  extractCompletionText,
  callOpenAiCompat,
} from "../src/localClient.js";
import type { StepMessage } from "../src/route.js";

const MSGS: StepMessage[] = [
  { role: "system", content: "Resolve the intent." },
  { role: "user", content: "how many orders" },
];

test("buildChatRequest emits the OpenAI chat shape (non-streaming, deterministic)", () => {
  const req = buildChatRequest("qwen2.5", MSGS);
  assert.equal(req.model, "qwen2.5");
  assert.equal(req.stream, false);
  assert.equal(req.temperature, 0);
  assert.deepEqual(req.messages, MSGS);
});

test("extractCompletionText pulls choices[0].message.content", () => {
  const body = { choices: [{ message: { role: "assistant", content: "intent: count orders" } }] };
  assert.equal(extractCompletionText(body), "intent: count orders");
});

test("extractCompletionText loud-fails on an empty/omitted choices array", () => {
  assert.throws(() => extractCompletionText({ choices: [] }), /no choices/);
  assert.throws(() => extractCompletionText({}), /no choices/);
});

test("callOpenAiCompat posts to {endpoint}/chat/completions and returns the text (stubbed fetch)", async () => {
  let seenUrl = "";
  let seenBody: unknown;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init?.body));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ choices: [{ message: { content: "count of orders" } }] }),
    } as Response;
  }) as unknown as typeof fetch;

  const text = await callOpenAiCompat({
    endpoint: "http://localhost:11434/v1",
    model: "qwen2.5",
    messages: MSGS,
    fetchImpl,
  });
  assert.equal(text, "count of orders");
  assert.equal(seenUrl, "http://localhost:11434/v1/chat/completions");
  assert.equal((seenBody as { model: string }).model, "qwen2.5");
});

test("callOpenAiCompat surfaces a non-OK HTTP status as a loud error", async () => {
  const fetchImpl = (async () =>
    ({ ok: false, status: 500, statusText: "Internal Server Error" }) as Response) as unknown as typeof fetch;
  await assert.rejects(
    () => callOpenAiCompat({ endpoint: "http://x/v1", model: "m", messages: MSGS, fetchImpl }),
    /500 Internal Server Error/,
  );
});
