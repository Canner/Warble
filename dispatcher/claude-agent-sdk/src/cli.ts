#!/usr/bin/env node
/**
 * `warble-agent-sdk` — the Claude Agent SDK back-end CLI.
 *
 *   warble-agent-sdk dispatch <ir.json> "<question>" [--target …] [--models-config m.yml]
 *       [--render-flavor programmatic|prompt] [--out ./run] [--project <dir>]
 *       [--strong opus] [--cheap haiku] [--orchestrator sonnet]
 *       [--warble-bin <path>] [--max-turns N] [--title <t>] [--dry-run]
 *
 *   warble-agent-sdk emit <ir.json> [--out agent.ts] [--standalone] [--target …] [--models-config …]
 *       [--render-flavor …] [--project <dir>] [--strong/--cheap/--orchestrator …]
 *
 *   warble-agent-sdk manifest <ir.json> [--out manifest.json] [--target …] [--models-config …]
 *       [--render-flavor …] [--project <dir>] [--strong/--cheap/--orchestrator …]
 *
 *   warble-agent-sdk chat <ir.json> [--project <dir>] [--component answer_query] [--out ./run]
 *       [--target …] [--models-config m.yml] [--render-flavor programmatic|prompt] [--warble-bin <path>]
 *       [--stream-json] [--resume <session-id>]
 *
 * `chat --stream-json` emits per-step/per-tool NDJSON events (one `WarbleChatEvent`, events.ts, per
 * line) to stdout as each turn runs, ending with a terminal `{"t":"answer","text":…}` line, instead of
 * the default plain final-answer-text-per-turn output — for a consumer that wants to build a live,
 * expandable work log rather than just the finished text. Every turn also emits a
 * `{"t":"session","id":…}` line (on success AND on a failed turn) carrying that turn's SDK session id.
 *
 * `--resume <session-id>` seeds a brand-new `chat` process's FIRST turn with a session id captured by
 * an earlier `chat` process (from its `{"t":"session",…}` line) — lets a caller resume a conversation
 * that a previous process started (e.g. one that ran out of turns), continuing the real SDK
 * conversation instead of re-dispatching a fresh prompt from scratch. Ignored after the first turn:
 * subsequent turns resume from this process's own prior turn, as usual.
 *
 * `dispatch` consumes the SAME `ir.json` a Rust `warble compile` emits and drives the SDK loop
 * in-process (`--dry-run` writes the assembled plan without calling `query()`). `emit` freezes the
 * resolved plan into an importable TS agent module (thin, or `--standalone`). `manifest` runs the
 * same preparation as `emit` (no `question`, no `query()` call) and instead serializes a display
 * manifest — the resolved agents/steps/tiers/capabilities/guardrails for THIS target, structurally
 * identical to the vercel back-end's bundle — so a consumer can source a display from whichever
 * back-end actually runs, instead of always reading the vercel bundle target's output. `chat` opens a
 * multi-turn session (session.ts, G1 — single profile, many turns) over one component, reading
 * questions from stdin line-by-line and resuming the SDK session turn over turn.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { emitAgentModule } from "./codegen.js";
import { prepareDispatch, type PreparedDispatch } from "./dispatch.js";
import { DispatchError } from "./error.js";
import type { WarbleChatEvent } from "./events.js";
import { buildManifest } from "./manifest.js";
import { ModelConfig } from "./models.js";
import { parseRenderFlavor, type RenderFlavor } from "./options.js";
import { DispatchSessionError, runDispatch } from "./run.js";
import { createChatSession } from "./session.js";
import { type ResolutionReport } from "./resolve.js";
import { DEFAULT_TARGET } from "./targets.js";

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

/** Locate the reference `warble` binary: --warble-bin, else PATH, else this repo's release build. */
function defaultWarbleBin(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoBuilt = resolve(here, "../../../target/release/warble");
  return existsSync(repoBuilt) ? repoBuilt : "warble";
}

function printResolutionSummary(target: string, id: string, report: ResolutionReport): void {
  process.stderr.write(`warble-agent-sdk: capability resolution for '${target}' (component '${id}'):\n`);
  for (const e of report) {
    const note = e.note ? ` — ${e.note}` : "";
    process.stderr.write(
      `  ${e.capability.padEnd(28)} ${e.outcome.padEnd(12)} (${e.provided_by}, ${e.criticality})${note}\n`,
    );
  }
}

interface CommonArgs {
  target: string;
  flavor: RenderFlavor;
  models: ModelConfig;
  raw: string;
  irPath: string;
  project: string | undefined;
}

