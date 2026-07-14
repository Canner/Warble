/**
 * Typed view of the Warble IR (`warble_ir_version` 0.1 / 0.2) that this back-end consumes.
 *
 * Mirrors `docs/spec/ir-schema.md` field-for-field — the SAME contract the Rust `claude-code-cli`
 * back-end reads (`dispatcher/claude-code-cli/src/ir.rs`). The IR JSON is the language-neutral seam:
 * this module depends on the schema doc, not on the front-end's Rust types, and never links the Rust
 * core. That a TypeScript runtime consumes the identical `ir.json` a Rust front-end emits is exactly
 * what this back-end exists to prove (plan §1).
 *
 * Enum values not yet realized by this target are rejected at dispatch time (a "wall-hit"), not
 * here: parsing accepts every schema-valid value so the loud-fail names the *capability*, not a
 * deserialization error.
 */
import { DispatchError } from "./error.js";

/** `realization_kind` — how a component is realized. */
export type RealizationKind = "skill" | "tool" | "gated-tool";

/** Component family. */
export type ComponentType =
  | "analytical"
  | "assertive"
  | "mutating"
  | "constitutive"
  | "orchestrating";

/** `trigger.kind`. */
export type TriggerKind = "one_shot" | "scheduled" | "event";

/** `effect.outcome.kind`. */
export type OutcomeKind = "none" | "assertion" | "mutation" | "dispatch";

export const REALIZATION_KINDS: readonly RealizationKind[] = ["skill", "tool", "gated-tool"];
export const COMPONENT_TYPES: readonly ComponentType[] = [
  "analytical",
  "assertive",
  "mutating",
  "constitutive",
  "orchestrating",
];
export const TRIGGER_KINDS: readonly TriggerKind[] = ["one_shot", "scheduled", "event"];
export const OUTCOME_KINDS: readonly OutcomeKind[] = ["none", "assertion", "mutation", "dispatch"];

export interface ContextBinding {
  project: string;
  binding_mode: string;
  /**
   * Fine-grained resolved binding (IR v0.3): metrics/dimensions/grains + lineage summary the
   * front-end learned from the bound semantic layer. Carried through and tolerated; this back-end
   * does not yet consume it (it drives off the coarse project path).
   */
  resolved?: unknown;
}

export interface IrConfig {
  tier_policy: string | null;
}

/**
 * A per-step LLM call. `tier` is an **open string** (standard core: `strong`/`cheap`; custom names
 * allowed) resolved to a concrete model at dispatch by the model config. The v0.2 named I/O contract
 * (`consumes`/`produces`) + per-step `prompt` make a step realizable in isolation; an in-loop runtime
 * like this one carries context itself and does not need them for single-session delegation.
 */
export interface LlmCall {
  name: string;
  tier: string;
  consumes: string[];
  produces: string | null;
  prompt: string;
  conditional: boolean;
  /**
   * The closed-vocabulary guard deciding whether a `conditional` step runs (IR v0.3+; see
   * `docs/spec/ir-schema.md`). Carried through additively — this back-end does not yet realize it
   * (the staged executor still treats `conditional` as an opaque flag); tolerated so the seam
   * stays forward-compatible with back-ends that do.
   */
  when: WhenGuard | null;
}

/**
 * A closed-vocabulary guard on a conditional `llm_call`: `guard` is one of `on_failure` /
 * `on_flag` / `on_missing`, `target` is the guard-specific argument. See `docs/spec/ir-schema.md`.
 */
export interface WhenGuard {
  guard: string;
  target: string;
}

export interface Guardrail {
  name: string;
  locked: boolean;
  scope: string | null;
  threshold?: unknown;
}

/** A context precondition a component requires to hold before it runs (e.g. `has_metric`). */
export interface Precondition {
  predicate: string;
  args?: Record<string, unknown>;
}

/**
 * A component parameter, either bound at dispatch time (`bind`, with an optional `default`) or
 * sourced from context (`source`). Exactly one of `bind`/`source` is expected per the schema.
 */
export interface ParamSpec {
  name: string;
  bind?: string;
  source?: string;
  default?: unknown;
}

/** An authored evaluation spec: which eval template to run and which metrics it scores. */
export interface EvalSpec {
  template_ref: string;
  metrics: string[];
}

