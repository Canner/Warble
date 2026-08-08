import assert from "node:assert/strict";
import { test } from "node:test";

import { buildEnrichManifest, describeEnrichTarget } from "../src/index.js";
import { preparedEnrich } from "./helpers.js";

test("Enrich manifest for inspect_context resolves both domain capabilities via the allowlisted MCP server, never native", () => {
  const manifest = buildEnrichManifest(preparedEnrich("inspect_context"));
  assert.deepEqual(manifest, {
    manifest_version: "0.1",
    compat: { min_ir_version: "0.4", max_ir_version: "0.4" },
    profile: "genbi-enrich-context",
    target: "codex:local",
    session: {
      persistence: "codex_thread_history",
      lifecycle_operations: ["start", "resume", "read", "turn", "steer", "interrupt", "fork"],
      artifact_reference: "allowlisted_mcp_tool_result",
      isolation: "dedicated_persistent_codex_home",
      authentication: "externally_provisioned",
    },
    agents: [
      {
        id: "inspect_context",
        verb: "inspect_context",
        component_type: "analytical",
        realization_kind: "skill",
        trigger: "one_shot",
        outcome: "none",
        steps: [
          { name: "inspect", tier: "cheap", model: "gpt-5.4", consumes: [], produces: "enrichment_gaps" },
        ],
        capabilities: [
          { capability: "semantic_introspection", outcome: "realize-via", via: "mcp:enrich" },
          { capability: "raw_material_read", outcome: "realize-via", via: "mcp:enrich" },
          { capability: "llm:cheap", outcome: "native", via: null },
        ],
        tools: [
          { name: "get_context", source: "mcp:enrich" },
          { name: "read_raw_material", source: "mcp:enrich" },
        ],
        guardrails: {
          read_only_execution: { enforcement: "mcp_only_read_only_sandbox", locked: true },
          isolated_codex_config: {
            ignore_user_config: true,
            ephemeral: true,
            approval_policy: "never",
            sandbox: "read-only",
            api_key_environment: "removed",
          },
        },
      },
    ],
  });
});

test("Enrich manifest for draft_enrichment carries the strong step and its single domain capability", () => {
  const manifest = buildEnrichManifest(preparedEnrich("draft_enrichment"));
  assert.equal(manifest.agents[0]!.steps[0]!.tier, "strong");
  assert.deepEqual(manifest.agents[0]!.capabilities, [
    { capability: "semantic_introspection", outcome: "realize-via", via: "mcp:enrich" },
    { capability: "llm:strong", outcome: "native", via: null },
  ]);
  assert.deepEqual(manifest.agents[0]!.tools, [{ name: "get_context", source: "mcp:enrich" }]);
});

test("describeEnrichTarget surfaces phase, tiers, capabilities, tools, and guardrails per scoped component", () => {
  assert.deepEqual(describeEnrichTarget(preparedEnrich("inspect_context")), {
    target: "codex:local",
    phase: "enrich-parity",
    execution_modes: ["one_shot", "persistent_session"],
    session_persistence: "codex_thread_history",
    lifecycle_operations: ["start", "resume", "read", "turn", "steer", "interrupt", "fork"],
    supported_components: ["inspect_context"],
    tiers: ["cheap"],
    capabilities: ["semantic_introspection", "raw_material_read", "llm:cheap"],
    tools: ["get_context", "read_raw_material"],
    guardrails: ["read_only_execution", "isolated_codex_config"],
  });

  assert.deepEqual(describeEnrichTarget(preparedEnrich("draft_enrichment")), {
    target: "codex:local",
    phase: "enrich-parity",
    execution_modes: ["one_shot", "persistent_session"],
    session_persistence: "codex_thread_history",
    lifecycle_operations: ["start", "resume", "read", "turn", "steer", "interrupt", "fork"],
    supported_components: ["draft_enrichment"],
    tiers: ["strong"],
    capabilities: ["semantic_introspection", "llm:strong"],
    tools: ["get_context"],
    guardrails: ["read_only_execution", "isolated_codex_config"],
  });
});
