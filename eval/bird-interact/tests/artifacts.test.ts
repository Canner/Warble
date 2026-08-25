import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TaskArtifactWriter } from "../src/artifacts.js";
import type { BirdSessionState } from "../src/types.js";

function session(): BirdSessionState {
  return {
    task_id: "alien_1",
    db_name: "alien",
    user_query: "question",
    current_phase: 2,
    budget_remaining: 4.5,
    initial_budget: 10,
    total_reward: 0.75,
    dialogue_history: [
      { role: "agent", content: "which metric?" },
      { role: "user", content: "the active metric API_KEY=dialogue-secret" },
    ],
    tool_trajectory: [
      {
        type: "tool",
        tool: "execute_sql",
        args: { sql: "SELECT 1", password: "[REDACTED]" },
        result: `rows token=result-secret ${"x".repeat(5_000)}`,
        cost: 1,
        budget_before: 10,
        budget_after: 9,
        phase: 1,
        semantic_sql: "SELECT 1",
        native_sql: "SELECT 1",
      },
    ],
    adk_events: [],
    phase1_completed: true,
    phase2_completed: false,
    task_done: false,
    model_turns: 3,
    sdk_session_id: "sdk-1",
    connection_file_contents: "postgres://admin:connection-secret@db/prod",
  };
}

