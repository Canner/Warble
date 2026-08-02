import type { WarbleCodexEvent } from "./events.js";

export const SESSION_REFERENCE_VERSION = "0.1" as const;

export interface CodexSessionReference {
  version: typeof SESSION_REFERENCE_VERSION;
  target: "codex:local";
  threadId: string;
  forkedFromThreadId: string | null;
}

export type SessionTurnStatus = "in_progress" | "completed" | "interrupted" | "failed";

export interface CodexTurnReference {
  threadId: string;
  turnId: string;
  status: SessionTurnStatus;
}

export interface CodexArtifactReference {
  version: typeof SESSION_REFERENCE_VERSION;
  kind: "mcp_tool_result";
  threadId: string;
  turnId: string;
  itemId: string;
  server: string;
  tool: string;
  ok: boolean;
}

export type CodexHistoryItem =
  | { type: "user" | "assistant"; itemId: string }
  | { type: "artifact"; reference: CodexArtifactReference };

export interface CodexHistoryTurn {
  id: string;
  status: SessionTurnStatus;
  items: CodexHistoryItem[];
}

export interface CodexSessionHistory {
  session: CodexSessionReference;
  turns: CodexHistoryTurn[];
}

export type CodexSessionEvent =
  | { t: "session_started" | "session_resumed" | "session_forked"; session: CodexSessionReference }
  | { t: "session_recoverable"; threadId: string | null; reason: "transport_disconnect" | "app_server_crash" | "turn_timeout" }
  | { t: "session_failed"; threadId: string | null; reason: "protocol_violation" }
  | { t: "turn_started"; turn: CodexTurnReference }
  | { t: "turn_completed"; turn: CodexTurnReference }
  | { t: "artifact"; reference: CodexArtifactReference }
  | ({ threadId: string; turnId: string } & WarbleCodexEvent);

export interface SessionIsolationOptions {
  codexHome: string;
  cwd: string;
  externalAuthentication: "provisioned";
  codexBin?: string;
  codexArgsPrefix?: string[];
  timeoutMs?: number;
  terminationGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: CodexSessionEvent) => void;
}
