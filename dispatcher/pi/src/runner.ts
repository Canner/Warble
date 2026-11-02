import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonBytes } from "./disclosure.js";
import { PrivateFailure, failureCode, type FailureCode } from "./private-failure.js";
import { record } from "./selection.js";

export interface PrivateModel { zone: "private"; id: string; baseUrl: string; apiKey: string; enableThinking?: boolean }
export interface PrivateTool {
  name: string; capability: string; action: string; zone: "private"; readOnly: true;
  description: string; parameters: Record<string, unknown>;
  validate(args: unknown): boolean;
  /** Hybrid invocation lifetime, including projection; aborts on completion or failure. */
  execute(args: unknown, signal: AbortSignal): Promise<unknown>;
}
export interface ChildInput {
  instructions: string; context: unknown[]; request: string; model: PrivateModel;
  tools: { name: string; description: string; parameters: Record<string, unknown> }[];
  maxTurns: number;
  maxRequestBytes: number;
  maxOutputBytes: number;
  /** Provider SSE wire bytes, separate from child protocol/result bytes. */
  maxResponseBytes?: number;
  /** Service-only final evidence object; permits one tool-free format correction. */
  evidenceOutput?: boolean;
}
export interface Limits {
  timeoutMs: number; maxRequestBytes: number; maxOutputBytes: number;
  maxToolCalls: number; maxTurns: number; maxAttempts: number;
}
export const DEFAULT_LIMITS: Limits = Object.freeze({ timeoutMs: 30000, maxRequestBytes: 65536,
  maxOutputBytes: 1048576, maxToolCalls: 16, maxTurns: 12, maxAttempts: 32 });

/** Package-owned entry only. No caller-selected executable, shell command, cwd or environment. */
export async function runPrivate(input: ChildInput, tools: readonly PrivateTool[], limits: Limits,
  signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (process.platform === "win32") throw new Error("unsupported_process_isolation");
  const bytes = jsonBytes(input, limits.maxRequestBytes);
  const dir = await mkdtemp(join(tmpdir(), "warble-private-"));
  try {
    signal.throwIfAborted();
    const child = spawn(process.execPath, [fileURLToPath(new URL("./child.js", import.meta.url))], {
      cwd: dir, detached: true, env: { HOME: dir, TMPDIR: dir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return await supervisePrivate(child, bytes, tools, limits, signal);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Internal protocol supervisor, separated for hostile process conformance tests. */
export function supervisePrivate(child: ChildProcessWithoutNullStreams, bytes: string, tools: readonly PrivateTool[], limits: Limits, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = "", outputBytes = 0, calls = 0, busy = false, result: unknown, hasResult = false;
    let failed = false, reason: FailureCode = "child_exit";
    const controller = new AbortController();
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } } };
    const fail = (error?: unknown) => { if (!failed) reason = error instanceof PrivateFailure ? error.code : "protocol"; failed = true; controller.abort(); kill(); };
    const aborted = () => fail(new PrivateFailure("cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    const timer = setTimeout(() => fail(new PrivateFailure("deadline")), limits.timeoutMs);
    const send = (value: unknown) => {
      if (failed || signal.aborted) return;
      child.stdin.write(jsonBytes(value, limits.maxOutputBytes) + "\n", error => { if (error) fail(); });
    };
    const consume = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > limits.maxOutputBytes) { fail(new PrivateFailure("output_limit")); return false; }
      return true;
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      if (!consume(Buffer.from(text)) || failed) return;
      buffer += text;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (hasResult || busy) throw new Error("event_order");
          if (record(event, ["type", "code"]) && event.type === "failure") {
            fail(new PrivateFailure(failureCode(event.code)));
          } else if (record(event, ["type", "value"]) && event.type === "result" && "value" in event) {
            result = event.value; hasResult = true;
          } else if (record(event, ["type", "id", "name", "args"]) && event.type === "tool_call"
            && event.id === calls + 1 && ++calls <= limits.maxToolCalls) {
            const tool = tools.find(t => t.name === event.name);
            if (!tool || !tool.validate(event.args)) throw new Error("tool_denied");
            busy = true;
            void Promise.resolve().then(() => {
              controller.signal.throwIfAborted();
              return tool.execute(event.args, controller.signal);
            }).then(value => {
              if (!failed && !signal.aborted) { busy = false; send({ type: "tool_result", id: event.id, value }); }
            }).catch(error => fail(error instanceof PrivateFailure ? error : new PrivateFailure("tool_failure")));
          } else throw new Error("malformed_event");
        } catch { fail(); break; }
      }
    });
    // Private stderr is never forwarded or persisted, but counts toward the byte budget.
    child.stderr.on("data", (chunk: Buffer) => { consume(chunk); });
    child.stdin.on("error", fail);
    child.on("error", fail);
    // Descendants may hold inherited pipes open after the leader exits. Kill the group on
    // exit, before waiting for close/drain, so they cannot extend the invocation deadline.
    child.on("exit", kill);
    child.on("close", code => {
      clearTimeout(timer); signal.removeEventListener("abort", aborted);
      controller.abort(); kill();
      const invalid = failed || signal.aborted || code !== 0 || !hasResult || busy || buffer.length;
      failed = true; // suppress all late tool completions, including after a clean exit
      if (invalid) reject(new PrivateFailure(reason));
      else resolve(result);
    });
    child.stdin.write(bytes + "\n", error => { if (error) fail(); });
  });
}
