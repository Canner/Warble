import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Locks in `warble-agent-sdk --version`/`-V`/`--help`: spawns the real CLI entry point (through the
// same `tsx` loader the `npm test` / `npm run dispatch` scripts use) rather than calling an internal
// function, because what's under test is the process-level contract (argv handling, exit code,
// stdout) — not just that some helper computes the right string.
const CLI_TS = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));
const ENRICH_IR = fileURLToPath(new URL("../../../examples/propose-apply-agent/ir.golden.json", import.meta.url));
const DEMO_IR = fileURLToPath(new URL("../../../examples/demo-agent/ir.golden.json", import.meta.url));
const COMPOSED_IR = fileURLToPath(new URL("../../conformance-fixtures/component-composition-unsupported.json", import.meta.url));

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
  assert.deepEqual(parsed.agents[2]!.availability, {
    status: "unavailable",
    reason: "component is unavailable on the configured runtime",
  });
  assert.deepEqual(parsed.agents[2]!.capabilities, []);
  assert.ok(Array.isArray(parsed.agents[2]!.capability_inspection));
  assert.deepEqual(parsed.agents[2]!.dependencies, []);
});

test("include-unavailable is rejected outside the manifest display contract", () => {
  const { status, stderr } = runCli(["emit", "fixture.json", "--include-unavailable"]);
  assert.equal(status, 1);
  assert.match(stderr, /--include-unavailable is only supported by manifest/);
});

test("dispatch asset preflight refuses before creating the requested output directory", () => {
  const temp = mkdtempSync(join(tmpdir(), "warble-cli-asset-preflight-"));
  const irPath = join(temp, "ir.json");
  const outDir = join(temp, "must-not-exist");
  try {
    const ir = JSON.parse(readFileSync(DEMO_IR, "utf8")) as {
      components: Array<{ assets?: Array<{ path: string; hash: string; bytes: number }> }>;
    };
    ir.components[0]!.assets = [{
      path: "missing.css",
      hash: `sha256:${"0".repeat(64)}`,
      bytes: 0,
    }];
    writeFileSync(irPath, JSON.stringify(ir));

    const result = runCli(["dispatch", irPath, "--dry-run", "--out", outDir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /declared in the IR but missing/);
    assert.equal(existsSync(outDir), false, "asset refusal must precede output creation");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("dispatch dry-run retains the composed entry registry instead of emitting a partial plan", () => {
  const temp = mkdtempSync(join(tmpdir(), "warble-cli-composed-plan-"));
  const irPath = join(temp, "ir.json");
  const outDir = join(temp, "out");
  try {
    const fixture = JSON.parse(readFileSync(COMPOSED_IR, "utf8")) as { ir: unknown };
    writeFileSync(irPath, JSON.stringify(fixture.ir));

    const result = runCli(["dispatch", irPath, "--dry-run", "--out", outDir]);
    assert.equal(result.status, 0);
    const plan = JSON.parse(readFileSync(join(outDir, "caller.plan.json"), "utf8")) as {
      composition: { entry: { root: string; components: string[] }; prepared_callees: string[] };
    };
    assert.deepEqual(plan.composition.entry, { root: "caller", components: ["caller", "callee"] });
    assert.deepEqual(plan.composition.prepared_callees, ["callee"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
