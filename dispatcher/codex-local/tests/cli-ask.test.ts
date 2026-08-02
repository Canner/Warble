import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ASK_IR_PATH, FAKE_MCP } from "./helpers.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const common = [
  ASK_IR_PATH,
  "--component",
  "answer_query",
  "--orchestrator-model",
  "gpt-5.6",
  "--cheap-model",
  "gpt-5.6-terra",
  "--strong-model",
  "gpt-5.6-sol",
  "--server-command",
  process.execPath,
  "--server-arg",
  FAKE_MCP,
  "--inspect-tool",
  "get_context",
  "--query-tool",
  "run_sql",
];

function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
  });
}

test("manifest-ask and describe-ask expose the canonical exact Ask surface", () => {
  const manifest = run(["manifest-ask", ...common]);
  assert.equal(manifest.status, 0, manifest.stderr);
  const parsedManifest = JSON.parse(manifest.stdout) as {
    target: string;
    agents: Array<{ tools: Array<{ name: string }> }>;
  };
  assert.equal(parsedManifest.target, "codex:local");
  assert.deepEqual(
    parsedManifest.agents[0]!.tools.map((tool) => tool.name),
    ["get_context", "run_sql"],
  );

  const described = run(["describe-ask", ...common]);
  assert.equal(described.status, 0, described.stderr);
  const parsedDescription = JSON.parse(described.stdout) as { phase: string; tools: string[] };
  assert.equal(parsedDescription.phase, "setup-and-ask-parity");
  assert.deepEqual(parsedDescription.tools, ["get_context", "run_sql"]);
});

test("Ask CLI fails before runtime on incomplete tool bindings or dispatch isolation args", () => {
  const missingQueryTool = run([
    "manifest-ask",
    ...common.filter((value, index) => value !== "--query-tool" && common[index - 1] !== "--query-tool"),
  ]);
  assert.equal(missingQueryTool.status, 1);
  assert.match(missingQueryTool.stderr, /requires exact MCP tools/);

  const missingHome = run(["dispatch-ask", ...common, "count orders"]);
  assert.equal(missingHome.status, 1);
  assert.match(missingHome.stderr, /requires --codex-home/);
});
