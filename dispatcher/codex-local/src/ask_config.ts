import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DISABLED_FEATURES,
  codexMcpCallableName,
  tomlString,
  tomlStringArray,
} from "./config.js";
import type { PreparedAskComponent, PreparedAskStep } from "./ask_prepare.js";
import { REQUEST_TRANSPORT_SERVER, REQUEST_TRANSPORT_TOOL } from "./request_transport.js";

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
  requestFile: string;
  agents: AskAgentConfigFile[];
  parentConfig: Record<string, unknown>;
  bindRequest: (request: string) => void;
  cleanup: () => void;
}

function renderConfigValue(value: unknown): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return tomlStringArray(value);
  }
  throw new Error("Ask app-server config contains an unsupported value");
}

/**
 * Custom-agent roles must be registered when app-server starts. Supplying the
 * same keys only in thread/start is too late: the collaboration tool's agent
 * registry has already been constructed and spawnAgent rejects the role.
 */
export function buildAskAppServerArgs(bundle: AskAgentConfigBundle): string[] {
  const args = ["app-server", "--stdio", "--strict-config"];
  for (const [key, value] of Object.entries(bundle.parentConfig)) {
    args.push("-c", `${key}=${renderConfigValue(value)}`);
  }
  return args;
}

function childInstructions(prepared: PreparedAskComponent, step: PreparedAskStep): string {
  const toolNames = step.enabledTools
    .map(
      (tool) =>
        `${prepared.mcp.name}.${tool} -> ${codexMcpCallableName(prepared.mcp.name, tool)}`,
    )
    .join(", ");
  const requestTransportCallable = codexMcpCallableName(
    REQUEST_TRANSPORT_SERVER,
    REQUEST_TRANSPORT_TOOL,
  );
  const dashboardContract =
    prepared.executionKind === "generate_dashboard"
      ? [
          `The exact allowed dashboard block contract is ${JSON.stringify(prepared.node.effect.render_blocks)}.`,
          "Each contract entry's fields object is schema metadata, not an output wrapper: emit each declared field directly beside type at the block top level and never emit a fields key.",
          "A field whose type ends in ? is optional: omit it when unavailable and never emit null for it.",
          "Use every required field declared for a chosen block type, use no undeclared fields, and represent each row as a JSON object keyed by its column names.",
        ]
      : [];
  const dashboardOutput =
    prepared.executionKind === "generate_dashboard" &&
    step.name === prepared.steps.at(-1)?.name
      ? [
          "The value in the successful step envelope must be the dashboard render artifact: a JSON object with non-empty blocks, optional summary, and boolean verified.",
          "Blocks may use only the block types and fields declared in the exact allowed dashboard block contract above; include at least one data panel and one definition block.",
          "Set verified=true only when the required MCP queries completed successfully and the returned values were validated.",
        ]
      : [];
  const requiredTool = step.requireSuccessfulTool
    ? [
        "This step requires at least one successful call to an enabled MCP tool. The configured tool is available: attempt the call before reporting any tool availability failure.",
      ]
    : [];
  return [
    `You are the named Warble step agent '${step.role}'.`,
    `Execute only IR step '${step.name}' and produce slot '${step.produces}'.`,
    `Before any reasoning or business MCP call, call ${REQUEST_TRANSPORT_SERVER}.${REQUEST_TRANSPORT_TOOL} through its exact qualified Codex callable ${requestTransportCallable} exactly once. Its returned text is the authoritative original user request for this turn.`,
    `When MCP tools are exposed through code-mode exec, invoke exactly await tools.${requestTransportCallable}({}); do not guess, shorten, or rename the callable.`,
    "Never ask the parent to copy, summarize, or reconstruct the original request, and never continue if the request transport call fails.",
    `Use only these MCP tools when needed (raw identity -> exact qualified Codex callable): ${toolNames}.`,
    "Under code-mode exec, invoke the qualified callable shown above through tools; do not guess an alias or use exec for any non-MCP operation.",
    "Do not use shell, file mutation, web, browser, apps, plugins, skills, or child agents.",
    "Return exactly one JSON object with keys warble_step, produces, ok, value, and error.",
    `warble_step must equal '${step.name}' and produces must equal '${step.produces}'.`,
    "On success set ok=true, put the produced slot value in value, and set error=null exactly; never use an empty error string.",
    "On failure set ok=false, keep the produced slot value with any diagnostics needed by a declared repair step, and use a non-empty stable non-secret error string.",
    "Do not wrap the JSON in markdown and do not add prose.",
    ...requiredTool,
    ...dashboardContract,
    ...dashboardOutput,
    "",
    "Step contract:",
    step.prompt,
  ].join("\n");
}

