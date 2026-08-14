/**
 * The `claude-agent-sdk:local` display manifest — a stable, structural snapshot of a resolved
 * profile (agents / steps / tiers / capabilities / guardrails) for THIS target, so a consumer can
 * source a "what will run" display from whichever back-end actually runs, instead of always
 * reading the vercel bundle target's output even when this back-end is the one dispatching.
 *
 * Field-for-field port of the vercel bundle target's assembly (`dispatcher/vercel/src/{bundle,
 * guardrails,schema,classify,emit}.rs`), driven off the same parsed IR + `ResolutionReport` this
 * back-end already produces via `prepareDispatch` — no shelling out to the Rust binary, and no
 * shared code between the two ports (each is a small, pure derivation from the same IR seam, kept
 * independently portable per language).
 */
import type { ComponentNode, Effect, Guardrail, RenderBlock } from "./ir.js";
import { parseIr } from "./ir.js";
import { collectRequiredCapabilities, type ResolutionReport } from "./resolve.js";
import type { DisplayComponent, PreparedComponent, PreparedDisplayManifest, PreparedDispatch, UnavailableDisplayComponent } from "./dispatch.js";

/** This manifest format's own version — bumped when its shape changes, independent of the IR
 * version and of the vercel bundle format's own version. */
export const MANIFEST_VERSION = "0.1";

/** The IR version window this manifest format was built against — a consumer checks a manifest's
 * own compat window, not the source IR's declared version. Mirrors the vercel bundle target's
 * `MIN/MAX_SUPPORTED_IR_VERSION` (`dispatcher/vercel/src/emit.rs`); kept in sync by hand since the
 * two are independent ports of the same policy, not shared code. */
const MIN_SUPPORTED_IR_VERSION = "0.5";
const MAX_SUPPORTED_IR_VERSION = "0.5";

export interface CompatibilityPolicy {
  min_ir_version: string;
  max_ir_version: string;
}

export interface WhenGuardOut {
  guard: string;
  target: string;
}

/**
 * How a conditional step is realized — mirrors the vercel bundle's `StepRealization` (serde
 * `tag = "kind"`, `snake_case`). `fallback` is omitted (never emitted): the IR has no field
 * declaring one today, matching the Rust port's `skip_serializing_if` behavior.
 */
export type StepRealization =
  | { kind: "independent" }
  | { kind: "repair_fold"; fold_into: string; max_attempts: number; fallback?: string }
  | { kind: "guarded_skip" };

export interface StepManifest {
  name: string;
  tier: string;
  consumes: string[];
  produces?: string;
  prompt: string;
  when?: WhenGuardOut;
  realization: StepRealization;
}

export interface ToolRef {
  name: string;
  source: string;
}

export interface GuardrailManifest {
  enforcement: string;
  locked: boolean;
  scope?: string;
  threshold?: unknown;
}

export interface AvailableAgentManifest {
  id: string;
  verb: string;
  component_type: ComponentNode["type"];
  realization_kind: ComponentNode["realization_kind"];
  trigger: ComponentNode["trigger"]["kind"];
  outcome: ComponentNode["effect"]["outcome"]["kind"];
  steps: StepManifest[];
  guardrails: Record<string, GuardrailManifest>;
  tools: ToolRef[];
  output_schema: unknown;
  capabilities: ResolutionReport;
  brief?: string;
}

/** A display-only declaration of a component that remains unavailable to this target. */
export interface UnavailableAgentManifest {
  id: string;
  verb: string;
  component_type: ComponentNode["type"];
  realization_kind: ComponentNode["realization_kind"];
  trigger: ComponentNode["trigger"]["kind"];
  outcome: ComponentNode["effect"]["outcome"]["kind"];
  /** Fixed empty surfaces: this record can never be treated as an execution plan. */
  steps: [];
  guardrails: Record<string, never>;
  tools: [];
  output_schema: Record<string, never>;
  capabilities: [];
  availability: { status: "unavailable"; reason: string };
}

export type AgentManifest = AvailableAgentManifest | UnavailableAgentManifest;

export interface Manifest {
  manifest_version: string;
  compat: CompatibilityPolicy;
  profile: string;
  target: string;
  agents: AgentManifest[];
}

const DEFAULT_MAX_ATTEMPTS = 1;

/**
 * Structural port of the vercel bundle's `classify_step` (`classify.rs`) — purely an adjacency
 * check over `when.guard`/`when.target`, no `consumes`/`produces` condition. Deliberately NOT the
 * same function as this back-end's own runtime classifier (`conditional.ts::repairFoldTarget`),
 * which has an extra consumes/produces condition and needs live execution state (`GuardState`) —
 * this one classifies statically off the IR alone, so its output matches vercel's field-for-field.
 */
