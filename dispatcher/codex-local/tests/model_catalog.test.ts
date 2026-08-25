import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { discoverCodexModels } from "../src/model_catalog.js";
import { FAKE_APP_SERVER } from "./helpers.js";

const scratch: string[] = [];
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `warble-codex-catalog-${label}-`));
  scratch.push(path);
  return path;
}

function fakeRuntime(): { codexHome: string; project: string; codexBin: string; statePath: string } {
  const codexHome = temp("home");
  const project = temp("project");
  const codexBin = join(temp("bin"), "codex");
  copyFileSync(FAKE_APP_SERVER, codexBin);
  chmodSync(codexBin, 0o755);
  return { codexHome, project, codexBin, statePath: join(codexHome, "fake-app-state.json") };
}

test("Codex catalog paginates model/list before any thread and only exposes allowlisted picker fields", async () => {
  const runtime = fakeRuntime();
  const result = await discoverCodexModels(runtime);
  assert.deepEqual(result, {
    version: 1,
    status: "ready",
    provider: "codex",
    models: [
      {
        model: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        description: "Balanced everyday model",
        isDefault: true,
        reasoningEfforts: [
          { value: "low", displayName: "low", description: "Fastest" },
          { value: "high", displayName: "high", description: "More reasoning" },
        ],
      },
      { model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", reasoningEfforts: [] },
    ],
  });
  const state = JSON.parse(readFileSync(runtime.statePath, "utf8")) as {
    requests: Array<{ method: string; params: { cursor: string | null; includeHidden: boolean; limit: number } }>;
  };
  assert.deepEqual(state.requests.map((request) => request.method), ["model/list", "model/list"]);
  assert.deepEqual(state.requests.map((request) => request.params), [
    { cursor: null, limit: 100, includeHidden: false },
    { cursor: "page-2", limit: 100, includeHidden: false },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|hidden-model|@example/);
});

test("Codex catalog maps unauthenticated, timeout, and malformed protocol errors without raw payloads", async () => {
  for (const [scenario, expected] of [
    ["unauthenticated", { code: "not_authenticated", retryable: false }],
    ["timeout", { code: "timeout", retryable: true }],
    ["malformed", { code: "protocol_error", retryable: false }],
  ] as const) {
    const runtime = fakeRuntime();
    const result = await discoverCodexModels({
      ...runtime,
      // The `timeout` scenario's fake holds deliberately, so its budget can only fire and stays
      // small. Every other scenario expects an answer, making its budget infrastructure — generous,
      // since a slow child start there would fail a test about something else entirely.
      timeoutMs: scenario === "timeout" ? 1_000 : 5_000,
      env: { ...process.env, WARBLE_FAKE_APP_CATALOG_SCENARIO: scenario },
    });
    assert.deepEqual(result, { version: 1, status: "unavailable", provider: "codex", ...expected });
    assert.doesNotMatch(JSON.stringify(result), /raw-token-must-not-leak|must-not-leak/);
  }
});

test("Codex list-models CLI emits one catalog object and no thread is created", () => {
  const runtime = fakeRuntime();
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI, "list-models", "--project", runtime.project, "--codex-home", runtime.codexHome, "--codex-bin", runtime.codexBin],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout) as object).sort(), ["models", "provider", "status", "version"]);
  const state = JSON.parse(readFileSync(runtime.statePath, "utf8")) as { requests: Array<{ method: string }> };
  assert.ok(state.requests.every((request) => request.method === "model/list"));
});
