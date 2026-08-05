import { resolve } from "node:path";

import { CodexAppServerTransport, type CatalogTransportOptions } from "./app_server_transport.js";

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
      provider: "codex";
      models: ModelCatalogModel[];
    }
  | {
      version: typeof MODEL_CATALOG_VERSION;
      status: "unavailable";
      provider: "codex";
      code: ModelCatalogUnavailableCode;
      retryable: boolean;
    };

export interface DiscoverCodexModelsOptions {
  cwd?: string;
  codexHome?: string;
  codexBin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface JsonRecord {
  [key: string]: unknown;
}

const PAGE_LIMIT = 100;
const MAX_PAGES = 100;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(code: ModelCatalogUnavailableCode, retryable: boolean): ModelCatalogResult {
  return { version: MODEL_CATALOG_VERSION, status: "unavailable", provider: "codex", code, retryable };
}

function classify(error: unknown): ModelCatalogResult {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timed out")) return unavailable("timeout", true);
  if (/(not authenticated|unauthenticated|authentication|login required|sign in)/.test(message)) {
    return unavailable("not_authenticated", false);
  }
  if (/(enoent|failed to start|not found|transport is not available|disconnected)/.test(message)) {
    return unavailable("runtime_unavailable", true);
  }
  // Never reflect raw JSON-RPC/provider errors: their payload is outside the public contract.
  return unavailable("protocol_error", false);
}

function text(record: JsonRecord, field: string, required = false): string | undefined {
  const value = record[field];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new Error("malformed model catalog response");
  return value;
}

function mapModel(raw: unknown): ModelCatalogModel | null {
  if (!isRecord(raw)) throw new Error("malformed model catalog response");
  // Defense in depth: the request has includeHidden=false and an unexpected hidden model still
  // never reaches a host picker.
  if (raw["hidden"] === true) return null;
  const model = text(raw, "model", true)!;
  const displayName = text(raw, "displayName", true)!;
  const description = text(raw, "description");
  const isDefault = raw["isDefault"];
  if (isDefault !== undefined && typeof isDefault !== "boolean") {
    throw new Error("malformed model catalog response");
  }
  const effortsRaw = raw["supportedReasoningEfforts"];
  let reasoningEfforts: ModelCatalogModel["reasoningEfforts"];
  if (effortsRaw !== undefined) {
    if (!Array.isArray(effortsRaw)) throw new Error("malformed model catalog response");
    reasoningEfforts = effortsRaw.map((effort) => {
      if (!isRecord(effort)) throw new Error("malformed model catalog response");
      const value = text(effort, "reasoningEffort", true)!;
      const effortDescription = text(effort, "description");
      return {
        value,
        // The app-server protocol exposes an effort value, not a separate label.
        displayName: value,
        ...(effortDescription === undefined ? {} : { description: effortDescription }),
      };
    });
  }
  return {
    model,
    displayName,
    ...(description === undefined ? {} : { description }),
    ...(isDefault === undefined ? {} : { isDefault }),
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
  };
}

function pageResponse(value: unknown): { data: unknown[]; nextCursor: string | null } {
  if (!isRecord(value) || !Array.isArray(value["data"])) {
    throw new Error("malformed model catalog response");
  }
  const nextCursor = value["nextCursor"];
  if (nextCursor !== null && nextCursor !== undefined && typeof nextCursor !== "string") {
    throw new Error("malformed model catalog response");
  }
  return { data: value["data"], nextCursor: (nextCursor ?? null) as string | null };
}

/**
 * List authenticated Codex models over app-server without creating a thread or a turn.
 * Only explicitly mapped model-picker fields ever leave this module.
 */
export async function discoverCodexModels(
  options: DiscoverCodexModelsOptions = {},
): Promise<ModelCatalogResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return unavailable("protocol_error", false);
  let transport: CodexAppServerTransport | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const transportOptions: CatalogTransportOptions = {
      cwd: resolve(options.cwd ?? process.cwd()),
      timeoutMs,
      ...(options.codexHome ? { codexHome: resolve(options.codexHome) } : {}),
      ...(options.codexBin ? { codexBin: resolve(options.codexBin) } : {}),
      ...(options.env ? { env: options.env } : {}),
    };
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        void transport?.close();
        reject(new Error("model catalog timed out"));
      }, timeoutMs);
    });
    const list = (async (): Promise<ModelCatalogResult> => {
      transport = await CodexAppServerTransport.startCatalog(transportOptions);
      const models: ModelCatalogModel[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = pageResponse(await transport.request("model/list", {
          cursor,
          limit: PAGE_LIMIT,
          includeHidden: false,
        }));
        for (const raw of response.data) {
          const model = mapModel(raw);
          if (model !== null) models.push(model);
        }
        if (response.nextCursor === null) {
          return { version: MODEL_CATALOG_VERSION, status: "ready", provider: "codex", models };
        }
        cursor = response.nextCursor;
      }
      throw new Error("model catalog pagination limit exceeded");
    })();
    return await Promise.race([list, deadline]);
  } catch (error) {
    return classify(error);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await transport?.close();
  }
}
