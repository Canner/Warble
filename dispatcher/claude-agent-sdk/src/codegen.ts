/**
 * Codegen (`emit`) — freeze a prepared dispatch into an importable TS agent module.
 *
 * The IR→options mapping is resolved at emit time and the resulting `query({options})` is written as
 * source, plus a thin `run()` per component. Analogue of the file target emitting `.md` — here it is
 * `.ts` a user drops into their own codebase. Two modes:
 *   - **thin (default)** — imports the runtime helpers (guardrail / trace / render) from
 *     `@warble/claude-agent-sdk`; small and always in sync with the library.
 *   - **standalone** — inlines a minimal read-only guard + trace + render shell, so the only imports
 *     are `@anthropic-ai/claude-agent-sdk` and Node built-ins (the `warble` *binary* is still used
 *     for render — that is the renderer-reuse contract, not a TS dependency).
 */
import type { PreparedDispatch } from "./dispatch.js";
import type { DispatchMeta } from "./options.js";

export interface EmitOptions {
  standalone?: boolean;
}

/** Emitted per-component metadata (the subset the guard/trace/render need at runtime). */
interface EmittedMeta {
  target: string;
  verb: string;
  model: string;
  split: boolean;
  readOnly: boolean;
  render: DispatchMeta["render"];
}

