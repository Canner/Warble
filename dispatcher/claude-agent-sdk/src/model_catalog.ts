import { query, type ModelInfo, type Query } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "node:path";

/** The deliberately small host-facing contract for provider-owned model discovery. */
export const MODEL_CATALOG_VERSION = 1 as const;

export interface ModelCatalogModel {
  model: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  reasoningEfforts?: Array<{ value: string; displayName: string; description?: string }>;
}

export type ModelCatalogUnavailableCode =
  | "not_authenticated"
  | "runtime_unavailable"
  | "timeout"
  | "protocol_error";

export type ModelCatalogResult =
  | {
      version: typeof MODEL_CATALOG_VERSION;
      status: "ready";
      provider: "claude";
      models: ModelCatalogModel[];
    }
  | {
      version: typeof MODEL_CATALOG_VERSION;
      status: "unavailable";
      provider: "claude";
      code: ModelCatalogUnavailableCode;
      retryable: boolean;
    };

type QueryFactory = (params: {
  prompt: AsyncIterable<unknown>;
  options: {
    cwd: string;
    tools: string[];
    mcpServers: [];
    settingSources: [];
    abortController: AbortController;
  };
}) => Query;

// Cleanup must never turn a bounded catalog request back into an unbounded CLI operation. This is
// intentionally short and only gives the SDK a chance to release its child process/iterator.
const CLEANUP_GRACE_MS = 25;

export interface DiscoverClaudeModelsOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Test seam; production always uses the installed Agent SDK query factory. */
  queryFactory?: QueryFactory;
}

function unavailable(code: ModelCatalogUnavailableCode, retryable: boolean): ModelCatalogResult {
  return { version: MODEL_CATALOG_VERSION, status: "unavailable", provider: "claude", code, retryable };
}

function classify(error: unknown): ModelCatalogResult {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timed out")) return unavailable("timeout", true);
  if (/(not authenticated|unauthenticated|authentication|login required|sign in)/.test(message)) {
    return unavailable("not_authenticated", false);
  }
  if (/(enoent|failed to start|not found|runtime unavailable)/.test(message)) {
    return unavailable("runtime_unavailable", true);
  }
  // Do not reflect provider exceptions: they can contain raw response data or credentials.
  return unavailable("protocol_error", false);
}

async function* idleInput(): AsyncGenerator<never, void> {
  // `supportedModels()` needs a Query instance, but discovery must never create a user turn.
  // Keeping this async iterable empty is stronger than supplying a synthetic/empty user message.
}

function mapModel(model: ModelInfo): ModelCatalogModel {
  if (typeof model.value !== "string" || typeof model.displayName !== "string") {
    throw new Error("malformed model catalog response");
  }
  return {
    model: model.value,
    displayName: model.displayName,
    ...(typeof model.description === "string" && model.description.length > 0
      ? { description: model.description }
      : {}),
  };
}

async function withinTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  abortController: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          abortController.abort();
          reject(new Error("model catalog timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settleCleanup(operation: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLEANUP_GRACE_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Ask the authenticated Agent SDK for its model picker data without yielding a user message.
 * The Query object still owns a subprocess/session, so every exit path interrupts, aborts, and
 * returns its iterator before exposing the narrow catalog result.
 */
export async function discoverClaudeModels(
  options: DiscoverClaudeModelsOptions = {},
): Promise<ModelCatalogResult> {
  const abortController = new AbortController();
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return unavailable("protocol_error", false);

  let catalogQuery: Query | undefined;
  try {
    const queryFactory = options.queryFactory ?? (query as unknown as QueryFactory);
    catalogQuery = queryFactory({
      prompt: idleInput(),
      options: {
        cwd: resolve(options.cwd ?? process.cwd()),
        tools: [],
        mcpServers: [],
        settingSources: [],
        abortController,
      },
    });
    const models = await withinTimeout(catalogQuery.supportedModels(), timeoutMs, abortController);
    if (!Array.isArray(models)) throw new Error("malformed model catalog response");
    return {
      version: MODEL_CATALOG_VERSION,
      status: "ready",
      provider: "claude",
      models: models.map(mapModel),
    };
  } catch (error) {
    return classify(error);
  } finally {
    // Cleanup is deliberately unconditional: supportedModels can fail before, during, or after
    // transport startup. Never leave an idle query/session behind.
    abortController.abort();
    if (catalogQuery !== undefined) {
      // Start both cleanup operations even if either SDK promise stalls. The bounded races retain
      // best-effort cleanup without allowing a hung interrupt/return to delay the JSON result.
      await Promise.all([
        settleCleanup(catalogQuery.interrupt()),
        settleCleanup(catalogQuery.return()),
      ]);
    }
  }
}
