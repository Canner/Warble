/** Shared usage error for every Warble BIRD-Interact command-line entry point. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}
