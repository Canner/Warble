/**
 * Tier → concrete model binding, resolved at **dispatch** (the runtime-injected mapping).
 *
 * TS sibling of the Rust file target's `models.rs`, and deliberately the same concept + the same
 * `--models-config` YAML format (plan decision #6): a tier travels in the IR as a name
 * (`strong`/`cheap`, or custom); which model it becomes is decided here, not in the IR, so the same
 * compiled IR runs against different models (the axis the eval loop ablates). A tier with no mapping
 * is a loud-fail.
 *
 * For the Agent SDK target a tier maps to a **model alias/id** passed to `query({ options.model })`
 * (top-level, free-form). The per-step-tier `agents[].model` field is a restricted alias union
 * (`sonnet|opus|haiku|inherit`) — see SDK-NOTES.md; the standard core tiers map onto it, custom
 * tiers on that path do not (handled in run.ts).
 *
 * **This is one of two implementations of the single, versioned binding spec** documented in
 * `docs/spec/binding-spec.md` (the authoritative source; the Rust sibling is
 * `dispatcher/claude-code-cli/src/models.rs`). `BINDING_SPEC_VERSION` must match the version
 * declared in that doc and in the Rust file — bump all three together.
 */
import { parse as parseYaml } from "yaml";
import { DispatchError } from "./error.js";
import type { LlmCall, WarbleIr } from "./ir.js";

const STRONG_TIER = "strong";
const CHEAP_TIER = "cheap";
/** Reserved dispatch-role tier for the per-step-tier driver's routing loop (never authored). */
const ORCHESTRATOR_TIER = "orchestrator";

/** The binding spec version this module implements — see `docs/spec/binding-spec.md`, the
 * authoritative, versioned source both back-ends conform to (kept in lockstep to avoid the IR's
 * own version-drift history). */
export const BINDING_SPEC_VERSION = "1.0";

/** Well-known provider name: rides the Claude runtime (the default when `provider` is absent). */
export const ANTHROPIC_PROVIDER = "anthropic";
/** Well-known provider name: an OpenAI-compatible endpoint (e.g. ollama's `/v1`); requires `endpoint`. */
export const OPENAI_COMPAT_PROVIDER = "openai_compat";

/**
 * Which provider serves a tier's model — an **open string**, opaque to warble (mirrors how the IR
 * treats `tier`; see `docs/spec/binding-spec.md`). Two well-known values get behavior baked into
 * `TierBinding` parsing below (`ANTHROPIC_PROVIDER`, the default; `OPENAI_COMPAT_PROVIDER`, which
 * requires `endpoint`), but warble does **not** validate this field against a fixed provider list —
 * any other string is a valid, warble-unrecognized provider that passes through unchanged.
 * Rejecting a genuinely unsupported provider is the consuming harness/back-end's adapter registry's
 * job (`oss-wrenai-harness-target.md` §8.2), never warble's — warble stays opaque pass-through.
 */
export type Provider = string;

/**
 * A tier's full runtime binding: which `provider` serves it, at what `endpoint` (OpenAI-compat only),
 * running which `model`. The shorthand YAML form `tier: <model>` is `{ provider: 'anthropic',
 * endpoint: null, model }` — so existing configs (and every all-cloud path) are byte-for-byte
 * unchanged. Per-step provider routing (D4) reads `provider`/`endpoint`; `require()` reads `model`.
 */
export interface TierBinding {
  provider: Provider;
  endpoint: string | null;
  model: string;
}

function anthropicBinding(model: string): TierBinding {
  return { provider: ANTHROPIC_PROVIDER, endpoint: null, model };
}

/**
 * An ordered tier→binding map. Declaration order is priority: earlier tiers are "stronger" — used to
 * pick the single model when a multi-tier component collapses to one call.
 */
export class ModelConfig {
  /** `[tier name, binding]` in declaration order (earliest = strongest). */
  private readonly tiers: ReadonlyArray<readonly [string, TierBinding]>;

  private constructor(tiers: ReadonlyArray<readonly [string, TierBinding]>) {
    this.tiers = tiers;
  }

  /** The Agent SDK defaults, matching the file target: strong→opus, cheap→haiku, orchestrator→sonnet. */
  static default(): ModelConfig {
    return new ModelConfig([
      [STRONG_TIER, anthropicBinding("opus")],
      [CHEAP_TIER, anthropicBinding("haiku")],
      [ORCHESTRATOR_TIER, anthropicBinding("sonnet")],
    ]);
  }

  /**
   * Build from the inline `--strong/--cheap/--orchestrator` flags. Inline flags are always
   * Anthropic-provider aliases — provider/endpoint routing is `--models-config` only, so a non-alias
   * inline flag still loud-fails on the SDK split path (unchanged behavior).
   */
  static fromFlags(strong: string, cheap: string, orchestrator: string): ModelConfig {
    return new ModelConfig([
      [STRONG_TIER, anthropicBinding(strong)],
      [CHEAP_TIER, anthropicBinding(cheap)],
      [ORCHESTRATOR_TIER, anthropicBinding(orchestrator)],
    ]);
  }

