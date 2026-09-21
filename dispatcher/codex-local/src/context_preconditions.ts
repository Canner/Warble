import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { CodexDispatchError } from "./error.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

/** The input snapshot is also the component's prompt context. No IR pass flag is trusted. */
export function verifyContextPreconditions(context: string, preconditions: unknown[], warbleBin: string): string {
  const fail = (): never => { throw new CodexDispatchError("unsupported_callee: context preconditions require verified prepared context"); };
  try {
    if (Buffer.byteLength(context, "utf8") > MAX_REQUEST_BYTES) fail();
    const snapshot: unknown = JSON.parse(context);
    const request = JSON.stringify({version: 1, context: snapshot, preconditions});
    if (Buffer.byteLength(request, "utf8") > MAX_REQUEST_BYTES) fail();
    const output = execFileSync(warbleBin, ["check-context"], {
      input: request, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 65_536,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const result: unknown = JSON.parse(output);
    if (typeof result !== "object" || result === null || Array.isArray(result)) fail();
    const record = result as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "request_sha256,status,version" ||
        record.version !== 1 || record.status !== "pass" ||
        record.request_sha256 !== createHash("sha256").update(request).digest("hex")) fail();
    // Prompt the same normalized snapshot that the evaluator saw, never a duplicate-key or
    // differently serialized source document that could describe contradictory facts.
    return JSON.stringify(snapshot);
  } catch { return fail(); }
}
