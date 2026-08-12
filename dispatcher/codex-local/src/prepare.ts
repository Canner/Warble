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
import {
  guardrailMatches,
  hasExactCapabilities,
  isSetupDomainCapability,
  resolveCapabilities,
  type SetupDomainCapability,
} from "./target_profile.js";

export type { SetupDomainCapability };

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

export interface PreparedSetupComponent {
  target: typeof TARGET;
  profile: string;
  node: ComponentNode;
  componentId: string;
  domainCapability: SetupDomainCapability;
  step: ComponentNode["llm_calls"][number];
  capabilities: CapabilityResolution[];
  enabledTools: string[];
  mcp: McpServerConfig;
  model: string;
}

export interface PrepareInput {
  ir: string | WarbleIr;
  component: string;
  model: string;
  mcp: McpServerConfig;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Verifies that every `consumes` name a step declares is satisfiable by some earlier step's
 * `produces` in the same component. With this transport's one-`llm_call`-per-dispatch limit,
 * there is never an earlier step to produce anything, so this rule derives "consumes must be
 * empty" for a single-step component — that emptiness is a consequence of the general rule,
 * not a hardcoded literal check.
 */
function validateStepMarshalling(node: ComponentNode): void {
  const produced = new Set<string>();
  for (const step of node.llm_calls) {
    for (const consumed of step.consumes) {
      if (!produced.has(consumed)) {
        throw new CodexDispatchError(
          `component '${node.id}' wall-hit: step '${step.name}' consumes '${consumed}' but no earlier step produces it`,
        );
      }
    }
    if (step.produces !== null) produced.add(step.produces);
  }
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
  if (node.llm_calls.length !== 1) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: this transport executes exactly one llm_call per dispatch; component declares ${node.llm_calls.length}`,
    );
  }
  const step = node.llm_calls[0]!;
  if (step.conditional || step.when !== null) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: this transport does not evaluate step conditions; step '${step.name}' is conditional`,
    );
  }
  validateStepMarshalling(node);
  if (step.produces === null) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: this transport requires a produced slot; step '${step.name}' produces none`,
    );
  }
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
  const expectedLlm = `llm:${step.tier}`;
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
  const step = node.llm_calls[0]!;
  if (input.model.trim().length === 0) {
    throw new CodexDispatchError(`'${step.tier}'-tier model binding must not be empty`);
  }
  return {
    target: TARGET,
    profile: ir.profile,
    node,
    componentId,
    domainCapability,
    step,
    capabilities: resolveCapabilities(node.required_capabilities, input.mcp.name),
    enabledTools,
    mcp: input.mcp,
    model: input.model,
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
