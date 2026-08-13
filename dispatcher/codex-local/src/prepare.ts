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
import { resolveStepModel, validateStepTopology, type OnFailureGuard } from "./step_engine.js";
import {
  guardrailMatches,
  hasExactCapabilities,
  isSetupDomainCapability,
  resolveCapabilities,
  type SetupDomainCapability,
} from "./target_profile.js";

export type { SetupDomainCapability };
export type { OnFailureGuard };

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  toolsByCapability: Record<SetupDomainCapability, string[]>;
}

export interface CapabilityResolution {
  capability: string;
  outcome: "native" | "realize-via";
  via: string | null;
}

export interface PreparedSetupStep {
  name: string;
  tier: string;
  model: string;
  prompt: string;
  consumes: string[];
  produces: string;
  when: OnFailureGuard | null;
}

export interface PreparedSetupComponent {
  target: typeof TARGET;
  profile: string;
  node: ComponentNode;
  componentId: string;
  domainCapability: SetupDomainCapability;
  steps: PreparedSetupStep[];
  capabilities: CapabilityResolution[];
  enabledTools: string[];
  mcp: McpServerConfig;
}

export interface PrepareInput {
  ir: string | WarbleIr;
  component: string;
  /**
   * A single string binds every step in the component to that one model (the shape every
   * existing single-step fixture already uses, and still all that's required when a component
   * declares only one tier). A per-tier map is required once a component declares steps at more
   * than one tier — see `resolveStepModel`.
   */
  model: string | Record<string, string>;
  mcp: McpServerConfig;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function validateSetupShape(node: ComponentNode): SetupDomainCapability {
  if (
    node.type !== "analytical" ||
    node.realization_kind !== "skill" ||
    node.trigger.kind !== "one_shot" ||
    node.effect.outcome.kind !== "none" ||
    node.effect.render_blocks.length !== 0
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: requires analytical/skill/one_shot/none with no render blocks`,
    );
  }
  if (node.llm_calls.length === 0) {
    throw new CodexDispatchError(`component '${node.id}' wall-hit: at least one llm_call is required`);
  }
  // Validates the full step sequence: unique names, produces-slot discipline, consumes→produces
  // marshalling closure, and on_failure guard placement. This is where the three phase-A
  // wall-hits ("exactly one llm_call", "does not evaluate step conditions", "requires a produced
  // slot") now live, generalized to n steps rather than hardcoded to one.
  validateStepTopology(node);
  if (node.guardrails.length !== 1 || !guardrailMatches(node.guardrails[0], "setup_execution")) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: exactly one locked setup_execution guardrail with scope '.' is required`,
    );
  }
  const domainCapabilities = node.required_capabilities.filter(isSetupDomainCapability);
  if (domainCapabilities.length !== 1) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: exactly one of source_connect/context_build is required`,
    );
  }
  const tiers = unique(node.llm_calls.map((step) => step.tier));
  const expectedLlm = tiers.length === 1 ? `llm:${tiers[0]}` : "llm:per_step_tier";
  if (!node.required_capabilities.includes(expectedLlm)) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: required capability '${expectedLlm}' is missing`,
    );
  }
  const expectedCapabilities = new Set<string>([domainCapabilities[0]!, expectedLlm]);
  if (!hasExactCapabilities(node.required_capabilities, expectedCapabilities)) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: supports exactly '${domainCapabilities[0]}' and '${expectedLlm}' capabilities`,
    );
  }
  return domainCapabilities[0]!;
}

export function matchesSetupContractShape(node: ComponentNode): boolean {
  try {
    validateSetupShape(node);
    return true;
  } catch (error) {
    if (error instanceof CodexDispatchError) return false;
    throw error;
  }
}

/**
 * The specific reason a component's IR shape does not match the Setup contract, or null when it
 * does match. This mirrors `matchesSetupContractShape`'s try/catch but preserves the validator's
 * own wall-hit message instead of collapsing it to a boolean, so a caller classifying across all
 * three families can surface precisely which structural expectation failed.
 */
export function setupContractMismatchReason(node: ComponentNode): string | null {
  try {
    validateSetupShape(node);
    return null;
  } catch (error) {
    if (error instanceof CodexDispatchError) return error.message;
    throw error;
  }
}

export function prepareSetup(input: PrepareInput): PreparedSetupComponent {
  const ir = typeof input.ir === "string" ? parseIr(input.ir) : input.ir;
  if (ir.warble_ir_version !== SUPPORTED_IR_VERSION) {
    throw new CodexDispatchError(
      `unsupported warble_ir_version '${ir.warble_ir_version}' (supported: ${SUPPORTED_IR_VERSION})`,
    );
  }
  const node = ir.components.find((candidate) => candidate.id === input.component);
  if (!node) {
    throw new CodexDispatchError(`component '${input.component}' was not found in profile '${ir.profile}'`);
  }
  assertDispatchableComponentIdentity(node);
  const domainCapability = validateSetupShape(node);
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
  const enabledTools = unique(input.mcp.toolsByCapability[domainCapability]);
  if (enabledTools.length === 0) {
    throw new CodexDispatchError(
      `component '${componentId}' has no allowlisted MCP tools for '${domainCapability}'`,
    );
  }
  const topology = validateStepTopology(node);
  const steps: PreparedSetupStep[] = node.llm_calls.map((call, index) => ({
    name: call.name,
    tier: call.tier,
    model: resolveStepModel(input.model, call.tier, componentId),
    prompt: call.prompt,
    consumes: call.consumes,
    produces: call.produces!,
    when: topology[index]!.when,
  }));
  return {
    target: TARGET,
    profile: ir.profile,
    node,
    componentId,
    domainCapability,
    steps,
    capabilities: resolveCapabilities(node.required_capabilities, input.mcp.name),
    enabledTools,
    mcp: input.mcp,
  };
}

export function prepareAllSetup(
  raw: string,
  config: Omit<PrepareInput, "ir" | "component">,
): PreparedSetupComponent[] {
  const ir = parseIr(raw);
  // Aggregate preparation must reject a reserved host-only identity before preparing any
  // component, so a direct caller cannot receive a partial array preceding the wall-hit.
  for (const node of ir.components) assertDispatchableComponentIdentity(node);
  return ir.components.map((node) =>
    prepareSetup({ ...config, ir, component: node.id }),
  );
}
