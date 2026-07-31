import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { CodexDispatchError, runSetup } from "../src/index.js";
import { FAKE_CODEX, prepared } from "./helpers.js";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "warble-codex-local-"));
  scratch.push(path);
  return path;
}

test("runs through a fake Codex executable, streams events, and sanitizes billing env", async () => {
  const dir = temp();
  const record = join(dir, "record.json");
  const streamed: unknown[] = [];
  const result = await runSetup(prepared(), {
    cwd: dir,
    request: "connect a disposable source",
    codexBin: process.execPath,
    codexArgsPrefix: [FAKE_CODEX],
    env: {
      PATH: process.env.PATH,
      CODEX_HOME: "/safe/auth-location",
      OPENAI_API_KEY: "must-not-leak",
      CODEX_API_KEY: "must-not-leak",
      AZURE_OPENAI_API_KEY: "must-not-leak",
      FAKE_CODEX_RECORD: record,
    },
    onEvent: (event) => streamed.push(event),
  });
  assert.equal(result.finalText, '{"connection_summary":{"ok":true}}');
  assert.deepEqual(streamed, result.events);
  const recorded = JSON.parse(readFileSync(record, "utf8")) as {
    argv: string[];
    prompt: string;
    env: Record<string, string | null>;
  };
  assert.equal(recorded.env.OPENAI_API_KEY, null);
  assert.equal(recorded.env.CODEX_API_KEY, null);
  assert.equal(recorded.env.AZURE_OPENAI_API_KEY, null);
  assert.equal(recorded.env.CODEX_HOME, "/safe/auth-location");
  assert.ok(recorded.argv.includes("--ignore-user-config"));
  assert.ok(recorded.argv.includes('mcp_servers.setup.enabled_tools=["probe_setup"]'));
  assert.match(recorded.prompt, /connect_source\.connect/);
});

test("non-zero, malformed output, and forbidden runtime items loud-fail", async () => {
  for (const [scenario, pattern] of [
    ["nonzero", /exited with 7/],
    ["malformed", /non-JSONL/],
    ["forbidden", /isolation violation/],
  ] as const) {
    await assert.rejects(
      runSetup(prepared(), {
        cwd: temp(),
        request: "test",
        codexBin: process.execPath,
        codexArgsPrefix: [FAKE_CODEX],
        env: { PATH: process.env.PATH, FAKE_CODEX_SCENARIO: scenario },
      }),
      pattern,
    );
  }
});

test("timeout and AbortSignal cancellation loud-fail", async () => {
  await assert.rejects(
    runSetup(prepared(), {
      cwd: temp(),
      request: "timeout",
      codexBin: process.execPath,
      codexArgsPrefix: [FAKE_CODEX],
      env: { PATH: process.env.PATH, FAKE_CODEX_SCENARIO: "hang" },
      timeoutMs: 30,
    }),
    /timed out/,
  );

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(
    runSetup(prepared(), {
      cwd: temp(),
      request: "cancel",
      codexBin: process.execPath,
      codexArgsPrefix: [FAKE_CODEX],
      env: { PATH: process.env.PATH, FAKE_CODEX_SCENARIO: "hang" },
      signal: controller.signal,
      timeoutMs: 5_000,
    }),
    /cancelled/,
  );
});
