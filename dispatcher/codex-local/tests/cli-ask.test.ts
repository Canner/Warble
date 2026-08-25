import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { ASK_IR_PATH, FAKE_APP_SERVER, FAKE_MCP } from "./helpers.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `warble-codex-cli-ask-${label}-`));
  scratch.push(path);
  return path;
}
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
const dashboardCommon = common.map((value) => value === "answer_query" ? "generate_dashboard" : value);

function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
  });
}

test("generic manifest and describe select the canonical Ask contract from the component IR", () => {
  const manifest = run(["manifest", ...common]);
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

  const described = run(["describe", ...common]);
  assert.equal(described.status, 0, described.stderr);
  const parsedDescription = JSON.parse(described.stdout) as { phase: string; tools: string[] };
  assert.equal(parsedDescription.phase, "setup-and-ask-parity");
  assert.deepEqual(parsedDescription.tools, ["get_context", "run_sql"]);
});

test("Ask CLI fails before runtime on incomplete tool bindings or dispatch isolation args", () => {
  const missingQueryTool = run([
    "manifest",
    ...common.filter((value, index) => value !== "--query-tool" && common[index - 1] !== "--query-tool"),
  ]);
  assert.equal(missingQueryTool.status, 1);
  assert.match(missingQueryTool.stderr, /requires exact MCP tools/);

  const missingHome = run(["dispatch", ...common, "count orders"]);
  assert.equal(missingHome.status, 1);
  assert.match(missingHome.stderr, /requires --codex-home/);
});

test("generic dispatch streams ordered Ask lifecycle events and the terminal answer", () => {
  const codexHome = temp("home");
  const project = temp("project");
  const fakeCodex = join(temp("bin"), "codex");
  copyFileSync(FAKE_APP_SERVER, fakeCodex);
  chmodSync(fakeCodex, 0o755);
  const dispatched = run([
    "dispatch",
    ...common,
    "ask-success",
    "--project",
    project,
    "--codex-home",
    codexHome,
    "--codex-bin",
    fakeCodex,
    "--stream-json",
  ]);
  assert.equal(dispatched.status, 0, dispatched.stderr);
  const events = dispatched.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { t: string; text?: string });
  assert.deepEqual(
    events.filter((event) => event.t === "agent_started" || event.t === "step_finished").map((event) => event.t),
    ["agent_started", "step_finished", "agent_started", "step_finished"],
  );
  assert.equal(events.at(-2)?.t, "turn_completed");
  assert.deepEqual(events.at(-1), {
    t: "answer",
    text: JSON.stringify({
      columns: ["orders"],
      rows: [[42]],
      summary: "There are 42 orders.",
      verified: true,
      definition: {
        sql: "SELECT COUNT(*) AS orders FROM orders",
        source_tables: ["orders"],
        filters: [],
      },
    }),
  });
});

test("dashboard CLI exposes parity and streams a render artifact before the terminal answer", () => {
  const described = run(["describe", ...dashboardCommon]);
  assert.equal(described.status, 0, described.stderr);
  const description = JSON.parse(described.stdout) as {
    phase: string;
    supported_components: string[];
  };
  assert.equal(description.phase, "setup-ask-and-dashboard-parity");
  assert.deepEqual(description.supported_components, ["generate_dashboard"]);

  const codexHome = temp("dashboard-home");
  const project = temp("dashboard-project");
  const fakeCodex = join(temp("dashboard-bin"), "codex");
  copyFileSync(FAKE_APP_SERVER, fakeCodex);
  chmodSync(fakeCodex, 0o755);
  const dispatched = run([
    "dispatch",
    ...dashboardCommon,
    "dashboard-success",
    "--project",
    project,
    "--codex-home",
    codexHome,
    "--codex-bin",
    fakeCodex,
    "--stream-json",
  ]);
  assert.equal(dispatched.status, 0, dispatched.stderr);
  const events = dispatched.stdout.trim().split("\n").map((line) => JSON.parse(line) as { t: string; text?: string });
  assert.equal(events.filter((event) => event.t === "render_artifact").length, 1);
  assert.equal(events.at(-2)?.t, "turn_completed");
  assert.equal(events.at(-1)?.t, "answer");
  const answer = JSON.parse(events.at(-1)!.text!) as { verified: boolean; blocks: unknown[] };
  assert.equal(answer.verified, true);
  assert.equal(answer.blocks.length, 4);
});
