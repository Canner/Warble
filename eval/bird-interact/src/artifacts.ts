import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { PREVIEW_LIMIT, SQL_RECORD_LIMIT } from "./preview-truncation.js";
import type { BirdSessionState, ToolTrajectoryEntry } from "./types.js";
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SECRET_KEY = /(password|passwd|secret|token|cookie|credential|connection|authorization|api.?key|env)/i;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|token|password|passwd|secret|authorization|cookie|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;

function safeText(value: string, limit: number = PREVIEW_LIMIT): string {
  return value
    .replace(SECRET_ASSIGNMENT, "$1=[REDACTED]")
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .slice(0, limit);
}

/**
 * A statement, redacted like everything else but kept whole.
 *
 * Same redaction, different cut: see `SQL_RECORD_LIMIT`. These two fields are what the autopsy
 * replays and what the report grades, so a prefix of them is not a smaller version of the record —
 * it is a different statement that no longer parses.
 */
function safeSql(value: string): string {
  return safeText(value, SQL_RECORD_LIMIT);
}

export interface TaskArtifactMetadata {
  taskId: string;
  model: string;
  dbEnvironmentUrl: string;
  userSimulatorUrl: string;
  warbleAgentSdkVersion: string;
  irVersion: string;
  irHash: string;
  wrenProjectPath: string;
  mdlHash: string | null;
  startedAt: string;
  finishedAt: string;
}

function safeValue(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return safeText(value);
  if (Array.isArray(value)) return value.map((item) => safeValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        safeValue(childValue, childKey),
      ]),
    );
  }
  return value;
}

function safeEvent(event: unknown): Record<string, unknown> {
  if (!event || typeof event !== "object") return { type: "unknown" };
  const source = event as Record<string, unknown>;
  const output: Record<string, unknown> = {
    type: typeof source.type === "string" ? source.type : "unknown",
  };
  for (const key of ["subtype", "session_id", "uuid"] as const) {
    if (typeof source[key] === "string") output[key] = safeText(source[key]);
  }
  if (typeof source.result === "string") output.result = safeText(source.result);
  return output;
}

function safeTrajectory(entry: ToolTrajectoryEntry): Record<string, unknown> {
  return {
    type: "tool",
    tool: entry.tool,
    args: safeValue(entry.args),
    result: safeText(entry.result),
    cost: entry.cost,
    budget_before: entry.budget_before,
    budget_after: entry.budget_after,
    phase: entry.phase,
    ...(entry.semantic_sql === undefined
      ? {}
      : { semantic_sql: safeSql(entry.semantic_sql) }),
    ...(entry.native_sql === undefined
      ? {}
      : { native_sql: safeSql(entry.native_sql) }),
    ...(entry.planner_error === undefined
      ? {}
      : { planner_error: safeText(entry.planner_error) }),
  };
}

function safeServiceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "[INVALID URL]";
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

export class TaskArtifactWriter {
  readonly #taskDir: string;
  #ready: Promise<void> | undefined;

  constructor(outRoot: string, taskId: string) {
    if (!SAFE_TASK_ID.test(taskId) || taskId === "." || taskId === "..") {
      throw new Error(`invalid artifact task id '${taskId}'`);
    }
    const root = resolve(outRoot);
    const taskDir = resolve(root, taskId);
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (!taskDir.startsWith(prefix)) throw new Error(`invalid artifact task id '${taskId}'`);
    this.#taskDir = taskDir;
  }

  /**
   * The first write of a session creates the task directory and truncates whatever stream an
   * earlier attempt at this task left there, so the work is memoized. Its *rejection* must not be:
   * a memoized rejection outlives the condition that caused it and then fails every later write of
   * a session that runs for minutes, turning one unwritable moment into a task with no record at
   * all. Clearing the memo lets the next write try again, and truncation stays a once-per-writer
   * effect because a memo that settled successfully is never rebuilt.
   */
  #initialize(): Promise<void> {
    this.#ready ??= mkdir(this.#taskDir, { recursive: true })
      .then(() =>
        writeFile(resolve(this.#taskDir, "agent-events.jsonl"), "", {
          encoding: "utf8",
          mode: 0o600,
        }),
      )
      .catch((error: unknown) => {
        this.#ready = undefined;
        throw error;
      });
    return this.#ready;
  }

  async appendAgentEvent(event: unknown): Promise<void> {
    await this.#initialize();
    await appendFile(
      resolve(this.#taskDir, "agent-events.jsonl"),
      `${JSON.stringify(safeEvent(event))}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  async finalize(
    state: Readonly<BirdSessionState>,
    metadata: Readonly<TaskArtifactMetadata>,
  ): Promise<void> {
    await this.#initialize();
    const eventsPath = resolve(this.#taskDir, "agent-events.jsonl");
    await appendFile(eventsPath, "", { encoding: "utf8", mode: 0o600 });

    const trace = {
      task_id: state.task_id,
      current_phase: state.current_phase,
      budget_remaining: state.budget_remaining,
      initial_budget: state.initial_budget,
      total_reward: state.total_reward,
      dialogue_history: safeValue(state.dialogue_history),
      tool_trajectory: state.tool_trajectory.map(safeTrajectory),
      phase1_completed: state.phase1_completed,
      phase2_completed: state.phase2_completed,
      task_done: state.task_done,
      model_turns: state.model_turns ?? 0,
      sdk_session_id: state.sdk_session_id ?? null,
      rejected_actions: safeValue(state.rejected_actions ?? []),
    };
    const safeMetadata = {
      task_id: metadata.taskId,
      model: metadata.model,
      service_urls: {
        db_environment: safeServiceUrl(metadata.dbEnvironmentUrl),
        user_simulator: safeServiceUrl(metadata.userSimulatorUrl),
      },
      warble_agent_sdk_version: metadata.warbleAgentSdkVersion,
      ir_version: metadata.irVersion,
      ir_hash: metadata.irHash,
      wren_project_path: resolve(metadata.wrenProjectPath),
      mdl_hash: metadata.mdlHash,
      started_at: metadata.startedAt,
      finished_at: metadata.finishedAt,
    };

    await Promise.all([
      atomicJson(resolve(this.#taskDir, "trace.json"), trace),
      atomicJson(resolve(this.#taskDir, "metadata.json"), safeMetadata),
    ]);
  }
}
