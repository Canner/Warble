import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { CliUsageError, parseCliArgs } from "../src/cli.js";

async function fixture(): Promise<{ root: string; ir: string; projects: string }> {
  const root = await mkdtemp(join(tmpdir(), "warble-bird-cli-"));
  const ir = join(root, "ir.json");
  const projects = join(root, "projects");
  await writeFile(ir, '{"warble_ir_version":"0.6","components":[]}', "utf8");
  await mkdir(projects);
  return { root, ir, projects };
}

test("parser requires IR/project paths and applies official service defaults", async () => {
  const paths = await fixture();
  try {
    const parsed = parseCliArgs([
      "--ir",
      paths.ir,
      "--wren-project-root",
      paths.projects,
    ]);
    assert.equal(parsed.kind, "run");
    if (parsed.kind !== "run") return;
    assert.equal(parsed.config.irPath, resolve(paths.ir));
    assert.equal(parsed.config.wrenProjectRoot, resolve(paths.projects));
    assert.equal(parsed.config.host, "127.0.0.1");
    assert.equal(parsed.config.port, 6000);
    assert.equal(parsed.config.dbEnvironmentUrl, "http://127.0.0.1:6002");
    assert.equal(parsed.config.userSimulatorUrl, "http://127.0.0.1:6001");
    assert.equal(parsed.config.outDir, resolve("runs/bird-interact"));
    assert.equal(parsed.config.model, "claude-sonnet-4-5-20250929");
    assert.equal(parsed.config.requestTimeoutMs, undefined);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("parser accepts explicit endpoints and validates numeric bounds", async () => {
  const paths = await fixture();
  try {
    const parsed = parseCliArgs([
      "--ir", paths.ir,
      "--wren-project-root", paths.projects,
      "--host", "0.0.0.0",
      "--port", "7777",
      "--db-environment-url", "http://db:7001",
      "--user-simulator-url", "http://user:7002",
      "--out", join(paths.root, "out"),
      "--model", "claude-test",
      "--request-timeout-ms", "5000",
      "--wren-bin", "/opt/wren",
    ]);
    assert.equal(parsed.kind, "run");
    if (parsed.kind !== "run") return;
    assert.equal(parsed.config.port, 7777);
    assert.equal(parsed.config.requestTimeoutMs, 5000);
    assert.equal(parsed.config.wrenBin, "/opt/wren");
    assert.equal(parsed.config.dbEnvironmentUrl, "http://db:7001");

    const invalidNumbers: Array<[string, string]> = [
      ["--port", "0"],
      ["--port", "1.5"],
      ["--request-timeout-ms", "0"],
    ];
    for (const [flag, value] of invalidNumbers) {
      assert.throws(
        () => parseCliArgs(["--ir", paths.ir, "--wren-project-root", paths.projects, flag, value]),
        CliUsageError,
      );
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("missing paths fail during pure configuration parsing", () => {
  assert.throws(() => parseCliArgs([]), /--ir/);
  assert.throws(
    () => parseCliArgs(["--ir", "/missing/ir.json", "--wren-project-root", "/missing/projects"]),
    /does not exist/,
  );
});

test("help and version do not require paths or start a service", () => {
  assert.deepEqual(parseCliArgs(["--help"]), { kind: "help" });
  assert.deepEqual(parseCliArgs(["--version"]), { kind: "version" });
});
