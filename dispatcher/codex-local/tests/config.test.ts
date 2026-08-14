import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCodexArgs,
  buildPrompt,
  sanitizeCodexEnvironment,
} from "../src/index.js";
import { prepared } from "./helpers.js";

test("isolated invocation ignores user config and disables non-Setup surfaces", () => {
  const component = prepared();
  const args = buildCodexArgs(component, component.steps[0]!, { cwd: "/tmp/project" });
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
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes("features.code_mode.enabled=false"));
  assert.ok(args.includes('features.code_mode.direct_only_tool_namespaces=["mcp__setup"]'));
  assert.equal(args.includes("code_mode"), false);
  assert.ok(args.includes('mcp_servers.setup.enabled_tools=["probe_setup"]'));
  assert.ok(args.includes('mcp_servers.setup.default_tools_approval_mode="approve"'));
  for (const feature of [
    "shell_tool",
    "unified_exec",
    "apps",
    "plugins",
    "browser_use",
    "computer_use",
    "multi_agent",
  ]) {
    const index = args.indexOf(feature);
    assert.ok(index > 0 && args[index - 1] === "--disable", `${feature} must be disabled`);
  }
  for (const retiredFeature of [
    "apply_patch_freeform",
    "js_repl",
    "tool_search",
    "web_search_cached",
    "web_search_request",
  ]) {
    assert.ok(
      !args.includes(retiredFeature),
      `${retiredFeature} must not emit a pre-turn Codex config warning`,
    );
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
  const component = prepared();
  const prompt = buildPrompt(component, component.steps[0]!, "connect a disposable source");
  assert.match(prompt, /connect_source\.connect/);
  assert.match(prompt, /Only use the allowlisted MCP tools/);
  assert.match(prompt, /setup\.probe_setup -> mcp__setup__probe_setup/);
  assert.match(prompt, /call the qualified Codex name, not a fallback/);
  assert.match(prompt, /Do not use shell, file mutation, web/);
  assert.match(prompt, /fail loudly; do not substitute/);
  assert.match(prompt, /connection_summary/);
});

test("prompt uses Codex MCP callable-name sanitization", () => {
  const component = prepared();
  component.mcp.name = "set-up";
  component.enabledTools = ["probe.tool"];
  const prompt = buildPrompt(component, component.steps[0]!, "connect a disposable source");
  assert.match(prompt, /set-up\.probe\.tool -> mcp__set_up__probe_tool/);
  const args = buildCodexArgs(component, component.steps[0]!, { cwd: "/tmp/project" });
  assert.ok(args.includes('features.code_mode.direct_only_tool_namespaces=["mcp__set_up"]'));
});
