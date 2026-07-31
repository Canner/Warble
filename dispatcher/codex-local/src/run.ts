import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { buildCodexArgs, buildPrompt, sanitizeCodexEnvironment } from "./config.js";
import { CodexDispatchError } from "./error.js";
import { CodexJsonlMapper, type WarbleCodexEvent } from "./events.js";
import type { PreparedSetupComponent } from "./prepare.js";

export interface RunOptions {
  cwd: string;
  request: string;
  codexBin?: string;
  codexArgsPrefix?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: WarbleCodexEvent) => void;
}

export interface RunResult {
  target: "codex:local";
  component: string;
  finalText: string;
  events: WarbleCodexEvent[];
}

export async function runSetup(
  prepared: PreparedSetupComponent,
  options: RunOptions,
): Promise<RunResult> {
  const mapper = new CodexJsonlMapper(prepared.step.name);
  const events: WarbleCodexEvent[] = [];
  const args = buildCodexArgs(prepared, {
    cwd: options.cwd,
    ...(options.codexArgsPrefix ? { codexArgsPrefix: options.codexArgsPrefix } : {}),
  });
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(options.codexBin ?? "codex", args, {
      cwd: options.cwd,
      env: sanitizeCodexEnvironment(options.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new CodexDispatchError(`failed to start codex: ${String(error)}`);
  }
  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    child.kill("SIGTERM");
    throw new CodexDispatchError("failed to start codex with piped stdio");
  }
  const childStdin = child.stdin;
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  let stderr = "";
  childStderr.setEncoding("utf8");
  childStderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
  });

  let terminalError: Error | null = null;
  const lines = createInterface({ input: childStdout });
  lines.on("line", (line) => {
    if (line.trim().length === 0 || terminalError) return;
    try {
      for (const event of mapper.nextLine(line)) {
        events.push(event);
        options.onEvent?.(event);
      }
    } catch (error) {
      terminalError = error instanceof Error ? error : new Error(String(error));
      child.kill("SIGTERM");
    }
  });

  const prompt = buildPrompt(prepared, options.request);
  childStdin.end(prompt);

  let aborted = false;
  const abort = () => {
    aborted = true;
    child.kill("SIGTERM");
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeoutMs = options.timeoutMs ?? 120_000;
  const timer = setTimeout(abort, timeoutMs);

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", (error) =>
        reject(new CodexDispatchError(`failed to start codex: ${error.message}`)),
      );
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  ).finally(() => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    lines.close();
  });

  if (terminalError) throw terminalError;
  if (aborted) {
    const reason = options.signal?.aborted ? "cancelled" : `timed out after ${timeoutMs}ms`;
    throw new CodexDispatchError(`codex dispatch ${reason}`);
  }
  if (exit.code !== 0) {
    const detail = stderr.trim();
    throw new CodexDispatchError(
      `codex exited with ${exit.code ?? exit.signal ?? "unknown"}${detail ? `: ${detail}` : ""}`,
    );
  }
  const result = mapper.result();
  return {
    target: prepared.target,
    component: prepared.componentId,
    finalText: result.finalText,
    events,
  };
}
