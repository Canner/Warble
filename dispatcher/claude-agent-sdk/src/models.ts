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
 */
import { parse as parseYaml } from "yaml";
import { DispatchError } from "./error.js";
import type { LlmCall, WarbleIr } from "./ir.js";

const STRONG_TIER = "strong";
const CHEAP_TIER = "cheap";
/** Reserved dispatch-role tier for the per-step-tier driver's routing loop (never authored). */
const ORCHESTRATOR_TIER = "orchestrator";

/**
 * An ordered tier→model map. Declaration order is priority: earlier tiers are "stronger" — used to
 * pick the single model when a multi-tier component collapses to one call.
 */
export class ModelConfig {
  /** `[tier name, model alias]` in declaration order (earliest = strongest). */
  private readonly tiers: ReadonlyArray<readonly [string, string]>;

  private constructor(tiers: ReadonlyArray<readonly [string, string]>) {
    this.tiers = tiers;
  }

  /** The Agent SDK defaults, matching the file target: strong→opus, cheap→haiku, orchestrator→sonnet. */
  static default(): ModelConfig {
    return new ModelConfig([
      [STRONG_TIER, "opus"],
      [CHEAP_TIER, "haiku"],
      [ORCHESTRATOR_TIER, "sonnet"],
    ]);
  }

  /** Build from the inline `--strong/--cheap/--orchestrator` flags. */
  static fromFlags(strong: string, cheap: string, orchestrator: string): ModelConfig {
    return new ModelConfig([
      [STRONG_TIER, strong],
      [CHEAP_TIER, cheap],
      [ORCHESTRATOR_TIER, orchestrator],
    ]);
  }

  /**
   * Parse a `--models-config` YAML document — the same shape the file target accepts:
   *
   * ```yaml
   * tiers:
   *   strong: opus
   *   cheap: haiku
   *   local: qwen2.5        # custom tiers allowed
   *   orchestrator: sonnet  # reserved: the per-step-tier driver
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
    const tiers: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(tiersRaw)) {
      if (typeof value !== "string") {
        throw new DispatchError(`models config: tier '${name}' must map to a model alias string`);
      }
      tiers.push([name, value]);
    }
    if (tiers.length === 0) {
      throw new DispatchError("models config: `tiers` must not be empty");
    }
    return new ModelConfig(tiers);
  }

  private modelFor(tier: string): string | undefined {
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
    const model = this.modelFor(tier);
    if (model === undefined) {
      throw new DispatchError(
        `tier '${tier}' has no model binding — define it in --models-config or via ` +
          `--strong/--cheap (known tiers: ${this.tierNames()})`,
      );
    }
    return model;
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
