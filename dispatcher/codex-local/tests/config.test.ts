import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCodexArgs,
  buildPrompt,
  sanitizeCodexEnvironment,
} from "../src/index.js";
import { prepared } from "./helpers.js";

test("isolated invocation ignores user config and disables non-Setup surfaces", () => {
  const args = buildCodexArgs(prepared(), { cwd: "/tmp/project" });
  for (const flag of [
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--skip-git-repo-check",
  ]) {
    assert.ok(args.includes(flag), `${flag} must be present`);
  }
  assert.ok(args.includes("read-only"));
  assert.ok(args.includes("never"));
  assert.ok(
    args.indexOf("--ask-for-approval") < args.indexOf("exec"),
    "global approval option must precede the exec subcommand",
  );
  assert.ok(args.includes("shell_environment_policy.inherit=none"));
  assert.ok(args.includes("project_doc_max_bytes=0"));
  assert.ok(args.includes("project_root_markers=[]"));
  assert.ok(args.includes('mcp_servers.setup.enabled_tools=["probe_setup"]'));
  for (const feature of [
    "shell_tool",
    "unified_exec",
    "web_search_request",
    "apps",
    "plugins",
    "browser_use",
    "computer_use",
    "apply_patch_freeform",
    "multi_agent",
  ]) {
    const index = args.indexOf(feature);
    assert.ok(index > 0 && args[index - 1] === "--disable", `${feature} must be disabled`);
  }
});

test("API-key billing environment is removed while auth location remains available", () => {
  const clean = sanitizeCodexEnvironment({
    PATH: "/bin",
    HOME: "/home/test",
    CODEX_HOME: "/home/test/.codex",
    OPENAI_API_KEY: "secret-openai",
    CODEX_API_KEY: "secret-codex",
    AZURE_OPENAI_API_KEY: "secret-azure",
    OPENAI_PROJECT: "project",
  });
  assert.deepEqual(clean, {
    PATH: "/bin",
    HOME: "/home/test",
    CODEX_HOME: "/home/test/.codex",
  });
});

test("prompt binds exactly one step and forbids fallback mechanisms", () => {
  const prompt = buildPrompt(prepared(), "connect a disposable source");
  assert.match(prompt, /connect_source\.connect/);
  assert.match(prompt, /Only use the allowlisted MCP tools/);
  assert.match(prompt, /Do not use shell, file mutation, web/);
  assert.match(prompt, /fail loudly; do not substitute/);
  assert.match(prompt, /connection_summary/);
});