function classifyStep(node: ComponentNode, stepIndex: number): StepRealization {
  const when = node.llm_calls[stepIndex]!.when;
  if (!when) return { kind: "independent" };

  const adjacentPreceding =
    stepIndex > 0 &&
    when.guard === "on_failure" &&
    node.llm_calls[stepIndex - 1]!.name === when.target;

  if (adjacentPreceding) {
    return { kind: "repair_fold", fold_into: when.target, max_attempts: DEFAULT_MAX_ATTEMPTS };
  }
  return { kind: "guarded_skip" };
}

function buildStep(node: ComponentNode, stepIndex: number): StepManifest {
  const call = node.llm_calls[stepIndex]!;
  return {
    name: call.name,
    tier: call.tier,
    consumes: call.consumes,
    ...(call.produces !== null ? { produces: call.produces } : {}),
    prompt: call.prompt,
    ...(call.when ? { when: { guard: call.when.guard, target: call.when.target } } : {}),
    realization: classifyStep(node, stepIndex),
  };
}

/**
 * Port of the vercel bundle's `enforcement_for` (`guardrails.rs`) — a closed vocabulary keyed on
 * the guardrail's *name*, never on the owning component's id/verb.
 */
function enforcementFor(name: string, hasThreshold: boolean): string {
  if (name === "read_only_execution") return "read_only";
  if (name === "artifact_write") return "scoped_write";
  if (
    name.includes("_limit") ||
    name.endsWith("_gate") ||
    name === "deterministic_gate" ||
    name === "additivity_guard"
  ) {
    return hasThreshold ? "threshold_limit" : "gated_check";
  }
  return "generic";
}

function guardrailManifest(g: Guardrail): GuardrailManifest {
  return {
    enforcement: enforcementFor(g.name, g.threshold !== undefined && g.threshold !== null),
    locked: g.locked,
    ...(g.scope !== null ? { scope: g.scope } : {}),
    ...(g.threshold !== undefined && g.threshold !== null ? { threshold: g.threshold } : {}),
  };
}

/** Port of the vercel bundle's `build_guardrails` — one entry per declared guardrail, keyed by
 * name, sorted (mirrors the Rust side's `BTreeMap` — deterministic output). */
function buildGuardrails(node: ComponentNode): Record<string, GuardrailManifest> {
  const out: Record<string, GuardrailManifest> = {};
  for (const g of [...node.guardrails].sort((a, b) => a.name.localeCompare(b.name))) {
    out[g.name] = guardrailManifest(g);
  }
  return out;
}

const PRIMITIVES = new Set(["string", "number", "boolean", "row"]);

function primitiveSchema(name: string): Record<string, unknown> {
  switch (name) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "row":
      return { type: "object" };
    default:
      return { type: "string", enum: [name] };
  }
}

/** Widen a schema's `type` to include `"null"` — port of `schema.rs::make_nullable`. */
function makeNullable(schema: Record<string, unknown>): Record<string, unknown> {
  const type = schema["type"];
  if (type === undefined) return schema;
  let widened: unknown;
  if (typeof type === "string") {
    widened = [type, "null"];
  } else if (Array.isArray(type)) {
    widened = type.includes("null") ? type : [...type, "null"];
  } else {
    widened = type;
  }
  return { ...schema, type: widened };
}

/** Port of `schema.rs::field_type_to_schema` — the render-block field-type grammar (trailing `?`
 * nullable, trailing `[]` array, `|`-union) echoed into JSON Schema. */
function fieldTypeToSchema(typeStr: string): Record<string, unknown> {
  const nullable = typeStr.endsWith("?");
  const base = nullable ? typeStr.slice(0, -1) : typeStr;

  let schema: Record<string, unknown>;
  if (base.endsWith("[]")) {
    schema = { type: "array", items: primitiveSchema(base.slice(0, -2)) };
  } else if (base.includes("|")) {
    const alternatives = base.split("|");
    schema = alternatives.every((alt) => PRIMITIVES.has(alt))
      ? { type: alternatives }
      : { type: "string", enum: alternatives };
  } else {
    schema = primitiveSchema(base);
  }

  return nullable ? makeNullable(schema) : schema;
}

/** Port of `schema.rs::render_block_schema`. */
function renderBlockSchema(block: RenderBlock): Record<string, unknown> {
  const properties: Record<string, unknown> = { type: { const: block.type } };
  const required: string[] = ["type"];
  for (const [name, typeStr] of Object.entries(block.fields).sort(([a], [b]) => a.localeCompare(b))) {
    properties[name] = fieldTypeToSchema(typeStr);
    if (!typeStr.endsWith("?")) required.push(name);
  }
  return { type: "object", properties, required };
}

/** Port of `schema.rs::output_schema_for` — the render-contract Envelope shape (`{blocks,
 * summary, verified}`) every agent's structured output conforms to. */
