import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { prepareSetup, type McpServerConfig, type PreparedSetupComponent } from "../src/index.js";

export const SETUP_IR_PATH = fileURLToPath(
  new URL("../../../genbi-setup/ir.golden.json", import.meta.url),
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

export function prepared(component = "connect_source"): PreparedSetupComponent {
  return prepareSetup({
    ir: readFileSync(SETUP_IR_PATH, "utf8"),
    component,
    model: "gpt-5.4",
    mcp: fakeMcp(),
  });
}
