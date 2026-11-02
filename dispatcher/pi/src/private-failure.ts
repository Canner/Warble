/** Bounded operator diagnostics. Never include provider text, SQL or credentials. */
export const FAILURE_CODES = ["deadline", "cancelled", "output_limit", "tool_failure", "protocol",
  "provider_http", "provider_stream", "child_exit", "model_error", "model_length", "invalid_json", "empty_output", "turn_limit",
  "destination_denied", "request_limit", "response_limit", "missing_response", "incomplete_child"] as const;
export type FailureCode = typeof FAILURE_CODES[number];
export class PrivateFailure extends Error {
  /** Per-model-call usage gathered before the failure; never carries content. */
  constructor(readonly code: FailureCode, readonly calls?: readonly unknown[]) { super("private_unavailable"); }
}
export function failureCode(value: unknown): FailureCode {
  return typeof value === "string" && (FAILURE_CODES as readonly string[]).includes(value)
    ? value as FailureCode : "child_exit";
}
