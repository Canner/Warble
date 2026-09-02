import { isAbsolute } from "node:path";

import { CodexDispatchError } from "./error.js";
import { assertDispatchableComponentIdentity } from "./dispatch_registry.js";
import {
  parseIr,
  SUPPORTED_IR_VERSION,
  TARGET,
  type ComponentNode,
  type LlmCall,
  type WarbleIr,
} from "./ir.js";
import type { CapabilityResolution } from "./prepare.js";
import { parseDashboardRenderBlockContracts } from "./render_contract.js";
import { REQUEST_TRANSPORT_SERVER } from "./request_transport.js";
import {
  ASK_ANSWER_CAPABILITIES,
  ASK_DASHBOARD_CAPABILITIES,
  guardrailMatches,
  hasExactCapabilities,
  resolveCapabilities,
} from "./target_profile.js";

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
  requireSuccessfulTool: boolean;
}

export type AnalyticalExecutionKind = "answer_query" | "generate_dashboard";

export interface PreparedAskComponent {
  target: typeof TARGET;
  profile: string;
  node: ComponentNode;
  componentId: string;
  steps: PreparedAskStep[];
  capabilities: CapabilityResolution[];
  mcp: AskMcpServerConfig;
  models: AskTierModels;
  executionKind: AnalyticalExecutionKind;
  maxRepairAttempts: number;
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

const TOOLS_BY_EXECUTION_KIND = {
  answer_query: [["get_context"], ["run_sql"], ["run_sql"]],
  generate_dashboard: [["get_context"], ["run_sql"]],
} as const;

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

function validateCommonAnalyticalShape(node: ComponentNode): void {
  if (
    node.type !== "analytical" ||
    node.realization_kind !== "skill" ||
    node.trigger.kind !== "one_shot" ||
    node.effect.outcome.kind !== "none"
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Codex analytical execution requires analytical/skill/one_shot/none`,
    );
  }
  if (node.context_binding.binding_mode !== "runtime_selected") {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Codex analytical execution requires runtime_selected context binding`,
    );
  }
}

/**
 * Generic IR-driven chain validator shared by both Ask shapes (answer_query, generate_dashboard).
 * Enforces the topology the runtime can honestly execute: any step count, any
 * tier per step (cheap|strong, not position-bound), each non-first unconditional step consumes
 * exactly its immediately-preceding step's output, each conditional step is an on_failure repair
 * targeting its immediately-preceding step and consumes that step's output, and — because the
 * runtime aligns `active.spawns[i]` to `steps[i]` with no gap-skipping support, and because an
 * always-run step cannot honestly depend on a conditionally-produced value — no unconditional
 * step may follow a conditional one (repairs form a maximal trailing suffix).
 */
function validateStepChain(node: ComponentNode): void {
  const calls = node.llm_calls;
  if (calls.length === 0) {
    throw new CodexDispatchError(`component '${node.id}' wall-hit: Ask requires at least one llm_call`);
  }
  let sawConditional = false;
  calls.forEach((call, index) => {
    if (call.tier !== "cheap" && call.tier !== "strong") {
      throw new CodexDispatchError(
        `component '${node.id}' wall-hit: step '${call.name}' has unsupported tier '${call.tier}'`,
      );
    }
    if (call.produces === null) {
      throw new CodexDispatchError(
        `component '${node.id}' wall-hit: step '${call.name}' must produce a named output`,
      );
    }
    const when = parseWhen(call);
    if (index === 0) {
      if (call.conditional || call.consumes.length !== 0) {
        throw new CodexDispatchError(
          `component '${node.id}' wall-hit: first Ask step must be unconditional with no consumes and one output`,
        );
      }
      return;
    }
    const previous = calls[index - 1]!;
    if (call.conditional) {
      if (
        when?.target !== previous.name ||
        call.consumes.length !== 1 ||
        call.consumes[0] !== previous.produces
      ) {
        throw new CodexDispatchError(
          `component '${node.id}' wall-hit: step '${call.name}' must be an on_failure repair of the immediately preceding step '${previous.name}'`,
        );
      }
      sawConditional = true;
      return;
    }
    if (sawConditional) {
      throw new CodexDispatchError(
        `component '${node.id}' wall-hit: an unconditional step cannot follow a repair step`,
      );
    }
    if (call.consumes.length !== 1 || call.consumes[0] !== previous.produces) {
      throw new CodexDispatchError(
        `component '${node.id}' wall-hit: step '${call.name}' must consume exactly the preceding step's output`,
      );
    }
  });
}

