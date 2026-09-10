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
 *   warble-agent-sdk manifest <ir.json> [--include-unavailable] [--out manifest.json] [--target …] [--models-config …]
 *       [--render-flavor …] [--project <dir>] [--strong/--cheap/--orchestrator …]
 *
 *   warble-agent-sdk chat <ir.json> [--project <dir>] [--component answer_query] [--out ./run]
 *       [--target …] [--models-config m.yml] [--render-flavor programmatic|prompt] [--warble-bin <path>]
 *       [--stream-json] [--resume <session-id>]
 *
 * `--slot NAME=VARIANT` fills a named prompt slot with that variant; `--slot NAME=` removes a slot
 * whose condition does not hold. Repeatable, accepted by every subcommand, and mirroring the `warble`
 * CLI's flag of the same name. A slot nobody names takes its declared default — except one carrying
 * a `present_when` condition, which is refused when unanswered on any path whose text reaches a
 * model, because shipping wording for something that may have been withheld is worse than shipping
 * none. `manifest` is a display and renders such a default instead of refusing.
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
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { emitAgentModule } from "./codegen.js";
import {
  dispatch,
  preflightDispatchAssets,
  prepareDisplayManifest,
  prepareDispatch,
  type DispatchInput,
  type PreparedDispatch,
} from "./dispatch.js";
import { parseSlotFlags } from "./slots.js";
import type { SlotSupply } from "./slots.js";
import { DispatchError } from "./error.js";
import type { WarbleChatEvent } from "./events.js";
import { buildManifest } from "./manifest.js";
import { parseIr } from "./ir.js";
import { ModelConfig } from "./models.js";
import { discoverClaudeModels } from "./model_catalog.js";
import { parseRenderFlavor, type RenderFlavor } from "./options.js";
import { DispatchSessionError } from "./run.js";
import { createChatSession } from "./session.js";
import { type ResolutionReport } from "./resolve.js";
import { DEFAULT_TARGET } from "./targets.js";

/** `parseSlotFlags` throws; this CLI reports a bad flag as a usage failure instead. */
function parseSlotFlagsOrFail(flags: readonly string[]): SlotSupply {
  try {
    return parseSlotFlags(flags);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

const USAGE =
  'usage: warble-agent-sdk <dispatch|emit|manifest|chat> <ir.json> ["<question>"] [options]\n' +
  "       warble-agent-sdk list-models [--project <dir>] [--timeout <ms>]";

// `require("../package.json")` resolves relative to *this* file's own location, one directory up —
// which is the package root in both the dev tree (src/cli.ts → ../package.json) and the published
// layout (dist/cli.js → ../package.json; package.json ships in every npm package regardless of the
// "files" allowlist). That keeps the reported version tied to the package's real `version` field
// instead of a literal that could drift from it.
const requireFromHere = createRequire(import.meta.url);

function packageVersion(): string {
  return (requireFromHere("../package.json") as { version: string }).version;
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
  /** The host's slot table, from `--slot`. Empty when none was given. */
  slots: SlotSupply;
}

function buildModels(values: Record<string, string | string[] | boolean | undefined>): ModelConfig {
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
  // Handle `--version`/`-V` and `--help`/`-h` up front, before the strict `parseArgs` below —
  // neither is a declared option there, so leaving them for `parseArgs` to see would throw
  // `ERR_PARSE_ARGS_UNKNOWN_OPTION` instead of doing what every other CLI does with them.
  const firstArg = process.argv[2];
  if (firstArg === "--version" || firstArg === "-V") {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }
  if (firstArg === "--help" || firstArg === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

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
      timeout: { type: "string" },
      "include-unavailable": { type: "boolean" },
      slot: { type: "string", multiple: true },
    },
  });



  const [subcommand, irArg, question] = positionals;
  if (
    subcommand !== "dispatch" &&
    subcommand !== "emit" &&
    subcommand !== "manifest" &&
    subcommand !== "chat" &&
    subcommand !== "list-models"
  ) {
    fail(USAGE);
  }
  if (subcommand === "list-models") {
    if (irArg !== undefined || question !== undefined) fail("list-models does not take an <ir.json> or question");
    const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) fail("--timeout must be a positive number");
    const catalog = await discoverClaudeModels({
      ...(values.project ? { cwd: values.project } : {}),
      ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
    });
    process.stdout.write(`${JSON.stringify(catalog)}\n`);
    return;
  }
  if (values.timeout !== undefined) fail("--timeout is only supported by list-models");
  if (values["include-unavailable"] && subcommand !== "manifest") fail("--include-unavailable is only supported by manifest");
  if (!irArg) fail("missing <ir.json> argument");

  const target = values.target ?? DEFAULT_TARGET;
  const flavor = parseRenderFlavor(values["render-flavor"] ?? "programmatic");
  const models = buildModels(values);
  const raw = readFileSync(resolve(irArg), "utf8");

  // Parsed once and carried on CommonArgs, so every subcommand that builds prompts gets the same
  // table. Without this the seam would be reachable only by importing the library, and a profile
  // with a conditional slot could not be run through this CLI at all — it would always refuse for
  // want of an answer.
  const common: CommonArgs = {
    target,
    flavor,
    models,
    raw,
    irPath: irArg,
    project: values.project,
    slots: parseSlotFlagsOrFail(values.slot ?? []),
  };

  if (subcommand === "emit") {
    return runEmit(common, values.out, Boolean(values.standalone));
  }
  if (subcommand === "manifest") {
    return runManifest(common, values.out, Boolean(values["include-unavailable"]));
  }
  if (subcommand === "chat") {
    return runChatCmd(common, values);
  }
  return runDispatchCmd(common, values, question);
}

