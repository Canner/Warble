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
