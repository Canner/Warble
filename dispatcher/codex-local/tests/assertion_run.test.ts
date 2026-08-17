import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseAssertionInvocation, runAssertion } from "../src/index.js";
import { FAKE_CODEX, preparedAssertion } from "./helpers.js";

function invocation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activation: {
      authority: "external",
      kind: "scheduled",
      occurrence_id: "occurrence-1",
      occurred_at: "2026-08-17T12:00:00.000Z",
    },
    evidence: {
      source: "wren",
      operation: "read_only_sql",
      success: true,
      read_only: true,
      model: "orders",
      timestamp_column: "updated_at",
      observed_at: "2026-08-17T12:00:00.000Z",
      latest_timestamp: "2026-08-15T12:00:00.000Z",
    },
    ...overrides,
  };
}

test("validated fresh evidence returns one host verdict and never launches Codex", async () => {
  const record = join(mkdtempSync(join(tmpdir(), "warble-assertion-fresh-")), "codex.json");
  const result = await runAssertion(
    preparedAssertion(),
    invocation({
      evidence: { ...invocation()["evidence"] as Record<string, unknown>, latest_timestamp: "2026-08-17T11:00:00.000Z" },
    }),
    {
      cwd: process.cwd(),
      codexBin: process.execPath,
      codexArgsPrefix: [FAKE_CODEX],
      env: { ...process.env, FAKE_CODEX_RECORD: record, FAKE_CODEX_SCENARIO: "assertion-success" },
    },
  );
  assert.equal(result.codexLaunched, false);
  assert.equal(result.verdict.fresh, true);
  assert.deepEqual(result.emitted, []);
  assert.deepEqual(result.events.map((event) => event.t), ["assertion_start", "freshness_reading", "assertion_result"]);
  assert.equal(existsSync(record), false);
});

test("stale evidence launches one isolated cheap severity turn and host assembles the signal", async () => {
  const record = join(mkdtempSync(join(tmpdir(), "warble-assertion-stale-")), "codex.json");
  const events: string[] = [];
  const result = await runAssertion(preparedAssertion(), invocation(), {
    cwd: process.cwd(),
    codexBin: process.execPath,
    codexArgsPrefix: [FAKE_CODEX],
    env: {
      ...process.env,
      OPENAI_API_KEY: "must-not-reach-child",
      FAKE_CODEX_RECORD: record,
      FAKE_CODEX_SCENARIO: "assertion-success",
    },
    onEvent: (event) => events.push(event.t),
  });
  assert.equal(result.codexLaunched, true);
  assert.deepEqual(result.emitted, ["freshness_breach"]);
  assert.deepEqual(result.verdict.status, {
    state: "stale",
    severity: "critical",
    rationale: "lag exceeds the expected cadence",
  });
  assert.deepEqual(events, [
    "assertion_start",
    "freshness_reading",
    "severity_start",
    "severity_finish",
    "assertion_result",
  ]);
  const child = JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; env: Record<string, string | null>; prompt: string };
  assert.ok(child.argv.includes("--ephemeral"));
  assert.ok(child.argv.includes("--ignore-user-config"));
  assert.ok(child.argv.includes("read-only"));
  assert.equal(child.argv.some((arg) => arg.includes("mcp_servers")), false);
  assert.equal(child.env.OPENAI_API_KEY, null);
  assert.match(child.prompt, /trusted caller-supplied read-only Wren evidence/);
});

test("invalid evidence and model terminals wall-hit before or during the bounded turn", async () => {
  const prepared = preparedAssertion();
  assert.throws(
    () => parseAssertionInvocation(prepared, invocation({ evidence: { ...invocation()["evidence"] as Record<string, unknown>, read_only: false } })),
    /successful read-only Wren/,
  );
  assert.throws(
    () => parseAssertionInvocation(prepared, invocation({ activation: { ...invocation()["activation"] as Record<string, unknown>, authority: "warble" } })),
    /external caller/,
  );
  assert.throws(
    () => parseAssertionInvocation(prepared, invocation({ bindings: { model: "widgets", expected_cadence: "1ms" } })),
    /must not override pinned profile bindings/,
  );
  assert.throws(
    () => parseAssertionInvocation(prepared, invocation({ evidence: { ...invocation()["evidence"] as Record<string, unknown>, model: "widgets" } })),
    /must match pinned bind/,
  );
  await assert.rejects(
    () => runAssertion(prepared, invocation(), {
      cwd: process.cwd(),
      codexBin: process.execPath,
      codexArgsPrefix: [FAKE_CODEX],
      env: { ...process.env, FAKE_CODEX_SCENARIO: "assertion-invalid" },
    }),
    /warn\|critical/,
  );
  await assert.rejects(
    () => runAssertion(prepared, invocation(), {
      cwd: process.cwd(),
      codexBin: process.execPath,
      codexArgsPrefix: [FAKE_CODEX],
      env: { ...process.env, FAKE_CODEX_SCENARIO: "assertion-mcp" },
    }),
    /non-allowlisted MCP tool/,
  );
});

test("stale severity turn observes timeout cancellation and tears down its ephemeral process", async () => {
  await assert.rejects(
    () => runAssertion(preparedAssertion(), invocation(), {
      cwd: process.cwd(),
      codexBin: process.execPath,
      codexArgsPrefix: [FAKE_CODEX],
      timeoutMs: 20,
      terminationGraceMs: 20,
      env: { ...process.env, FAKE_CODEX_SCENARIO: "hang" },
    }),
    /timed out after 20ms/,
  );
});
