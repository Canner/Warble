import { isAbsolute } from "node:path";

import { CodexDispatchError } from "./error.js";
import { assertDispatchableComponentIdentity } from "./dispatch_registry.js";
import {
  parseIrInput,
  SUPPORTED_IR_VERSION,
  TARGET,
  type ComponentNode,
  type WarbleIr,
  assertNoComponentCompositionForRoots,
  assertNoSlots,
} from "./ir.js";
import type { CapabilityResolution } from "./exec_prepare.js";
import { resolveStepModel, validateStepTopology, type OnFailureGuard } from "./step_engine.js";
import {
  validateRequirements,
  resolveCapabilities,
} from "./target_profile.js";
import { toolsForStep, validateStepToolBindings, type StepToolBindings } from "./tool_bindings.js";


export interface TurnMcpServerConfig extends StepToolBindings {
  name: string;
  command: string;
  args?: string[];
}

export interface PreparedTurnStep {
  enabledTools: string[];
  requireSuccessfulTool: boolean;
  name: string;
  tier: string;
  model: string;
  prompt: string;
  consumes: string[];
  produces: string;
  when: OnFailureGuard | null;
}

export interface PreparedTurnComponent {
  target: typeof TARGET;
  profile: string;
  node: ComponentNode;
  componentId: string;
  steps: PreparedTurnStep[];
  capabilities: CapabilityResolution[];
  enabledTools: string[];
  mcp: TurnMcpServerConfig;
}

export interface PrepareTurnInput {
  ir: string | WarbleIr;
  component: string;
  /**
   * A single string binds every step in the component to that one model. A per-tier map is
   * required once a component declares steps at more than one tier — see `resolveStepModel`.
   */
  model: string | Record<string, string>;
  mcp: TurnMcpServerConfig;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function validateTurnShape(node: ComponentNode): void {
  assertDispatchableComponentIdentity(node);
  // Checked first, and by capability name rather than by shape: a component whose
  // required_capabilities include anything outside this target's honestly-guaranteed set for
  // Enrich (e.g. a gated-tool component's context_write_authz/context_validate/context_build/
  // version_control/human_approval) can never be legalized here, no matter what its other IR shape
  // looks like. This keeps the wall-hit deterministic and named, and it must never be relaxed to
  // make a gated-tool component dispatchable. It also keeps Enrich's tier allowlist ({cheap,
  // strong}, no `llm:per_step_tier` widening) intact regardless of step count.
  validateRequirements(node, "turn");
  if (
    node.type !== "analytical" ||
    node.realization_kind !== "skill" ||
    node.trigger.kind !== "one_shot" ||
    node.effect.outcome.kind !== "none"
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: requires analytical/skill/one_shot/none`,
    );
  }
  if (node.context_binding.binding_mode !== "pinned") {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: requires a pinned context binding`,
    );
  }
  if (node.llm_calls.length === 0) {
    throw new CodexDispatchError(`component '${node.id}' wall-hit: at least one llm_call is required`);
  }
  // Validates the full step sequence: unique names, produces-artifact discipline, consumes→produces
  // marshalling closure, and on_failure guard placement. This is where the three phase-A
  // wall-hits now live, generalized to n steps rather than hardcoded to one.
  validateStepTopology(node);
  // Unlike Setup (which spawns a brand-new one-shot `codex exec` process per step and can pass
  // `--model` fresh each time — see `resolveStepModel`/`buildCodexArgs`), Enrich's session-based
  // transport (`CodexSessionRuntime`) binds one model to the whole persistent thread for its
  // entire lifetime: `thread/start` takes a single `model`, and there is no per-turn override.
  // Ask's own architecture confirms this is a real transport limit, not an arbitrary one: Ask
  // realizes multi-tier steps by spawning a *separate* sub-agent thread per tier
  // (`orchestrate_runtime.ts`'s `spawnAgent`), a capability turn does not have. So a turn component
  // may now have more than one step, but it must still declare exactly one tier — the single-
  // `llm_call` shape this replaced only ever had one, and this keeps that one true as steps grow.
  const tiers = unique(node.llm_calls.map((step) => step.tier));
  if (tiers.length !== 1) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: this transport's persistent session supports exactly one ` +
        `tier per component; found '${tiers.join("', '")}'`,
    );
  }
  const expectedLlm = `llm:${tiers[0]}`;
  if (!node.required_capabilities.includes(expectedLlm)) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: required capability '${expectedLlm}' is missing`,
    );
  }
}

export function prepareTurn(input: PrepareTurnInput): PreparedTurnComponent {
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
  assertNoSlots({ slots: ir.slots, components: [node] });
  validateTurnShape(node);
  validateStepToolBindings(input.mcp, ir.components.flatMap((component) => component.llm_calls.map((step) => step.name)));
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
  const enabledTools = unique(node.llm_calls.flatMap((step) => toolsForStep(input.mcp, step.name)));
  const topology = validateStepTopology(node);
  const steps: PreparedTurnStep[] = node.llm_calls.map((call, index) => ({
    enabledTools: toolsForStep(input.mcp, call.name),
    requireSuccessfulTool: input.mcp.requireTool?.includes(call.name) ?? false,
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
    steps,
    capabilities: resolveCapabilities(node.required_capabilities, input.mcp.name),
    enabledTools,
    mcp: input.mcp,
  };
}
