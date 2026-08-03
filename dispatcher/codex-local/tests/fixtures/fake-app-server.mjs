#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const codexHome = process.env.CODEX_HOME;
if (!codexHome) process.exit(2);
const statePath = join(codexHome, "fake-app-state.json");
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { nextThread: 1, nextTurn: 1, threads: {}, requests: [], argv: process.argv.slice(2) };
state.pid = process.pid;
state.billingEnvPresent = Object.keys(process.env).some((key) =>
  ["OPENAI_API_KEY", "CODEX_API_KEY", "AZURE_OPENAI_API_KEY"].includes(key.toUpperCase()),
);
save();

const held = new Map();
const rl = createInterface({ input: process.stdin });

function save() {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function response(id, result) {
  send({ id, result });
}

function notify(method, params) {
  send({ method, params });
}

function threadView(thread, includeTurns = false) {
  return {
    id: thread.id,
    sessionId: thread.id,
    forkedFromId: thread.forkedFromId,
    parentThreadId: thread.parentThreadId ?? null,
    preview: "fake session",
    ephemeral: false,
    isPinned: false,
    historyMode: "legacy",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: "idle" },
    path: join(codexHome, `${thread.id}.jsonl`),
    cwd: thread.cwd,
    cliVersion: "0.146.0",
    source: "vscode",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: thread.agentNickname ?? null,
    agentRole: thread.agentRole ?? null,
    gitInfo: null,
    name: null,
    turns: includeTurns ? thread.turns : [],
  };
}

function collabItem(id, tool, status, thread, model = null, prompt = null) {
  return {
    type: "collabAgentToolCall",
    id,
    tool,
    status,
    senderThreadId: thread.id,
    receiverThreadIds: [],
    prompt,
    model,
    reasoningEffort: null,
    agentsStates: {},
  };
}

function askEnvelope(step, produces, ok, value, error = null) {
  return JSON.stringify({ warble_step: step, produces, ok, value, error });
}