function buildModels(values: Record<string, string | boolean | undefined>): ModelConfig {
  const cfgPath = values["models-config"];
  if (typeof cfgPath === "string") {
    return ModelConfig.fromYaml(readFileSync(resolve(cfgPath), "utf8"));
  }
  return ModelConfig.fromFlags(
    (values.strong as string) ?? "opus",
    (values.cheap as string) ?? "haiku",
    (values.orchestrator as string) ?? "sonnet",
  );
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      target: { type: "string" },
      out: { type: "string" },
      "models-config": { type: "string" },
      "render-flavor": { type: "string" },
      strong: { type: "string" },
      cheap: { type: "string" },
      orchestrator: { type: "string" },
      project: { type: "string" },
      "warble-bin": { type: "string" },
      "max-turns": { type: "string" },
      title: { type: "string" },
      "dry-run": { type: "boolean" },
      standalone: { type: "boolean" },
      component: { type: "string" },
      "stream-json": { type: "boolean" },
      resume: { type: "string" },
    },
  });

  const [subcommand, irArg, question] = positionals;
  if (
    subcommand !== "dispatch" &&
    subcommand !== "emit" &&
    subcommand !== "manifest" &&
    subcommand !== "chat"
  ) {
    fail('usage: warble-agent-sdk <dispatch|emit|manifest|chat> <ir.json> ["<question>"] [options]');
  }
  if (!irArg) fail("missing <ir.json> argument");

  const target = values.target ?? DEFAULT_TARGET;
  const flavor = parseRenderFlavor(values["render-flavor"] ?? "programmatic");
  const models = buildModels(values);
  const raw = readFileSync(resolve(irArg), "utf8");

  const common: CommonArgs = { target, flavor, models, raw, irPath: irArg, project: values.project };

  if (subcommand === "emit") {
    return runEmit(common, values.out, Boolean(values.standalone));
  }
  if (subcommand === "manifest") {
    return runManifest(common, values.out);
  }
  if (subcommand === "chat") {
    return runChatCmd(common, values);
  }
  return runDispatchCmd(common, values, question);
}

function runEmit(common: CommonArgs, outArg: string | undefined, standalone: boolean): void {
  const prepared: PreparedDispatch = prepareDispatch({
    ir: common.raw,
    target: common.target,
    flavor: common.flavor,
    models: common.models,
    irPath: common.irPath,
    ...(common.project !== undefined ? { project: common.project } : {}),
  });
  for (const c of prepared.components) printResolutionSummary(common.target, c.id, c.report);

  const outPath = resolve(outArg ?? "agent.ts");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, emitAgentModule(prepared, { standalone }), "utf8");
  process.stderr.write(
    `warble-agent-sdk: emit — wrote ${outPath} (${prepared.components.length} component(s), ${standalone ? "standalone" : "thin"}).\n`,
  );
}

/**
 * `manifest` — same preparation as `emit` (no `question`, `query()` never called), but instead of
 * freezing an importable agent module, serializes the display manifest (see `manifest.ts`) to stdout
 * or `--out`. Capability resolution summaries still go to stderr so stdout stays pure JSON.
 */
function runManifest(common: CommonArgs, outArg: string | undefined): void {
  const prepared: PreparedDispatch = prepareDispatch({
    ir: common.raw,
    target: common.target,
    flavor: common.flavor,
    models: common.models,
    irPath: common.irPath,
    ...(common.project !== undefined ? { project: common.project } : {}),
  });
  for (const c of prepared.components) printResolutionSummary(common.target, c.id, c.report);

  const manifest = buildManifest(prepared, common.raw);
  const json = `${JSON.stringify(manifest, null, 2)}\n`;

  if (outArg) {
    const outPath = resolve(outArg);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, json, "utf8");
    process.stderr.write(
      `warble-agent-sdk: manifest — wrote ${outPath} (${prepared.components.length} agent(s)).\n`,
    );
  } else {
    process.stdout.write(json);
  }
}

