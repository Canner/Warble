import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ASSERTION_IR_PATH, FAKE_CODEX } from "./helpers.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function executableFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "warble-codex-cli-assertion-"));
  scratch.push(directory);
  const fixture = join(directory, "codex");
  copyFileSync(FAKE_CODEX, fixture);
  chmodSync(fixture, 0o755);
  return fixture;
}

function invoke(stale: boolean): string {
  return JSON.stringify({
    activation: { authority: "external", kind: "scheduled", occurrence_id: "run-1", occurred_at: "2026-08-17T12:00:00Z" },
    evidence: {
      source: "wren",
      operation: "read_only_sql",
      success: true,
      read_only: true,
      model: "orders",
      timestamp_column: "updated_at",
      observed_at: "2026-08-17T12:00:00Z",
      latest_timestamp: stale ? "2026-08-15T12:00:00Z" : "2026-08-17T11:00:00Z",
    },
  });
}

function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(
    process.execPath,
    ["--import", env.WARBLE_TEST_TSX_IMPORT ?? "tsx", CLI, ...args],
    { encoding: "utf8", env },
  );
}

test("assertion manifest describes borrowed scheduler, Wren evidence, and caller routing without MCP config", () => {
  const result = run(["manifest", ASSERTION_IR_PATH, "--component", "monitor_freshness", "--cheap-model", "cheap"]);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(result.stdout) as {
    session: { persistence: string };
    agents: Array<{
      tools: unknown[];
      borrowed_capabilities: Record<string, string>;
      capabilities: Array<{ capability: string; via: string | null }>;
    }>;
  };
  assert.equal(manifest.session.persistence, "none");
  assert.deepEqual(manifest.agents[0]!.tools, []);
  assert.equal(manifest.agents[0]!.borrowed_capabilities["scheduler"], "external-invocation");
  assert.equal(
    manifest.agents[0]!.capabilities.find((capability) => capability.capability === "sql_execution:read_only")?.via,
    "trusted-caller-supplied-successful-wren-evidence",
  );
});

test("assertion CLI accepts one invocation, streams one terminal host result, and never requires --server-command", () => {
  const result = run(
    [
      "dispatch",
      ASSERTION_IR_PATH,
      "--component",
      "monitor_freshness",
      "--cheap-model",
      "cheap",
      "--invocation",
      invoke(true),
      "--codex-bin",
      executableFixture(),
      "--stream-json",
    ],
    { ...process.env, FAKE_CODEX_SCENARIO: "assertion-success" },
  );
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as { t: string });
  assert.deepEqual(events.map((event) => event.t), [
    "assertion_start",
    "freshness_reading",
    "severity_start",
    "severity_finish",
    "assertion_result",
  ]);
  assert.equal(events.filter((event) => event.t === "assertion_result").length, 1);
});

test("assertion CLI rejects malformed invocation before any Codex process can begin", () => {
  const result = run([
    "dispatch",
    ASSERTION_IR_PATH,
    "--component",
    "monitor_freshness",
    "--cheap-model",
    "cheap",
    "--invocation",
    "{not-json",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invocation must be valid JSON/);
});