function validateAnswerShape(node: ComponentNode): void {
  validateCommonAnalyticalShape(node);
  validateStepChain(node);

  if (!hasExactCapabilities(node.required_capabilities, ASK_ANSWER_CAPABILITIES)) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Ask capability set must be read-only SQL plus cheap/strong per-step tiering`,
    );
  }
  const guards = new Map(node.guardrails.map((guard) => [guard.name, guard]));
  if (
    guards.size !== 4 ||
    !guardrailMatches(guards.get("read_only_execution"), "read_only_execution") ||
    !guardrailMatches(guards.get("deterministic_gate"), "deterministic_gate") ||
    !guardrailMatches(guards.get("row_limit"), "row_limit") ||
    !guardrailMatches(guards.get("statement_timeout"), "statement_timeout")
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Ask guardrails must match the locked read-only/deterministic and bounded row/timeout contract`,
    );
  }
}

function validateDashboardShape(node: ComponentNode): void {
  validateCommonAnalyticalShape(node);
  validateStepChain(node);

  if (!hasExactCapabilities(node.required_capabilities, ASK_DASHBOARD_CAPABILITIES)) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: dashboard capability set must match read-only SQL, build, render, artifact, and cheap/strong per-step tiering`,
    );
  }
  const guards = new Map(node.guardrails.map((guard) => [guard.name, guard]));
  if (
    guards.size !== 2 ||
    !guardrailMatches(guards.get("read_only_execution"), "read_only_execution") ||
    !guardrailMatches(guards.get("artifact_write"), "artifact_write")
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: dashboard guardrails must be locked read-only execution plus scoped artifact_write`,
    );
  }
  if (node.effect.render_blocks.length === 0) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: dashboard render contract must declare at least one render block type`,
    );
  }
  // Wall-hits early on a structurally malformed render-block declaration using the
  // same parse that later validates the terminal envelope (render_contract.ts) — never
  // a second, independent check of the declared contract's *content*.
  parseDashboardRenderBlockContracts(node.effect.render_blocks);
}

function executionKind(node: ComponentNode): AnalyticalExecutionKind {
  const capabilities = new Set(node.required_capabilities);
  if (capabilities.has("render_contract") || capabilities.has("artifact_write")) {
    validateDashboardShape(node);
    return "generate_dashboard";
  }
  validateAnswerShape(node);
  return "answer_query";
}

export function matchesAskContractShape(node: ComponentNode): boolean {
  try {
    executionKind(node);
    return true;
  } catch (error) {
    if (error instanceof CodexDispatchError) return false;
    throw error;
  }
}

/**
 * The specific reason a component's IR shape does not match either Ask contract (answer_query or
 * generate_dashboard), or null when it matches one of them. Mirrors `matchesAskContractShape`'s
 * try/catch but preserves the validator's own wall-hit message so a caller classifying across all
 * three families can surface precisely which structural expectation failed.
 */
export function askContractMismatchReason(node: ComponentNode): string | null {
  try {
    executionKind(node);
    return null;
  } catch (error) {
    if (error instanceof CodexDispatchError) return error.message;
    throw error;
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
  assertDispatchableComponentIdentity(node);
  const kind = executionKind(node);
  if (!/^[A-Za-z0-9_-]+$/.test(input.mcp.name)) {
    throw new CodexDispatchError(
      `MCP server name '${input.mcp.name}' must contain only letters, digits, '_' or '-'`,
    );
  }
  if (input.mcp.name === REQUEST_TRANSPORT_SERVER) {
    throw new CodexDispatchError(`MCP server name '${input.mcp.name}' is reserved by the Ask request transport`);
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
    const expectedTools = TOOLS_BY_EXECUTION_KIND[kind][index];
    if (expectedTools === undefined) {
      throw new CodexDispatchError(
        `step '${step.name}' has no declared MCP tool allowlist for target index ${index}`,
      );
    }
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
      requireSuccessfulTool: kind === "generate_dashboard" || index > 0,
    };
  });

  return {
    target: TARGET,
    profile: ir.profile,
    node,
    componentId: node.id,
    steps,
    capabilities: resolveCapabilities(node.required_capabilities, input.mcp.name),
    mcp: input.mcp,
    models: input.models,
    executionKind: kind,
    maxRepairAttempts: steps.filter((step) => step.conditional).length,
  };
}
