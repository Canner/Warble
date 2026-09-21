import { CodexDispatchError } from "./error.js";
import type { ComponentNode, Guardrail } from "./ir.js";

// This module is codex:local's single answer to two questions every family validator used to
// answer separately: "what can this target honestly realize, and how" (capability →
// realization) and "what does a guardrail occurrence have to look like to count as enforced"
// (guardrail → enforcement). Exec, turn, and orchestrate preparers all read from here instead of
// each carrying its own literal capability sets and scattered guardrail assertions.
//
// codex:local's honesty posture is deliberate and non-negotiable: no capability that would
// require a cwd-scoped native read or write primitive is ever claimed native here. Codex
// child agents get only a per-step MCP allowlist and this target has no native read
// primitive — unlike claude-agent-sdk's SDK-level Read tool — so every data/context/
// introspection capability (source_connect, context_build, semantic_introspection,
// raw_material_read, sql_execution:read_only) resolves `realize-via` an allowlisted MCP
// tool, no matter how tempting a single shared table makes native alignment look. This is
// narrower than "only llm:* is native": genbi_build and render_contract are also native,
// because the target validates the render envelope itself and borrows nothing from an MCP
// tool to do it; artifact_write stays realize-via because the consumer persists the
// artifact, never this target.

export type CapabilityOutcome = "native" | "realize-via";

export interface CapabilityResolution {
  capability: string;
  outcome: CapabilityOutcome;
  via: string | null;
}

interface CapabilityRealizationEntry {
  outcome: CapabilityOutcome | "fail";
  /** A fixed native `via`, or a function of the invocation's configured MCP server name. */
  via: string | null | ((mcpName: string) => string);
  note?: string;
}

const mcpVia = (mcpName: string): string => `mcp:${mcpName}`;

/** The target-level table: every capability codex:local can honestly resolve, and how. */
export const CAPABILITY_REALIZATION: Readonly<Record<string, CapabilityRealizationEntry>> = {
  component_invocation: {
    outcome: "realize-via",
    via: "host-scoped-dynamic-alias",
    note: "requires composed orchestrate preflight and the isolated invocation runtime",
  },
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
 * they were declared. Unknown or unsupported capabilities fail; callers do not classify families.
 */
export function resolveCapabilities(
  requiredCapabilities: readonly string[],
  mcpName: string,
): CapabilityResolution[] {
  return requiredCapabilities.map((capability) => {
    const entry = Object.hasOwn(CAPABILITY_REALIZATION, capability) ? CAPABILITY_REALIZATION[capability] : undefined;
    if (!entry) {
      throw new CodexDispatchError(`capability '${capability}' has no realization on codex:local`);
    }
    if (entry.outcome === "fail") {
      throw new CodexDispatchError(
        `capability '${capability}' resolves fail on codex:local (${entry.note ?? "unsupported"})`,
      );
    }
    return {
      capability,
      outcome: entry.outcome,
      via: typeof entry.via === "function" ? entry.via(mcpName) : entry.via,
    };
  });
}

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
 * them for this guardrail — callers that need a stricter check, such as turn's requirement
 * that `read_only_execution` carry no scope at all, pass `requireScopeAbsent`).
 */
export function guardrailMatches(
  guard: Guardrail | undefined,
  name: string,
  options?: { requireScopeAbsent?: boolean },
): boolean {
  const requirement = Object.hasOwn(GUARDRAIL_ENFORCEMENT, name) ? GUARDRAIL_ENFORCEMENT[name] : undefined;
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

/** Validate declared requirements against target rules, never a component family. */
export function validateRequirements(node: ComponentNode, transport: "exec" | "turn" | "orchestrate", invocation = false): void {
  if (node.required_capabilities.includes("component_invocation") && !invocation) {
    throw new CodexDispatchError("component_invocation requires composed orchestrate bindings (wall-hit)");
  }
  if (new Set(node.required_capabilities).size !== node.required_capabilities.length) {
    throw new CodexDispatchError(`component '${node.id}' wall-hit: duplicate required capability`);
  }
  resolveCapabilities(node.required_capabilities, "preflight");
  for (const step of node.llm_calls) {
    if (step.tier === "per_step_tier") {
      throw new CodexDispatchError(`component '${node.id}' wall-hit: llm:per_step_tier is a tiering capability, not an executable step tier`);
    }
  }
  const names = new Set<string>();
  for (const guard of node.guardrails) {
    if (names.has(guard.name) || !guardrailMatches(guard, guard.name, {
      requireScopeAbsent: transport === "turn" && guard.name === "read_only_execution",
    })) {
      throw new CodexDispatchError(`component '${node.id}' wall-hit: unsupported guardrail '${guard.name}' or enforcement parameters`);
    }
    names.add(guard.name);
    if (transport !== "orchestrate" && guard.name === "artifact_write") {
      throw new CodexDispatchError(`component '${node.id}' wall-hit: transport '${transport}' cannot enforce guardrail 'artifact_write'`);
    }
  }
  const capabilities = new Set(node.required_capabilities);
  const requiredGuards = new Set<string>();
  if (capabilities.has("source_connect") || capabilities.has("context_build")) requiredGuards.add("setup_execution");
  if (["semantic_introspection", "raw_material_read", "sql_execution:read_only"].some((capability) => capabilities.has(capability))) requiredGuards.add("read_only_execution");
  if (capabilities.has("artifact_write")) requiredGuards.add("artifact_write");
  if (capabilities.has("sql_execution:read_only") && !capabilities.has("render_contract") && !capabilities.has("artifact_write")) {
    for (const name of ["deterministic_gate", "row_limit", "statement_timeout"]) requiredGuards.add(name);
  }
  for (const name of requiredGuards) {
    if (!names.has(name)) throw new CodexDispatchError(`component '${node.id}' wall-hit: required guardrail '${name}' is missing`);
  }
  // These engines return produced values; only orchestration validates a render envelope.
  if (transport !== "orchestrate" && node.required_capabilities.some((capability) =>
    ["genbi_build", "render_contract", "artifact_write"].includes(capability))) {
    throw new CodexDispatchError(`component '${node.id}' wall-hit: transport '${transport}' cannot enforce render-envelope capabilities`);
  }
}
