import type { PreparedSetupComponent } from "./prepare.js";

const API_BILLING_ENV_KEYS = new Set([
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "OPENAI_ORGANIZATION",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT",
  "OPENAI_PROJECT_ID",
]);

const DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "shell_zsh_fork",
  "unified_exec_zsh_fork",
  "js_repl",
  "code_mode",
  "web_search_request",
  "web_search_cached",
  "standalone_web_search",
  "apps",
  "plugins",
  "in_app_browser",
  "browser_use",
  "computer_use",
  "image_generation",
  "skill_search",
  "tool_search",
  "apply_patch_freeform",
  "multi_agent",
] as const;

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(",")}]`;
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

export function buildCodexArgs(
  prepared: PreparedSetupComponent,
  options: InvocationArgsOptions,
): string[] {
  const serverKey = `mcp_servers.${prepared.mcp.name}`;
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
    prepared.model,
    "-c",
    "shell_environment_policy.inherit=none",
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    "project_root_markers=[]",
    "-c",
    `${serverKey}.command=${tomlString(prepared.mcp.command)}`,
    "-c",
    `${serverKey}.args=${tomlStringArray(prepared.mcp.args ?? [])}`,
    "-c",
    `${serverKey}.enabled_tools=${tomlStringArray(prepared.enabledTools)}`,
    "-c",
    `${serverKey}.required=true`,
  ];
  for (const feature of DISABLED_FEATURES) {
    args.push("--disable", feature);
  }
  args.push("-");
  return args;
}

export function buildPrompt(prepared: PreparedSetupComponent, request: string): string {
  return [
    `You are executing Warble target ${prepared.target}.`,
    `Run exactly one profile step: ${prepared.componentId}.${prepared.step.name}.`,
    `Only use the allowlisted MCP tools from server '${prepared.mcp.name}': ${prepared.enabledTools.join(", ")}.`,
    "Do not use shell, file mutation, web, browser, apps, plugins, skills, or delegation.",
    "If the required MCP tool is unavailable or fails, fail loudly; do not substitute another mechanism.",
    `The final answer must include the produced field '${prepared.step.produces ?? "result"}'.`,
    "",
    "Step contract:",
    prepared.step.prompt,
    "",
    "User request:",
    request,
  ].join("\n");
}
