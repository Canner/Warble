import { z } from "zod";

import type { SubmitSqlResponse } from "./types.js";
import { BIRD_HTTP_PATHS } from "./protocol.js";

export type BirdRequestOperation =
  | "execute"
  | "submit"
  | "phase_transition"
  | "ask"
  | "schema"
  | "knowledge";

const BIRD_REQUEST_TIMEOUTS_MS = Object.freeze({
  execute: 120_000,
  submit: 120_000,
  phase_transition: 120_000,
  ask: 60_000,
  schema: 30_000,
  knowledge: 30_000,
} satisfies Record<BirdRequestOperation, number>);

export function birdRequestTimeoutMs(
  operation: BirdRequestOperation,
  override?: number,
): number {
  return override ?? BIRD_REQUEST_TIMEOUTS_MS[operation];
}

const executeResponseSchema = z.object({
  success: z.boolean(),
  result: z.string(),
  error: z.string().nullable().optional(),
});
const schemaResponseSchema = z.object({ schema: z.string() });
const allColumnMeaningsResponseSchema = z.object({ column_meanings: z.string() });
const columnMeaningResponseSchema = z.object({ meaning: z.string() });
const knowledgeNamesResponseSchema = z.object({ names: z.array(z.string()) });
const knowledgeResponseSchema = z.object({ knowledge: z.string() });
const askResponseSchema = z.object({ answer: z.string() });
const phaseTransitionResponseSchema = z.object({ status: z.string() });
const submitResponseSchema = z.object({
  passed: z.boolean(),
  message: z.string(),
  reward: z.number().optional(),
  phase_completed: z.union([z.literal(1), z.literal(2), z.null()]).optional(),
  has_follow_up: z.boolean().optional(),
  follow_up_query: z.string().nullable().optional(),
});

export type ExecuteSqlResponse = z.infer<typeof executeResponseSchema>;

export interface BirdClient {
  execute(taskId: string, sql: string): Promise<ExecuteSqlResponse>;
  getSchema(taskId: string): Promise<string>;
  getAllColumnMeanings(taskId: string): Promise<string>;
  getColumnMeaning(taskId: string, tableName: string, columnName: string): Promise<string>;
  getAllKnowledgeNames(taskId: string): Promise<string[]>;
  getKnowledge(taskId: string, knowledgeName?: string): Promise<string>;
  askUser(taskId: string, question: string): Promise<string>;
  phaseTransition(taskId: string): Promise<void>;
  submit(taskId: string, sql: string): Promise<SubmitSqlResponse>;
}

export interface FetchBirdClientOptions {
  dbEnvironmentUrl: string;
  userSimulatorUrl: string;
  timeoutMs?: number;
}

export class BirdClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BirdClientError";
  }
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid BIRD endpoint]";
  }
}

export class FetchBirdClient implements BirdClient {
  readonly #dbEnvironmentUrl: string;
  readonly #userSimulatorUrl: string;
  readonly #timeoutMs: number | undefined;

  constructor(options: FetchBirdClientOptions) {
    this.#dbEnvironmentUrl = options.dbEnvironmentUrl;
    this.#userSimulatorUrl = options.userSimulatorUrl;
    this.#timeoutMs = options.timeoutMs;
  }