function ident(verb: string): string {
  const base = verb.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[0-9]/.test(base) ? `_${base}` : base;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const RUN_RESULT_TYPE =
  "{ finalText: string; trace: Trace; htmlPath: string | null; denials: Denial[] }";

/** The shared body of a component's `run()` (identical in both modes; only imports differ). */
function runBody(fn: string): string {
  return `  const cwd = ${fn}_options.cwd ?? process.cwd();
  const gate = ${fn}_meta.render;
  const writeScope = gate.kind === "realize" && gate.flavor === "prompt" ? gate.scope : null;
  const { canUseTool, denials } = makeReadOnlyGuard({ readOnly: ${fn}_meta.readOnly, writeScope, cwd });

  const messages: SDKMessage[] = [];
  for await (const m of query({ prompt: question, options: { ...${fn}_options, canUseTool } })) {
    messages.push(m);
  }

  const result = messages.find((m): m is Extract<SDKMessage, { type: "result" }> => m.type === "result");
  if (!result || result.subtype !== "success") {
    throw new Error(\`agent run failed: \${result ? result.subtype : "no result message"}\`);
  }
  const finalText = result.result;
  const trace = aggregateTrace(
    messages,
    { target: ${fn}_meta.target, verb: ${fn}_meta.verb, model: ${fn}_meta.model, split: ${fn}_meta.split },
    denials,
  );

  let htmlPath: string | null = null;
  if (gate.kind === "realize" && gate.flavor === "programmatic" && opts.outDir) {
    htmlPath = join(opts.outDir, "dashboard.html");
    renderEnvelope(finalText, htmlPath, { warbleBin: opts.warbleBin ?? "warble", ...(opts.title ? { title: opts.title } : {}) });
  }
  return { finalText, trace, htmlPath, denials };`;
}

function componentBlock(fn: string, verb: string, options: unknown, meta: EmittedMeta): string {
  return `// ---- component: ${verb} ----
const ${fn}_options = ${json(options)} satisfies Options;
const ${fn}_meta: EmittedMeta = ${json(meta)};

/** Run the \`${verb}\` agent against the live Agent SDK loop. */
export async function ${fn}(question: string, opts: RunOptions = {}): Promise<RunResult> {
${runBody(fn)}
}`;
}

const THIN_IMPORTS = `import { join } from "node:path";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  makeReadOnlyGuard,
  aggregateTrace,
  renderEnvelope,
  type Trace,
  type Denial,
} from "@warble/claude-agent-sdk";`;

const STANDALONE_IMPORTS = `import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";`;

/** Inlined runtime helpers for the standalone (eject) mode — no `@warble/*` dependency. */
const STANDALONE_HELPERS = `interface Denial { tool: string; reason: string; command?: string }
interface Trace {
  target: string; verb: string; model: string; split: boolean;
  run: { total_cost_usd: number; duration_ms: number; duration_api_ms: number; num_turns: number } | null;
  modelUsage: Record<string, unknown>;
  steps: { model: string; parent_tool_use_id: string | null; usage: unknown }[];
  denials: Denial[];
}

const DESTRUCTIVE = /\\b(rm|sudo|dd|mkfs|shutdown|reboot|kill|chmod|chown|mv|cp)\\b/;
const REDIRECTION = /(^|[^>])>>?[^>]/;

function makeReadOnlyGuard(cfg: {
  readOnly: boolean;
  writeScope: string | null;
  cwd: string;
  mutation?: { mustDryRun: boolean; approvalRequired: boolean };
}) {
  const denials: Denial[] = [];
  const canUseTool = async (toolName: string, input: Record<string, unknown>) => {
    if (toolName === "Read" || toolName === "Task" || toolName === "TodoWrite") {
      return { behavior: "allow" as const, updatedInput: input };
    }
    if (toolName === "Bash") {
      const command = typeof input.command === "string" ? input.command : "";
      if (DESTRUCTIVE.test(command) || REDIRECTION.test(command)) {
        const reason = "destructive or file-writing bash is blocked by read_only_execution.";
        denials.push({ tool: "Bash", reason, command });
        return { behavior: "deny" as const, message: reason };
      }
      if (command.trim().split(/\\s+/)[0] !== "wren") {
        const reason = "only wren CLI invocations are permitted (read_only_execution).";
        denials.push({ tool: "Bash", reason, command });
        return { behavior: "deny" as const, message: reason };
      }
      return { behavior: "allow" as const, updatedInput: input };
    }
    if (toolName === "Write" || toolName === "Edit") {
      if (cfg.mutation) {
        const gate = cfg.mutation.approvalRequired ? "human approval" : "the must_dry_run gate";
        const reason = \`\${toolName} is the gated apply of a mutating component and requires \${gate} to clear first; that approval is borrowed from the SDK embedder's own canUseTool/approval channel.\`;
        denials.push({ tool: toolName, reason });
        return { behavior: "deny" as const, message: reason };
      }
      if (cfg.writeScope) {
        const target = typeof input.file_path === "string" ? input.file_path : "";
        const abs = join(cfg.cwd, target);
        if (abs.startsWith(join(cfg.cwd, cfg.writeScope))) return { behavior: "allow" as const, updatedInput: input };
        const reason = \`write to '\${target}' is outside the permitted artifact scope.\`;
        denials.push({ tool: toolName, reason, command: target });
        return { behavior: "deny" as const, message: reason };
      }
      const reason = \`\${toolName} is blocked: this component is read-only.\`;
      denials.push({ tool: toolName, reason });
      return { behavior: "deny" as const, message: reason };
    }
    const reason = \`tool '\${toolName}' is not permitted.\`;
    denials.push({ tool: toolName, reason });
    return { behavior: "deny" as const, message: reason };
  };
  return { canUseTool, denials };
}

function aggregateTrace(
  messages: readonly SDKMessage[],
  meta: { target: string; verb: string; model: string; split: boolean },
  denials: Denial[],
): Trace {
  const steps = messages
    .filter((m): m is Extract<SDKMessage, { type: "assistant" }> => m.type === "assistant")
    .map((m) => ({ model: m.message.model, parent_tool_use_id: m.parent_tool_use_id, usage: m.message.usage }));
  const result = messages.find((m): m is Extract<SDKMessage, { type: "result" }> => m.type === "result");
  const run = result === undefined ? null : {
    total_cost_usd: result.total_cost_usd, duration_ms: result.duration_ms,
    duration_api_ms: result.duration_api_ms, num_turns: result.num_turns,
  };
  return {
    target: meta.target, verb: meta.verb, model: meta.model, split: meta.split, run,
    modelUsage: (result?.modelUsage ?? {}) as Record<string, unknown>, steps, denials,
  };
}

function renderEnvelope(finalText: string, outPath: string, opts: { warbleBin: string; title?: string }): void {
  const dir = mkdtempSync(join(tmpdir(), "warble-emit-"));
  const envelopePath = join(dir, "envelope.txt");
  writeFileSync(envelopePath, finalText, "utf8");
  const args = ["render", envelopePath, "--out", outPath];
  if (opts.title) args.push("--title", opts.title);
  const proc = spawnSync(opts.warbleBin, args, { encoding: "utf8" });
  if (proc.error) throw new Error(\`failed to run '\${opts.warbleBin} render': \${proc.error.message}\`);
  if (proc.status !== 0) throw new Error(\`warble render exited \${proc.status}: \${proc.stderr?.trim() ?? ""}\`);
}`;

const PREAMBLE_TYPES = `export interface RunOptions { outDir?: string; warbleBin?: string; title?: string }
export type RunResult = ${RUN_RESULT_TYPE};

interface EmittedMeta {
  target: string; verb: string; model: string; split: boolean; readOnly: boolean;
  render: { kind: "realize" | "degrade" | "none"; scope: string | null; flavor: "programmatic" | "prompt" | null };
}`;

/**
 * Emit a TS agent module (as source text) for a prepared dispatch. Each component becomes an exported
 * async `run()` function that drives the SDK loop with the resolved, frozen options.
 */
export function emitAgentModule(prepared: PreparedDispatch, opts: EmitOptions = {}): string {
  const standalone = opts.standalone ?? false;

  const header = [
    "// Generated by `warble-agent-sdk emit` — do not edit by hand.",
    `// Target: ${prepared.target}. Regenerate from the IR instead of editing.`,
    standalone
      ? "// Mode: standalone (runtime helpers inlined; only @anthropic-ai/claude-agent-sdk + the `warble` binary needed)."
      : "// Mode: thin (imports runtime helpers from @warble/claude-agent-sdk).",
  ].join("\n");

  const blocks = prepared.components.map((c) => {
    const fn = ident(c.node.verb);
    const meta: EmittedMeta = {
      target: c.plan.meta.target,
      verb: c.plan.meta.verb,
      model: c.plan.meta.model,
      split: c.plan.meta.split,
      readOnly: c.plan.meta.readOnly,
      render: c.plan.meta.render,
    };
    return componentBlock(fn, c.node.verb, c.plan.options, meta);
  });

  return [
    header,
    "",
    standalone ? STANDALONE_IMPORTS : THIN_IMPORTS,
    "",
    PREAMBLE_TYPES,
    ...(standalone ? ["", STANDALONE_HELPERS] : []),
    "",
    ...blocks,
    "",
  ].join("\n");
}
