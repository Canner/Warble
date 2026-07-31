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
  terminationGraceMs?: number;
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
  if (options.signal?.aborted) {
    throw new CodexDispatchError("codex dispatch cancelled before start");
  }
  const mapper = new CodexJsonlMapper(
    prepared.step.name,
    prepared.mcp.name,
    prepared.enabledTools,
  );
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
      detached: process.platform !== "win32",
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
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", (error) =>
        reject(new CodexDispatchError(`failed to start codex: ${error.message}`)),
      );
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  childStderr.resume();

  let terminalError: Error | null = null;
  let terminationRequested = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminationGraceMs = options.terminationGraceMs ?? 1_000;
  const signalProcessTree = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      }
    }
    child.kill(signal);
  };
  const terminateProcessTree = () => {
    if (terminationRequested) return;
    terminationRequested = true;
    signalProcessTree("SIGTERM");
    killTimer = setTimeout(() => signalProcessTree("SIGKILL"), terminationGraceMs);
  };
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
      terminateProcessTree();
    }
  });

  const prompt = buildPrompt(prepared, options.request);
  childStdin.end(prompt);

  let aborted = false;
  const abort = () => {
    aborted = true;
    terminateProcessTree();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeoutMs = options.timeoutMs ?? 120_000;
  const timer = setTimeout(abort, timeoutMs);

  const exit = await exitPromise.finally(() => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    lines.close();
    if (terminationRequested) signalProcessTree("SIGKILL");
    if (killTimer !== undefined) clearTimeout(killTimer);
  });

  if (terminalError) throw terminalError;
  if (aborted) {
    const reason = options.signal?.aborted ? "cancelled" : `timed out after ${timeoutMs}ms`;
    throw new CodexDispatchError(`codex dispatch ${reason}`);
  }
  if (exit.code !== 0) {
    throw new CodexDispatchError(
      `codex exited with ${exit.code ?? exit.signal ?? "unknown"}`,
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
