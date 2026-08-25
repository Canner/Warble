import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { buildCodexArgs, buildPrompt, sanitizeCodexEnvironment } from "./config.js";
import { CodexDispatchError } from "./error.js";
import { CodexJsonlMapper, type WarbleCodexEvent } from "./events.js";
import type { PreparedSetupComponent, PreparedSetupStep } from "./prepare.js";
import { parseStepTerminal, shouldRunStep, type StepOutcome } from "./step_engine.js";

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

/** One step's dispatch-time evidence: whether it ran (an on_failure guard may skip it) and, if
 * it ran, whether its terminal matched its declared `produces` slot. */
export interface SetupStepRunOutcome {
  name: string;
  ran: boolean;
  ok: boolean;
  value?: unknown;
}

export interface RunResult {
  target: "codex:local";
  component: string;
  /** The last step that actually ran's raw terminal text — unchanged for every existing
   * single-step component, since there the last step run is the only step run. */
  finalText: string;
  events: WarbleCodexEvent[];
  steps: SetupStepRunOutcome[];
}

/** Spawns exactly one Codex process for exactly one step, mirroring the transport's original
 * one-shot design per step rather than per dispatch — Setup has no persistent session to reuse
 * across steps, so each step gets its own child process. */
async function runOneStep(
  prepared: PreparedSetupComponent,
  step: PreparedSetupStep,
  inputs: Record<string, unknown>,
  options: RunOptions,
  events: WarbleCodexEvent[],
): Promise<string> {
  const mapper = new CodexJsonlMapper(step.name, prepared.mcp.name, prepared.enabledTools);
  const args = buildCodexArgs(prepared, step, {
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

  const prompt = buildPrompt(prepared, step, options.request, inputs, { producedValue: "string" });
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
  return mapper.result().finalText;
}

export async function runSetup(
  prepared: PreparedSetupComponent,
  options: RunOptions,
): Promise<RunResult> {
  if (options.signal?.aborted) {
    throw new CodexDispatchError("codex dispatch cancelled before start");
  }
  const events: WarbleCodexEvent[] = [];
  const slots: Record<string, unknown> = {};
  const outcomes = new Map<string, StepOutcome>();
  const steps: SetupStepRunOutcome[] = [];
  let lastFinalText: string | null = null;

  for (const step of prepared.steps) {
    if (!shouldRunStep(step.when, outcomes)) {
      outcomes.set(step.name, { ran: false });
      steps.push({ name: step.name, ran: false, ok: false });
      continue;
    }
    const inputs = Object.fromEntries(step.consumes.map((name) => [name, slots[name]]));
    const finalText = await runOneStep(prepared, step, inputs, options, events);
    // Whether a step's produces-mismatch is fatal or recoverable depends on whether any later
    // step in this component actually guards on it — the accept-set-equals-execute-set invariant
    // applied the other way round: a step that no on_failure guard ever names must fail the whole
    // dispatch exactly as it always has, since nothing downstream is prepared to observe it fail.
    const hasGuardedConsumer = prepared.steps.some((candidate) => candidate.when?.target === step.name);
    let record: Record<string, unknown>;
    try {
      record = parseStepTerminal(finalText, step.produces);
    } catch (error) {
      if (hasGuardedConsumer && error instanceof CodexDispatchError) {
        outcomes.set(step.name, { ran: true, ok: false });
        steps.push({ name: step.name, ran: true, ok: false });
        lastFinalText = finalText;
        continue;
      }
      throw error;
    }
    const value = record[step.produces];
    slots[step.produces] = value;
    outcomes.set(step.name, { ran: true, ok: true, value });
    steps.push({ name: step.name, ran: true, ok: true, value });
    lastFinalText = finalText;
  }

  if (lastFinalText === null) {
    // Unreachable for any component `validateStepTopology` accepts: the only conditional step
    // allowed is the last one, and it must target a strictly earlier step, so a component can
    // only be conditional-only when it has zero steps, which prepare already rejects. Kept as a
    // defensive backstop, not a reachable branch.
    throw new CodexDispatchError("codex dispatch completed without running any step");
  }
  return {
    target: prepared.target,
    component: prepared.componentId,
    finalText: lastFinalText,
    events,
    steps,
  };
}
