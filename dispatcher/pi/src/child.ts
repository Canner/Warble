/** Private process entry. No config discovery, filesystem tools, persistence or inherited auth. */
import { createInterface } from "node:readline";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { Model } from "@earendil-works/pi-ai";
import { failureCode } from "./private-failure.js";
import { record } from "./selection.js";
import { jsonBytes } from "./disclosure.js";
import type { ChildInput, UsageCall } from "./runner.js";

const lines = createInterface({ input: process.stdin });
const pending = new Map<number, (value: unknown) => void>();
let started = false, seq = 0;
const calls: UsageCall[] = [];
const send = (value: unknown) => process.stdout.write(jsonBytes(value) + "\n");
lines.on("line", line => {
  try {
    const message = JSON.parse(line);
    if (!started) { started = true; void run(message).catch(error => { send({ type: "failure", code: failureCode(error?.message), calls }); process.exitCode = 1; lines.close(); process.stdin.destroy(); }); }
    else if (message.type === "tool_result" && pending.has(message.id)) {
      pending.get(message.id)!(message.value); pending.delete(message.id);
    } else throw new Error("protocol");
  } catch { process.exit(1); }
});

const token = (value: unknown) => typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32) : "";
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;

async function run(input: ChildInput): Promise<void> {
  const maxTokens = input.maxTokens ?? 4096, retries = input.providerMaxRetries ?? 0;
  const attemptCap = input.maxTurns * (retries + 1);
  const model: Model<"openai-completions"> = {
    id: input.model.id, name: input.model.id, api: "openai-completions", provider: "warble-private",
    baseUrl: input.model.baseUrl, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: Math.max(32768, 2 * maxTokens), maxTokens,
  };
  const deadline = input.deadlineAt === undefined ? undefined : AbortSignal.timeout(Math.max(0, input.deadlineAt - Date.now()));
  let repairing = false, denial: string | undefined, openStart: number | undefined;
  const recordCall = (call: UsageCall) => { if (calls.length < attemptCap) calls.push(call); };
  const tools: AgentTool[] = input.tools.map(tool => ({ ...tool, label: tool.name,
    parameters: tool.parameters as AgentTool["parameters"],
    execute: async (_id, args, signal) => {
      if (repairing) throw new Error("protocol");
      const id = ++seq;
      const value = await new Promise<unknown>((resolve, reject) => {
        pending.set(id, resolve); send({ type: "tool_call", id, name: tool.name, args });
        signal?.addEventListener("abort", () => { pending.delete(id); reject(new Error("aborted")); }, { once: true });
      });
      return { content: [{ type: "text" as const, text: jsonBytes(value) }], details: {} };
    },
  }));
  let turns = 0, requests = 0, attempts = 0, fetchedTurn = 0, responseBytes = 0, lastStatus = 0;
  const destination = new URL("chat/completions", input.model.baseUrl.replace(/\/?$/, "/")).href;
  const agent = new Agent({
    initialState: { model, systemPrompt: input.instructions + "\n\n" + jsonBytes(input.context), tools },
    toolExecution: "sequential",
    streamFn: (_model, context, options) => {
      if (++turns > input.maxTurns) throw new Error("turn_limit");
      const signal = deadline ? AbortSignal.any([...options?.signal ? [options.signal] : [], deadline]) : options?.signal;
      return streamSimple(model, context, { ...options, ...signal ? { signal } : {}, apiKey: input.model.apiKey, maxTokens,
        maxRetries: retries, maxRetryDelayMs: input.providerMaxRetryDelayMs ?? 8000,
        onPayload: payload => ({ ...payload as Record<string, unknown>,
          ...(input.model.enableThinking === undefined ? {} : { chat_template_kwargs: { enable_thinking: input.model.enableThinking } }),
          ...(repairing ? { response_format: { type: "json_object" } } : {}),
        }),
        fetch: async (url, init) => {
          // A local policy denial must not look retryable to the provider retry loop.
          const deny = (code: string) => { denial ??= code; return new Response("", { status: 400, headers: { "x-should-retry": "false" } }); };
          if (String(url) !== destination) return deny("destination_denied");
          if (turns !== fetchedTurn) { fetchedTurn = turns; if (++requests > input.maxTurns) return deny("destination_denied"); }
          if (++attempts > attemptCap) return deny("destination_denied");
          if (typeof init?.body !== "string" || Buffer.byteLength(init.body) > input.maxRequestBytes) return deny("request_limit");
          const started = Date.now(), failed = (status: string) => recordCall({ turn: turns, elapsedMs: Date.now() - started,
            input: 0, output: 0, reasoning: 0, cacheRead: 0, stopReason: "", rawStopReason: "", toolCalls: 0, status });
          let response: Response;
          try { response = await fetch(url, { ...init, redirect: "error" }); }
          catch (error) { failed(init.signal?.aborted ? "aborted" : "network_error"); throw error; }
          lastStatus = response.status;
          if (!response.ok) failed("http_" + response.status);
          else openStart = started;
          if (!response.body) return deny("missing_response");
          const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              responseBytes += chunk.length;
              if (responseBytes > (input.maxResponseBytes ?? input.maxOutputBytes)) throw new Error("response_limit");
              controller.enqueue(chunk);
            },
          }));
          return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        } });
    },
  });
  agent.subscribe(event => {
    if (event.type !== "message_end" || event.message.role !== "assistant" || openStart === undefined) return;
    const { message } = event, started = openStart;
    openStart = undefined;
    recordCall({ turn: turns, elapsedMs: Date.now() - started, input: count(message.usage.input), output: count(message.usage.output),
      reasoning: count(message.usage.reasoning), cacheRead: count(message.usage.cacheRead),
      stopReason: token(message.stopReason), rawStopReason: token(message.rawStopReason),
      toolCalls: message.content.filter(part => part.type === "toolCall").length,
      status: message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "ok" });
  });
  deadline?.addEventListener("abort", () => agent.abort(), { once: true });
  if (deadline?.aborted) throw new Error("deadline");
  await agent.prompt(input.request);
  function finalValue(): unknown {
    if (deadline?.aborted) throw new Error("deadline");
    if (denial) throw new Error(denial);
    const last = agent.state.messages.at(-1);
    if (last?.role === "assistant" && last.stopReason === "error") throw new Error(failureCode(last.errorMessage) !== "child_exit" ? failureCode(last.errorMessage) :
      lastStatus >= 400 ? "provider_http" : last.errorMessage?.includes("without finish_reason") ? "provider_stream" : "model_error");
    if (last?.role === "assistant" && last.stopReason === "length") throw new Error("model_length");
    if (!last || last.role !== "assistant" || last.stopReason !== "stop"
      || last.content.some(part => part.type !== "text" && part.type !== "thinking")) throw new Error("incomplete_child");
    // Reasoning remains private. Only a validated final object crosses this process.
    const text = last.content.map(part => part.type === "text" ? part.text : "").join("");
    if (!text.trim()) throw new Error("empty_output");
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error("invalid_json"); }
    if (input.evidenceOutput && (!record(value, ["evidence"]) || typeof value.evidence !== "string")) throw new Error("invalid_json");
    return value;
  }
  let value: unknown;
  try { value = finalValue(); }
  catch (error) {
    if (!input.evidenceOutput || !(error instanceof Error) || !["invalid_json", "empty_output"].includes(error.message)) throw error;
    // One format-only correction, with all original request/byte/time budgets intact.
    // No tool execution, token extraction from prose, or bypass of the host evidence ledger.
    repairing = true;
    agent.state.tools = [];
    await agent.prompt('Correct only the final output format. Return exactly the JSON object {"evidence":"existing host token"} using the token already returned by a tool for this task. No markdown, prose, extra keys or tool calls. Never invent a token or a status.');
    value = finalValue();
  }
  send({ type: "result", value, calls });
  lines.close(); process.stdin.destroy();
}
