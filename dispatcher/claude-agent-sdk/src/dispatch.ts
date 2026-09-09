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
import {
  resolveComponentClosure,
  type ComponentClosurePlan,
  type ComponentDependency,
  type EntryClosure,
} from "./closure.js";
import {
  assertComponentCompositionFields,
  assertSupportedIrVersion,
  parseIrInput,
  type ComponentNode,
  type WarbleIr,
} from "./ir.js";
import { applySlots, resolveSlots, type SlotSupply, type UnansweredCondition } from "./slots.js";
import { ModelConfig } from "./models.js";
import {
  buildPreparedNodePlan,
  DEFAULT_RENDER_FLAVOR,
  type BuildConfig,
  type DispatchPlan,
  type RenderFlavor,
} from "./options.js";
import { inspectNodeCapabilities, type ResolutionReport } from "./resolve.js";
import { runDispatch, type RunResult } from "./run.js";
import { DEFAULT_TARGET } from "./targets.js";
import { validateAssets } from "./assets.js";

export interface DispatchInput {
  /** A parsed IR or a raw JSON string. */
  ir: WarbleIr | string;
  /**
   * What this host says about each declared slot: a variant name to render, `null` to remove the
   * slot because its `present_when` does not hold, or nothing at all to take the declared default.
   *
   * The IR carries every variant and picks none — picking is the host's job, and so is answering a
   * condition. Omit this entirely for an IR that declares no slots; supplying it then is harmless
   * but pointless. An IR that DOES declare a conditional slot and gets no answer for it is a loud
   * failure rather than a silent default (see `resolveSlots`).
   */
  slots?: SlotSupply;
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
   * Scope preparation to this root id and its complete transitive component-call closure. An
   * unreachable sibling is left untouched, so its model, slots, assets, capabilities, guardrails,
   * effect and trigger never enter this dispatch's preflight. Use this for `chat`, which starts one
   * root per process.
   *
   * Omit (the default) to prepare every component in the IR — the shape `manifest`, `emit`, and
   * the whole-profile `dispatch` subcommand need, since each of those actually reads or runs
   * every component and must know every component's resolution, not just one's.
   *
   * This narrows *which closure's* requirements gate a call; it does not weaken a failed
   * capability. Reachable callees are fully planned under their own authority and stored in the
   * prepared-callee registry, never appended to the root plan list or started automatically.
   */
  componentId?: string;
}

export interface PreparedComponent {
  id: string;
  node: ComponentNode;
  report: ResolutionReport;
  plan: DispatchPlan;
  role: "entry" | "callee";
}

export interface PreparedDispatch {
  target: string;
  profile: string;
  /** Backwards-compatible root plan list. Reachable callees never appear here merely by reachability. */
  components: PreparedComponent[];
  /** Immutable records addressable only through the authorized dependency table. */
  preparedCallees: readonly PreparedComponent[];
  entries: readonly EntryClosure[];
  dependencies: readonly ComponentDependency[];
}

/** Stable redacted status for a component the configured target cannot run. */
export const UNAVAILABLE_COMPONENT_REASON = "component is unavailable on the configured runtime";

export interface UnavailableDisplayComponent {
  id: string;
  node: ComponentNode;
  /** Read-only diagnostic resolution; never an executable capability grant. */
  inspection: ResolutionReport;
  availability: { status: "unavailable"; reason: typeof UNAVAILABLE_COMPONENT_REASON };
}

/**
 * A component in a display manifest that the target CAN run.
 *
 * Deliberately **not** a {@link PreparedComponent}: it carries no `plan`. A plan built for a display
 * is resolved under the lenient unanswered-condition policy, so handing one out would let a consumer
 * do the natural "preview it, then dispatch what was previewed" — `runDispatch(component.plan, cfg)`
 * type-checks with no cast — and send a model wording for a condition nobody ever answered. That is
 * exactly the failure the strict policy exists to prevent, arriving through the display door.
 *
 * A plan is still built during preparation, because that is what surfaces an unsupported enum as a
 * wall-hit; it is discarded rather than returned. Nothing in the manifest builders reads it.
 */
export interface AvailableDisplayComponent {
  id: string;
  node: ComponentNode;
  report: ResolutionReport;
}

export type DisplayComponent = AvailableDisplayComponent | UnavailableDisplayComponent;

