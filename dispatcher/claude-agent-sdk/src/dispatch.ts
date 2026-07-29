/**
 * High-level dispatch API — the embeddable surface (embed this back-end in your own TS app).
 *
 * Two entry points over the lower-level modules:
 *   - `prepareDispatch` — PURE: parse IR → resolve capabilities → build one `query({options})` per
 *     component. No SDK call. Powers `--dry-run`, codegen (`emit`), and offline inspection.
 *   - `dispatch` — runs each prepared plan against the live Agent SDK loop (+ render + trace).
 *
 * A caller who wants full control of the loop can stop at `prepareDispatch` and hand `plan.options`
 * to the SDK's `query()` themselves (attaching their own tools/MCP/permission strategy) — the plan's
 * options are the language-neutral hand-off.
 */
import { dirname, isAbsolute, resolve } from "node:path";

import { assertSupportedIrVersion, parseIr, type ComponentNode, type WarbleIr } from "./ir.js";
import { ModelConfig } from "./models.js";
import {
  buildDispatchPlan,
  DEFAULT_RENDER_FLAVOR,
  type BuildConfig,
  type DispatchPlan,
  type RenderFlavor,
} from "./options.js";
import { resolveNodeCapabilities, type ResolutionReport } from "./resolve.js";
import { runDispatch, type RunResult } from "./run.js";
import { DEFAULT_TARGET } from "./targets.js";

export interface DispatchInput {
  /** A parsed IR or a raw JSON string. */
  ir: WarbleIr | string;
  /** The data question to answer (the `query()` prompt). Optional for prepare-only (dry-run/emit). */
  question?: string;
  target?: string;
  flavor?: RenderFlavor;
  models?: ModelConfig;
  maxTurns?: number;
  /** Explicit bound-project cwd (absolute or cwd-relative). Overrides `irPath`-based resolution. */
  project?: string;
  /** Resolve each node's relative `context_binding.project` against this IR file's directory. */
  irPath?: string;
}

export interface PreparedComponent {
  id: string;
  node: ComponentNode;
  report: ResolutionReport;
  plan: DispatchPlan;
}

export interface PreparedDispatch {
  target: string;
  components: PreparedComponent[];
}

/**
 * Resolve a node's bound wren project to an absolute cwd. Relative `context_binding.project` paths
 * resolve against the IR file's directory (`irPath`) when given, else the current working directory;
 * an explicit `project` always wins.
 */
export function resolveProjectCwd(
  node: ComponentNode,
  opts: { project?: string; irPath?: string },
): string {
  if (opts.project) return resolve(opts.project);
  const p = node.context_binding.project;
  if (isAbsolute(p)) return p;
  const baseDir = opts.irPath ? dirname(resolve(opts.irPath)) : process.cwd();
  return resolve(baseDir, p);
}

/** Parse + resolve + build every component's `query({options})`, without calling the SDK. */
export function prepareDispatch(input: DispatchInput): PreparedDispatch {
  const ir: WarbleIr = typeof input.ir === "string" ? parseIr(input.ir) : input.ir;
  // `parseIr` already gates the string-input branch; an object handed in directly (e.g. a caller's
  // own `JSON.parse` widened to `WarbleIr`) never runs through it, so gate here too — every caller
  // of `prepareDispatch`/`dispatch`, not just callers who pass a raw string, is covered.
  assertSupportedIrVersion(ir.warble_ir_version);
  const target = input.target ?? DEFAULT_TARGET;
  const models = input.models ?? ModelConfig.default();
  models.validate(ir); // every step tier must map to a model — abort before building anything.

  const components: PreparedComponent[] = ir.components.map((node) => {
    const report = resolveNodeCapabilities(node, target);
    const cfg: BuildConfig = {
      target,
      flavor: input.flavor ?? DEFAULT_RENDER_FLAVOR,
      models,
      question: input.question ?? "",
      cwd: resolveProjectCwd(node, { ...(input.project !== undefined ? { project: input.project } : {}), ...(input.irPath !== undefined ? { irPath: input.irPath } : {}) }),
      ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
    };
    return { id: node.id, node, report, plan: buildDispatchPlan(node, report, cfg) };
  });

  return { target, components };
}

export interface DispatchRunConfig {
  outDir: string;
  warbleBin?: string;
  title?: string;
}

export interface ComponentOutcome {
  id: string;
  report: ResolutionReport;
  plan: DispatchPlan;
  result: RunResult;
}

export interface DispatchOutcome {
  target: string;
  components: ComponentOutcome[];
}

/**
 * Prepare then RUN each component against the live Agent SDK loop. Requires `input.question`.
 * Writes each run's artifacts under `runCfg.outDir` (see {@link runDispatch}).
 */
export async function dispatch(
  input: DispatchInput,
  runCfg: DispatchRunConfig,
): Promise<DispatchOutcome> {
  const prepared = prepareDispatch(input);
  const warbleBin = runCfg.warbleBin ?? "warble";

  const components: ComponentOutcome[] = [];
  for (const c of prepared.components) {
    const result = await runDispatch(c.plan, {
      outDir: runCfg.outDir,
      warbleBin,
      ...(runCfg.title ? { title: runCfg.title } : {}),
    });
    components.push({ id: c.id, report: c.report, plan: c.plan, result });
  }
  return { target: prepared.target, components };
}
