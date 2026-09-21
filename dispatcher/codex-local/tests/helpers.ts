import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  prepareOrchestrate,
  prepareTurn,
  prepareExec,
  type OrchestrateMcpServerConfig,
  type TurnMcpServerConfig,
  type McpServerConfig,
  type PreparedOrchestrateComponent,
  type PreparedTurnComponent,
  type PreparedExecComponent,
} from "../src/index.js";

export const SETUP_IR_PATH = fileURLToPath(
  new URL("../../../examples/provision-agent/ir.golden.json", import.meta.url),
);
export const ASK_IR_PATH = fileURLToPath(
  new URL("../../../examples/analysis-agent/ir.golden.json", import.meta.url),
);
export const ENRICH_IR_PATH = fileURLToPath(
  new URL("../../../examples/propose-apply-agent/ir.golden.json", import.meta.url),
);
export const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
export const FAKE_MCP = fileURLToPath(new URL("./fixtures/fake-mcp.mjs", import.meta.url));
export const FAKE_APP_SERVER = fileURLToPath(
  new URL("./fixtures/fake-app-server.mjs", import.meta.url),
);

export function fakeMcp(): McpServerConfig {
  return {
    name: "setup",
    command: process.execPath,
    args: [FAKE_MCP],
    toolsByStep: {
      attach: ["probe_setup"],
      compose: ["probe_setup"],
    },
    requireTool: ["attach", "compose"],
  };
}

export function prepared(component = "attach_source"): PreparedExecComponent {
  return prepareExec({
    ir: readFileSync(SETUP_IR_PATH, "utf8"),
    component,
    model: "gpt-5.4",
    mcp: fakeMcp(),
  });
}

export function fakeOrchestrateMcp(): OrchestrateMcpServerConfig {
  return {
    name: "wren",
    command: process.execPath,
    args: [FAKE_MCP],
    toolsByStep: {
      resolve_intent: ["get_context"],
      generate_sql: ["run_sql"],
      repair_sql: ["run_sql"],
      plan_dashboard: ["get_context"],
      compose_layout: ["run_sql"],
    },
    requireTool: ["generate_sql", "repair_sql", "plan_dashboard", "compose_layout"],
  };
}

export function preparedAsk(component = "answer_query"): PreparedOrchestrateComponent {
  return prepareOrchestrate({
    ir: readFileSync(ASK_IR_PATH, "utf8"),
    component,
    models: {
      orchestrator: "gpt-5.6",
      cheap: "gpt-5.6-terra",
      strong: "gpt-5.6-sol",
    },
    mcp: fakeOrchestrateMcp(),
  });
}

/**
 * Retain deterministic coverage for the already-supported uncomposed dashboard runtime shape.
 * The canonical Hub dashboard now carries a component-call edge and is separately required to
 * wall-hit on codex:local until that target gains component invocation.
 */
export function uncomposedDashboardIr(): string {
  const parsed = JSON.parse(readFileSync(ASK_IR_PATH, "utf8")) as {
    components: Array<Record<string, unknown>>;
  };
  const dashboard = parsed.components.find((component) => component["id"] === "generate_dashboard");
  if (!dashboard) throw new Error("analysis-agent must contain generate_dashboard");
  dashboard["required_capabilities"] = [
    "sql_execution:read_only",
    "genbi_build",
    "render_contract",
    "artifact_write",
    "llm:per_step_tier",
    "llm:strong",
    "llm:cheap",
  ];
  for (const step of dashboard["llm_calls"] as Array<Record<string, unknown>>) {
    delete step["component_calls"];
  }
  return JSON.stringify(parsed);
}

export function preparedDashboard(): PreparedOrchestrateComponent {
  return prepareOrchestrate({
    ir: uncomposedDashboardIr(),
    component: "generate_dashboard",
    models: {
      orchestrator: "gpt-5.6",
      cheap: "gpt-5.6-terra",
      strong: "gpt-5.6-sol",
    },
    mcp: fakeOrchestrateMcp(),
  });
}

export function fakeEnrichMcp(): TurnMcpServerConfig {
  return {
    name: "enrich",
    command: process.execPath,
    args: [FAKE_MCP],
    toolsByStep: {
      survey: ["get_context", "read_raw_material"],
      propose: ["get_context"],
    },
    requireTool: ["survey", "propose"],
  };
}

export function preparedEnrich(component = "survey_context"): PreparedTurnComponent {
  return prepareTurn({
    ir: readFileSync(ENRICH_IR_PATH, "utf8"),
    component,
    model: "gpt-5.4",
    mcp: fakeEnrichMcp(),
  });
}
