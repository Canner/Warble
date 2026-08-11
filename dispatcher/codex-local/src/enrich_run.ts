import { CodexDispatchError } from "./error.js";
import type { PreparedEnrichComponent } from "./enrich_prepare.js";
import { CodexSessionRuntime } from "./session.js";
import type { CodexSessionEvent, SessionIsolationOptions } from "./session_types.js";

interface JsonRecord {
  [key: string]: unknown;
}

export interface EnrichRunResult {
  target: "codex:local";
  component: string;
  finalText: string;
  value: unknown;
  events: CodexSessionEvent[];
}

function terminalValue(text: string, produces: string | null): unknown {
  if (produces === null) throw new CodexDispatchError("enrichment step has no produced slot");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CodexDispatchError("enrichment terminal is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CodexDispatchError("enrichment terminal must be a JSON object");
  }
  const record = parsed as JsonRecord;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== produces || record[produces] === null) {
    throw new CodexDispatchError(
      `enrichment terminal requires exactly the produced field '${produces}'`,
    );
  }
  return record;
}

/**
 * Execute one read-only enrichment component through the persistent Codex app-server transport.
 * The Codex thread is created before the model turn begins; this preserves durable session history
 * before any metered work can occur, while the host remains owner of enrichment run bookkeeping.
 */
export async function runEnrich(
  prepared: PreparedEnrichComponent,
  request: string,
  options: SessionIsolationOptions,
): Promise<EnrichRunResult> {
  if (request.trim().length === 0) throw new CodexDispatchError("enrichment request must not be empty");
  const events: CodexSessionEvent[] = [];
  let finalText: string | null = null;
  const onEvent = (event: CodexSessionEvent): void => {
    events.push(event);
    if (event.t === "answer") finalText = event.text;
    options.onEvent?.(event);
  };
  const runtime = await CodexSessionRuntime.connect(prepared, { ...options, onEvent });
  try {
    const session = await runtime.start();
    const turn = await runtime.turn(session, request);
    const completed = await runtime.waitForTurn(turn, options.timeoutMs ?? 120_000);
    if (completed.status !== "completed" || finalText === null) {
      throw new CodexDispatchError("enrichment turn did not complete with a terminal answer");
    }
    return {
      target: prepared.target,
      component: prepared.componentId,
      finalText,
      value: terminalValue(finalText, prepared.step.produces),
      events,
    };
  } finally {
    await runtime.close();
  }
}
