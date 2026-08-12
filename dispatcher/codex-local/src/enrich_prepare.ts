import { isAbsolute } from "node:path";

import { CodexDispatchError } from "./error.js";
import { assertDispatchableComponentIdentity } from "./dispatch_registry.js";
import {
  parseIr,
  SUPPORTED_IR_VERSION,
  TARGET,
  type ComponentNode,
  type WarbleIr,
} from "./ir.js";
import type { CapabilityResolution } from "./prepare.js";
import {
  ENRICH_ALLOWED_CAPABILITIES,
  guardrailMatches,
  hasExactCapabilities,
  isEnrichDomainCapability,
  resolveCapabilities,
  type EnrichDomainCapability,
} from "./target_profile.js";

export type { EnrichDomainCapability };

export interface EnrichMcpServerConfig {
  name: string;
  command: string;
  args?: string[];
  toolsByCapability: Record<EnrichDomainCapability, string[]>;
}

export interface PreparedEnrichComponent {
  target: typeof TARGET;
  profile: string;
  node: ComponentNode;
  componentId: string;
  domainCapabilities: EnrichDomainCapability[];
  step: ComponentNode["llm_calls"][number];
  capabilities: CapabilityResolution[];
  enabledTools: string[];
  mcp: EnrichMcpServerConfig;
  model: string;
}

export interface PrepareEnrichInput {
  ir: string | WarbleIr;
  component: string;
  model: string;
  mcp: EnrichMcpServerConfig;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function validateEnrichShape(node: ComponentNode): EnrichDomainCapability[] {
  assertDispatchableComponentIdentity(node);
  // Checked first, and by capability name rather than by shape: a component whose
  // required_capabilities include anything outside this target's honestly-guaranteed set for
  // Enrich (e.g. a gated-tool component's context_write_authz/context_validate/context_build/
  // version_control/human_approval) can never be legalized here, no matter what its other IR shape
  // looks like. This keeps the wall-hit deterministic and named, and it must never be relaxed to
  // make a gated-tool component dispatchable.
  for (const capability of node.required_capabilities) {
    if (!ENRICH_ALLOWED_CAPABILITIES.has(capability)) {
      throw new CodexDispatchError(
        `component '${node.id}' cannot be dispatched by codex:local's Enrich prototype: ` +
          `required capability '${capability}' has no honest realization on this target`,
      );
    }
  }
  if (
    node.type !== "analytical" ||
    node.realization_kind !== "skill" ||
    node.trigger.kind !== "one_shot" ||
    node.effect.outcome.kind !== "none"
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Enrich prototype requires analytical/skill/one_shot/none`,
    );
  }
  if (node.context_binding.binding_mode !== "pinned") {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Enrich prototype requires a pinned context binding`,
    );
  }
  if (node.llm_calls.length !== 1) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Enrich prototype requires exactly one llm_call`,
    );
  }
  const step = node.llm_calls[0]!;
  if (
    (step.tier !== "cheap" && step.tier !== "strong") ||
    step.conditional ||
    step.when !== null ||
    step.consumes.length !== 0 ||
    step.produces === null
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Enrich prototype requires one unconditional cheap/strong ` +
        "step with no consumes and one produced slot",
    );
  }
  if (
    node.guardrails.length !== 1 ||
    !guardrailMatches(node.guardrails[0], "read_only_execution", { requireScopeAbsent: true })
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: exactly one locked read_only_execution guardrail with no scope is required`,
    );
  }
  const domainCapabilities = node.required_capabilities.filter(isEnrichDomainCapability);
  if (domainCapabilities.length === 0) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: at least one of semantic_introspection/raw_material_read is required`,
    );
  }
  const expectedLlm = `llm:${step.tier}`;
  if (!node.required_capabilities.includes(expectedLlm)) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: required capability '${expectedLlm}' is missing`,
    );
  }
  const expectedCapabilities = new Set<string>([...domainCapabilities, expectedLlm]);
  if (!hasExactCapabilities(node.required_capabilities, expectedCapabilities)) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Enrich prototype supports exactly ` +
        `'${domainCapabilities.join("', '")}' and '${expectedLlm}' capabilities`,
    );
  }
  return domainCapabilities;
}

export function matchesEnrichContractShape(node: ComponentNode): boolean {
  try {
    validateEnrichShape(node);
    return true;
  } catch (error) {
    if (error instanceof CodexDispatchError) return false;
    throw error;
  }
}

/**
 * The specific reason a component's IR shape does not match the Enrich contract, or null when it
 * does match. Mirrors `matchesEnrichContractShape`'s try/catch but preserves the validator's own
 * wall-hit message so a caller classifying across all three families can surface precisely which
 * structural expectation failed.
 */
export function enrichContractMismatchReason(node: ComponentNode): string | null {
  try {
    validateEnrichShape(node);
    return null;
  } catch (error) {
    if (error instanceof CodexDispatchError) return error.message;
    throw error;
  }
}

export function prepareEnrich(input: PrepareEnrichInput): PreparedEnrichComponent {
  const ir = typeof input.ir === "string" ? parseIr(input.ir) : input.ir;
  if (ir.warble_ir_version !== SUPPORTED_IR_VERSION) {
    throw new CodexDispatchError(
      `unsupported warble_ir_version '${ir.warble_ir_version}' (supported: ${SUPPORTED_IR_VERSION})`,
    );
  }
  const node = ir.components.find((candidate) => candidate.id === input.component);
  if (!node) {
    throw new CodexDispatchError(
      `component '${input.component}' was not found in profile '${ir.profile}'`,
    );
  }
  const domainCapabilities = validateEnrichShape(node);
  const componentId = node.id;
  if (!/^[A-Za-z0-9_-]+$/.test(input.mcp.name)) {
    throw new CodexDispatchError(
      `MCP server name '${input.mcp.name}' must contain only letters, digits, '_' or '-'`,
    );
  }
  if (!isAbsolute(input.mcp.command)) {
    throw new CodexDispatchError(
      `MCP server command must be absolute when shell_environment_policy.inherit=none`,
    );
  }
  const enabledTools = unique(
    domainCapabilities.flatMap((capability) => input.mcp.toolsByCapability[capability] ?? []),
  );
  if (enabledTools.length === 0) {
    throw new CodexDispatchError(
      `component '${componentId}' has no allowlisted MCP tools for '${domainCapabilities.join("', '")}'`,
    );
  }
  if (input.model.trim().length === 0) {
    throw new CodexDispatchError("model binding must not be empty");
  }
  return {
    target: TARGET,
    profile: ir.profile,
    node,
    componentId,
    domainCapabilities,
    step: node.llm_calls[0]!,
    capabilities: resolveCapabilities(node.required_capabilities, input.mcp.name),
    enabledTools,
    mcp: input.mcp,
    model: input.model,
  };
}
