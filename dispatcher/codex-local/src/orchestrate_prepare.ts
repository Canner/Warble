import { isAbsolute } from "node:path";

import { CodexDispatchError } from "./error.js";
import { assertDispatchableComponentIdentity } from "./dispatch_registry.js";
import {
  parseIrInput,
  SUPPORTED_IR_VERSION,
  TARGET,
  type ComponentNode,
  type LlmCall,
  type WarbleIr,
  assertNoComponentCompositionForRoots,
  assertNoSlots,
} from "./ir.js";
import type { CapabilityResolution } from "./exec_prepare.js";
import { parseDashboardRenderBlockContracts } from "./render_contract.js";
import { REQUEST_TRANSPORT_SERVER } from "./request_transport.js";
import {
  validateRequirements,
  resolveCapabilities,
} from "./target_profile.js";
import { toolsForStep, validateStepToolBindings, type StepToolBindings } from "./tool_bindings.js";

export interface OrchestrateMcpServerConfig extends StepToolBindings {
  name: string;
  command: string;
  args?: string[];
  toolsByStep: Record<string, string[]>;
}

export interface OrchestrateTierModels {
  orchestrator: string;
  cheap: string;
  strong: string;
}

export interface OrchestrateWhenGuard {
  guard: "on_failure";
  target: string;
}

export interface PreparedOrchestrateStep {
  name: string;
  role: string;
  tier: "cheap" | "strong";
  model: string;
  prompt: string;
  consumes: string[];
  produces: string;
  conditional: boolean;
  when: OrchestrateWhenGuard | null;
  enabledTools: string[];
  requireSuccessfulTool: boolean;
}

export type TerminalBehavior = "terminal_value" | "render_envelope";

export interface PreparedOrchestrateComponent {
  target: typeof TARGET;
  profile: string;
  node: ComponentNode;
  componentId: string;
  steps: PreparedOrchestrateStep[];
  capabilities: CapabilityResolution[];
  mcp: OrchestrateMcpServerConfig;
  models: OrchestrateTierModels;
  executionKind: TerminalBehavior;
  maxRepairAttempts: number;
}

export interface PrepareOrchestrateInput {
  ir: string | WarbleIr;
  component: string;
  models: OrchestrateTierModels;
  mcp: OrchestrateMcpServerConfig;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new CodexDispatchError(`${field} must not be empty`);
}

function parseWhen(step: LlmCall): OrchestrateWhenGuard | null {
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
 * Generic IR-driven chain validator shared by both Ask shapes (terminal_value, render_envelope).
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

function validateTerminalValueShape(node: ComponentNode, invocation: boolean): void {
  validateCommonAnalyticalShape(node);
  validateStepChain(node);

  validateRequirements(node, "orchestrate", invocation);
}

function validateRenderEnvelopeShape(node: ComponentNode, invocation: boolean): void {
  validateCommonAnalyticalShape(node);
  validateStepChain(node);

  validateRequirements(node, "orchestrate", invocation);
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

function executionKind(node: ComponentNode, invocation: boolean): TerminalBehavior {
  const capabilities = new Set(node.required_capabilities);
  if (capabilities.has("render_contract") || capabilities.has("artifact_write")) {
    validateRenderEnvelopeShape(node, invocation);
    return "render_envelope";
  }
  validateTerminalValueShape(node, invocation);
  return "terminal_value";
}

function roleName(stepName: string): string {
  const value = `warble_${stepName}`.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) {
    throw new CodexDispatchError(`step '${stepName}' cannot be mapped to a Codex agent role`);
  }
  return value;
}

export function prepareOrchestrate(input: PrepareOrchestrateInput): PreparedOrchestrateComponent {
  const ir = parseIrInput(input.ir);
  if (ir.warble_ir_version !== SUPPORTED_IR_VERSION) {
    throw new CodexDispatchError(
      `unsupported warble_ir_version '${ir.warble_ir_version}' (supported: ${SUPPORTED_IR_VERSION})`,
    );
  }
  assertNoComponentCompositionForRoots(ir, [input.component]);
  const node = ir.components.find((candidate) => candidate.id === input.component);
  if (!node) {
    throw new CodexDispatchError(
      `component '${input.component}' was not found in profile '${ir.profile}'`,
    );
  }
  return prepareOrchestrateNode(input, ir, node);
}

/** Internal shared shape preparation; composed execution owns closure/entry authorization. */
export function prepareOrchestrateNode(
  input: PrepareOrchestrateInput,
  ir: WarbleIr,
  node: ComponentNode,
  invocation = false,
): PreparedOrchestrateComponent {
  assertNoSlots({ slots: ir.slots, components: [node] });
  assertDispatchableComponentIdentity(node);
  const kind = executionKind(node, invocation);
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
  validateStepToolBindings(input.mcp, ir.components.flatMap((component) => component.llm_calls.map((step) => step.name)));

  const steps = node.llm_calls.map((step, index): PreparedOrchestrateStep => {
    const tier = step.tier;
    if (tier !== "cheap" && tier !== "strong") {
      throw new CodexDispatchError(`step '${step.name}' has unsupported tier '${tier}'`);
    }
    const enabledTools = toolsForStep(input.mcp, step.name);
    if (step.produces === null) {
      throw new CodexDispatchError(`step '${step.name}' must produce a named artifact`);
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
      requireSuccessfulTool: input.mcp.requireTool?.includes(step.name) ?? false,
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