export interface Trigger {
  kind: TriggerKind;
}

/** A typed render block: a type plus its field-name → field-type schema (echoed verbatim). */
export interface RenderBlock {
  type: string;
  fields: Record<string, string>;
}

export interface Outcome {
  kind: OutcomeKind;
  verdict_type?: string;
  emits?: string[];
  target?: string;
  change_type?: string;
  routable_scope?: unknown;
}

export interface Effect {
  render_blocks: RenderBlock[];
  outcome: Outcome;
}

/** One evaluated `context_precondition` and its outcome (IR v0.3: structured, was a string list). */
export interface PreconditionCheck {
  predicate: string;
  outcome: string;
}

export interface PreconditionResult {
  status: string;
  checks: PreconditionCheck[];
}

export interface ComponentNode {
  id: string;
  verb: string;
  type: ComponentType;
  realization_kind: RealizationKind;
  context_binding: ContextBinding;
  precondition_result: PreconditionResult;
  prompt_fragment: string;
  llm_calls: LlmCall[];
  guardrails: Guardrail[];
  trigger: Trigger;
  required_capabilities: string[];
  borrowed_actions: string[];
  eval_ref: string;
  effect: Effect;
  context_requirements: string[];
  context_precondition: Precondition[];
  params: ParamSpec[];
  eval: EvalSpec | null;
}

export interface WarbleIr {
  warble_ir_version: string;
  profile: string;
  context_binding: ContextBinding;
  config: IrConfig;
  components: ComponentNode[];
}

/**
 * IR versions this back-end understands. 0.2 is additive over 0.1 (per-step I/O contract + prompt);
 * both parse. An unrecognized version is a loud-fail rather than a silent best-effort read.
 */
export const SUPPORTED_IR_VERSIONS: readonly string[] = ["0.1", "0.2", "0.3"];

// --- minimal runtime validation (the seam has no compile-time guarantee across the JSON boundary) --
//
// We validate presence + type of the load-bearing fields and enum membership only. We do NOT re-run
// the front-end's compile-time checks (bind-required, locked-guardrail override, precondition) —
// the IR is already resolved; those are the compiler's responsibility (plan §4.1).

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new DispatchError(`invalid IR: ${message}`);
}

function requireObject(value: unknown, at: string): Json {
  if (!isObject(value)) fail(`${at} must be an object`);
  return value;
}

function requireString(obj: Json, key: string, at: string): string {
  const value = obj[key];
  if (typeof value !== "string") fail(`${at}.${key} must be a string`);
  return value;
}

function requireBool(obj: Json, key: string, at: string): boolean {
  const value = obj[key];
  if (typeof value !== "boolean") fail(`${at}.${key} must be a boolean`);
  return value;
}

function optString(obj: Json, key: string): string | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail(`${key} must be a string when present`);
  return value;
}

/** Like {@link optString}, but returns `undefined` (not `null`) when absent — for `?:` fields. */
function optStringU(obj: Json, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(`${key} must be a string when present`);
  return value;
}

/** Array of strings defaulting to `undefined` (not `[]`) when absent — for `?:` array fields. */
function optStringArrayU(obj: Json, key: string, at: string): string[] | undefined {
  if (obj[key] === undefined || obj[key] === null) return undefined;
  return requireArray(obj, key, at).map((v, i) => {
    if (typeof v !== "string") fail(`${at}.${key}[${i}] must be a string`);
    return v;
  });
}

