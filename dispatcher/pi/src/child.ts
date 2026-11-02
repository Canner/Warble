/** Private process entry. No config discovery, filesystem tools, persistence or inherited auth. */
import { createInterface } from "node:readline";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { Model } from "@earendil-works/pi-ai";
import { failureCode } from "./private-failure.js";
import { record } from "./selection.js";
import { jsonBytes } from "./disclosure.js";
import type { ChildInput } from "./runner.js";

const lines = createInterface({ input: process.stdin });
const pending = new Map<number, (value: unknown) => void>();
let started = false, seq = 0;
const send = (value: unknown) => process.stdout.write(jsonBytes(value) + "\n");
lines.on("line", line => {
  try {
    const message = JSON.parse(line);
    if (!started) { started = true; void run(message).catch(error => { send({ type: "failure", code: failureCode(error?.message) }); process.exitCode = 1; lines.close(); process.stdin.destroy(); }); }
    else if (message.type === "tool_result" && pending.has(message.id)) {
      pending.get(message.id)!(message.value); pending.delete(message.id);
    } else throw new Error("protocol");
  } catch { process.exit(1); }
});

async function run(input: ChildInput): Promise<void> {
  const model: Model<"openai-completions"> = {
    id: input.model.id, name: input.model.id, api: "openai-completions", provider: "warble-private",
    baseUrl: input.model.baseUrl, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096,
  };
  let repairing = false;
  const tools: AgentTool[] = input.tools.map(tool => ({ ...tool, label: tool.name,
    parameters: tool.parameters as AgentTool["parameters"],
    execute: async (_id, args) => {
      if (repairing) throw new Error("protocol");
      const id = ++seq;
      const value = await new Promise<unknown>(resolve => {
        pending.set(id, resolve); send({ type: "tool_call", id, name: tool.name, args });
      });
      return { content: [{ type: "text" as const, text: jsonBytes(value) }], details: {} };
    },
  }));
  let turns = 0, requests = 0, responseBytes = 0, lastStatus = 0;
  const destination = new URL("chat/completions", input.model.baseUrl.replace(/\/?$/, "/")).href;
  const agent = new Agent({
    initialState: { model, systemPrompt: input.instructions + "\n\n" + jsonBytes(input.context), tools },
    toolExecution: "sequential",
    streamFn: (_model, context, options) => {
      if (++turns > input.maxTurns) throw new Error("turn_limit");
      return streamSimple(model, context, { ...options, apiKey: input.model.apiKey, maxTokens: 4096,
        onPayload: payload => ({ ...payload as Record<string, unknown>,
          ...(input.model.enableThinking === undefined ? {} : { chat_template_kwargs: { enable_thinking: input.model.enableThinking } }),
          ...(repairing ? { response_format: { type: "json_object" } } : {}),
        }),
        fetch: async (url, init) => {
          if (String(url) !== destination || ++requests > input.maxTurns) throw new Error("destination_denied");
          if (typeof init?.body !== "string" || Buffer.byteLength(init.body) > input.maxRequestBytes) throw new Error("request_limit");
          const response = await fetch(url, { ...init, redirect: "error" });
          lastStatus = response.status;
          if (!response.body) throw new Error("missing_response");
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
  await agent.prompt(input.request);
  function finalValue(): unknown {
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
  send({ type: "result", value });
  lines.close(); process.stdin.destroy();
}