function completeAsk(thread, turn, scenario, parentPrompt) {
  const originalRequest = parentPrompt.split("\nOriginal request: ").at(-1) ?? "fake question";
  const generatedOk = scenario !== "ask-repair" && scenario !== "ask-repair-fails";
  const definitions = [
    {
      step: "resolve_intent",
      role: "warble_resolve_intent",
      model: "gpt-5.6-terra",
      produces: "query_intent",
      tools: [],
      value: { metric: "orders", limit: 10 },
      ok: true,
      error: null,
    },
    {
      step: "generate_sql",
      role: "warble_generate_sql",
      model: "gpt-5.6-sol",
      produces: "query_result",
      tools: ["run_sql"],
      value: generatedOk
        ? { columns: ["orders"], rows: [[42]], verified: true }
        : { sql: "bad sql", verified: false, reason: "fake query failure" },
      ok: generatedOk,
      error: generatedOk ? null : "query failed",
    },
    ...(!generatedOk
      ? [{
          step: "repair_sql",
          role: "warble_repair_sql",
          model: "gpt-5.6-sol",
          produces: "repaired_result",
          tools: ["run_sql"],
          value: scenario === "ask-repair-fails"
            ? { verified: false, refused: true, reason: "repair failed" }
            : { columns: ["orders"], rows: [[42]], verified: true },
          ok: scenario !== "ask-repair-fails",
          error: scenario === "ask-repair-fails" ? "repair failed" : null,
        }]
      : []),
  ];
  const slots = {};
  for (const [index, definition] of definitions.entries()) {
    const spawnId = `spawn-${turn.id}-${index + 1}`;
    const inputs = index === 0
      ? {}
      : { [index === 1 ? "query_intent" : "query_result"]: slots[index === 1 ? "query_intent" : "query_result"] };
    if (scenario === "ask-wrong-input" && index === 1) inputs.query_intent = { fabricated: true };
    const childPrompt = `WARBLE_STEP_REQUEST\n${JSON.stringify({
      step: definition.step,
      request: originalRequest,
      inputs,
    })}`;
    const started = collabItem(spawnId, "spawnAgent", "inProgress", thread, "", childPrompt);
    notify("item/started", { item: started, threadId: thread.id, turnId: turn.id, startedAtMs: 2 + index });
    const childId = `thread-${state.nextThread++}`;
    const childRole = scenario === "ask-wrong-role" && index === 0 ? "wrong_role" : definition.role;
    const child = {
      id: childId,
      forkedFromId: null,
      parentThreadId: thread.id,
      agentRole: childRole,
      agentNickname: `fake-${index + 1}`,
      model: definition.model,
      cwd: thread.cwd,
      turns: [],
    };
    const childTurnId = `turn-${state.nextTurn++}`;
    const user = {
      type: "userMessage",
      id: `user-${childTurnId}`,
      clientId: null,
      content: [{ type: "text", text: childPrompt, text_elements: [] }],
    };
    const childItems = [user];
    for (const tool of definition.tools) {
      childItems.push({
        type: "mcpToolCall",
        id: `tool-${childTurnId}`,
        server: scenario === "ask-wrong-tool" ? "other" : "wren",
        tool,
        status: "completed",
        arguments: { secret: "must-not-leak" },
        result: { content: [{ type: "text", text: "must-not-leak" }] },
        error: null,
      });
    }
    const answer = {
      type: "agentMessage",
      id: `answer-${childTurnId}`,
      text: askEnvelope(
        definition.step,
        definition.produces,
        definition.ok,
        definition.value,
        definition.error,
      ),
      phase: "final_answer",
      memoryCitation: null,
    };
    childItems.push(answer);
    child.turns.push({ id: childTurnId, status: "completed", items: childItems });
    state.threads[childId] = child;
    const completed = {
      ...started,
      status: "completed",
      receiverThreadIds: [childId],
      model: scenario === "ask-wrong-model" && index === 0 ? "wrong-model" : definition.model,
      agentsStates: { [childId]: { status: "running", message: null } },
    };
    notify("item/completed", { item: completed, threadId: thread.id, turnId: turn.id, completedAtMs: 3 + index });
    if (scenario === "ask-unknown-child-event" && index === 0) {
      notify("turn/started", {
        threadId: "unknown-child-thread",
        turn: turnView(child.turns[0]),
      });
    }
    notify("turn/started", {
      threadId: childId,
      turn: turnView(child.turns[0]),
    });
    for (const item of childItems) {
      notify("item/completed", {
        item,
        threadId: childId,
        turnId: childTurnId,
        completedAtMs: 3 + index,
      });
    }
    notify("turn/completed", {
      threadId: childId,
      turn: turnView(child.turns[0]),
    });

    const waitId = `wait-${turn.id}-${index + 1}`;
    const waitStarted = {
      ...collabItem(waitId, "wait", "inProgress", thread),
      receiverThreadIds: [childId],
    };
    notify("item/started", { item: waitStarted, threadId: thread.id, turnId: turn.id, startedAtMs: 4 + index });
    const waitCompleted = {
      ...waitStarted,
      status: scenario === "ask-wait-error" && index === 0 ? "failed" : "completed",
      agentsStates: {
        [childId]: {
          status: scenario === "ask-child-fails" && index === 0 ? "failed" : "completed",
          message: null,
        },
      },
    };
    notify("item/completed", { item: waitCompleted, threadId: thread.id, turnId: turn.id, completedAtMs: 5 + index });
    slots[definition.produces] = definition.value;
  }
  const last = definitions.at(-1);
  const parentAnswer = {
    type: "agentMessage",
    id: `answer-${turn.id}`,
    text: JSON.stringify(last.value),
    phase: "final_answer",
    memoryCitation: null,
  };
  notify("item/completed", { item: parentAnswer, threadId: thread.id, turnId: turn.id, completedAtMs: 20 });
  turn.items.push(parentAnswer);
  turn.status = "completed";
  save();
  notify("turn/completed", { threadId: thread.id, turn: turnView(turn) });
}

function turnView(turn, status = turn.status) {
  return {
    id: turn.id,
    items: turn.items,
    itemsView: "full",
    status,
    error: status === "failed" ? { message: "fake failure" } : null,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1,
  };
}

