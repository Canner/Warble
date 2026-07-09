#!/usr/bin/env node
/**
 * `warble-agent-sdk` — the Claude Agent SDK back-end CLI (plan §4.7).
 *
 *   warble-agent-sdk dispatch <ir.json> "<question>" [--target …] [--models-config m.yml]
 *       [--render-flavor programmatic|prompt] [--out ./run] [--project <dir>]
 *       [--strong opus] [--cheap haiku] [--orchestrator sonnet]
 *       [--warble-bin <path>] [--max-turns N] [--title <t>] [--dry-run]
 *
 *   warble-agent-sdk emit <ir.json> [--out agent.ts] [--standalone] [--target …] [--models-config …]
 *       [--render-flavor …] [--project <dir>] [--strong/--cheap/--orchestrator …]
 *
 * `dispatch` consumes the SAME `ir.json` a Rust `warble compile` emits and drives the SDK loop
 * in-process (`--dry-run` writes the assembled plan without calling `query()`). `emit` freezes the
 * resolved plan into an importable TS agent module (thin, or `--standalone`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { emitAgentModule } from "./codegen.js";
import { prepareDispatch, type PreparedDispatch } from "./dispatch.js";
import { DispatchError } from "./error.js";
import { ModelConfig } from "./models.js";
import { parseRenderFlavor, type RenderFlavor } from "./options.js";
import { runDispatch } from "./run.js";
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
    },
  });

  const [subcommand, irArg, question] = positionals;
  if (subcommand !== "dispatch" && subcommand !== "emit") {
    fail('usage: warble-agent-sdk <dispatch|emit> <ir.json> ["<question>"] [options]');
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

main().catch((e: unknown) => {
  if (e instanceof DispatchError) fail(e.message);
  fail(e instanceof Error ? (e.stack ?? e.message) : String(e));
});
