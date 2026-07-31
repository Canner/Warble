export class CodexDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexDispatchError";
  }
}