export interface PreparedDisplayManifest {
  target: string;
  profile: string;
  components: readonly DisplayComponent[];
  entries: readonly EntryClosure[];
  dependencies: readonly ComponentDependency[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function buildPreparedComponent(
  node: ComponentNode,
  report: ResolutionReport,
  input: DispatchInput,
  target: string,
  models: ModelConfig,
  role: PreparedComponent["role"] = "entry",
): PreparedComponent {
  const cfg: BuildConfig = {
    target,
    flavor: input.flavor ?? DEFAULT_RENDER_FLAVOR,
    models,
    question: input.question ?? "",
    cwd: resolveProjectCwd(node, { ...(input.project !== undefined ? { project: input.project } : {}), ...(input.irPath !== undefined ? { irPath: input.irPath } : {}) }),
    ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
  };
  const plan = buildPreparedNodePlan(node, report, cfg);
  return deepFreeze({ id: node.id, node, report, plan, role });
}

function assertExecutableReport(
  node: ComponentNode,
  report: ResolutionReport,
  target: string,
  deferInvocationWall: boolean,
): void {
  const failed = report.find(
    (entry) =>
      entry.outcome === "fail" &&
      !(deferInvocationWall && entry.capability === "component_invocation"),
  );
  if (!failed) return;
  const reason = failed.note ?? "unsupported on this target";
  throw new DispatchError(
    `${failed.capability}: fail on ${target} (${reason}) — component '${node.verb}' cannot be dispatched`,
  );
}

function assertInvocationRealization(
  closure: ComponentClosurePlan,
  reports: ReadonlyMap<string, ResolutionReport>,
  target: string,
): void {
  if (closure.dependencies.length === 0) return;
  const edge = closure.dependencies.find((dependency) =>
    reports.get(dependency.caller)?.some(
      (entry) => entry.capability === "component_invocation" && entry.outcome === "fail",
    ),
  );
  if (!edge) return;
  const resolution = reports
    .get(edge.caller)!
    .find((entry) => entry.capability === "component_invocation")!;
  throw new DispatchError(
    `step '${edge.step}' on component '${edge.caller}' authorizes component call alias ` +
      `'${edge.alias}' to '${edge.component}', but component_invocation resolves ` +
      `${resolution.outcome} on ${target} (${resolution.note ?? "no trusted invocation handler"}) ` +
      `(wall-hit)`,
  );
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
 * By default this prepares every advertised entry and the union of their closures. Pass
 * `input.componentId` to scope preparation to one advertised root and its transitive callees;
 * components outside that closure are never consulted. See {@link DispatchInput.componentId}.
 */
export function prepareDispatch(input: DispatchInput): PreparedDispatch {
  const ir: WarbleIr = parseIrInput(input.ir);
  // `parseIrInput` normalizes both wire strings and caller-parsed objects through one parser. Keep
  // the explicit version assertion here as the executable entrypoint's last-line invariant.
  assertSupportedIrVersion(ir.warble_ir_version);
  const target = input.target ?? DEFAULT_TARGET;
  const models = input.models ?? ModelConfig.default();
  const closure = resolveComponentClosure(
    ir,
    input.componentId === undefined ? undefined : [input.componentId],
  );
  models.validate({ ...ir, components: [...closure.components] });

  // Slots are resolved into the node's own prompt-carrying fields BEFORE anything assembles a
  // prompt from them. Doing it here rather than at each assembly site means a surface that is added
  // later cannot quietly miss it — whatever reads `brief` or a step's `prompt` downstream is already
  // reading resolved text, and `assertNoSlotReferences` catches anything that still is not.
  const supply = input.slots ?? {};
  const resolvedNodes = new Map<string, ComponentNode>();
  const reports = new Map<string, ResolutionReport>();
  for (const node of closure.components) {
    const resolved = resolveSlotsForNode(node, ir, supply);
    const withSlots = resolved === null ? node : applyNodeSlots(node, resolved);
    const report = inspectNodeCapabilities(withSlots, target);
    resolvedNodes.set(node.id, withSlots);
    reports.set(node.id, report);
  }

  // Inspect every reachable node before enforcing target support. This keeps the preparation seam
  // ready for a target that later realizes invocation and ensures no sibling outside the closure
  // participates in model, slot, capability, or structural validation.
  for (const node of closure.components) {
    assertExecutableReport(
      resolvedNodes.get(node.id)!,
      reports.get(node.id)!,
      target,
      closure.dependencies.some((dependency) => dependency.caller === node.id),
    );
  }

  const components = closure.roots.map((node) =>
    buildPreparedComponent(resolvedNodes.get(node.id)!, reports.get(node.id)!, input, target, models, "entry"),
  );
  const preparedCallees = closure.callees.map((node) =>
    buildPreparedComponent(
      resolvedNodes.get(node.id)!,
      reports.get(node.id)!,
      input,
      target,
      models,
      "callee",
    ),
  );
  // Structural planning of every reachable node (trigger/effect/guardrail/tool shape) is complete
  // before the target-level invocation wall is enforced. No plan escapes when that wall fails.
  assertInvocationRealization(closure, reports, target);

  return Object.freeze({
    target,
    profile: ir.profile,
    // Keep the established mutable TypeScript surface for compatibility while freezing the actual
    // registry returned for a run. Callers cannot widen it after preflight.
    components: Object.freeze(components) as PreparedComponent[],
    preparedCallees: Object.freeze(preparedCallees),
    entries: closure.entries,
    dependencies: closure.dependencies,
  });
}

/**
 * Resolve every slot in scope for one component: its own, plus the profile's.
 *
 * The two layers are checked separately at compile but arrive merged — compile folds the profile's
 * `system_prompt` into each component's `brief` — so one combined table is what a consumer needs.
 * Names are unique project-wide, which is what makes combining them unambiguous.
 *
 * Returns `null` when nothing in scope declares a slot, so a pre-0.7-shaped IR takes a path that
 * touches none of its text.
 */
function resolveSlotsForNode(
  node: ComponentNode,
  ir: WarbleIr,
  supply: SlotSupply,
  unanswered: UnansweredCondition = "fail",
): ReadonlyMap<string, string | null> | null {
  const decls = [...(ir.slots ?? []), ...(node.slots ?? [])];
  if (decls.length === 0) return null;
  return resolveSlots(decls, supply, `component '${node.id}'`, unanswered);
}

/** A copy of `node` with every slot reference in its prompt-carrying fields replaced. */
function applyNodeSlots(
  node: ComponentNode,
  resolved: ReadonlyMap<string, string | null>,
): ComponentNode {
  const scope = `component '${node.id}'`;
  return {
    ...node,
    ...(node.brief === undefined ? {} : { brief: applySlots(node.brief, resolved, scope) }),
    prompt_fragment: applySlots(node.prompt_fragment, resolved, scope),
    llm_calls: node.llm_calls.map((call) => ({
      ...call,
      prompt: applySlots(call.prompt, resolved, scope),
    })),
  };
}

/**
 * Prepare a display-only whole-profile manifest. Unsupported components are
 * represented by a closed unavailable marker; no executable plan is built
 * for them. This must never be used by emit, dispatch, or chat.
 */
export function prepareDisplayManifest(input: Omit<DispatchInput, "componentId" | "question">): PreparedDisplayManifest {
  const ir: WarbleIr = parseIrInput(input.ir);
  assertSupportedIrVersion(ir.warble_ir_version);
  assertComponentCompositionFields(ir);
  const target = input.target ?? DEFAULT_TARGET;
  const models = input.models ?? ModelConfig.default();
  const closure = resolveComponentClosure(ir);

  // Slots are resolved here too, and this path is the reason the policy above is a parameter rather
  // than a constant. THIS BACK-END'S MANIFEST CARRIES PROMPT TEXT (`StepManifest.prompt`), unlike the
  // Rust CLI's, whose schema omits it structurally — so leaving the text unresolved here would both
  // show a reader a placeholder and trip the plan guard, which is unconditional by design. A display
  // is not a model, so an unanswered condition renders its default instead of failing: what it shows
  // is what the default binding would say, never a promise about what will be sent.
  const supply = input.slots ?? {};
  const components: DisplayComponent[] = ir.components.map((node) => {
    const resolved = resolveSlotsForNode(node, ir, supply, "default");
    const withSlots = resolved === null ? node : applyNodeSlots(node, resolved);
    const report = inspectNodeCapabilities(withSlots, target);
    let modelReady = true;
    try {
      models.validate({ ...ir, components: [withSlots] });
    } catch {
      modelReady = false;
    }
    if (
      !modelReady ||
      report.some((entry) => entry.outcome === "fail")
    ) {
      return {
        id: withSlots.id,
        node: withSlots,
        inspection: report,
        availability: { status: "unavailable", reason: UNAVAILABLE_COMPONENT_REASON },
      };
    }
    // The plan is built (so an unsupported enum still wall-hits here, as it does for `emit`) and
    // then dropped — see `AvailableDisplayComponent` for why it must not travel.
    const prepared = buildPreparedComponent(withSlots, report, input, target, models, withSlots.entrypoint ? "entry" : "callee");
    return { id: prepared.id, node: prepared.node, report: prepared.report };
  });
  return {
    target,
    profile: ir.profile,
    components,
    entries: closure.entries,
    dependencies: closure.dependencies,
  };
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
 * Verify every reachable mount's travelling assets without writing them. This is intentionally a
 * separate executable preflight from pure graph preparation: it reads the filesystem, but still
 * completes before a model, session, output directory, or asset target is created.
 */
export function preflightDispatchAssets(
  input: DispatchInput,
  prepared: PreparedDispatch,
): void {
  const all = [...new Map(
    [...prepared.components, ...prepared.preparedCallees].map((component) => [component.id, component]),
  ).values()];
  if (!all.some((component) => (component.node.assets?.length ?? 0) > 0)) return;
  if (!input.irPath) {
    throw new DispatchError(
      "reachable components declare assets, but executable preparation has no irPath from which to resolve the travelling asset directory",
    );
  }
  const ir = parseIrInput(input.ir);
  for (const component of all) {
    if ((component.node.assets?.length ?? 0) === 0) continue;
    validateAssets(
      { ...ir, components: [component.node] },
      input.irPath,
      component.plan.options.cwd ?? process.cwd(),
    );
  }
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
  preflightDispatchAssets(input, prepared);
  const warbleBin = runCfg.warbleBin ?? "warble";

  const components: ComponentOutcome[] = [];
  for (const c of prepared.components) {
    const result = await runDispatch(c.plan, {
      outDir: runCfg.outDir,
      warbleBin,
      ...(input.irPath
        ? { assets: { ir: { ...parseIrInput(input.ir), components: [c.node] }, irPath: input.irPath } }
        : {}),
      ...(runCfg.title ? { title: runCfg.title } : {}),
    });
    components.push({ id: c.id, report: c.report, plan: c.plan, result });
  }
  return { target: prepared.target, components };
}
