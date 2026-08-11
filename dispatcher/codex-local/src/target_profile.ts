import { CodexDispatchError } from "./error.js";
import type { Guardrail } from "./ir.js";

// This module is codex:local's single answer to two questions every family validator used to
// answer separately: "what can this target honestly realize, and how" (capability →
// realization) and "what does a guardrail occurrence have to look like to count as enforced"
// (guardrail → enforcement). Setup, Ask, and Enrich preparers all read from here instead of
// each carrying its own literal capability sets and scattered guardrail assertions.
//
// codex:local's honesty posture is deliberate and non-negotiable: only `llm:*` capabilities
// resolve `native`; every domain capability resolves `realize-via` an allowlisted MCP tool.
// Codex child agents have no cwd-scoped native read primitive — unlike claude-agent-sdk's
// SDK-level Read tool — so a domain capability must never be claimed native here, no matter
// how tempting a single shared table makes that alignment look.

export type CapabilityOutcome = "native" | "realize-via";

export interface CapabilityResolution {
  capability: string;
  outcome: CapabilityOutcome;
  via: string | null;
}

interface CapabilityRealizationEntry {
  outcome: CapabilityOutcome;
  /** A fixed native `via`, or a function of the invocation's configured MCP server name. */
  via: string | null | ((mcpName: string) => string);
}

const mcpVia = (mcpName: string): string => `mcp:${mcpName}`;

/** The target-level table: every capability codex:local can honestly resolve, and how. */
export const CAPABILITY_REALIZATION: Readonly<Record<string, CapabilityRealizationEntry>> = {
  "llm:strong": { outcome: "native", via: null },
  "llm:cheap": { outcome: "native", via: null },
  "llm:per_step_tier": { outcome: "native", via: null },
  source_connect: { outcome: "realize-via", via: mcpVia },
  context_build: { outcome: "realize-via", via: mcpVia },
  semantic_introspection: { outcome: "realize-via", via: mcpVia },
  raw_material_read: { outcome: "realize-via", via: mcpVia },
  "sql_execution:read_only": { outcome: "realize-via", via: mcpVia },
  genbi_build: { outcome: "native", via: "validated-render-envelope" },
  render_contract: { outcome: "native", via: "validated-render-envelope" },
  artifact_write: { outcome: "realize-via", via: "consumer-persisted-render-envelope" },
};

/**
 * Resolves a component's required capabilities against the target-level table, in the order
 * they were declared. Throws if a capability has no entry — this is a defensive backstop only:
 * every caller validates the exact capability set before reaching this point, so an unresolved
 * capability here means a family's shape check let something through it shouldn't have.
 */
export function resolveCapabilities(
  requiredCapabilities: readonly string[],
  mcpName: string,
): CapabilityResolution[] {
  return requiredCapabilities.map((capability) => {
    const entry = CAPABILITY_REALIZATION[capability];
    if (!entry) {
      throw new CodexDispatchError(`capability '${capability}' has no realization on codex:local`);
    }
    return {
      capability,
      outcome: entry.outcome,
      via: typeof entry.via === "function" ? entry.via(mcpName) : entry.via,
    };
  });
}

/** True iff `requiredCapabilities` is exactly `expected` (same size, same members). */
export function hasExactCapabilities(
  requiredCapabilities: readonly string[],
  expected: ReadonlySet<string>,
): boolean {
  return (
    requiredCapabilities.length === expected.size &&
    requiredCapabilities.every((capability) => expected.has(capability))
  );
}

// --- Setup family capability grouping ---

export const SETUP_DOMAIN_CAPABILITIES = ["source_connect", "context_build"] as const;
export type SetupDomainCapability = (typeof SETUP_DOMAIN_CAPABILITIES)[number];

const SETUP_DOMAIN_CAPABILITY_SET: ReadonlySet<string> = new Set(SETUP_DOMAIN_CAPABILITIES);

export function isSetupDomainCapability(value: string): value is SetupDomainCapability {
  return SETUP_DOMAIN_CAPABILITY_SET.has(value);
}

// --- Ask family capability sets (fixed per execution kind — not derived from the IR) ---

export const ASK_ANSWER_CAPABILITIES: ReadonlySet<string> = new Set([
  "sql_execution:read_only",
  "llm:per_step_tier",
  "llm:strong",
  "llm:cheap",
]);

export const ASK_DASHBOARD_CAPABILITIES: ReadonlySet<string> = new Set([
  "sql_execution:read_only",
  "genbi_build",
  "render_contract",
  "artifact_write",
  "llm:per_step_tier",
  "llm:strong",
  "llm:cheap",
]);

// --- Enrich family capability grouping ---

export const ENRICH_DOMAIN_CAPABILITIES = ["semantic_introspection", "raw_material_read"] as const;
export type EnrichDomainCapability = (typeof ENRICH_DOMAIN_CAPABILITIES)[number];

const ENRICH_DOMAIN_CAPABILITY_SET: ReadonlySet<string> = new Set(ENRICH_DOMAIN_CAPABILITIES);

export function isEnrichDomainCapability(value: string): value is EnrichDomainCapability {
  return ENRICH_DOMAIN_CAPABILITY_SET.has(value);
}

// Deliberately narrower than CAPABILITY_REALIZATION's full key set: some capabilities this
// target can honestly realize for OTHER families (e.g. `context_build`, for Setup) are not
// legal for Enrich's own components. The allowlist must name only what Enrich itself may
// require, so a foreign-but-realizable capability still fails Enrich's by-name check (and does
// so before any shape error can mask which capability was illegal) rather than silently passing
// the name check and only failing later with a message that doesn't name it.
export const ENRICH_ALLOWED_CAPABILITIES: ReadonlySet<string> = new Set<string>([
  ...ENRICH_DOMAIN_CAPABILITIES,
  "llm:cheap",
  "llm:strong",
]);

// --- Guardrail enforcement ---

export interface GuardrailRequirement {
  locked: boolean;
  scope?: string;
  threshold?: number;
}

/** The target-level table: the canonical locked/scope/threshold values for each guardrail name. */
export const GUARDRAIL_ENFORCEMENT: Readonly<Record<string, GuardrailRequirement>> = {
  setup_execution: { locked: true, scope: "." },
  read_only_execution: { locked: true },
  deterministic_gate: { locked: true },
  row_limit: { locked: false, threshold: 1000 },
  statement_timeout: { locked: false, threshold: 30 },
  artifact_write: { locked: true, scope: "." },
};

/**
 * True iff `guard` is present, named `name`, and matches every value `GUARDRAIL_ENFORCEMENT`
 * defines for that name (locked-state always; scope/threshold only when the table defines
 * them for this guardrail — callers that need a stricter check, such as Enrich's requirement
 * that `read_only_execution` carry no scope at all, pass `requireScopeAbsent`).
 */
export function guardrailMatches(
  guard: Guardrail | undefined,
  name: string,
  options?: { requireScopeAbsent?: boolean },
): boolean {
  const requirement = GUARDRAIL_ENFORCEMENT[name];
  if (!requirement || !guard || guard.name !== name || guard.locked !== requirement.locked) {
    return false;
  }
  if (requirement.scope !== undefined && guard.scope !== requirement.scope) {
    return false;
  }
  if (requirement.threshold !== undefined && guard.threshold !== requirement.threshold) {
    return false;
  }
  if (options?.requireScopeAbsent && guard.scope !== undefined) {
    return false;
  }
  return true;
}
