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
    parentThreadId: null,
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
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: includeTurns ? thread.turns : [],
  };
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
    response(message.id, { userAgent: "fake/0.1", codexHome, platformFamily: "unix", platformOs: "macos" });
    return;
  }
  if (message.method === "initialized") return;
  state.requests.push({ method: message.method, params: message.params });
  if (message.method === "thread/start") {
    const id = `thread-${state.nextThread++}`;
    const thread = { id, forkedFromId: null, cwd: message.params.cwd, turns: [] };
    state.threads[id] = thread;
    save();
    response(message.id, { thread: threadView(thread), model: "gpt-5.4", modelProvider: "openai" });
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
    response(message.id, { turn: turnView(turn) });
    setTimeout(() => {
      notify("turn/started", { threadId: thread.id, turn: turnView(turn) });
      if (text.endsWith("hold for steer") || text.endsWith("hold for interrupt")) held.set(id, { thread, turn });
      else if (text.endsWith("crash after start")) process.exit(23);
      else if (text.endsWith("completed-with-error")) complete(thread, turn, "completed", "completed-with-error");
      else if (text.endsWith("invalid-status")) complete(thread, turn, "completed", "invalid-status");
      else if (text.endsWith("forbidden-item")) complete(thread, turn, "completed", "forbidden-item");
      else if (text.endsWith("unknown-item")) complete(thread, turn, "completed", "unknown-item");
      else if (text.endsWith("nonallowlisted")) complete(thread, turn, "completed", "nonallowlisted");
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
      setTimeout(() => complete(entry.thread, entry.turn, "interrupted"), 5);
    }
  } else {
    send({ id: message.id, error: { code: -32601, message: "unknown method" } });
  }
});
