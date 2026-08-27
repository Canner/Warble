import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { z } from "zod";

import type { BirdSessionState } from "./types.js";
import { BIRD_HTTP_PATHS, BIRD_INTERACT_MODE } from "./protocol.js";

const MAX_REQUEST_BYTES = 1024 * 1024;

const modeSchema = z.literal(BIRD_INTERACT_MODE).default(BIRD_INTERACT_MODE);
const stateSchema = z
  .object({
    task_id: z.string().min(1).optional(),
    db_name: z.string().optional(),
    user_query: z.string().optional(),
    current_phase: z.union([z.literal(1), z.literal(2)]).optional(),
    budget_remaining: z.number().finite().optional(),
    initial_budget: z.number().finite().optional(),
    total_reward: z.number().finite().optional(),
    dialogue_history: z.array(z.unknown()).optional(),
    tool_trajectory: z.array(z.unknown()).optional(),
    adk_events: z.array(z.unknown()).optional(),
    phase1_completed: z.boolean().optional(),
    phase2_completed: z.boolean().optional(),
    task_done: z.boolean().optional(),
    model_turns: z.number().int().nonnegative().optional(),
    sdk_session_id: z.string().min(1).optional(),
    rejected_actions: z.array(z.unknown()).optional(),
  })
  .catchall(z.unknown());

const initRequestSchema = z
  .object({
    task_id: z.string().min(1),
    mode: modeSchema,
    state: stateSchema.default({}),
    reset: z.boolean().default(true),
  })
  .strict();

const runRequestSchema = z
  .object({
    task_id: z.string().min(1),
    message: z.string().min(1),
    mode: modeSchema,
  })
  .strict();

export interface BirdAgentRunner {
  run(message: string): Promise<{ message: string; sessionId: string | null }>;
}

export type BirdAgentFactory = (state: BirdSessionState) => BirdAgentRunner;

export interface BirdSystemAgentServerOptions {
  agentFactory: BirdAgentFactory;
  log?: (message: string) => void;
  model?: string;
}

interface SessionRecord {
  state: BirdSessionState;
  sessionId: string;
  agent: BirdAgentRunner;
  running: boolean;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new HttpError(400, "request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body must be valid JSON");
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function normalizeState(
  taskId: string,
  source: z.infer<typeof stateSchema>,
): BirdSessionState {
  const {
    model_turns,
    sdk_session_id: _untrustedSdkSessionId,
    rejected_actions,
    ...rest
  } = source;
  return {
    ...rest,
    task_id: taskId,
    db_name: source.db_name ?? "",
    user_query: source.user_query ?? "",
    current_phase: source.current_phase ?? 1,
    budget_remaining: source.budget_remaining ?? 0,
    initial_budget: source.initial_budget ?? source.budget_remaining ?? 0,
    total_reward: source.total_reward ?? 0,
    dialogue_history: (source.dialogue_history ?? []) as BirdSessionState["dialogue_history"],
    tool_trajectory: (source.tool_trajectory ?? []) as BirdSessionState["tool_trajectory"],
    adk_events: source.adk_events ?? [],
    phase1_completed: source.phase1_completed ?? false,
    phase2_completed: source.phase2_completed ?? false,
    task_done: source.task_done ?? false,
    ...(model_turns === undefined ? {} : { model_turns }),
    ...(rejected_actions === undefined
      ? {}
      : {
          rejected_actions:
            rejected_actions as NonNullable<BirdSessionState["rejected_actions"]>,
        }),
  };
}

export function createBirdSystemAgentServer(
  options: BirdSystemAgentServerOptions,
): Server {
  const sessions = new Map<string, SessionRecord>();
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));

  return createServer(async (request, response) => {
    try {
      if (
        request.method === "GET" &&
        request.url === BIRD_HTTP_PATHS.system_agent.health
      ) {
        writeJson(response, 200, {
          status: "healthy",
          service: "system_agent",
          model: options.model ?? "warble",
          adk_available: true,
          adk_error: null,
        });
        return;
      }

      if (
        request.method === "POST" &&
        request.url === BIRD_HTTP_PATHS.system_agent.init_session
      ) {
        const parsed = initRequestSchema.safeParse(await readJson(request));
        if (!parsed.success) throw new HttpError(400, "invalid init_session request");
        const input = parsed.data;
        const existing = sessions.get(input.task_id);
        if (existing?.running && input.reset) {
          throw new HttpError(409, "task is already running");
        }
        if (existing && !input.reset) {
          writeJson(response, 200, {
            task_id: input.task_id,
            mode: input.mode,
            session_id: existing.sessionId,
            adk_available: true,
          });
          return;
        }

        const state = normalizeState(input.task_id, input.state);
        const record: SessionRecord = {
          state,
          sessionId: randomUUID(),
          agent: options.agentFactory(state),
          running: false,
        };
        sessions.set(input.task_id, record);
        writeJson(response, 200, {
          task_id: input.task_id,
          mode: input.mode,
          session_id: record.sessionId,
          adk_available: true,
        });
        return;
      }

      if (
        request.method === "POST" &&
        request.url === BIRD_HTTP_PATHS.system_agent.run_session
      ) {
        const parsed = runRequestSchema.safeParse(await readJson(request));
        if (!parsed.success) throw new HttpError(400, "invalid run_session request");
        const input = parsed.data;
        const record = sessions.get(input.task_id);
        if (!record) throw new HttpError(404, "unknown task_id");
        if (record.running) throw new HttpError(409, "task is already running");

        record.running = true;
        try {
          const result = await record.agent.run(input.message);
          writeJson(response, 200, {
            task_id: input.task_id,
            mode: input.mode,
            session_id: record.sessionId,
            response: result.message,
            state: record.state,
            adk_available: true,
          });
        } catch {
          log(`BIRD agent run failed for task '${input.task_id}'`);
          writeJson(response, 500, { error: "agent run failed" });
        } finally {
          record.running = false;
        }
        return;
      }

      writeJson(response, 404, { error: "not found" });
    } catch (error) {
      if (response.headersSent) return;
      if (error instanceof HttpError) {
        writeJson(response, error.status, { error: error.message });
        return;
      }
      log("BIRD system-agent request failed");
      writeJson(response, 500, { error: "internal server error" });
    }
  });
}
