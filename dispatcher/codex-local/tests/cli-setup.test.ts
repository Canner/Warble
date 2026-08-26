import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { FAKE_CODEX, FAKE_MCP, SETUP_IR_PATH } from "./helpers.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});
const common = [
  SETUP_IR_PATH,
  "--server-command",
  process.execPath,
  "--server-arg",
  FAKE_MCP,
  "--source-tool",
  "probe_setup",
  "--context-tool",
  "probe_setup",
];

function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
  });
}

function executableFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "warble-codex-cli-setup-"));
  scratch.push(directory);
  const fixture = join(directory, "codex");
  copyFileSync(FAKE_CODEX, fixture);
  chmodSync(fixture, 0o755);
  return fixture;
}

test("generic setup manifest and describe retain their whole-profile aggregate", () => {
  for (const command of ["manifest", "describe"] as const) {
    const result = run([command, ...common]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as {
      supported_components?: string[];
      agents?: Array<{ id: string }>;
    };
    assert.deepEqual(parsed.supported_components ?? parsed.agents?.map((agent) => agent.id), [
      "attach_source",
      "compose_context",
    ]);
  }
});

test("generic setup dispatch selects its component through --component", () => {
  const result = run([
    "dispatch",
    ...common,
    "connect a disposable source",
    "--component",
    "attach_source",
    "--codex-bin",
    executableFixture(),
    "--server",
    "setup",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /attachment_summary/);
});

test("removed profile aliases are rejected and usage exposes only generic operations", () => {
  for (const alias of [
    "dispatch-ask",
    "manifest-ask",
    "describe-ask",
    "dispatch-enrich",
    "manifest-enrich",
    "describe-enrich",
  ]) {
    const result = run([alias, ...common]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /<dispatch\|manifest\|describe>/);
    assert.doesNotMatch(result.stderr, /dispatch-ask|manifest-ask|describe-ask|dispatch-enrich|manifest-enrich|describe-enrich/);
  }

  const usage = run([]);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /<dispatch\|manifest\|describe>/);
  assert.doesNotMatch(usage.stderr, /dispatch-ask|manifest-ask|describe-ask|dispatch-enrich|manifest-enrich|describe-enrich/);
});
