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
import { DispatchError } from "./error.js";

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
  /** +Setup: threaded to `makeReadOnlyGuard` so the emitted module gets the same Read-side
   *  `PreToolUse` dotenv-deny hook as run.ts. `null` for every non-setup component. See the
   *  standalone-mode wall-hit in `emitAgentModule` below for why this is fail-closed, not silently
   *  dropped, when `--standalone` is combined with a setup-scoped component. */
  setupScope: string | null;
}

function ident(verb: string): string {
  const base = verb.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[0-9]/.test(base) ? `_${base}` : base;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const RUN_RESULT_TYPE =
  "{ finalText: string; trace: Trace; htmlPath: string | null; denials: Denial[]; " +
  "renderDegraded: { reason: string } | null }";

/** The shared body of a component's `run()` (identical in both modes; only imports differ). */
function runBody(fn: string): string {
  return `  const cwd = ${fn}_options.cwd ?? process.cwd();
  const gate = ${fn}_meta.render;
  const writeScope = gate.kind === "realize" && gate.flavor === "prompt" ? gate.scope : null;
  const { canUseTool, denials, hooks } = makeReadOnlyGuard({
    readOnly: ${fn}_meta.readOnly,
    writeScope,
    cwd,
    setupScope: ${fn}_meta.setupScope,
  });

  // Read never reaches \`canUseTool\` for an in-cwd path in the real SDK (see guardrails.ts in the
  // warble repo); this hook is the live enforcement point for the +Setup dotenv-read gate's Read
  // side. Mirrors run.ts's wiring exactly — merge, don't clobber, any hooks already on the options.
  const messages: SDKMessage[] = [];
  for await (const m of query({
    prompt: question,
    options: {
      ...${fn}_options,
      canUseTool,
      hooks: { ...${fn}_options.hooks, PreToolUse: [...(${fn}_options.hooks?.PreToolUse ?? []), ...hooks] },
    },
  })) {
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
  let renderDegraded: { reason: string } | null = null;
  if (gate.kind === "realize" && gate.flavor === "programmatic" && opts.outDir) {
    const out = join(opts.outDir, "dashboard.html");
    try {
      renderEnvelope(finalText, out, { warbleBin: opts.warbleBin ?? "warble", ...(opts.title ? { title: opts.title } : {}) });
      htmlPath = out;
    } catch (err) {
      // best-effort render_contract: degrade to the agent's own text instead of failing the whole
      // run (capability-model.md — only safety-critical/required capabilities never silently
      // degrade). \`onFailure\` absent/"fail" preserves the prior hard-fail behavior exactly.
      if (gate.onFailure !== "degrade") throw err;
      renderDegraded = { reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return { finalText, trace, htmlPath, denials, renderDegraded };`;
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

const STANDALONE_IMPORTS = `import { join, sep } from "node:path";
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
// Kept byte-identical to guardrails.ts's DOTENV_READER_COMMANDS/DOTENV_PATH pair (see that file's doc
// comment for the incident this closes) — checked FIRST and unconditionally in the Bash branch below,
// exactly like canonical, never gated behind any config field. tests/guard-drift.test.ts asserts this
// inlined guard stays behaviorally equivalent to guardrails.ts on the surface standalone mode actually
// supports (setupScope always null here — see the wall-hit above).
const DOTENV_READER_COMMANDS = /\\b(cat|head|tail|less|more|od|xxd|strings|grep|awk|sed)\\b/;
const DOTENV_PATH = /(^|[\\s"'\\/=])\\.env(\\.[\\w.-]+)?(?=$|[\\s"'\\/])/;

function referencesDotenvPath(text: string): boolean {
  return DOTENV_PATH.test(text);
}

function makeReadOnlyGuard(cfg: {
  readOnly: boolean;
  writeScope: string | null;
  cwd: string;
  mutation?: { mustDryRun: boolean; approvalRequired: boolean };
  // \`emitAgentModule\` wall-hits before generating any component code if a setup-scoped component is
  // combined with --standalone (see codegen.ts), so this is always null here in practice — the field
  // only exists so this inlined guard's call signature matches the thin-mode \`makeReadOnlyGuard\`
  // import that runBody() (shared between both modes) calls. This guard's Bash branch DOES carry the
  // unconditional dotenv-read denylist (see DOTENV_READER_COMMANDS/DOTENV_PATH above) — that applies to
  // every component, not just +Setup ones, so it stays in sync here. What it deliberately does NOT
  // carry is any setupScope-aware widening (Bash beyond \`wren\`, Write/Edit scoped to a project root, a
  // Read-side PreToolUse hook) — the wall-hit above refuses --standalone for a setup-scoped component
  // rather than hand-syncing that logic and risking exactly the copy-drift this fix exists to close.
  // tests/guard-drift.test.ts is the tripwire: it fails if this copy and guardrails.ts::makeReadOnlyGuard
  // diverge on the setupScope == null surface, or if guardrails.ts grows new reachable behavior on that
  // surface that this copy doesn't (yet) have.
  setupScope?: string | null;
}) {
  const denials: Denial[] = [];
  const hooks: never[] = [];
  const canUseTool = async (toolName: string, input: Record<string, unknown>) => {
    if (toolName === "Read" || toolName === "Task" || toolName === "TodoWrite") {
      return { behavior: "allow" as const, updatedInput: input };
    }
    if (toolName === "Bash") {
      const command = typeof input.command === "string" ? input.command : "";
      // Dotenv-read pair: checked FIRST and unconditionally, before DESTRUCTIVE/REDIRECTION and the
      // wren-only check below — mirrors guardrails.ts::makeReadOnlyGuard exactly (see that file's
      // comment; standalone mode never has setupScope set, but the same compound-command bypass
      // guardrails.ts closes here applies to every component, not just +Setup ones).
      if (DOTENV_READER_COMMANDS.test(command) && referencesDotenvPath(command)) {
        const reason =
          "reading a dotenv file's contents is blocked by the read_only_execution guardrail; the " +
          "setup credential design writes an empty .env template and is never meant to read it back.";
        denials.push({ tool: "Bash", reason, command });
        return { behavior: "deny" as const, message: reason };
      }
      if (DESTRUCTIVE.test(command) || REDIRECTION.test(command)) {
        const reason =
          "destructive or file-writing bash is blocked by the read_only_execution guardrail; " +
          "all data access must go through the read-only \`wren\` CLI.";
        denials.push({ tool: "Bash", reason, command });
        return { behavior: "deny" as const, message: reason };
      }
      if (command.trim().split(/\\s+/)[0] !== "wren") {
        const reason =
          "only \`wren\` CLI invocations are permitted (data access goes through the semantic " +
          "layer); this command is blocked by the read_only_execution guardrail.";
        denials.push({ tool: "Bash", reason, command });
        return { behavior: "deny" as const, message: reason };
      }
      return { behavior: "allow" as const, updatedInput: input };
    }
    if (toolName === "Write" || toolName === "Edit") {
      if (cfg.mutation) {
        const gate = cfg.mutation.approvalRequired ? "human approval" : "the must_dry_run gate";
        const reason = \`\${toolName} is the gated apply of a mutating component and requires \${gate} to clear first; that approval is borrowed from the SDK embedder's own canUseTool/approval channel, which this guard does not provide, so it denies by default (fail-closed).\`;
        denials.push({ tool: toolName, reason });
        return { behavior: "deny" as const, message: reason };
      }
      if (cfg.writeScope) {
        const target = typeof input.file_path === "string" ? input.file_path : "";
        const abs = join(cfg.cwd, target);
        // Path-boundary-safe containment (mirrors guardrails.ts::withinScope): an exact match or a
        // real separator boundary — never a bare prefix, which would admit a sibling like models-export/.
        const scopeAbs = join(cfg.cwd, cfg.writeScope);
        if (abs === scopeAbs || abs.startsWith(scopeAbs.endsWith(sep) ? scopeAbs : scopeAbs + sep)) return { behavior: "allow" as const, updatedInput: input };
        const reason = \`write to '\${target}' is outside the permitted artifact scope '\${cfg.writeScope}'.\`;
        denials.push({ tool: toolName, reason, command: target });
        return { behavior: "deny" as const, message: reason };
      }
      const reason =
        \`\${toolName} is blocked: this component is read-only (programmatic render flavor keeps the \` +
        \`agent from writing files; the dispatcher renders the dashboard from your envelope).\`;
      denials.push({ tool: toolName, reason });
      return { behavior: "deny" as const, message: reason };
    }
    const reason = \`tool '\${toolName}' is not permitted for this component.\`;
    denials.push({ tool: toolName, reason });
    return { behavior: "deny" as const, message: reason };
  };
  return { canUseTool, denials, hooks };
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
  render: {
    kind: "realize" | "degrade" | "none"; scope: string | null; flavor: "programmatic" | "prompt" | null;
    onFailure?: "degrade" | "fail";
  };
  setupScope: string | null;
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

  // Standalone (eject) mode has no counterpart to run.ts's PreToolUse hook wiring: its inlined guard
  // does not (and, per the review, should not be hand-synced to) replicate the +Setup Read-side
  // dotenv PreToolUse hook or any other setupScope-aware widening. Rather than silently ship a
  // setup-scoped agent with zero dotenv protection on the Read side, wall-hit at emit time — loud and
  // specific, same convention as options.ts's `unsupported()`. tests/guard-drift.test.ts is the
  // tripwire that keeps this inlined guard behaviorally in sync with guardrails.ts on the surface
  // standalone mode DOES support (setupScope == null).
  if (standalone) {
    const setupScoped = prepared.components.filter((c) => c.plan.meta.setupScope != null);
    if (setupScoped.length > 0) {
      const verbs = setupScoped.map((c) => c.node.verb).join(", ");
      throw new DispatchError(
        `emit --standalone does not support setup-scoped component(s) [${verbs}] (wall-hit): the ` +
          "inlined standalone guard has no dotenv-read Read hook and no setupScope-aware Bash/Write " +
          "widening, so a standalone-ejected setup agent would have zero protection against the " +
          "dotenv-read gap that guardrails.ts's PreToolUse hook closes for the thin (default) mode. " +
          "Emit without --standalone for these component(s), or omit them from this IR.",
      );
    }
  }

  const blocks = prepared.components.map((c) => {
    const fn = ident(c.node.verb);
    const meta: EmittedMeta = {
      target: c.plan.meta.target,
      verb: c.plan.meta.verb,
      model: c.plan.meta.model,
      split: c.plan.meta.split,
      readOnly: c.plan.meta.readOnly,
      render: c.plan.meta.render,
      setupScope: c.plan.meta.setupScope,
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