function runEmit(common: CommonArgs, outArg: string | undefined, standalone: boolean): void {
  const input: DispatchInput = {
    slots: common.slots,
    ir: common.raw,
    target: common.target,
    flavor: common.flavor,
    models: common.models,
    irPath: common.irPath,
    ...(common.project !== undefined ? { project: common.project } : {}),
  };
  const prepared: PreparedDispatch = prepareDispatch(input);
  preflightDispatchAssets(input, prepared);
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
function runManifest(common: CommonArgs, outArg: string | undefined, includeUnavailable: boolean): void {
  const input = {
    ir: common.raw,
    target: common.target,
    flavor: common.flavor,
    models: common.models,
    irPath: common.irPath,
    ...(common.project !== undefined ? { project: common.project } : {}),
  } as const;
  const prepared = includeUnavailable ? prepareDisplayManifest({ ...input, slots: common.slots }) : prepareDispatch({ ...input, slots: common.slots });
  for (const c of prepared.components) {
    if ("report" in c) printResolutionSummary(common.target, c.id, c.report);
  }

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
  values: Record<string, string | string[] | boolean | undefined>,
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

  const input: DispatchInput = {
    slots: common.slots,
    ir: common.raw,
    question: question ?? "",
    target: common.target,
    flavor: common.flavor,
    models: common.models,
    irPath: common.irPath,
    ...(common.project !== undefined ? { project: common.project } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
  const prepared = prepareDispatch(input);
  preflightDispatchAssets(input, prepared);
  for (const c of prepared.components) printResolutionSummary(common.target, c.id, c.report);

  if (dryRun) {
    mkdirSync(outDir, { recursive: true });
    for (const c of prepared.components) {
      const planPath = join(outDir, `${c.node.verb}.plan.json`);
      writeFileSync(
        planPath,
        JSON.stringify({
          prompt: c.plan.prompt,
          options: c.plan.options,
          meta: c.plan.meta,
          composition: {
            entry: prepared.entries.find((entry) => entry.root === c.id) ?? null,
            dependencies: prepared.dependencies,
            prepared_callees: prepared.preparedCallees.map((callee) => callee.id),
          },
        }, null, 2) + "\n",
        "utf8",
      );
      process.stderr.write(
        `warble-agent-sdk: dry-run — wrote plan ${planPath} (model=${c.plan.meta.model}, split=${c.plan.meta.split}, render=${c.plan.meta.render.kind}); query() not called.\n`,
      );
    }
  } else {
    const outcome = await dispatch(input, {
      outDir,
      warbleBin,
      ...(title ? { title } : {}),
    });
    for (const component of outcome.components) {
      process.stderr.write(
        `warble-agent-sdk: ran '${component.id}' → ${component.result.htmlPath ?? "(no html)"}; ` +
          `${component.result.denials.length} guardrail denial(s); trace at ${join(outDir, "trace.json")}\n`,
      );
    }
  }

  writeFileSync(
    join(outDir, "capability-report.json"),
    JSON.stringify(
      {
        target: common.target,
        profile: prepared.profile,
        entries: prepared.entries,
        dependencies: prepared.dependencies,
        components: [...prepared.components, ...prepared.preparedCallees].map((c) => ({
          id: c.id,
          role: c.role,
          capabilities: c.report,
        })),
      },
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
  values: Record<string, string | string[] | boolean | undefined>,
): Promise<void> {
  const outDir = resolve((values.out as string) ?? "./run");
  const warbleBin = (values["warble-bin"] as string) ?? defaultWarbleBin();
  const componentId = (values.component as string) ?? "answer_query";

  // Scoped to `componentId`: only its own required capabilities are resolved, so a *different*
  // component's unmet requirements (e.g. a sibling gated-tool with no approval channel wired on
  // this target) can never block dispatching this one. See `DispatchInput.componentId`.
  const input: DispatchInput = {
    slots: common.slots,
    ir: common.raw,
    target: common.target,
    flavor: common.flavor,
    models: common.models,
    irPath: common.irPath,
    componentId,
    ...(common.project !== undefined ? { project: common.project } : {}),
  };
  const prepared = prepareDispatch(input);
  preflightDispatchAssets(input, prepared);

  // `prepareDispatch` with `componentId` set either returns exactly this one component or throws
  // (caught by `main().catch()` below) — this is a defensive invariant check, not a reachable
  // "not found" path; that path's error text now comes from `prepareDispatch` itself.
  const component = prepared.components[0];
  if (!component) fail(`internal error: no component prepared for '${componentId}'`);
  for (const c of prepared.components) printResolutionSummary(common.target, c.id, c.report);

  mkdirSync(outDir, { recursive: true });
  const resumeSessionId = values.resume as string | undefined;
  const ir = parseIr(common.raw);
  const session = createChatSession(
    component.plan,
    {
      outDir,
      warbleBin,
      assets: { ir: { ...ir, components: [component.node] }, irPath: common.irPath },
    },
    resumeSessionId,
  );

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