function outputSchemaFor(effect: Effect): Record<string, unknown> {
  const blockSchemas = effect.render_blocks.map(renderBlockSchema);
  const blocksItems: Record<string, unknown> =
    blockSchemas.length === 0
      ? { type: "object" }
      : blockSchemas.length === 1
        ? blockSchemas[0]!
        : { anyOf: blockSchemas };

  return {
    type: "object",
    properties: {
      blocks: { type: "array", items: blocksItems },
      summary: { type: ["string", "null"] },
      verified: { type: ["boolean", "null"] },
    },
    required: ["blocks"],
  };
}

/**
 * This target's fixed local tool map — unlike the vercel bundle target (which composes a tool map
 * from pluggable per-target **provider** fragments, see `dispatcher/vercel/src/{tools,provider}.rs`),
 * this back-end has exactly one target and drives its own fixed mechanisms directly (the `wren` CLI
 * via Bash, the filesystem, git), so its tool bindings are a fixed table rather than composed. Names
 * mirror the vercel port's shape (a callable `{name, source}` per domain capability); `source` values
 * reuse this back-end's own mechanism labels (`targets.ts::localProfile()`'s `via` strings) rather
 * than vercel's provider-specific ones — the two back-ends are expected to differ in tool *values*,
 * only their *shape* (deduped `{name, source}[]`, non-callable capabilities excluded) needs to match.
 */
const LOCAL_TOOL_MAP: Record<string, ToolRef> = {
  "sql_execution:read_only": { name: "wren_query", source: "bash-wren" },
  genbi_build: { name: "wren_build", source: "bash-wren" },
  semantic_introspection: { name: "wren_context_show", source: "bash-wren" },
  raw_material_read: { name: "read_raw_material", source: "sdk-read" },
  schema_introspection: { name: "wren_context_show", source: "bash-wren" },
  source_connect: { name: "wren_connect", source: "bash-setup" },
  context_build: { name: "wren_context_build", source: "bash-setup" },
  artifact_write: { name: "write_artifact", source: "fs" },
  version_control: { name: "commit", source: "git" },
  scheduler: { name: "schedule", source: "os-cron" },
  event_bus: { name: "publish_event", source: "pub-sub" },
  notify_channel: { name: "notify", source: "mcp-notify" },
};

/** Port of `tools.rs::build_tools` — the de-duplicated list of tool refs `node` needs, derived from
 * its declared + implied required capabilities. Capabilities with no entry in `LOCAL_TOOL_MAP`
 * (LLM tiers, the structured-output contract, authz gates, human approval, blast-radius, …) are
 * intentionally not tools and are skipped, same exclusion set as the vercel port. */
function buildTools(node: ComponentNode): ToolRef[] {
  const seen = new Set<string>();
  const out: ToolRef[] = [];
  for (const capability of collectRequiredCapabilities(node)) {
    const binding = LOCAL_TOOL_MAP[capability];
    if (!binding || seen.has(binding.name)) continue;
    seen.add(binding.name);
    out.push(binding);
  }
  return out;
}

/** Port of `emit.rs::build_agent_bundle`, minus the tool-map parameter (this back-end's is fixed,
 * see `LOCAL_TOOL_MAP`). */
export function buildAgentManifest(component: PreparedComponent): AvailableAgentManifest {
  const node = component.node;
  return {
    id: node.id,
    verb: node.verb,
    component_type: node.type,
    realization_kind: node.realization_kind,
    trigger: node.trigger.kind,
    outcome: node.effect.outcome.kind,
    steps: node.llm_calls.map((_call, i) => buildStep(node, i)),
    guardrails: buildGuardrails(node),
    tools: buildTools(node),
    output_schema: outputSchemaFor(node.effect),
    capabilities: component.report,
    ...(node.brief !== undefined ? { brief: node.brief } : {}),
  };
}

/** Never derives a plan, tool, or capability grant for an unavailable component. */
export function buildUnavailableAgentManifest(component: UnavailableDisplayComponent): UnavailableAgentManifest {
  const node = component.node;
  return {
    id: node.id,
    verb: node.verb,
    component_type: node.type,
    realization_kind: node.realization_kind,
    trigger: node.trigger.kind,
    outcome: node.effect.outcome.kind,
    steps: [],
    guardrails: {},
    tools: [],
    output_schema: {},
    capabilities: [],
    availability: component.availability,
  };
}

/** Build the full display manifest for a `prepareDispatch` result. `raw` is the same IR the
 * dispatch was prepared from — re-parsed here (a second, cheap, pure parse) just to read
 * `profile`, which `PreparedDispatch` does not itself carry. */
export function buildManifest(prepared: PreparedDispatch | PreparedDisplayManifest, raw: string): Manifest {
  const ir = parseIr(raw);
  return {
    manifest_version: MANIFEST_VERSION,
    compat: { min_ir_version: MIN_SUPPORTED_IR_VERSION, max_ir_version: MAX_SUPPORTED_IR_VERSION },
    profile: ir.profile,
    target: prepared.target,
    agents: prepared.components.map((component: DisplayComponent) =>
      "availability" in component ? buildUnavailableAgentManifest(component) : buildAgentManifest(component)),
  };
}
