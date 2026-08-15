import type { PreparedSetupComponent } from "./prepare.js";
import type { PreparedEnrichComponent } from "./enrich_prepare.js";

type PreparedOneShotComponent = PreparedSetupComponent | PreparedEnrichComponent;

/** Structurally matches both `PreparedSetupStep` and `PreparedEnrichStep` — the two engines stay
 * separate types, but a single prepared step is enough to build this target's args/prompt for
 * either one. */
export interface PreparedStepLike {
  name: string;
  model: string;
  prompt: string;
  consumes: string[];
  produces: string;
}

const API_BILLING_ENV_KEYS = new Set([
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "OPENAI_ORGANIZATION",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT",
  "OPENAI_PROJECT_ID",
]);

export const DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "shell_zsh_fork",
  "unified_exec_zsh_fork",
  "standalone_web_search",
  "apps",
  "plugins",
  "in_app_browser",
  "browser_use",
  "computer_use",
  "image_generation",
  "skill_search",
  "multi_agent",
] as const;

export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(",")}]`;
}

function sanitizeCodexToolName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

export function codexMcpCallableNamespace(server: string): string {
  return `mcp__${sanitizeCodexToolName(server)}`;
}

export function codexMcpCallableName(server: string, tool: string): string {
  return `${codexMcpCallableNamespace(server)}__${sanitizeCodexToolName(tool)}`;
}

export function sanitizeCodexEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!API_BILLING_ENV_KEYS.has(key.toUpperCase()) && value !== undefined) clean[key] = value;
  }
  return clean;
}

export interface InvocationArgsOptions {
  cwd: string;
  codexArgsPrefix?: string[];
}

export function buildIsolationArgs(prepared: PreparedOneShotComponent): string[] {
  const serverKey = `mcp_servers.${prepared.mcp.name}`;
  const args = [
    "-c",
    "shell_environment_policy.inherit=none",
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    "project_root_markers=[]",
    "-c",
    `web_search=${tomlString("disabled")}`,
    "-c",
    "features.code_mode.enabled=false",
    "-c",
    `features.code_mode.direct_only_tool_namespaces=${tomlStringArray([codexMcpCallableNamespace(prepared.mcp.name)])}`,
    "-c",
    `${serverKey}.command=${tomlString(prepared.mcp.command)}`,
    "-c",
    `${serverKey}.args=${tomlStringArray(prepared.mcp.args ?? [])}`,
    "-c",
    `${serverKey}.enabled_tools=${tomlStringArray(prepared.enabledTools)}`,
    "-c",
    `${serverKey}.default_tools_approval_mode=${tomlString("approve")}`,
    "-c",
    `${serverKey}.required=true`,
  ];
  for (const feature of DISABLED_FEATURES) args.push("--disable", feature);
  return args;
}

export function buildIsolationConfig(prepared: PreparedOneShotComponent): Record<string, unknown> {
  const serverKey = `mcp_servers.${prepared.mcp.name}`;
  return {
    "shell_environment_policy.inherit": "none",
    project_doc_max_bytes: 0,
    project_root_markers: [],
    web_search: "disabled",
    "features.code_mode.enabled": false,
    "features.code_mode.direct_only_tool_namespaces": [
      codexMcpCallableNamespace(prepared.mcp.name),
    ],
    [`${serverKey}.command`]: prepared.mcp.command,
    [`${serverKey}.args`]: prepared.mcp.args ?? [],
    [`${serverKey}.enabled_tools`]: prepared.enabledTools,
    [`${serverKey}.default_tools_approval_mode`]: "approve",
    [`${serverKey}.required`]: true,
    ...Object.fromEntries(DISABLED_FEATURES.map((feature) => [`features.${feature}`, false])),
  };
}

export function buildCodexArgs(
  prepared: PreparedOneShotComponent,
  step: PreparedStepLike,
  options: InvocationArgsOptions,
): string[] {
  const args = [
    ...(options.codexArgsPrefix ?? []),
    "--ask-for-approval",
    "never",
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--cd",
    options.cwd,
    "--model",
    step.model,
    ...buildIsolationArgs(prepared),
  ];
  args.push("-");
  return args;
}

/**
 * `inputs` carries the marshalled values this step's `consumes` names resolve to from earlier
 * steps' outputs in this same dispatch. When a step declares no `consumes` (every existing
 * single-step fixture, and the first step of any multi-step component), no input section is added.
 */
export function buildPrompt(
  prepared: PreparedOneShotComponent,
  step: PreparedStepLike,
  request: string,
  inputs: Record<string, unknown> = {},
): string {
  const tools = prepared.enabledTools
    .map(
      (tool) =>
        `${prepared.mcp.name}.${tool} -> ${codexMcpCallableName(prepared.mcp.name, tool)}`,
    )
    .join(", ");
  const terminalContract = [
    `The final answer must be one JSON object with exactly the produced field '${step.produces}'.`,
    "Do not wrap the JSON in Markdown or include prose.",
  ];
  const inputSection =
    step.consumes.length === 0
      ? []
      : [
          "",
          "Inputs from earlier steps (JSON):",
          JSON.stringify(Object.fromEntries(step.consumes.map((name) => [name, inputs[name]]))),
        ];
  return [
    `You are executing Warble target ${prepared.target}.`,
    `Run exactly one profile step: ${prepared.componentId}.${step.name}.`,
    `Only use the allowlisted MCP tools (raw identity -> Codex callable name): ${tools}.`,
    "The raw and qualified names identify the same MCP tool; call the qualified Codex name, not a fallback.",
    "Do not use shell, file mutation, web, browser, apps, plugins, skills, or delegation.",
    "If the required MCP tool is unavailable or fails, fail loudly; do not substitute another mechanism.",
    ...terminalContract,
    ...inputSection,
    "",
    "Step contract:",
    step.prompt,
    "",
    "User request:",
    request,
  ].join("\n");
}