export function renderAskAgentToml(
  prepared: PreparedAskComponent,
  step: PreparedAskStep,
  requestFile: string,
): string {
  const serverKey = `mcp_servers.${prepared.mcp.name}`;
  const requestServerKey = `mcp_servers.${REQUEST_TRANSPORT_SERVER}`;
  const builtRequestMcp = fileURLToPath(new URL("./request_mcp.js", import.meta.url));
  const sourceRequestMcp = fileURLToPath(new URL("./request_mcp.ts", import.meta.url));
  const sourceTsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
  const requestMcp = existsSync(builtRequestMcp) ? builtRequestMcp : sourceRequestMcp;
  const requestMcpCommand = existsSync(builtRequestMcp) ? process.execPath : sourceTsx;
  if (!existsSync(requestMcp) || !existsSync(requestMcpCommand)) {
    throw new Error("Ask request transport executable is unavailable");
  }
  const lines = [
    `name = ${tomlString(step.role)}`,
    `description = ${tomlString(`Executes Warble IR step ${step.name}`)}`,
    `developer_instructions = ${tomlString(childInstructions(prepared, step))}`,
    `model = ${tomlString(step.model)}`,
    `approval_policy = ${tomlString("never")}`,
    `sandbox_mode = ${tomlString("read-only")}`,
    "",
    "[agents]",
    "enabled = false",
    "",
    `[${serverKey}]`,
    `command = ${tomlString(prepared.mcp.command)}`,
    `args = ${tomlStringArray(prepared.mcp.args ?? [])}`,
    `enabled_tools = ${tomlStringArray(step.enabledTools)}`,
    `default_tools_approval_mode = ${tomlString("approve")}`,
    "required = true",
    "",
    `[${requestServerKey}]`,
    `command = ${tomlString(requestMcpCommand)}`,
    `args = ${tomlStringArray([requestMcp, "--request-file", requestFile])}`,
    `enabled_tools = ${tomlStringArray([REQUEST_TRANSPORT_TOOL])}`,
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
    const requestFile = join(directory, "original-request.txt");
    writeFileSync(requestFile, "", { encoding: "utf8", mode: 0o600 });
    const agents = prepared.steps.map((step): AskAgentConfigFile => {
      const path = join(directory, `${step.role}.toml`);
      writeFileSync(path, renderAskAgentToml(prepared, step, requestFile), { encoding: "utf8", mode: 0o600 });
      return { role: step.role, path, model: step.model, tools: [...step.enabledTools] };
    });
    const parentConfig: Record<string, unknown> = {
      "shell_environment_policy.inherit": "none",
      project_doc_max_bytes: 0,
      project_root_markers: [],
      web_search: "disabled",
      // Current Codex collaboration tools are invoked through code-mode exec.
      // The parent has no business MCP servers and every non-collaboration
      // surface remains disabled below, so this only exposes the IR driver.
      "features.code_mode.enabled": true,
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
      requestFile,
      agents,
      parentConfig,
      bindRequest: (request) => writeFileSync(requestFile, request, { encoding: "utf8", mode: 0o600 }),
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
