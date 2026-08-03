import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  createAskAgentConfigBundle,
  renderAskAgentToml,
} from "../src/index.js";
import { preparedAsk } from "./helpers.js";

test("renders one isolated custom-agent layer per IR step", () => {
  const prepared = preparedAsk();
  const bundle = createAskAgentConfigBundle(prepared);
  try {
    assert.equal(bundle.agents.length, 3);
    assert.equal(bundle.parentConfig["features.multi_agent"], true);
    assert.equal(bundle.parentConfig["agents.enabled"], true);
    assert.equal(bundle.parentConfig["agents.max_concurrent_threads_per_session"], 3);
    assert.equal(bundle.parentConfig["features.shell_tool"], false);
    assert.equal(bundle.parentConfig["mcp_servers.wren.command"], undefined);

    for (const [index, agent] of bundle.agents.entries()) {
      const step = prepared.steps[index]!;
      assert.equal(agent.role, step.role);
      assert.equal(agent.model, step.model);
      assert.deepEqual(agent.tools, step.enabledTools);
      assert.equal(bundle.parentConfig[`agents.${agent.role}.config_file`], agent.path);
      const toml = readFileSync(agent.path, "utf8");
      assert.equal(toml, renderAskAgentToml(prepared, step));
      assert.match(toml, new RegExp(`name = "${step.role}"`));
      assert.match(toml, new RegExp(`model = "${step.model.replaceAll(".", "\\.")}"`));
      assert.match(toml, /sandbox_mode = "read-only"/);
      assert.match(toml, /\[agents\]\nenabled = false/);
      assert.doesNotMatch(toml, /multi_agent|shell_tool/);
      assert.match(toml, /\[mcp_servers\.wren\]/);
      assert.match(toml, /required = true/);
      for (const tool of step.enabledTools) assert.match(toml, new RegExp(tool));
      assert.doesNotMatch(toml, /OPENAI_API_KEY|CODEX_API_KEY/);
    }
  } finally {
    bundle.cleanup();
  }
  assert.equal(existsSync(bundle.directory), false);
});

test("child instructions require a structured step envelope and forbid fallback surfaces", () => {
  const prepared = preparedAsk();
  for (const step of prepared.steps) {
    const toml = renderAskAgentToml(prepared, step);
    assert.match(toml, /warble_step, produces, ok, value, and error/);
    assert.match(toml, /Do not use shell, file mutation, web/);
    assert.match(toml, /Do not wrap the JSON in markdown/);
    assert.match(toml, new RegExp(step.name));
    assert.match(toml, new RegExp(step.produces));
  }
});
