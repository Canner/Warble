import { isAbsolute } from "node:path";

import { CodexDispatchError } from "./error.js";
import {
  parseIr,
  TARGET,
  type ComponentNode,
  type LlmCall,
  type WarbleIr,
} from "./ir.js";
import type { CapabilityResolution } from "./prepare.js";

export interface AskMcpServerConfig {
  name: string;
  command: string;
  args?: string[];
  toolsByStep: Record<string, string[]>;
}

export interface AskTierModels {
  orchestrator: string;
  cheap: string;
  strong: string;
}

export interface AskWhenGuard {
  guard: "on_failure";
  target: string;
}

export interface PreparedAskStep {
  name: string;
  role: string;
  tier: "cheap" | "strong";
  model: string;
  prompt: string;
  consumes: string[];
  produces: string;
  conditional: boolean;
  when: AskWhenGuard | null;
  enabledTools: string[];
}

export interface PreparedAskComponent {
  target: typeof TARGET;
  profile: string;
  node: ComponentNode;
  componentId: string;
  steps: PreparedAskStep[];
  capabilities: CapabilityResolution[];
  mcp: AskMcpServerConfig;
  models: AskTierModels;
  maxRepairAttempts: 1;
}

export interface PrepareAskInput {
  ir: string | WarbleIr;
  component: string;
  models: AskTierModels;
  mcp: AskMcpServerConfig;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

const ASK_TOOLS_BY_POSITION = [["get_context"], ["run_sql"], ["run_sql"]] as const;

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new CodexDispatchError(`${field} must not be empty`);
}

function parseWhen(step: LlmCall): AskWhenGuard | null {
  if (!step.conditional) {
    if (step.when !== null) {
      throw new CodexDispatchError(`step '${step.name}' is unconditional but has a when guard`);
    }
    return null;
  }
  if (
    typeof step.when !== "object" ||
    step.when === null ||
    Array.isArray(step.when) ||
    (step.when as Record<string, unknown>)["guard"] !== "on_failure" ||
    typeof (step.when as Record<string, unknown>)["target"] !== "string"
  ) {
    throw new CodexDispatchError(
      `step '${step.name}' wall-hit: Ask repair requires on_failure(target)`,
    );
  }
  return {
    guard: "on_failure",
    target: (step.when as Record<string, string>)["target"]!,
  };
}

function validateAskShape(node: ComponentNode): void {
  if (
    node.type !== "analytical" ||
    node.realization_kind !== "skill" ||
    node.trigger.kind !== "one_shot" ||
    node.effect.outcome.kind !== "none"
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Ask requires analytical/skill/one_shot/none`,
    );
  }
  if (node.context_binding.binding_mode !== "runtime_selected") {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Ask requires runtime_selected context binding`,
    );
  }
  if (node.llm_calls.length !== 3) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Ask requires three ordered llm_calls`,
    );
  }
  const [first, second, repair] = node.llm_calls as [LlmCall, LlmCall, LlmCall];
  if (
    first.tier !== "cheap" ||
    first.conditional ||
    first.consumes.length !== 0 ||
    first.produces === null
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: first Ask step must be unconditional cheap with no consumes and one output`,
    );
  }
  if (
    second.tier !== "strong" ||
    second.conditional ||
    second.produces === null ||
    second.consumes.length !== 1 ||
    second.consumes[0] !== first.produces
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: second Ask step must be unconditional strong and consume the first output`,
    );
  }
  const when = parseWhen(repair);
  if (
    repair.tier !== "strong" ||
    repair.produces === null ||
    repair.consumes.length !== 1 ||
    repair.consumes[0] !== second.produces ||
    when?.target !== second.name
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: third Ask step must be strong on_failure repair of the preceding output`,
    );
  }

  const expectedCapabilities = new Set([
    "sql_execution:read_only",
    "llm:per_step_tier",
    "llm:strong",
    "llm:cheap",
  ]);
  if (
    node.required_capabilities.length !== expectedCapabilities.size ||
    node.required_capabilities.some((capability) => !expectedCapabilities.has(capability))
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Ask capability set must be read-only SQL plus cheap/strong per-step tiering`,
    );
  }
  const guards = new Map(node.guardrails.map((guard) => [guard.name, guard]));
  if (
    guards.size !== 4 ||
    guards.get("read_only_execution")?.locked !== true ||
    guards.get("deterministic_gate")?.locked !== true ||
    guards.get("row_limit")?.locked !== false ||
    guards.get("statement_timeout")?.locked !== false ||
    guards.get("row_limit")?.threshold !== 1000 ||
    guards.get("statement_timeout")?.threshold !== 30
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Ask guardrails must match the locked read-only/deterministic and bounded row/timeout contract`,
    );
  }
}

function roleName(stepName: string): string {
  const value = `warble_${stepName}`.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) {
    throw new CodexDispatchError(`step '${stepName}' cannot be mapped to a Codex agent role`);
  }
  return value;
}

export function prepareAsk(input: PrepareAskInput): PreparedAskComponent {
  const ir = typeof input.ir === "string" ? parseIr(input.ir) : input.ir;
  if (ir.warble_ir_version !== "0.3") {
    throw new CodexDispatchError(
      `unsupported warble_ir_version '${ir.warble_ir_version}' (supported: 0.3)`,
    );
  }
  const node = ir.components.find((candidate) => candidate.id === input.component);
  if (!node) {
    throw new CodexDispatchError(
      `component '${input.component}' was not found in profile '${ir.profile}'`,
    );
  }
  validateAskShape(node);
  if (!/^[A-Za-z0-9_-]+$/.test(input.mcp.name)) {
    throw new CodexDispatchError(
      `MCP server name '${input.mcp.name}' must contain only letters, digits, '_' or '-'`,
    );
  }
  if (!isAbsolute(input.mcp.command)) {
    throw new CodexDispatchError("Ask MCP server command must be absolute");
  }
  requireNonEmpty(input.models.orchestrator, "orchestrator model binding");
  requireNonEmpty(input.models.cheap, "cheap-tier model binding");
  requireNonEmpty(input.models.strong, "strong-tier model binding");

  const steps = node.llm_calls.map((step, index): PreparedAskStep => {
    const tier = step.tier;
    if (tier !== "cheap" && tier !== "strong") {
      throw new CodexDispatchError(`step '${step.name}' has unsupported tier '${tier}'`);
    }
    const enabledTools = unique(input.mcp.toolsByStep[step.name] ?? []);
    const expectedTools = ASK_TOOLS_BY_POSITION[index]!;
    if (
      enabledTools.length !== expectedTools.length ||
      enabledTools.some((tool, toolIndex) => tool !== expectedTools[toolIndex])
    ) {
      throw new CodexDispatchError(
        `step '${step.name}' requires exact MCP tools: ${expectedTools.join(", ")}`,
      );
    }
    if (step.produces === null) {
      throw new CodexDispatchError(`step '${step.name}' must produce a named slot`);
    }
    return {
      name: step.name,
      role: roleName(step.name),
      tier,
      model: input.models[tier],
      prompt: step.prompt,
      consumes: [...step.consumes],
      produces: step.produces,
      conditional: step.conditional,
      when: parseWhen(step),
      enabledTools,
    };
  });

  return {
    target: TARGET,
    profile: ir.profile,
    node,
    componentId: node.id,
    steps,
    capabilities: node.required_capabilities.map((capability) =>
      capability.startsWith("llm:")
        ? { capability, outcome: "native", via: null }
        : { capability, outcome: "realize-via", via: `mcp:${input.mcp.name}` },
    ),
    mcp: input.mcp,
    models: input.models,
    maxRepairAttempts: 1,
  };
}
