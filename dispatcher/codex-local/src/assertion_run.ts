import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { buildNoMcpCodexArgs, sanitizeCodexEnvironment } from "./config.js";
import { CodexDispatchError } from "./error.js";
import { CodexJsonlMapper } from "./events.js";
import type { PreparedAssertionComponent } from "./assertion_prepare.js";

export interface AssertionInvocation {
  activation: {
    /** Caller attestation boundary, not a cryptographic statement about evidence.source. */
    authority: "external";
    kind: "scheduled" | "manual";
    occurrence_id: string;
    occurred_at: string;
  };
  evidence: {
    source: "wren";
    operation: "read_only_sql";
    success: true;
    read_only: true;
    model: string;
    timestamp_column: string;
    observed_at: string;
    latest_timestamp: string;
  };
}

export interface FreshnessVerdict {
  type: string;
  fresh: boolean;
  observed_at: string;
  latest_timestamp: string;
  observed_lag_ms: number;
  expected_cadence_ms: number;
  status: { state: "fresh" | "stale"; severity?: "warn" | "critical"; rationale?: string };
}

export type AssertionEvent =
  | { t: "assertion_start"; component: string; occurrence_id: string }
  | { t: "freshness_reading"; component: string; stale: boolean; observed_lag_ms: number }
  | { t: "severity_start"; component: string; step: string }
  | { t: "severity_finish"; component: string; step: string; severity: "warn" | "critical" }
  | { t: "assertion_result"; component: string; verdict: FreshnessVerdict; emitted: string[] };

export interface AssertionRunOptions {
  cwd: string;
  codexBin?: string;
  codexArgsPrefix?: string[];
  timeoutMs?: number;
  terminationGraceMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: AssertionEvent) => void;
}

export interface AssertionRunResult {
  target: "codex:local";
  component: string;
  verdict: FreshnessVerdict;
  emitted: string[];
  /** This is always false for a fresh reading; no session/thread exists in either branch. */
  codexLaunched: boolean;
  events: AssertionEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new CodexDispatchError(`${field} must be a nonempty string no longer than ${maxLength} characters`);
  }
  return value;
}

function requiredIsoTimestamp(value: unknown, field: string): { text: string; ms: number } {
  const text = requiredString(value, field, 64);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new CodexDispatchError(`${field} must be an ISO-8601 timestamp`);
  return { text, ms };
}

/**
 * Validates a caller-supplied occurrence.  The caller is trusted to have performed the Wren
 * operation: an ordinary JSON `source: "wren"` field is only a typed claim, not provenance.
 * Deployments needing independent attestation must validate/sign this envelope before invoking
 * Warble.  Warble deliberately owns neither scheduler state nor Wren credentials.
 */
export function parseAssertionInvocation(
  prepared: PreparedAssertionComponent,
  value: unknown,
): { invocation: AssertionInvocation; observedAtMs: number; latestTimestampMs: number; cadenceMs: number } {
  if (!isRecord(value) || !isRecord(value["activation"]) || !isRecord(value["evidence"])) {
    throw new CodexDispatchError("assertion invocation requires activation and evidence objects");
  }
  const activation = value["activation"];
  const evidence = value["evidence"];
  if (activation["authority"] !== "external") {
    throw new CodexDispatchError("assertion activation must be authorized by an external caller");
  }
  if (activation["kind"] !== "scheduled" && activation["kind"] !== "manual") {
    throw new CodexDispatchError("assertion activation kind must be scheduled or manual");
  }
  const occurrenceId = requiredString(activation["occurrence_id"], "activation.occurrence_id", 128);
  const occurredAt = requiredIsoTimestamp(activation["occurred_at"], "activation.occurred_at");
  if (
    evidence["source"] !== "wren" ||
    evidence["operation"] !== "read_only_sql" ||
    evidence["success"] !== true ||
    evidence["read_only"] !== true
  ) {
    throw new CodexDispatchError(
      "assertion evidence must attest a successful read-only Wren read_only_sql operation",
    );
  }
  const model = requiredString(evidence["model"], "evidence.model");
  const timestampColumn = requiredString(evidence["timestamp_column"], "evidence.timestamp_column");
  const observedAt = requiredIsoTimestamp(evidence["observed_at"], "evidence.observed_at");
  const latestTimestamp = requiredIsoTimestamp(evidence["latest_timestamp"], "evidence.latest_timestamp");
  if (latestTimestamp.ms > observedAt.ms || occurredAt.ms > observedAt.ms + 5 * 60_000) {
    throw new CodexDispatchError("assertion evidence timestamps are out of order");
  }
  if (value["bindings"] !== undefined) {
    throw new CodexDispatchError(
      "assertion invocation must not override pinned profile bindings; use the compiled IR binds",
    );
  }
  if (model !== prepared.pinnedModel) {
    throw new CodexDispatchError(
      `assertion evidence.model must match pinned bind '${prepared.modelBinding}'`,
    );
  }
  return {
    invocation: {
      activation: {
        authority: "external",
        kind: activation["kind"],
        occurrence_id: occurrenceId,
        occurred_at: occurredAt.text,
      },
      evidence: {
        source: "wren",
        operation: "read_only_sql",
        success: true,
        read_only: true,
        model,
        timestamp_column: timestampColumn,
        observed_at: observedAt.text,
        latest_timestamp: latestTimestamp.text,
      },
    },
    observedAtMs: observedAt.ms,
    latestTimestampMs: latestTimestamp.ms,
    cadenceMs: prepared.pinnedCadenceMs,
  };
}

