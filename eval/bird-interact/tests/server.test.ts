import assert from "node:assert/strict";
import type { Server } from "node:http";
import test from "node:test";

import {
  createBirdSystemAgentServer,
  type BirdAgentFactory,
} from "../src/server.js";
import type { BirdSessionState } from "../src/types.js";

function initialState(taskId: string, budget = 10): BirdSessionState {
  return {
    task_id: taskId,
    db_name: taskId.split("_")[0] ?? "alien",
    user_query: `question for ${taskId}`,
    current_phase: 1,
    budget_remaining: budget,
    initial_budget: budget,
    total_reward: 0,
    dialogue_history: [],
    tool_trajectory: [],
    adk_events: [],
    phase1_completed: false,
    phase2_completed: false,
    task_done: false,
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function echoFactory(): BirdAgentFactory {
  return (state) => ({
    run: async (message) => {
      state.last_message = message;
      return { message: `agent: ${message}`, sessionId: "sdk-session" };
    },
  });
}

test("health is available without model credentials or upstream services", async () => {
  const server = createBirdSystemAgentServer({ agentFactory: echoFactory() });
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "healthy",
      service: "system_agent",
      model: "warble",
      adk_available: true,
      adk_error: null,
    });
  } finally {
    await close(server);
  }
});

test("init is official-compatible and reset controls session replacement", async () => {
  let factoryCalls = 0;
  const server = createBirdSystemAgentServer({
    agentFactory: (session) => {
      factoryCalls += 1;
      return echoFactory()(session);
    },
  });
  const url = await listen(server);
  try {
    const first = await post(url, "/init_session", {
      task_id: "alien_1",
      mode: "a-interact",
      state: initialState("alien_1", 10),
      reset: true,
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.task_id, "alien_1");
    assert.equal(first.body.mode, "a-interact");
    assert.equal(typeof first.body.session_id, "string");
    assert.equal(first.body.adk_available, true);

    const reused = await post(url, "/init_session", {
      task_id: "alien_1",
      state: initialState("alien_1", 99),
      reset: false,
    });
    assert.equal(reused.body.session_id, first.body.session_id);
    assert.equal(factoryCalls, 1);

    const replaced = await post(url, "/init_session", {
      task_id: "alien_1",
      state: initialState("alien_1", 7),
      reset: true,
    });
    assert.notEqual(replaced.body.session_id, first.body.session_id);
    assert.equal(factoryCalls, 2);

    const run = await post(url, "/run_session", {
      task_id: "alien_1",
      message: "solve",
    });
    assert.equal((run.body.state as BirdSessionState).budget_remaining, 7);
  } finally {
    await close(server);
  }
});

test("HTTP state cannot inject or resume a prior SDK conversation", async () => {
  const sdkAnchorsSeen: unknown[] = [];
  const server = createBirdSystemAgentServer({
    agentFactory: (state) => {
      sdkAnchorsSeen.push(state.sdk_session_id);
      state.sdk_session_id = `private-${state.task_id}`;
      return echoFactory()(state);
    },
  });
  const url = await listen(server);
  try {
    const injected = {
      ...initialState("alien_1"),
      sdk_session_id: "stolen-from-other-task",
    };
    await post(url, "/init_session", {
      task_id: "alien_1",
      state: injected,
      reset: true,
    });
    await post(url, "/init_session", {
      task_id: "polar_1",
      state: { ...initialState("polar_1"), sdk_session_id: "private-alien_1" },
      reset: true,
    });
    await post(url, "/init_session", {
      task_id: "alien_1",
      state: { ...initialState("alien_1"), sdk_session_id: "private-alien_1" },
      reset: true,
    });

    assert.deepEqual(sdkAnchorsSeen, [undefined, undefined, undefined]);
  } finally {
    await close(server);
  }
});

test("run returns the official response envelope and mutated isolated state", async () => {
  const server = createBirdSystemAgentServer({ agentFactory: echoFactory() });
  const url = await listen(server);
  try {
    const init = await post(url, "/init_session", {
      task_id: "alien_1",
      state: initialState("alien_1"),
    });
    const run = await post(url, "/run_session", {
      task_id: "alien_1",
      message: "only prompt",
      mode: "a-interact",
    });

    assert.equal(run.status, 200);
    assert.equal(run.body.task_id, "alien_1");
    assert.equal(run.body.mode, "a-interact");
    assert.equal(run.body.session_id, init.body.session_id);
    assert.equal(run.body.response, "agent: only prompt");
    assert.equal(run.body.adk_available, true);
    assert.equal((run.body.state as BirdSessionState).last_message, "only prompt");
  } finally {
    await close(server);
  }
});

test("unknown tasks, malformed JSON, and unsupported modes are rejected", async () => {
  const server = createBirdSystemAgentServer({ agentFactory: echoFactory() });
  const url = await listen(server);
  try {
    assert.equal(
      (await post(url, "/run_session", { task_id: "missing", message: "x" })).status,
      404,
    );
    assert.equal(
      (await post(url, "/init_session", { task_id: "x", mode: "c-interact" })).status,
      400,
    );
    assert.equal(
      (await post(url, "/run_session", { task_id: "x", message: "", mode: "a-interact" })).status,
      400,
    );
    const malformed = await fetch(`${url}/init_session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    assert.equal(malformed.status, 400);
  } finally {
    await close(server);
  }
});

test("same-task concurrent run is 409 while different tasks remain concurrent", async () => {
  let releaseAlien: (() => void) | undefined;
  let alienStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    alienStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseAlien = resolve;
  });
  const server = createBirdSystemAgentServer({
    agentFactory: (state) => ({
      run: async (message) => {
        if (state.task_id === "alien_1") {
          alienStarted?.();
          await gate;
        }
        state.run_marker = `${state.task_id}:${message}`;
        return { message: String(state.run_marker), sessionId: null };
      },
    }),
  });
  const url = await listen(server);
  try {
    await post(url, "/init_session", { task_id: "alien_1", state: initialState("alien_1") });
    await post(url, "/init_session", { task_id: "polar_1", state: initialState("polar_1") });

    const firstAlien = post(url, "/run_session", { task_id: "alien_1", message: "first" });
    await started;
    const duplicate = await post(url, "/run_session", { task_id: "alien_1", message: "second" });
    assert.equal(duplicate.status, 409);
    const resetWhileRunning = await post(url, "/init_session", {
      task_id: "alien_1",
      state: initialState("alien_1"),
      reset: true,
    });
    assert.equal(resetWhileRunning.status, 409);

    const polar = await post(url, "/run_session", { task_id: "polar_1", message: "parallel" });
    assert.equal(polar.status, 200);
    assert.equal((polar.body.state as BirdSessionState).run_marker, "polar_1:parallel");

    releaseAlien?.();
    assert.equal((await firstAlien).status, 200);
  } finally {
    releaseAlien?.();
    await close(server);
  }
});

test("runner failure returns a redacted 500 and preserves state for retry", async () => {
  let attempts = 0;
  const logged: string[] = [];
  const server = createBirdSystemAgentServer({
    log: (message) => logged.push(message),
    agentFactory: (state) => ({
      run: async () => {
        attempts += 1;
        state.attempts = attempts;
        if (attempts === 1) throw new Error("API_KEY=super-secret-value");
        return { message: "recovered", sessionId: null };
      },
    }),
  });
  const url = await listen(server);
  try {
    await post(url, "/init_session", { task_id: "alien_1", state: initialState("alien_1") });
    const failed = await post(url, "/run_session", { task_id: "alien_1", message: "first" });
    assert.equal(failed.status, 500);
    assert.doesNotMatch(JSON.stringify(failed.body), /super-secret-value/);
    assert.doesNotMatch(logged.join("\n"), /super-secret-value/);

    const retried = await post(url, "/run_session", { task_id: "alien_1", message: "retry" });
    assert.equal(retried.status, 200);
    assert.equal((retried.body.state as BirdSessionState).attempts, 2);
  } finally {
    await close(server);
  }
});
