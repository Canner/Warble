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

import { DispatchError } from "./error.js";
import { assertSupportedIrVersion, parseIr, type ComponentNode, type WarbleIr } from "./ir.js";
import { ModelConfig } from "./models.js";
import {
  buildDispatchPlan,
  DEFAULT_RENDER_FLAVOR,
  type BuildConfig,
  type DispatchPlan,
  type RenderFlavor,
} from "./options.js";
import { inspectNodeCapabilities, resolveNodeCapabilities, type ResolutionReport } from "./resolve.js";
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
  /**
   * Scope preparation to exactly this component id: only its capabilities are resolved and only
   * its plan is built — every *other* component in the IR is left untouched, so its
   * `required_capabilities` never enter this dispatch's preflight. Use this for `chat`, which
   * only ever runs one component per process.
   *
   * Omit (the default) to prepare every component in the IR — the shape `manifest`, `emit`, and
   * the whole-profile `dispatch` subcommand need, since each of those actually reads or runs
   * every component and must know every component's resolution, not just one's.
   *
   * This narrows *which* component's requirements gate a given `prepareDispatch` call — it does
   * not change what happens when a gated capability is unmet (still a loud throw, same message,
   * same named capability; see `resolveNodeCapabilities`). A component that can itself invoke
   * another IR component at runtime would need that callee's requirements folded in here too, but
   * no such reachability exists yet: `borrowed_actions` names external runtime actions (notify,
   * ticket, …), never another component, and the one mechanism shaped for it — `orchestrating` /
   * `effect.outcome.kind: "dispatch"` with `routable_scope` — is parsed but not consumed by any
   * back-end (`docs/spec/authoring.md` marks `orchestrating` "scaffolded", not realized). If that
   * ever lands, this scoping must fold in the callee's requirements too.
   */
  componentId?: string;
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

/** Stable redacted status for a component the configured target cannot run. */
export const UNAVAILABLE_COMPONENT_REASON = "component is unavailable on the configured runtime";

export interface UnavailableDisplayComponent {
  id: string;
  node: ComponentNode;
  availability: { status: "unavailable"; reason: typeof UNAVAILABLE_COMPONENT_REASON };
}

export type DisplayComponent = PreparedComponent | UnavailableDisplayComponent;

export interface PreparedDisplayManifest {
  target: string;
  components: DisplayComponent[];
}

function buildPreparedComponent(
  node: ComponentNode,
  report: ResolutionReport,
  input: DispatchInput,
  target: string,
  models: ModelConfig,
): PreparedComponent {
  const cfg: BuildConfig = {
    target,
    flavor: input.flavor ?? DEFAULT_RENDER_FLAVOR,
    models,
    question: input.question ?? "",
    cwd: resolveProjectCwd(node, { ...(input.project !== undefined ? { project: input.project } : {}), ...(input.irPath !== undefined ? { irPath: input.irPath } : {}) }),
    ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
  };
  return { id: node.id, node, report, plan: buildDispatchPlan(node, report, cfg) };
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

/**
 * Parse + resolve + build every requested component's `query({options})`, without calling the SDK.
 *
 * By default this prepares every component in the IR. Pass `input.componentId` to scope
 * preparation — and therefore capability resolution — to exactly that one component; every other
 * component's `required_capabilities` are never consulted, so a component that isn't being
 * dispatched can't wall-hit a dispatch it has nothing to do with. See {@link DispatchInput.componentId}.
 */
export function prepareDispatch(input: DispatchInput): PreparedDispatch {
  const ir: WarbleIr = typeof input.ir === "string" ? parseIr(input.ir) : input.ir;
  // `parseIr` already gates the string-input branch; an object handed in directly (e.g. a caller's
  // own `JSON.parse` widened to `WarbleIr`) never runs through it, so gate here too — every caller
  // of `prepareDispatch`/`dispatch`, not just callers who pass a raw string, is covered.
  assertSupportedIrVersion(ir.warble_ir_version);
  const target = input.target ?? DEFAULT_TARGET;
  const models = input.models ?? ModelConfig.default();
  models.validate(ir); // every step tier must map to a model — abort before building anything.

  let scoped = ir.components;
  if (input.componentId !== undefined) {
    const node = ir.components.find((candidate) => candidate.id === input.componentId);
    if (!node) {
      throw new DispatchError(
        `component '${input.componentId}' not found in IR (available: ${ir.components.map((c) => c.id).join(", ")})`,
      );
    }
    scoped = [node];
  }

  const components: PreparedComponent[] = scoped.map((node) => {
    const report = resolveNodeCapabilities(node, target);
    return buildPreparedComponent(node, report, input, target, models);
  });

  return { target, components };
}

/**
 * Prepare a display-only whole-profile manifest. Unsupported components are
 * represented by a closed unavailable marker; no executable plan is built
 * for them. This must never be used by emit, dispatch, or chat.
 */
export function prepareDisplayManifest(input: Omit<DispatchInput, "componentId" | "question">): PreparedDisplayManifest {
  const ir: WarbleIr = typeof input.ir === "string" ? parseIr(input.ir) : input.ir;
  assertSupportedIrVersion(ir.warble_ir_version);
  const target = input.target ?? DEFAULT_TARGET;
  const models = input.models ?? ModelConfig.default();
  models.validate(ir);

  const components: DisplayComponent[] = ir.components.map((node) => {
    const report = inspectNodeCapabilities(node, target);
    if (report.some((entry) => entry.outcome === "fail")) {
      return { id: node.id, node, availability: { status: "unavailable", reason: UNAVAILABLE_COMPONENT_REASON } };
    }
    return buildPreparedComponent(node, report, input, target, models);
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
