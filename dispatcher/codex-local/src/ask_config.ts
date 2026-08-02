import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DISABLED_FEATURES,
  codexMcpCallableNamespace,
  tomlString,
  tomlStringArray,
} from "./config.js";
import type { PreparedAskComponent, PreparedAskStep } from "./ask_prepare.js";

const ASK_DISABLED_FEATURES = DISABLED_FEATURES.filter(
  (feature) => feature !== "multi_agent",
);

export interface AskAgentConfigFile {
  role: string;
  path: string;
  model: string;
  tools: string[];
}

export interface AskAgentConfigBundle {
  directory: string;
  agents: AskAgentConfigFile[];
  parentConfig: Record<string, unknown>;
  cleanup: () => void;
}

function childInstructions(prepared: PreparedAskComponent, step: PreparedAskStep): string {
  const toolNames = step.enabledTools
    .map((tool) => `${prepared.mcp.name}.${tool}`)
    .join(", ");
  return [
    `You are the named Warble step agent '${step.role}'.`,
    `Execute only IR step '${step.name}' and produce slot '${step.produces}'.`,
    `Use only these MCP tools when needed: ${toolNames}.`,
    "Do not use shell, file mutation, web, browser, apps, plugins, skills, or child agents.",
    "Return exactly one JSON object with keys warble_step, produces, ok, value, and error.",
    `warble_step must equal '${step.name}' and produces must equal '${step.produces}'.`,
    "Set ok=false with a stable non-secret error when execution or validation fails.",
    "Do not wrap the JSON in markdown and do not add prose.",
    "",
    "Step contract:",
    step.prompt,
  ].join("\n");
}

export function renderAskAgentToml(
  prepared: PreparedAskComponent,
  step: PreparedAskStep,
): string {
  const serverKey = `mcp_servers.${prepared.mcp.name}`;
  const lines = [
    `name = ${tomlString(step.role)}`,
    `description = ${tomlString(`Executes Warble IR step ${step.name}`)}`,
    `developer_instructions = ${tomlString(childInstructions(prepared, step))}`,
    `model = ${tomlString(step.model)}`,
    `approval_policy = ${tomlString("never")}`,
    `sandbox_mode = ${tomlString("read-only")}`,
    "project_doc_max_bytes = 0",
    "project_root_markers = []",
    `web_search = ${tomlString("disabled")}`,
    "",
    "[shell_environment_policy]",
    `inherit = ${tomlString("none")}`,
    "",
    "[agents]",
    "enabled = false",
    "",
    "[features]",
    "multi_agent = false",
    ...ASK_DISABLED_FEATURES.map((feature) => `${feature} = false`),
    "",
    "[features.code_mode]",
    "enabled = false",
    `direct_only_tool_namespaces = ${tomlStringArray([codexMcpCallableNamespace(prepared.mcp.name)])}`,
    "",
    `[${serverKey}]`,
    `command = ${tomlString(prepared.mcp.command)}`,
    `args = ${tomlStringArray(prepared.mcp.args ?? [])}`,
    `enabled_tools = ${tomlStringArray(step.enabledTools)}`,
    `default_tools_approval_mode = ${tomlString("approve")}`,
    "required = true",
    "",
  ];
  return lines.join("\n");
}

export function createAskAgentConfigBundle(
  prepared: PreparedAskComponent,
): AskAgentConfigBundle {
  const directory = mkdtempSync(join(tmpdir(), "warble-codex-agents-"));
  try {
    const agents = prepared.steps.map((step): AskAgentConfigFile => {
      const path = join(directory, `${step.role}.toml`);
      writeFileSync(path, renderAskAgentToml(prepared, step), { encoding: "utf8", mode: 0o600 });
      return { role: step.role, path, model: step.model, tools: [...step.enabledTools] };
    });
    const parentConfig: Record<string, unknown> = {
      "shell_environment_policy.inherit": "none",
      project_doc_max_bytes: 0,
      project_root_markers: [],
      web_search: "disabled",
      "features.code_mode.enabled": false,
      "features.multi_agent": true,
      "agents.enabled": true,
      // Codex applies this as the total spawned-thread capacity for the session.
      // Warble enforces sequential spawn -> wait ordering in the event validator.
      "agents.max_concurrent_threads_per_session": prepared.steps.length,
      ...Object.fromEntries(
        ASK_DISABLED_FEATURES.map((feature) => [`features.${feature}`, false]),
      ),
    };
    for (const agent of agents) {
      parentConfig[`agents.${agent.role}.description`] =
        `Execute only the Warble step mapped to ${agent.role}`;
      parentConfig[`agents.${agent.role}.config_file`] = agent.path;
    }
    return {
      directory,
      agents,
      parentConfig,
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
