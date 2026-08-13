import { SUPPORTED_IR_VERSION, TARGET } from "./ir.js";
import type { PreparedSetupComponent } from "./prepare.js";
import type { PreparedAskComponent } from "./ask_prepare.js";
import type { PreparedEnrichComponent } from "./enrich_prepare.js";

export interface StepManifest {
  name: string;
  tier: string;
  model: string;
  consumes: string[];
  produces: string | null;
  agent_role?: string;
  conditional?: boolean;
  when?: { guard: string; target: string } | null;
  tools?: string[];
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
  tools: Array<{ name: string; source: string; agents?: string[] }>;
  guardrails: Record<string, unknown>;
  artifact_output?: {
    kind: "render_envelope";
    persistence: "consumer";
    block_types: string[];
  };
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
  artifact_reference:
    | "allowlisted_mcp_tool_result"
    | "allowlisted_mcp_tool_result_or_render_envelope";
  isolation: "dedicated_persistent_codex_home";
  authentication: "externally_provisioned";
}

export interface TargetDescription {
  target: typeof TARGET;
  phase:
    | "setup-only"
    | "setup-and-ask-parity"
    | "setup-ask-and-dashboard-parity"
    | "enrich-parity";
  execution_modes: Array<"one_shot" | "persistent_session">;
  session_persistence: SessionManifest["persistence"];
  lifecycle_operations: SessionManifest["lifecycle_operations"];
  supported_components: string[];
  tiers: string[];
  capabilities: string[];
  tools: string[];
  guardrails: string[];
}

export function buildAskAgentManifest(prepared: PreparedAskComponent): AgentManifest {
  const toolAgents = new Map<string, string[]>();
  for (const step of prepared.steps) {
    for (const tool of step.enabledTools) {
      const agents = toolAgents.get(tool) ?? [];
      if (!agents.includes(step.role)) agents.push(step.role);
      toolAgents.set(tool, agents);
    }
  }
  const dashboard = prepared.executionKind === "generate_dashboard";
  return {
    id: prepared.node.id,
    verb: prepared.node.verb,
    component_type: prepared.node.type,
    realization_kind: prepared.node.realization_kind,
    trigger: prepared.node.trigger.kind,
    outcome: prepared.node.effect.outcome.kind,
    steps: prepared.steps.map((step) => ({
      name: step.name,
      tier: step.tier,
      model: step.model,
      consumes: [...step.consumes],
      produces: step.produces,
      agent_role: step.role,
      conditional: step.conditional,
      when: step.when,
      tools: [...step.enabledTools],
    })),
    capabilities: prepared.capabilities,
    tools: [...toolAgents].map(([name, agents]) => ({
      name,
      source: `mcp:${prepared.mcp.name}`,
      agents,
    })),
    guardrails: {
      read_only_execution: { enforcement: "per_agent_mcp_only_read_only_sandbox", locked: true },
      ...(dashboard
        ? {
            artifact_write: {
              enforcement: "consumer_persisted_render_envelope",
              locked: true,
              scope: ".",
            },
            render_contract: {
              enforcement: "validated_ir_declared_render_envelope",
              on_failure: "degrade",
            },
          }
        : {
            deterministic_gate: {
              enforcement: "child_result_envelope_and_event_attribution",
              locked: true,
            },
            row_limit: { threshold: 1000 },
            statement_timeout: { threshold: 30 },
          }),
      ordered_delegation: {
        enforcement: "named_child_threads_in_ir_order",
        flattening: "forbidden",
      },
      ...(dashboard
        ? {}
        : {
            conditional_repair: {
              guard: prepared.steps[2]!.when,
              max_attempts: prepared.maxRepairAttempts,
              exhaustion: "loud_fail",
            },
          }),
      isolated_codex_config: {
        parent_tools: "multi_agent_only",
        child_tools: "per_step_exact_mcp_allowlist",
        approval_policy: "never",
        sandbox: "read-only",
        api_key_environment: "removed",
      },
    },
    ...(dashboard
      ? {
          artifact_output: {
            kind: "render_envelope" as const,
            persistence: "consumer" as const,
            block_types: prepared.node.effect.render_blocks.map((block) =>
              typeof block === "object" && block !== null && "type" in block
                ? String((block as { type: unknown }).type)
                : "unknown",
            ),
          },
        }
      : {}),
  };
}

