import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Locks in `warble-agent-sdk --version`/`-V`/`--help`: spawns the real CLI entry point (through the
// same `tsx` loader the `npm test` / `npm run dispatch` scripts use) rather than calling an internal
// function, because what's under test is the process-level contract (argv handling, exit code,
// stdout) — not just that some helper computes the right string.
const CLI_TS = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));
const ENRICH_IR = fileURLToPath(new URL("../../../examples/propose-apply-agent/ir.golden.json", import.meta.url));

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", CLI_TS, ...args], {
      encoding: "utf8",
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

/** The version the CLI *should* report: this package's own `package.json`, read directly — not a
 * literal — so this test would fail if the CLI's version source ever silently drifted from it. */
function expectedVersion(): string {
  return (JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version: string }).version;
}

test("--version exits 0 and prints the package version", () => {
  const { stdout, status } = runCli(["--version"]);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), expectedVersion());
});

test("-V exits 0 and prints the same package version", () => {
  const { stdout, status } = runCli(["-V"]);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), expectedVersion());
});

test("--help still exits 0", () => {
  const { status } = runCli(["--help"]);
  assert.equal(status, 0);
});

test("-h still exits 0", () => {
  const { status } = runCli(["-h"]);
  assert.equal(status, 0);
});

test("existing manifest rejects the catalog-only timeout option", () => {
  const { status, stderr } = runCli(["manifest", "--timeout", "10"]);
  assert.equal(status, 1);
  assert.match(stderr, /--timeout is only supported by list-models/);
});

test("list-models accepts timeout parsing before its value validation", () => {
  const { status, stderr } = runCli(["list-models", "--timeout", "not-a-number"]);
  assert.equal(status, 1);
  assert.match(stderr, /--timeout must be a positive number/);
});

test("manifest keeps the default wall but include-unavailable returns a redacted display-only component", () => {
  const defaultManifest = runCli(["manifest", ENRICH_IR]);
  assert.equal(defaultManifest.status, 1);
  assert.match(defaultManifest.stderr, /context_write_authz/);

  const displayManifest = runCli(["manifest", ENRICH_IR, "--include-unavailable"]);
  assert.equal(displayManifest.status, 0);
  const parsed = JSON.parse(displayManifest.stdout) as { agents: Array<Record<string, unknown>> };
  assert.deepEqual(parsed.agents.map((agent) => agent.id), ["survey_context", "propose_changes", "apply_changes"]);
  assert.deepEqual(parsed.agents[2], {
    id: "apply_changes",
    verb: "apply_changes",
    component_type: "constitutive",
    realization_kind: "gated-tool",
    trigger: "one_shot",
    outcome: "mutation",
    steps: [],
    guardrails: {},
    tools: [],
    output_schema: {},
    capabilities: [],
    availability: { status: "unavailable", reason: "component is unavailable on the configured runtime" },
  });
});

test("include-unavailable is rejected outside the manifest display contract", () => {
  const { status, stderr } = runCli(["emit", "fixture.json", "--include-unavailable"]);
  assert.equal(status, 1);
  assert.match(stderr, /--include-unavailable is only supported by manifest/);
});