  /**
   * Parse a `--models-config` YAML document — the same shape the file target accepts. A tier value is
   * EITHER a bare model-alias string (Anthropic shorthand) OR a `{ provider, endpoint?, model }` map:
   *
   * ```yaml
   * tiers:
   *   strong: opus                          # shorthand ⇒ provider: anthropic
   *   cheap:                                # structured binding (§9.2 layer 3)
   *     provider: openai_compat
   *     endpoint: http://localhost:11434/v1
   *     model: qwen2.5
   *   orchestrator: sonnet                  # reserved: the per-step-tier driver
   * ```
   */
  static fromYaml(text: string): ModelConfig {
    let doc: unknown;
    try {
      doc = parseYaml(text);
    } catch (e) {
      throw new DispatchError(`invalid models config: ${(e as Error).message}`);
    }
    if (typeof doc !== "object" || doc === null) {
      throw new DispatchError("invalid models config: expected a mapping with a `tiers:` key");
    }
    const tiersRaw = (doc as Record<string, unknown>)["tiers"];
    if (typeof tiersRaw !== "object" || tiersRaw === null || Array.isArray(tiersRaw)) {
      throw new DispatchError("models config: `tiers` must be a mapping");
    }
    const tiers: Array<[string, TierBinding]> = [];
    for (const [name, value] of Object.entries(tiersRaw)) {
      tiers.push([name, parseTierValue(name, value)]);
    }
    if (tiers.length === 0) {
      throw new DispatchError("models config: `tiers` must not be empty");
    }
    return new ModelConfig(tiers);
  }

  private bindingFor(tier: string): TierBinding | undefined {
    return this.tiers.find(([name]) => name === tier)?.[1];
  }

  /** Priority rank of a tier (declaration order); unknown tiers rank last. */
  private rank(tier: string): number {
    const idx = this.tiers.findIndex(([name]) => name === tier);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  }

  private tierNames(): string {
    return this.tiers.map(([name]) => name).join(", ");
  }

  /** The model a tier maps to, or a loud-fail naming the undefined tier. */
  require(tier: string): string {
    return this.binding(tier).model;
  }

  /**
   * The full `{provider, endpoint, model}` binding a tier maps to (§9.2 layer 3), or a loud-fail.
   * The per-step provider router (route.ts) reads this to send a step cloud-vs-local.
   */
  binding(tier: string): TierBinding {
    const b = this.bindingFor(tier);
    if (b === undefined) {
      throw new DispatchError(
        `tier '${tier}' has no model binding — define it in --models-config or via ` +
          `--strong/--cheap (known tiers: ${this.tierNames()})`,
      );
    }
    return b;
  }

  /** The model for the reserved `orchestrator` tier, or a loud-fail if a config omitted it. */
  orchestrator(): string {
    return this.require(ORCHESTRATOR_TIER);
  }

  /** The model for a single collapsed call: the strongest (lowest-rank) tier among the calls. */
  collapsedModel(calls: readonly LlmCall[]): string {
    if (calls.length === 0) {
      throw new DispatchError("component has no llm_calls; cannot select a model");
    }
    let strongest = calls[0]!;
    for (const call of calls) {
      if (this.rank(call.tier) < this.rank(strongest.tier)) strongest = call;
    }
    return this.require(strongest.tier);
  }

  /** Validate every step tier in the IR maps to a model (front-loaded so dispatch is infallible). */
  validate(ir: WarbleIr): void {
    const checked = new Set<string>();
    for (const node of ir.components) {
      for (const call of node.llm_calls) {
        if (!checked.has(call.tier)) {
          checked.add(call.tier);
          this.require(call.tier);
        }
      }
    }
  }
}

/** A tier value: a bare model-alias string (Anthropic shorthand) or a `{provider, endpoint?, model}` map. */
function parseTierValue(name: string, value: unknown): TierBinding {
  if (typeof value === "string") {
    return anthropicBinding(value);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DispatchError(
      `models config: tier '${name}' must be a model-alias string or a {provider, endpoint?, model} map`,
    );
  }
  const map = value as Record<string, unknown>;
  const model = map["model"];
  if (typeof model !== "string") {
    throw new DispatchError(`models config: tier '${name}' map is missing a string \`model\``);
  }
  // `provider` is an open string (opaque pass-through) — any value parses; only the two
  // well-known names get special handling (default / endpoint requirement) below.
  const providerRaw = map["provider"];
  let provider: Provider = ANTHROPIC_PROVIDER;
  if (providerRaw !== undefined) {
    if (typeof providerRaw !== "string") {
      throw new DispatchError(`models config: tier '${name}' has a non-string \`provider\``);
    }
    provider = providerRaw;
  }
  const endpointRaw = map["endpoint"];
  const endpoint = typeof endpointRaw === "string" ? endpointRaw : null;
  if (provider === OPENAI_COMPAT_PROVIDER && endpoint === null) {
    throw new DispatchError(
      `models config: tier '${name}' uses provider openai_compat but has no \`endpoint\``,
    );
  }
  return { provider, endpoint, model };
}
