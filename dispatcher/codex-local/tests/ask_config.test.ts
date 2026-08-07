import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
  createAskAgentConfigBundle,
  renderAskAgentToml,
} from "../src/index.js";
import { preparedAsk, preparedDashboard } from "./helpers.js";

test("renders one isolated custom-agent layer per IR step", () => {
  const prepared = preparedAsk();
  const bundle = createAskAgentConfigBundle(prepared);
  try {
    assert.equal(bundle.agents.length, 3);
    assert.equal(bundle.parentConfig["features.multi_agent"], true);
    assert.equal(bundle.parentConfig["features.code_mode.enabled"], true);
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
      assert.equal(toml, renderAskAgentToml(prepared, step, bundle.requestFile));
      assert.match(toml, new RegExp(`name = "${step.role}"`));
      assert.match(toml, new RegExp(`model = "${step.model.replaceAll(".", "\\.")}"`));
      assert.match(toml, /sandbox_mode = "read-only"/);
      assert.match(toml, /\[agents\]\nenabled = false/);
      assert.doesNotMatch(toml, /multi_agent|shell_tool/);
      assert.match(toml, /\[mcp_servers\.wren\]/);
      assert.match(toml, /\[mcp_servers\.warble_request_transport\]/);
      assert.match(toml, /get_original_request/);
      assert.match(toml, /mcp__warble_request_transport__get_original_request/);
      for (const tool of step.enabledTools) {
        assert.match(toml, new RegExp(`mcp__wren__${tool}`));
      }
      assert.match(toml, /request_mcp\.ts/);
      assert.match(toml, /node_modules\/\.bin\/tsx/);
      assert.match(toml, /required = true/);
      for (const tool of step.enabledTools) assert.match(toml, new RegExp(tool));
      assert.doesNotMatch(toml, /OPENAI_API_KEY|CODEX_API_KEY/);
    }
    bundle.bindRequest("raw request\nwith JSON: {\"ok\":true}");
    assert.equal(readFileSync(bundle.requestFile, "utf8"), "raw request\nwith JSON: {\"ok\":true}");
    assert.equal(statSync(bundle.requestFile).mode & 0o777, 0o600);
  } finally {
    bundle.cleanup();
  }
  assert.equal(existsSync(bundle.directory), false);
});

test("child instructions require a structured step envelope and forbid fallback surfaces", () => {
  const prepared = preparedAsk();
  for (const step of prepared.steps) {
    const toml = renderAskAgentToml(prepared, step, "/tmp/fake-warble-request");
    assert.match(toml, /warble_step, produces, ok, value, and error/);
    assert.match(toml, /Do not use shell, file mutation, web/);
    assert.match(toml, /Do not wrap the JSON in markdown/);
    assert.match(toml, /set error=null exactly; never use an empty error string/);
    assert.match(toml, /keep the produced slot value with any diagnostics needed by a declared repair step/);
    assert.match(
      toml,
      /warble_request_transport\.get_original_request through its exact qualified Codex callable mcp__warble_request_transport__get_original_request exactly once/,
    );
    assert.match(
      toml,
      /await tools\.mcp__warble_request_transport__get_original_request\(\{\}\)/,
    );
    assert.match(toml, /raw identity -> exact qualified Codex callable/);
    assert.match(toml, new RegExp(step.name));
    assert.match(toml, new RegExp(step.produces));
  }
});

test("child instructions sanitize exact code-mode MCP callable names", () => {
  const prepared = preparedAsk();
  prepared.mcp.name = "wr-en";
  const step = prepared.steps[0]!;
  step.enabledTools = ["context.show"];
  const toml = renderAskAgentToml(prepared, step, "/tmp/fake-warble-request");
  assert.match(toml, /wr-en\.context\.show -> mcp__wr_en__context_show/);
  assert.match(toml, /mcp__warble_request_transport__get_original_request/);
});

test("dashboard agents receive the exact IR-declared render block contract", () => {
  const prepared = preparedDashboard();
  for (const step of prepared.steps) {
    const toml = renderAskAgentToml(prepared, step, "/tmp/fake-warble-request");
    assert.match(toml, /exact allowed dashboard block contract/);
    assert.match(toml, /kpi_card/);
    assert.match(toml, /source_tables/);
    assert.match(toml, /represent each row as a JSON object/);
    assert.match(toml, /omit it when unavailable and never emit null/);
    assert.match(toml, /never emit a fields key/);
    assert.match(toml, /requires at least one successful call/);
  }
});
