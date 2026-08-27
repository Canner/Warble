import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  prepareAsk,
  prepareEnrich,
  prepareAssertion,
  prepareSetup,
  type AskMcpServerConfig,
  type EnrichMcpServerConfig,
  type McpServerConfig,
  type PreparedAskComponent,
  type PreparedEnrichComponent,
  type PreparedSetupComponent,
  type PreparedAssertionComponent,
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
export const ASSERTION_IR_PATH = fileURLToPath(
  new URL("../../../examples/monitor-agent/ir.golden.json", import.meta.url),
);
export const GENBI_ASSERTION_IR_PATH = fileURLToPath(
  new URL("../../../genbi-monitor/ir.golden.json", import.meta.url),
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
    toolsByCapability: {
      source_connect: ["probe_setup"],
      context_build: ["probe_setup"],
    },
  };
}

export function prepared(component = "attach_source"): PreparedSetupComponent {
  return prepareSetup({
    ir: readFileSync(SETUP_IR_PATH, "utf8"),
    component,
    model: "gpt-5.4",
    mcp: fakeMcp(),
  });
}

export function fakeAskMcp(): AskMcpServerConfig {
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
  };
}

export function preparedAsk(component = "answer_query"): PreparedAskComponent {
  return prepareAsk({
    ir: readFileSync(ASK_IR_PATH, "utf8"),
    component,
    models: {
      orchestrator: "gpt-5.6",
      cheap: "gpt-5.6-terra",
      strong: "gpt-5.6-sol",
    },
    mcp: fakeAskMcp(),
  });
}

export function preparedDashboard(): PreparedAskComponent {
  return preparedAsk("generate_dashboard");
}

export function fakeEnrichMcp(): EnrichMcpServerConfig {
  return {
    name: "enrich",
    command: process.execPath,
    args: [FAKE_MCP],
    toolsByCapability: {
      semantic_introspection: ["get_context"],
      raw_material_read: ["read_raw_material"],
    },
  };
}

export function preparedEnrich(component = "survey_context"): PreparedEnrichComponent {
  return prepareEnrich({
    ir: readFileSync(ENRICH_IR_PATH, "utf8"),
    component,
    model: "gpt-5.4",
    mcp: fakeEnrichMcp(),
  });
}

export function preparedAssertion(component = "monitor_freshness"): PreparedAssertionComponent {
  return prepareAssertion({
    ir: readFileSync(ASSERTION_IR_PATH, "utf8"),
    component,
    model: "gpt-5.6-terra",
  });
}
