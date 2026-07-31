import { isAbsolute } from "node:path";

import { CodexDispatchError } from "./error.js";
import {
  parseIr,
  TARGET,
  type ComponentNode,
  type WarbleIr,
} from "./ir.js";

export type SetupDomainCapability = "source_connect" | "context_build";

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

function validateSetupShape(node: ComponentNode): SetupDomainCapability {
  if (
    node.type !== "analytical" ||
    node.realization_kind !== "skill" ||
    node.trigger.kind !== "one_shot" ||
    node.effect.outcome.kind !== "none" ||
    node.effect.render_blocks.length !== 0
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Setup prototype requires analytical/skill/one_shot/none with no render blocks`,
    );
  }
  if (node.llm_calls.length !== 1) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Setup prototype requires exactly one llm_call`,
    );
  }
  const step = node.llm_calls[0]!;
  if (
    step.tier !== "strong" ||
    step.conditional ||
    step.when !== null ||
    step.consumes.length !== 0 ||
    step.produces === null
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Setup prototype requires one unconditional strong step with no consumes and one produced slot`,
    );
  }
  const guard = node.guardrails[0];
  if (
    node.guardrails.length !== 1 ||
    guard?.name !== "setup_execution" ||
    !guard.locked ||
    guard.scope !== "."
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: exactly one locked setup_execution guardrail with scope '.' is required`,
    );
  }
  const domainCapabilities = node.required_capabilities.filter(
    (capability): capability is SetupDomainCapability =>
      capability === "source_connect" || capability === "context_build",
  );
  if (domainCapabilities.length !== 1) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: exactly one of source_connect/context_build is required`,
    );
  }
  if (!node.required_capabilities.includes("llm:strong")) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: required capability 'llm:strong' is missing`,
    );
  }
  const expectedCapabilities = new Set<string>([domainCapabilities[0]!, "llm:strong"]);
  if (
    node.required_capabilities.length !== expectedCapabilities.size ||
    node.required_capabilities.some((capability) => !expectedCapabilities.has(capability))
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Setup prototype supports exactly '${domainCapabilities[0]}' and 'llm:strong' capabilities`,
    );
  }
  return domainCapabilities[0]!;
}

export function prepareSetup(input: PrepareInput): PreparedSetupComponent {
  const ir = typeof input.ir === "string" ? parseIr(input.ir) : input.ir;
  if (ir.warble_ir_version !== "0.3") {
    throw new CodexDispatchError(
      `unsupported warble_ir_version '${ir.warble_ir_version}' (supported: 0.3)`,
    );
  }
  const node = ir.components.find((candidate) => candidate.id === input.component);
  if (!node) {
    throw new CodexDispatchError(`component '${input.component}' was not found in profile '${ir.profile}'`);
  }
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
  if (input.model.trim().length === 0) {
    throw new CodexDispatchError("strong-tier model binding must not be empty");
  }
  return {
    target: TARGET,
    profile: ir.profile,
    node,
    componentId,
    domainCapability,
    step: node.llm_calls[0]!,
    capabilities: node.required_capabilities.map((capability) =>
      capability === "llm:strong"
        ? { capability, outcome: "native", via: null }
        : { capability, outcome: "realize-via", via: `mcp:${input.mcp.name}` },
    ),
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
  return ir.components.map((node) =>
    prepareSetup({ ...config, ir, component: node.id }),
  );
}
