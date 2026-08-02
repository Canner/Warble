import { SUPPORTED_IR_VERSION, TARGET } from "./ir.js";
import type { PreparedSetupComponent } from "./prepare.js";

export interface StepManifest {
  name: string;
  tier: string;
  model: string;
  consumes: string[];
  produces: string | null;
}

export interface AgentManifest {
  id: string;
  verb: string;
  component_type: string;
  realization_kind: string;
  trigger: string;
  outcome: string;
  steps: StepManifest[];
  capabilities: PreparedSetupComponent["capabilities"];
  tools: Array<{ name: string; source: string }>;
  guardrails: Record<string, unknown>;
}

export interface Manifest {
  manifest_version: "0.1";
  compat: {
    min_ir_version: typeof SUPPORTED_IR_VERSION;
    max_ir_version: typeof SUPPORTED_IR_VERSION;
  };
  profile: string;
  target: typeof TARGET;
  session: SessionManifest;
  agents: AgentManifest[];
}

export const SESSION_LIFECYCLE_OPERATIONS = [
  "start",
  "resume",
  "read",
  "turn",
  "steer",
  "interrupt",
  "fork",
] as const;

export interface SessionManifest {
  persistence: "codex_thread_history";
  lifecycle_operations: Array<(typeof SESSION_LIFECYCLE_OPERATIONS)[number]>;
  artifact_reference: "allowlisted_mcp_tool_result";
  isolation: "dedicated_persistent_codex_home";
  authentication: "externally_provisioned";
}

export interface TargetDescription {
  target: typeof TARGET;
  phase: "setup-only";
  execution_modes: ["one_shot", "persistent_session"];
  session_persistence: SessionManifest["persistence"];
  lifecycle_operations: SessionManifest["lifecycle_operations"];
  supported_components: string[];
  tiers: string[];
  capabilities: string[];
  tools: string[];
  guardrails: string[];
}

export function buildAgentManifest(prepared: PreparedSetupComponent): AgentManifest {
  return {
    id: prepared.node.id,
    verb: prepared.node.verb,
    component_type: prepared.node.type,
    realization_kind: prepared.node.realization_kind,
    trigger: prepared.node.trigger.kind,
    outcome: prepared.node.effect.outcome.kind,
    steps: [
      {
        name: prepared.step.name,
        tier: prepared.step.tier,
        model: prepared.model,
        consumes: prepared.step.consumes,
        produces: prepared.step.produces,
      },
    ],
    capabilities: prepared.capabilities,
    tools: prepared.enabledTools.map((name) => ({
      name,
      source: `mcp:${prepared.mcp.name}`,
    })),
    guardrails: {
      setup_execution: {
        enforcement: "mcp_only_read_only_sandbox",
        locked: true,
        scope: ".",
      },
      isolated_codex_config: {
        ignore_user_config: true,
        ephemeral: true,
        approval_policy: "never",
        sandbox: "read-only",
        api_key_environment: "removed",
      },
    },
  };
}

export function buildManifest(prepared: readonly PreparedSetupComponent[]): Manifest {
  const first = prepared[0];
  if (!first) {
    throw new Error("cannot build a manifest without prepared components");
  }
  return {
    manifest_version: "0.1",
    compat: {
      min_ir_version: SUPPORTED_IR_VERSION,
      max_ir_version: SUPPORTED_IR_VERSION,
    },
    profile: first.profile,
    target: TARGET,
    session: {
      persistence: "codex_thread_history",
      lifecycle_operations: [...SESSION_LIFECYCLE_OPERATIONS],
      artifact_reference: "allowlisted_mcp_tool_result",
      isolation: "dedicated_persistent_codex_home",
      authentication: "externally_provisioned",
    },
    agents: prepared.map(buildAgentManifest),
  };
}

export function describeTarget(prepared: readonly PreparedSetupComponent[]): TargetDescription {
  return {
    target: TARGET,
    phase: "setup-only",
    execution_modes: ["one_shot", "persistent_session"],
    session_persistence: "codex_thread_history",
    lifecycle_operations: [...SESSION_LIFECYCLE_OPERATIONS],
    supported_components: prepared.map((component) => component.componentId),
    tiers: [...new Set(prepared.map((component) => component.step.tier))],
    capabilities: [
      ...new Set(prepared.flatMap((component) => component.capabilities.map((entry) => entry.capability))),
    ],
    tools: [...new Set(prepared.flatMap((component) => component.enabledTools))],
    guardrails: ["setup_execution", "isolated_codex_config"],
  };
}