function complete(thread, turn, status = "completed", scenario = "success") {
  if (status === "completed") {
    notify("error", {
      ...(scenario === "malformed-retry-error" ? {} : { error: { message: "retry detail must-not-leak" } }),
      willRetry: true,
      threadId: thread.id,
      turnId: turn.id,
    });
    if (scenario === "malformed-retry-error") return;
    if (scenario === "terminal-error-notification") {
      notify("error", {
        error: { message: "terminal detail must-not-leak" },
        willRetry: false,
        threadId: thread.id,
        turnId: turn.id,
      });
      return;
    }
    const itemId = `tool-${turn.id}`;
    const started = {
      type: "mcpToolCall",
      id: itemId,
      server: scenario === "nonallowlisted" ? "other" : "setup",
      tool: "probe_setup",
      status: "inProgress",
      arguments: { credential: "must-not-leak" },
      appContext: null,
      pluginId: null,
      result: null,
      error: null,
      durationMs: null,
    };
    notify("item/started", { item: started, threadId: thread.id, turnId: turn.id, startedAtMs: 1 });
    const completed = {
      ...started,
      status: scenario === "invalid-status" ? "mystery" : "completed",
      result: { content: [{ type: "text", text: '{"ok":true,"secret":"must-not-leak"}' }], structuredContent: null, _meta: null },
      error: scenario === "completed-with-error" ? { message: "must-not-leak" } : null,
      durationMs: 1,
    };
    notify("item/completed", { item: completed, threadId: thread.id, turnId: turn.id, completedAtMs: 2 });
    if (scenario === "invalid-status") return;
    if (scenario === "completed-with-error") {
      const answer = { type: "agentMessage", id: `answer-${turn.id}`, text: `answer ${turn.id}`, phase: "final_answer", memoryCitation: null };
      notify("item/completed", { item: answer, threadId: thread.id, turnId: turn.id, completedAtMs: 3 });
      turn.items.push(completed, answer);
      turn.status = status;
      save();
      notify("turn/completed", { threadId: thread.id, turn: turnView(turn) });
      return;
    }
    if (scenario === "forbidden-item") {
      notify("item/completed", {
        item: { type: "commandExecution", id: `forbidden-${turn.id}`, command: "echo must-not-leak" },
        threadId: thread.id,
        turnId: turn.id,
        completedAtMs: 3,
      });
      return;
    }
    if (scenario === "unknown-item") {
      notify("item/completed", {
        item: { type: "futureToolCall", id: `unknown-${turn.id}` },
        threadId: thread.id,
        turnId: turn.id,
        completedAtMs: 3,
      });
      return;
    }
    const answer = { type: "agentMessage", id: `answer-${turn.id}`, text: `answer ${turn.id}`, phase: "final_answer", memoryCitation: null };
    notify("item/completed", { item: answer, threadId: thread.id, turnId: turn.id, completedAtMs: 3 });
    turn.items.push(completed, answer);
  }
  turn.status = status;
  save();
  notify("turn/completed", { threadId: thread.id, turn: turnView(turn) });
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (process.env.WARBLE_FAKE_APP_HANG_INIT === "1") return;
    state.initializeCapabilities = message.params.capabilities;
    save();
    response(message.id, { userAgent: "fake/0.1", codexHome, platformFamily: "unix", platformOs: "macos" });
    notify("remoteControl/status/changed", { status: "disconnected" });
    return;
  }
  if (message.method === "initialized") return;
  state.requests.push({ method: message.method, params: message.params });
  if (message.method === "thread/start") {
    const id = `thread-${state.nextThread++}`;
    const thread = { id, forkedFromId: null, parentThreadId: null, cwd: message.params.cwd, turns: [] };
    state.threads[id] = thread;
    save();
    response(message.id, { thread: threadView(thread), model: message.params.model ?? "gpt-5.4", modelProvider: "openai" });
    notify("thread/started", { thread: threadView(thread) });
  } else if (message.method === "thread/resume") {
    const thread = state.threads[message.params.threadId];
    if (!thread) return send({ id: message.id, error: { code: -32000, message: "missing thread" } });
    thread.cwd = message.params.cwd;
    save();
    response(message.id, { thread: threadView(thread, true), model: "gpt-5.4", modelProvider: "openai" });
  } else if (message.method === "thread/read") {
    const thread = state.threads[message.params.threadId];
    if (!thread) return send({ id: message.id, error: { code: -32000, message: "missing thread" } });
    response(message.id, { thread: threadView(thread, message.params.includeTurns === true) });
  } else if (message.method === "thread/fork") {
    const source = state.threads[message.params.threadId];
    if (!source) return send({ id: message.id, error: { code: -32000, message: "missing thread" } });
    const id = `thread-${state.nextThread++}`;
    const thread = { id, forkedFromId: source.id, cwd: message.params.cwd, turns: structuredClone(source.turns) };
    state.threads[id] = thread;
    save();
    response(message.id, { thread: threadView(thread, true), model: "gpt-5.4", modelProvider: "openai" });
  } else if (message.method === "turn/start") {
    const thread = state.threads[message.params.threadId];
    const id = `turn-${state.nextTurn++}`;
    const text = message.params.input?.[0]?.text ?? "";
    const user = { type: "userMessage", id: `user-${id}`, clientId: null, content: message.params.input };
    const turn = { id, status: "inProgress", items: [user] };
    thread.turns.push(turn);
    save();
    if (text.includes("Execute Warble component") && text.includes("ask-config-warning")) {
      notify("configWarning", { message: "fake passive configuration warning" });
    }
    if (text.includes("Execute Warble component") && text.includes("ask-early-notify")) {
      notify("turn/started", { threadId: thread.id, turn: turnView(turn) });
      completeAsk(thread, turn, "ask-success", text);
      response(message.id, { turn: { ...turnView(turn), status: "inProgress" } });
      return;
    }
    response(message.id, { turn: turnView(turn) });
    setTimeout(() => {
      notify("turn/started", { threadId: thread.id, turn: turnView(turn) });
      if (text.includes("Execute Warble component") && text.includes("ask-hold")) held.set(id, { thread, turn, ask: true });
      else if (text.includes("Execute Warble component")) {
        const scenario = [
          "ask-repair-fails",
          "ask-repair",
          "ask-wrong-input",
          "ask-wrong-role",
          "ask-wrong-model",
          "ask-wrong-tool",
          "ask-child-fails",
          "ask-wait-error",
          "ask-unknown-child-event",
        ].find((candidate) => text.includes(candidate)) ?? "ask-success";
        completeAsk(thread, turn, scenario, text);
      }
      else if (text.endsWith("hold for steer") || text.endsWith("hold for interrupt")) held.set(id, { thread, turn });
      else if (text.endsWith("crash after start")) process.exit(23);
      else if (text.endsWith("completed-with-error")) complete(thread, turn, "completed", "completed-with-error");
      else if (text.endsWith("invalid-status")) complete(thread, turn, "completed", "invalid-status");
      else if (text.endsWith("forbidden-item")) complete(thread, turn, "completed", "forbidden-item");
      else if (text.endsWith("unknown-item")) complete(thread, turn, "completed", "unknown-item");
      else if (text.endsWith("nonallowlisted")) complete(thread, turn, "completed", "nonallowlisted");
      else if (text.endsWith("terminal-error-notification")) complete(thread, turn, "completed", "terminal-error-notification");
      else if (text.endsWith("malformed-retry-error")) complete(thread, turn, "completed", "malformed-retry-error");
      else if (text.endsWith("unknown-notification")) notify("future/tool/started", { secret: "must-not-leak" });
      else complete(thread, turn);
    }, 5);
  } else if (message.method === "turn/steer") {
    const entry = held.get(message.params.expectedTurnId);
    if (!entry) return send({ id: message.id, error: { code: -32000, message: "not active" } });
    response(message.id, { turnId: entry.turn.id });
    held.delete(entry.turn.id);
    setTimeout(() => complete(entry.thread, entry.turn), 5);
  } else if (message.method === "turn/interrupt") {
    const entry = held.get(message.params.turnId);
    response(message.id, {});
    if (entry) {
      held.delete(entry.turn.id);
      if (entry.ask) {
        entry.turn.status = "interrupted";
        save();
        setTimeout(() => notify("turn/completed", {
          threadId: entry.thread.id,
          turn: turnView(entry.turn),
        }), 5);
      } else setTimeout(() => complete(entry.thread, entry.turn, "interrupted"), 5);
    }
  } else {
    send({ id: message.id, error: { code: -32601, message: "unknown method" } });
  }
});
