/**
 * Host-supplied stdio MCP server for `chat` (`--host-mcp-config <absolute path>`).
 *
 * A host that embeds `chat` as a subprocess cannot pass callbacks the way a library caller of
 * `dispatch()` can. This seam lets it name ONE stdio MCP server and the exact tools on it that the
 * agent may call; the read-only guardrail then allows exactly `mcp__<name>__<tool>` for those tools
 * and keeps refusing every other `mcp__*` tool.
 *
 * The config file is trusted input from the host, so it is checked like one: absolute path, opened
 * with `O_NOFOLLOW`, a regular file, owned by the current user, and not readable or writable by group
 * or others. The file is expected to hold no secret (a host keeps its token in a separate file it
 * names in `args`); even so, nothing here ever echoes its contents, `args` or the environment — error
 * messages name only the offending key.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";

import { DispatchError } from "./error.js";

export interface HostMcpConfig {
  /** MCP server name, `[a-z0-9_]{1,32}`; the agent sees its tools as `mcp__<name>__<tool>`. */
  name: string;
  /** Absolute path of the server executable. */
  command: string;
  args: string[];
  /** The only tools on this server the guardrail allows, each `[a-z0-9_]{1,64}`. */
  tools: string[];
  /** Optional single line (at most 300 chars) appended to the system prompt. */
  instruction?: string;
}

const NAME_RE = /^[a-z0-9_]{1,32}$/;
const TOOL_RE = /^[a-z0-9_]{1,64}$/;
const LINE_BREAK_RE = /[\r\n\u2028\u2029]/;
const MAX_INSTRUCTION = 300;
const ALLOWED_KEYS = new Set(["name", "command", "args", "tools", "instruction"]);

function reject(reason: string): never {
  throw new DispatchError(`--host-mcp-config: ${reason}`);
}

/** Read the config file, enforcing the location/ownership/mode checks before parsing anything. */
function readTrustedFile(path: string): string {
  if (!isAbsolute(path)) reject("the path must be absolute");
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) reject("file ownership cannot be verified on this platform");
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") reject("the path must not be a symbolic link");
    reject(`the file cannot be opened (${code ?? "unknown error"})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) reject("the path must be a regular file");
    if (st.uid !== uid) reject("the file must be owned by the current user");
    if ((st.mode & 0o077) !== 0) {
      reject("the file must not be accessible by group or others (chmod 600)");
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Validate a parsed config value. Exported for tests; `loadHostMcpConfig` is the entry point. */
export function parseHostMcpConfig(value: unknown): HostMcpConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("the file must contain a JSON object");
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) reject(`unknown key '${key.slice(0, 64)}'`);
  }

  const { name, command, args, tools, instruction } = obj;
  if (typeof name !== "string" || !NAME_RE.test(name)) reject("'name' must match [a-z0-9_]{1,32}");
  if (typeof command !== "string" || !isAbsolute(command)) {
    reject("'command' must be an absolute path");
  }
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    reject("'args' must be an array of strings");
  }
  if (!Array.isArray(tools) || tools.length === 0) reject("'tools' must be a non-empty array");
  for (const t of tools) {
    if (typeof t !== "string" || !TOOL_RE.test(t)) {
      reject("each of 'tools' must match [a-z0-9_]{1,64}");
    }
  }
  if (new Set(tools).size !== tools.length) reject("'tools' must not repeat a tool");
  if (instruction !== undefined) {
    if (typeof instruction !== "string" || instruction.trim().length === 0) {
      reject("'instruction' must be a non-empty string");
    }
    if (instruction.length > MAX_INSTRUCTION) {
      reject(`'instruction' must be at most ${MAX_INSTRUCTION} characters`);
    }
    if (LINE_BREAK_RE.test(instruction)) reject("'instruction' must be a single line");
  }

  return {
    name,
    command,
    args: [...(args as string[])],
    tools: [...(tools as string[])],
    ...(instruction !== undefined ? { instruction: instruction as string } : {}),
  };
}

/** Load and validate a `--host-mcp-config` file. Throws `DispatchError` without echoing contents. */
export function loadHostMcpConfig(path: string): HostMcpConfig {
  const raw = readTrustedFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parser's message can quote the input, so it is deliberately not forwarded.
    reject("the file is not valid JSON");
  }
  return parseHostMcpConfig(parsed);
}

/** The exact tool names the guardrail allows for this server: `mcp__<name>__<tool>`. */
export function hostMcpToolNames(cfg: HostMcpConfig): string[] {
  return cfg.tools.map((tool) => `mcp__${cfg.name}__${tool}`);
}

/** The `query()` `mcpServers` entry for this server. */
export function hostMcpServerEntry(cfg: HostMcpConfig): McpStdioServerConfig {
  return { type: "stdio", command: cfg.command, args: [...cfg.args] };
}