/** Boolean defaulting to `false` when the key is absent (matches serde `#[serde(default)]`). */
function boolWithDefault(obj: Json, key: string, at: string): boolean {
  const value = obj[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean") fail(`${at}.${key} must be a boolean when present`);
  return value;
}

function requireArray(obj: Json, key: string, at: string): unknown[] {
  const value = obj[key];
  if (!Array.isArray(value)) fail(`${at}.${key} must be an array`);
  return value;
}

/** Array of strings, defaulting to `[]` when the key is absent (matches serde `#[serde(default)]`). */
function stringArray(obj: Json, key: string, at: string): string[] {
  if (obj[key] === undefined) return [];
  return requireArray(obj, key, at).map((v, i) => {
    if (typeof v !== "string") fail(`${at}.${key}[${i}] must be a string`);
    return v;
  });
}

function requireEnum<T extends string>(
  obj: Json,
  key: string,
  at: string,
  allowed: readonly T[],
): T {
  const value = requireString(obj, key, at);
  if (!(allowed as readonly string[]).includes(value)) {
    fail(`${at}.${key} '${value}' is not one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function parseContextBinding(value: unknown, at: string): ContextBinding {
  const obj = requireObject(value, at);
  return {
    project: requireString(obj, "project", at),
    binding_mode: requireString(obj, "binding_mode", at),
    // v0.3 fine-grained resolved binding; carried opaquely (not consumed by this back-end).
    resolved: obj["resolved"],
  };
}

function parseChecks(obj: Json, at: string): PreconditionCheck[] {
  if (obj["checks"] === undefined) return [];
  return requireArray(obj, "checks", at).map((c, i) => {
    const check = requireObject(c, `${at}.checks[${i}]`);
    return {
      predicate: requireString(check, "predicate", `${at}.checks[${i}]`),
      outcome: requireString(check, "outcome", `${at}.checks[${i}]`),
    };
  });
}

function parseWhenGuard(value: unknown, at: string): WhenGuard {
  const obj = requireObject(value, at);
  return {
    guard: requireString(obj, "guard", at),
    target: requireString(obj, "target", at),
  };
}

function parseLlmCall(value: unknown, at: string): LlmCall {
  const obj = requireObject(value, at);
  const whenRaw = obj["when"];
  return {
    name: requireString(obj, "name", at),
    tier: requireString(obj, "tier", at),
    consumes: stringArray(obj, "consumes", at),
    produces: optString(obj, "produces"),
    prompt: requireString(obj, "prompt", at),
    conditional: boolWithDefault(obj, "conditional", at),
    when:
      whenRaw === undefined || whenRaw === null ? null : parseWhenGuard(whenRaw, `${at}.when`),
  };
}

function parseGuardrail(value: unknown, at: string): Guardrail {
  const obj = requireObject(value, at);
  return {
    name: requireString(obj, "name", at),
    locked: requireBool(obj, "locked", at),
    scope: optString(obj, "scope"),
    threshold: obj["threshold"],
  };
}

function parsePrecondition(value: unknown, at: string): Precondition {
  const obj = requireObject(value, at);
  const argsRaw = obj["args"];
  const args =
    argsRaw === undefined || argsRaw === null
      ? undefined
      : (requireObject(argsRaw, `${at}.args`) as Record<string, unknown>);
  return { predicate: requireString(obj, "predicate", at), args };
}

function parseParamSpec(value: unknown, at: string): ParamSpec {
  const obj = requireObject(value, at);
  return {
    name: requireString(obj, "name", at),
    bind: optStringU(obj, "bind"),
    source: optStringU(obj, "source"),
    default: obj["default"],
  };
}

function parseEvalSpec(value: unknown, at: string): EvalSpec {
  const obj = requireObject(value, at);
  return {
    template_ref: requireString(obj, "template_ref", at),
    metrics: stringArray(obj, "metrics", at),
  };
}

/** Array of {@link Precondition}s, defaulting to `[]` when the key is absent. */
function preconditionArray(obj: Json, key: string, at: string): Precondition[] {
  if (obj[key] === undefined) return [];
  return requireArray(obj, key, at).map((v, i) => parsePrecondition(v, `${at}.${key}[${i}]`));
}

/** Array of {@link ParamSpec}s, defaulting to `[]` when the key is absent. */
function paramArray(obj: Json, key: string, at: string): ParamSpec[] {
  if (obj[key] === undefined) return [];
  return requireArray(obj, key, at).map((v, i) => parseParamSpec(v, `${at}.${key}[${i}]`));
}

function parseRenderBlock(value: unknown, at: string): RenderBlock {
  const obj = requireObject(value, at);
  const fieldsRaw = obj["fields"];
  const fields: Record<string, string> = {};
  if (fieldsRaw !== undefined) {
    const fieldsObj = requireObject(fieldsRaw, `${at}.fields`);
    for (const [k, v] of Object.entries(fieldsObj)) {
      if (typeof v !== "string") fail(`${at}.fields.${k} must be a string`);
      fields[k] = v;
    }
  }
  return { type: requireString(obj, "type", at), fields };
}

function parseOutcome(value: unknown, at: string): Outcome {
  const obj = requireObject(value, at);
  return {
    kind: requireEnum(obj, "kind", at, OUTCOME_KINDS),
    verdict_type: optStringU(obj, "verdict_type"),
    emits: optStringArrayU(obj, "emits", at),
    target: optStringU(obj, "target"),
    change_type: optStringU(obj, "change_type"),
    routable_scope: obj["routable_scope"],
  };
}

function parseEffect(value: unknown, at: string): Effect {
  const obj = requireObject(value, at);
  const blocks =
    obj["render_blocks"] === undefined
      ? []
      : requireArray(obj, "render_blocks", at).map((b, i) =>
          parseRenderBlock(b, `${at}.render_blocks[${i}]`),
        );
  return {
    render_blocks: blocks,
    outcome: parseOutcome(obj["outcome"], `${at}.outcome`),
  };
}

function parseComponent(value: unknown, at: string): ComponentNode {
  const obj = requireObject(value, at);
  const precondition = requireObject(obj["precondition_result"], `${at}.precondition_result`);
  const trigger = requireObject(obj["trigger"], `${at}.trigger`);
  return {
    id: requireString(obj, "id", at),
    verb: requireString(obj, "verb", at),
    type: requireEnum(obj, "type", at, COMPONENT_TYPES),
    realization_kind: requireEnum(obj, "realization_kind", at, REALIZATION_KINDS),
    context_binding: parseContextBinding(obj["context_binding"], `${at}.context_binding`),
    precondition_result: {
      status: requireString(precondition, "status", `${at}.precondition_result`),
      checks: parseChecks(precondition, `${at}.precondition_result`),
    },
    prompt_fragment: requireString(obj, "prompt_fragment", at),
    llm_calls: requireArray(obj, "llm_calls", at).map((c, i) =>
      parseLlmCall(c, `${at}.llm_calls[${i}]`),
    ),
    guardrails: requireArray(obj, "guardrails", at).map((g, i) =>
      parseGuardrail(g, `${at}.guardrails[${i}]`),
    ),
    trigger: { kind: requireEnum(trigger, "kind", `${at}.trigger`, TRIGGER_KINDS) },
    required_capabilities: stringArray(obj, "required_capabilities", at),
    borrowed_actions: stringArray(obj, "borrowed_actions", at),
    eval_ref: requireString(obj, "eval_ref", at),
    effect: parseEffect(obj["effect"], `${at}.effect`),
    context_requirements: stringArray(obj, "context_requirements", at),
    context_precondition: preconditionArray(obj, "context_precondition", at),
    params: paramArray(obj, "params", at),
    eval:
      obj["eval"] === undefined || obj["eval"] === null
        ? null
        : parseEvalSpec(obj["eval"], `${at}.eval`),
  };
}

/**
 * Parse + validate a Warble IR JSON document. Throws a {@link DispatchError} (loud-fail) on an
 * unsupported version, a missing/mistyped load-bearing field, or an out-of-vocabulary enum value.
 */
export function parseIr(json: string): WarbleIr {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch (e) {
    fail(`not valid JSON: ${(e as Error).message}`);
  }
  const obj = requireObject(root, "<root>");

  const version = requireString(obj, "warble_ir_version", "<root>");
  if (!SUPPORTED_IR_VERSIONS.includes(version)) {
    throw new DispatchError(
      `unsupported warble_ir_version '${version}' (this back-end understands: ${SUPPORTED_IR_VERSIONS.join(", ")})`,
    );
  }

  const configRaw = obj["config"];
  const config: IrConfig = { tier_policy: null };
  if (configRaw !== undefined) {
    const c = requireObject(configRaw, "config");
    config.tier_policy = optString(c, "tier_policy");
  }

  return {
    warble_ir_version: version,
    profile: requireString(obj, "profile", "<root>"),
    context_binding: parseContextBinding(obj["context_binding"], "context_binding"),
    config,
    components: requireArray(obj, "components", "<root>").map((c, i) =>
      parseComponent(c, `components[${i}]`),
    ),
  };
}

/** Distinct tier names across a node's `llm_calls`, order-preserving. */
export function distinctTiers(calls: readonly LlmCall[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const call of calls) {
    if (!seen.has(call.tier)) {
      seen.add(call.tier);
      out.push(call.tier);
    }
  }
  return out;
}