export function buildAskManifest(prepared: PreparedAskComponent): Manifest {
  return {
    manifest_version: "0.1",
    compat: {
      min_ir_version: SUPPORTED_IR_VERSION,
      max_ir_version: SUPPORTED_IR_VERSION,
    },
    profile: prepared.profile,
    target: TARGET,
    session: {
      persistence: "codex_thread_history",
      lifecycle_operations: [...SESSION_LIFECYCLE_OPERATIONS],
      artifact_reference:
        prepared.executionKind === "generate_dashboard"
          ? "allowlisted_mcp_tool_result_or_render_envelope"
          : "allowlisted_mcp_tool_result",
      isolation: "dedicated_persistent_codex_home",
      authentication: "externally_provisioned",
    },
    agents: [buildAskAgentManifest(prepared)],
  };
}

export function describeAskTarget(prepared: PreparedAskComponent): TargetDescription {
  return {
    target: TARGET,
    phase:
      prepared.executionKind === "generate_dashboard"
        ? "setup-ask-and-dashboard-parity"
        : "setup-and-ask-parity",
    execution_modes: ["persistent_session"],
    session_persistence: "codex_thread_history",
    lifecycle_operations: [...SESSION_LIFECYCLE_OPERATIONS],
    supported_components: [prepared.componentId],
    tiers: [...new Set(prepared.steps.map((step) => step.tier))],
    capabilities: prepared.capabilities.map((entry) => entry.capability),
    tools: [...new Set(prepared.steps.flatMap((step) => step.enabledTools))],
    guardrails:
      prepared.executionKind === "generate_dashboard"
        ? [
            "read_only_execution",
            "artifact_write",
            "render_contract",
            "ordered_delegation",
            "isolated_codex_config",
          ]
        : [
            "read_only_execution",
            "deterministic_gate",
            "row_limit",
            "statement_timeout",
            "ordered_delegation",
            "conditional_repair",
            "isolated_codex_config",
          ],
  };
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

// Enrich is scoped-only (no whole-profile aggregator), mirroring Ask rather than Setup: the profile
// deliberately mixes two dispatchable read-only skills with a gated-tool component (non-`skill`
// realization_kind, host-owned capabilities) that no headless target can ever legalize, so a
// `.map()`-style aggregator across the whole profile would always throw and would not describe
// anything real. Each enrichment component is dispatched with its own `dispatch --component <id>`
// turn, exactly like the two existing families' per-component calls.
export function buildEnrichAgentManifest(prepared: PreparedEnrichComponent): AgentManifest {
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
      read_only_execution: {
        enforcement: "mcp_only_read_only_sandbox",
        locked: true,
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

export function buildEnrichManifest(prepared: PreparedEnrichComponent): Manifest {
  return {
    manifest_version: "0.1",
    compat: {
      min_ir_version: SUPPORTED_IR_VERSION,
      max_ir_version: SUPPORTED_IR_VERSION,
    },
    profile: prepared.profile,
    target: TARGET,
    session: {
      persistence: "codex_thread_history",
      lifecycle_operations: [...SESSION_LIFECYCLE_OPERATIONS],
      artifact_reference: "allowlisted_mcp_tool_result",
      isolation: "dedicated_persistent_codex_home",
      authentication: "externally_provisioned",
    },
    agents: [buildEnrichAgentManifest(prepared)],
  };
}

export function describeEnrichTarget(prepared: PreparedEnrichComponent): TargetDescription {
  return {
    target: TARGET,
    phase: "enrich-parity",
    execution_modes: ["one_shot", "persistent_session"],
    session_persistence: "codex_thread_history",
    lifecycle_operations: [...SESSION_LIFECYCLE_OPERATIONS],
    supported_components: [prepared.componentId],
    tiers: [prepared.step.tier],
    capabilities: prepared.capabilities.map((entry) => entry.capability),
    tools: [...prepared.enabledTools],
    guardrails: ["read_only_execution", "isolated_codex_config"],
  };
}