test("writes ordered safe events plus atomic trace and reproducibility metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "warble-bird-artifacts-"));
  const writer = new TaskArtifactWriter(root, "alien_1");
  try {
    await writer.appendAgentEvent({
      type: "assistant",
      session_id: "sdk-1",
      message: { content: "ANTHROPIC_API_KEY=event-secret" },
      cookie: "cookie-secret",
    });
    await writer.appendAgentEvent({
      type: "result",
      subtype: "success",
      result: "done password=event-result-secret",
      session_id: "sdk-1",
    });
    await writer.finalize(session(), {
      taskId: "alien_1",
      model: "claude-test",
      dbEnvironmentUrl: "http://127.0.0.1:6001",
      userSimulatorUrl: "http://127.0.0.1:6002",
      warbleAgentSdkVersion: "0.2.0",
      irVersion: "0.6",
      irHash: "ir-sha256",
      wrenProjectPath: "/projects/alien",
      mdlHash: "mdl-sha256",
      startedAt: "2026-08-24T00:00:00.000Z",
      finishedAt: "2026-08-24T00:01:00.000Z",
    });

    const taskDir = join(root, "alien_1");
    assert.deepEqual((await readdir(taskDir)).sort(), [
      "agent-events.jsonl",
      "metadata.json",
      "trace.json",
    ]);
    const events = (await readFile(join(taskDir, "agent-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(events, [
      { type: "assistant", session_id: "sdk-1" },
      {
        type: "result",
        subtype: "success",
        session_id: "sdk-1",
        result: "done password=[REDACTED]",
      },
    ]);

    const trace = JSON.parse(await readFile(join(taskDir, "trace.json"), "utf8")) as Record<string, unknown>;
    assert.equal(trace.task_id, "alien_1");
    assert.equal(trace.current_phase, 2);
    assert.equal(trace.budget_remaining, 4.5);
    assert.equal(trace.total_reward, 0.75);
    assert.equal(trace.sdk_session_id, "sdk-1");
    assert.deepEqual(trace.phase1_completed, true);
    assert.ok(Array.isArray(trace.dialogue_history));
    assert.ok(Array.isArray(trace.tool_trajectory));

    const metadata = JSON.parse(await readFile(join(taskDir, "metadata.json"), "utf8")) as Record<string, unknown>;
    assert.equal(metadata.warble_agent_sdk_version, "0.2.0");
    assert.equal(metadata.ir_version, "0.6");
    assert.equal(metadata.ir_hash, "ir-sha256");
    assert.equal(metadata.wren_project_path, "/projects/alien");
    assert.equal(metadata.mdl_hash, "mdl-sha256");
    assert.deepEqual(metadata.service_urls, {
      db_environment: "http://127.0.0.1:6001",
      user_simulator: "http://127.0.0.1:6002",
    });

    const all = [
      await readFile(join(taskDir, "agent-events.jsonl"), "utf8"),
      await readFile(join(taskDir, "trace.json"), "utf8"),
      await readFile(join(taskDir, "metadata.json"), "utf8"),
    ].join("\n");
    assert.doesNotMatch(
      all,
      /event-secret|event-result-secret|result-secret|dialogue-secret|cookie-secret|connection-secret|ANTHROPIC_API_KEY/,
    );
    assert.ok(all.length < 15_000, "long upstream bodies must be capped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects task ids that could escape the output root", () => {
  assert.throws(() => new TaskArtifactWriter("/tmp/output", "../escape"), /task id/);
});

test("a reset writer starts a fresh event stream for the task", async () => {
  const root = await mkdtemp(join(tmpdir(), "warble-bird-artifacts-reset-"));
  try {
    const first = new TaskArtifactWriter(root, "alien_1");
    await first.appendAgentEvent({ type: "assistant", result: "old-session" });

    const reset = new TaskArtifactWriter(root, "alien_1");
    await reset.appendAgentEvent({ type: "assistant", result: "new-session" });

    const events = await readFile(
      join(root, "alien_1", "agent-events.jsonl"),
      "utf8",
    );
    assert.doesNotMatch(events, /old-session/);
    assert.match(events, /new-session/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The poisoning this closes: the initialization promise was memoized on the first call and kept
 * its rejection forever, so one moment the task directory could not be created failed every
 * remaining write of that session — long after the cause was gone. A live benchmark session
 * writes one task's events over minutes, so the memo turned a transient failure into a task with
 * no record at all. A file standing where the task directory belongs reproduces that first
 * failure without depending on the uid the tests run as.
 */
test("a failed first write does not poison the rest of the session", async () => {
  const root = await mkdtemp(join(tmpdir(), "warble-bird-artifacts-retry-"));
  try {
    const blocking = join(root, "alien_1");
    await writeFile(blocking, "", "utf8");
    const writer = new TaskArtifactWriter(root, "alien_1");
    await assert.rejects(
      writer.appendAgentEvent({ type: "assistant", result: "blocked" }),
      /EEXIST/,
    );

    await rm(blocking);
    await writer.appendAgentEvent({
      type: "result",
      subtype: "success",
      result: "recovered",
    });

    const events = await readFile(join(root, "alien_1", "agent-events.jsonl"), "utf8");
    assert.match(events, /recovered/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A submission that bypassed planning has to say so in the record.
 *
 * `safeTrajectory` copies a whitelist of fields, so a field added to `ToolTrajectoryEntry` reaches
 * `trace.json` only when it is added here too -- and a field that never lands is invisible rather
 * than wrong, which is the failure mode nothing else in the suite would catch. `planner_error` is
 * what separates a planner outage from a management statement that never needed planning: without
 * it, an autopsy of a task that scored 0 on valid SQL has nothing pointing at the planner.
 */
test("a submission recorded without planning carries the reason it bypassed the planner", async () => {
  const root = await mkdtemp(join(tmpdir(), "warble-bird-artifacts-planner-"));
  try {
    const state = session();
    const failed: BirdSessionState = {
      ...state,
      tool_trajectory: [
        {
          type: "tool",
          tool: "submit_sql",
          args: { sql: "SELECT 1" },
          result: "Submitted",
          cost: 3,
          budget_before: 4.5,
          budget_after: -1,
          phase: 1,
          semantic_sql: "SELECT 1",
          planner_error: `wren dry-plan failed password=planner-secret ${"x".repeat(5_000)}`,
        },
      ],
    };
    const writer = new TaskArtifactWriter(root, "alien_1");
    await writer.finalize(failed, {
      taskId: "alien_1",
      model: "claude-test",
      dbEnvironmentUrl: "http://127.0.0.1:6001",
      userSimulatorUrl: "http://127.0.0.1:6002",
      warbleAgentSdkVersion: "0.2.0",
      irVersion: "0.6",
      irHash: "ir-sha256",
      wrenProjectPath: "/projects/alien",
      mdlHash: "mdl-sha256",
      startedAt: "2026-08-24T00:00:00.000Z",
      finishedAt: "2026-08-24T00:01:00.000Z",
    });

    const trace = JSON.parse(await readFile(join(root, "alien_1", "trace.json"), "utf8")) as {
      tool_trajectory: Array<Record<string, unknown>>;
    };
    const entry = trace.tool_trajectory[0];
    assert.ok(entry !== undefined, "the submission must be recorded");
    assert.match(
      String(entry.planner_error),
      /^wren dry-plan failed/,
      "trace.json must keep the reason a submission bypassed planning, or an autopsy of a task " +
        "that scored 0 on valid SQL has nothing pointing at the planner",
    );
    assert.equal(entry.native_sql, undefined, "an unplanned submission records no native SQL");
    assert.doesNotMatch(String(entry.planner_error), /planner-secret/, "the reason is redacted");
    assert.ok(
      String(entry.planner_error).length < 3_000,
      "the reason is truncated like every other recorded string",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