function parseSeverityTerminal(text: string, produces: string): { severity: "warn" | "critical"; rationale: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CodexDispatchError("assertion severity terminal is not JSON");
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !isRecord(parsed[produces])) {
    throw new CodexDispatchError(`assertion severity terminal requires exactly the '${produces}' object`);
  }
  const verdict = parsed[produces];
  if (
    Object.keys(verdict).length !== 2 ||
    (verdict["severity"] !== "warn" && verdict["severity"] !== "critical") ||
    typeof verdict["rationale"] !== "string" ||
    verdict["rationale"].trim().length === 0 ||
    verdict["rationale"].length > 500
  ) {
    throw new CodexDispatchError("assertion severity must be warn|critical with a bounded nonempty rationale");
  }
  return { severity: verdict["severity"], rationale: verdict["rationale"] };
}

function buildSeverityPrompt(
  prepared: PreparedAssertionComponent,
  invocation: AssertionInvocation,
  lagMs: number,
  cadenceMs: number,
): string {
  return [
    `You are executing Warble target ${prepared.target}.`,
    `Run exactly one profile step: ${prepared.componentId}.${prepared.step.name}.`,
    "The host has already validated trusted caller-supplied read-only Wren evidence and determined this reading is stale.",
    "Do not use tools, shell, files, web, browser, apps, plugins, skills, or delegation.",
    `The final answer must be exactly one JSON object with field '${prepared.step.produces}'.`,
    "Its value must be exactly {\"severity\": \"warn\" | \"critical\", \"rationale\": string}; rationale must be concise and evidence-grounded.",
    "Do not wrap JSON in Markdown or include prose.",
    "",
    "Validated freshness reading (JSON):",
    JSON.stringify({ evidence: invocation.evidence, observed_lag_ms: lagMs, expected_cadence_ms: cadenceMs }),
    "",
    "Step contract:",
    prepared.step.prompt,
  ].join("\n");
}

async function runSeverity(
  prepared: PreparedAssertionComponent,
  invocation: AssertionInvocation,
  lagMs: number,
  cadenceMs: number,
  options: AssertionRunOptions,
): Promise<{ severity: "warn" | "critical"; rationale: string }> {
  const mapper = new CodexJsonlMapper(prepared.step.name, null, [], false);
  const args = buildNoMcpCodexArgs(prepared.step.model, {
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
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", (error) => reject(new CodexDispatchError(`failed to start codex: ${error.message}`)));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stderr.resume();
  let terminalError: Error | null = null;
  let terminationRequested = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
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
    killTimer = setTimeout(() => signalProcessTree("SIGKILL"), options.terminationGraceMs ?? 1_000);
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line.trim().length === 0 || terminalError) return;
    try {
      mapper.nextLine(line);
    } catch (error) {
      terminalError = error instanceof Error ? error : new Error(String(error));
      terminateProcessTree();
    }
  });
  child.stdin.end(buildSeverityPrompt(prepared, invocation, lagMs, cadenceMs));
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
    throw new CodexDispatchError(`codex assertion dispatch ${options.signal?.aborted ? "cancelled" : `timed out after ${timeoutMs}ms`}`);
  }
  if (exit.code !== 0) throw new CodexDispatchError(`codex exited with ${exit.code ?? exit.signal ?? "unknown"}`);
  return parseSeverityTerminal(mapper.result().finalText, prepared.step.produces);
}

export async function runAssertion(
  prepared: PreparedAssertionComponent,
  input: unknown,
  options: AssertionRunOptions,
): Promise<AssertionRunResult> {
  if (options.signal?.aborted) throw new CodexDispatchError("codex assertion dispatch cancelled before start");
  const parsed = parseAssertionInvocation(prepared, input);
  const lagMs = parsed.observedAtMs - parsed.latestTimestampMs;
  const stale = lagMs > parsed.cadenceMs;
  const events: AssertionEvent[] = [];
  const emit = (event: AssertionEvent) => {
    events.push(event);
    options.onEvent?.(event);
  };
  emit({ t: "assertion_start", component: prepared.componentId, occurrence_id: parsed.invocation.activation.occurrence_id });
  emit({ t: "freshness_reading", component: prepared.componentId, stale, observed_lag_ms: lagMs });
  let status: FreshnessVerdict["status"] = { state: stale ? "stale" : "fresh" };
  if (stale) {
    emit({ t: "severity_start", component: prepared.componentId, step: prepared.step.name });
    const severity = await runSeverity(prepared, parsed.invocation, lagMs, parsed.cadenceMs, options);
    status = { state: "stale", ...severity };
    emit({ t: "severity_finish", component: prepared.componentId, step: prepared.step.name, severity: severity.severity });
  }
  const verdict: FreshnessVerdict = {
    type: prepared.verdictType,
    fresh: !stale,
    observed_at: parsed.invocation.evidence.observed_at,
    latest_timestamp: parsed.invocation.evidence.latest_timestamp,
    observed_lag_ms: lagMs,
    expected_cadence_ms: parsed.cadenceMs,
    status,
  };
  const emitted = stale ? [...prepared.emittedSignals] : [];
  emit({ t: "assertion_result", component: prepared.componentId, verdict, emitted });
  return {
    target: prepared.target,
    component: prepared.componentId,
    verdict,
    emitted,
    codexLaunched: stale,
    events,
  };
}