async function runDispatchCmd(
  common: CommonArgs,
  values: Record<string, string | boolean | undefined>,
  question: string | undefined,
): Promise<void> {
  const dryRun = Boolean(values["dry-run"]);
  if (!question && !dryRun) fail('missing "<question>" argument (or pass --dry-run)');

  const maxTurnsRaw = values["max-turns"];
  const maxTurns = typeof maxTurnsRaw === "string" ? Number(maxTurnsRaw) : undefined;
  if (maxTurns !== undefined && !Number.isFinite(maxTurns)) fail("--max-turns must be a number");

  const outDir = resolve((values.out as string) ?? "./run");
  const warbleBin = (values["warble-bin"] as string) ?? defaultWarbleBin();
  const title = values.title as string | undefined;

  const prepared = prepareDispatch({
    ir: common.raw,
    question: question ?? "",
    target: common.target,
    flavor: common.flavor,
    models: common.models,
    irPath: common.irPath,
    ...(common.project !== undefined ? { project: common.project } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  });

  mkdirSync(outDir, { recursive: true });
  for (const c of prepared.components) printResolutionSummary(common.target, c.id, c.report);

  for (const c of prepared.components) {
    if (dryRun) {
      const planPath = join(outDir, `${c.node.verb}.plan.json`);
      writeFileSync(
        planPath,
        JSON.stringify({ prompt: c.plan.prompt, options: c.plan.options, meta: c.plan.meta }, null, 2) + "\n",
        "utf8",
      );
      process.stderr.write(
        `warble-agent-sdk: dry-run — wrote plan ${planPath} (model=${c.plan.meta.model}, split=${c.plan.meta.split}, render=${c.plan.meta.render.kind}); query() not called.\n`,
      );
      continue;
    }
    const result = await runDispatch(c.plan, { outDir, warbleBin, ...(title ? { title } : {}) });
    process.stderr.write(
      `warble-agent-sdk: ran '${c.node.verb}' → ${result.htmlPath ?? "(no html)"}; ` +
        `${result.denials.length} guardrail denial(s); trace at ${join(outDir, "trace.json")}\n`,
    );
  }

  writeFileSync(
    join(outDir, "capability-report.json"),
    JSON.stringify(
      { target: common.target, components: prepared.components.map((c) => ({ id: c.id, capabilities: c.report })) },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

/**
 * `chat` — a multi-turn session (session.ts, G1) over ONE prepared component, reading questions from
 * stdin line-by-line. Each turn's answer is printed to stdout; the SDK session is resumed turn over
 * turn (`ChatSession` handles the `resume: session_id` plumbing). Manual/live use only — not exercised
 * by the offline test suite.
 *
 * `--stream-json` (opt-in): instead of printing the turn's plain final-answer text, stream one
 * `WarbleChatEvent` NDJSON line per event as the turn runs (via `session.ask`'s `onEvent`), followed
 * by a terminal `{"t":"answer","text":…}` line. Without the flag, behavior is byte-for-byte unchanged
 * from before this option existed.
 */
async function runChatCmd(
  common: CommonArgs,
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const outDir = resolve((values.out as string) ?? "./run");
  const warbleBin = (values["warble-bin"] as string) ?? defaultWarbleBin();
  const componentId = (values.component as string) ?? "answer_query";

  const prepared = prepareDispatch({
    ir: common.raw,
    target: common.target,
    flavor: common.flavor,
    models: common.models,
    irPath: common.irPath,
    ...(common.project !== undefined ? { project: common.project } : {}),
  });

  const component = prepared.components.find((c) => c.id === componentId);
  if (!component) {
    fail(
      `component '${componentId}' not found in IR (available: ` +
        `${prepared.components.map((c) => c.id).join(", ")})`,
    );
  }
  for (const c of prepared.components) printResolutionSummary(common.target, c.id, c.report);

  mkdirSync(outDir, { recursive: true });
  const resumeSessionId = values.resume as string | undefined;
  const session = createChatSession(component.plan, { outDir, warbleBin }, resumeSessionId);

  process.stderr.write(
    `warble-agent-sdk: chat — component '${componentId}'; type a question per line (Ctrl-D to end).\n`,
  );

  const streamJson = Boolean(values["stream-json"]);
  const onEvent = streamJson
    ? (event: WarbleChatEvent): void => {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }
    : undefined;

  const emitSession = (id: string | null): void => {
    if (!streamJson) return;
    const sessionEvent: WarbleChatEvent = { t: "session", id };
    process.stdout.write(`${JSON.stringify(sessionEvent)}\n`);
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const question = line.trim();
    if (!question) continue;
    let turn;
    try {
      turn = await session.ask(question, onEvent ? { onEvent } : {});
    } catch (err) {
      // A failed turn (e.g. error_max_turns) still surfaces its session id, when the SDK's result
      // message carried one, so a caller can resume this same conversation instead of starting over.
      emitSession(err instanceof DispatchSessionError ? err.sessionId : null);
      throw err;
    }
    emitSession(turn.sessionId);
    if (streamJson) {
      const answerEvent: WarbleChatEvent = { t: "answer", text: turn.finalText };
      process.stdout.write(`${JSON.stringify(answerEvent)}\n`);
    } else {
      process.stdout.write(`${turn.finalText}\n`);
    }
  }
}

main().catch((e: unknown) => {
  if (e instanceof DispatchError) fail(e.message);
  fail(e instanceof Error ? (e.stack ?? e.message) : String(e));
});