  async execute(taskId: string, sql: string): Promise<ExecuteSqlResponse> {
    return this.#post(
      endpoint(this.#dbEnvironmentUrl, BIRD_HTTP_PATHS.db_environment.execute),
      { task_id: taskId, sql },
      executeResponseSchema,
      birdRequestTimeoutMs("execute", this.#timeoutMs),
    );
  }

  async getSchema(taskId: string): Promise<string> {
    const response = await this.#post(
      endpoint(this.#dbEnvironmentUrl, BIRD_HTTP_PATHS.db_environment.schema),
      { task_id: taskId },
      schemaResponseSchema,
      birdRequestTimeoutMs("schema", this.#timeoutMs),
    );
    return response.schema;
  }

  async getAllColumnMeanings(taskId: string): Promise<string> {
    const response = await this.#post(
      endpoint(
        this.#dbEnvironmentUrl,
        BIRD_HTTP_PATHS.db_environment.all_column_meanings,
      ),
      { task_id: taskId },
      allColumnMeaningsResponseSchema,
      birdRequestTimeoutMs("knowledge", this.#timeoutMs),
    );
    return response.column_meanings;
  }

  async getColumnMeaning(
    taskId: string,
    tableName: string,
    columnName: string,
  ): Promise<string> {
    const response = await this.#post(
      endpoint(this.#dbEnvironmentUrl, BIRD_HTTP_PATHS.db_environment.column_meaning),
      { task_id: taskId, table_name: tableName, column_name: columnName },
      columnMeaningResponseSchema,
      birdRequestTimeoutMs("knowledge", this.#timeoutMs),
    );
    return response.meaning;
  }

  async getAllKnowledgeNames(taskId: string): Promise<string[]> {
    const response = await this.#post(
      endpoint(this.#dbEnvironmentUrl, BIRD_HTTP_PATHS.db_environment.knowledge_names),
      { task_id: taskId },
      knowledgeNamesResponseSchema,
      birdRequestTimeoutMs("knowledge", this.#timeoutMs),
    );
    return response.names;
  }

  async getKnowledge(taskId: string, knowledgeName?: string): Promise<string> {
    const response = await this.#post(
      endpoint(this.#dbEnvironmentUrl, BIRD_HTTP_PATHS.db_environment.knowledge),
      knowledgeName === undefined
        ? { task_id: taskId }
        : { task_id: taskId, knowledge_name: knowledgeName },
      knowledgeResponseSchema,
      birdRequestTimeoutMs("knowledge", this.#timeoutMs),
    );
    return response.knowledge;
  }

  async askUser(taskId: string, question: string): Promise<string> {
    const response = await this.#post(
      endpoint(this.#userSimulatorUrl, BIRD_HTTP_PATHS.user_simulator.ask),
      { task_id: taskId, question },
      askResponseSchema,
      birdRequestTimeoutMs("ask", this.#timeoutMs),
    );
    return response.answer;
  }

  async phaseTransition(taskId: string): Promise<void> {
    await this.#post(
      endpoint(
        this.#userSimulatorUrl,
        BIRD_HTTP_PATHS.user_simulator.phase_transition,
      ),
      { task_id: taskId },
      phaseTransitionResponseSchema,
      birdRequestTimeoutMs("phase_transition", this.#timeoutMs),
    );
  }

  async submit(taskId: string, sql: string): Promise<SubmitSqlResponse> {
    const response = await this.#post(
      endpoint(this.#dbEnvironmentUrl, BIRD_HTTP_PATHS.db_environment.submit),
      { task_id: taskId, sql },
      submitResponseSchema,
      birdRequestTimeoutMs("submit", this.#timeoutMs),
    );
    return {
      passed: response.passed,
      message: response.message,
      ...(response.reward === undefined ? {} : { reward: response.reward }),
      ...(response.phase_completed === undefined
        ? {}
        : { phase_completed: response.phase_completed }),
      ...(response.has_follow_up === undefined
        ? {}
        : { has_follow_up: response.has_follow_up }),
      ...(response.follow_up_query === undefined
        ? {}
        : { follow_up_query: response.follow_up_query }),
    };
  }

  async #post<T>(
    url: string,
    body: unknown,
    responseSchema: z.ZodType<T>,
    timeoutMs: number,
  ): Promise<T> {
    const safeUrl = safeEndpoint(url);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new BirdClientError(`BIRD request to ${safeUrl} timed out`, { cause: error });
      }
      throw new BirdClientError(`BIRD request to ${safeUrl} failed`, { cause: error });
    }

    const text = await response.text();
    if (!response.ok) {
      throw new BirdClientError(
        `BIRD request to ${safeUrl} returned HTTP ${response.status}`,
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new BirdClientError(`BIRD request to ${safeUrl} returned invalid JSON`, {
        cause: error,
      });
    }

    const parsed = responseSchema.safeParse(value);
    if (!parsed.success) {
      throw new BirdClientError(`BIRD request to ${safeUrl} returned an invalid response`);
    }
    return parsed.data;
  }
}
