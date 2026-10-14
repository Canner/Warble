/**
 * Dispatch-time error — the TS analogue of the Rust back-end's `DispatchError`.
 *
 * Every loud-fail in this back-end (unknown IR version, unsupported enum "wall-hit", capability
 * `fail`, undefined tier) throws a `DispatchError`; the CLI turns it into a non-zero exit + message.
 */
export class DispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchError";
  }
}

/** A dispatcher-safe, single-line failure reason: paths and SQL-bearing text are redacted and the length is capped. */
export function boundedMessage(message: string): string {
  const collapsed = message.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const withoutPaths = collapsed.replace(/(?:^|\s)\/(?:[^\s/]+\/)*[^\s]*/g, " [redacted path]");
  const safe = /\b(select|insert|update|delete|merge|alter|drop|create)\b/i.test(withoutPaths)
    ? "The callee did not complete the request."
    : withoutPaths;
  return (safe || "The child run did not complete.").slice(0, 240);
}
