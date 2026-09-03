import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  CliUsageError,
  parseCliArgs,
  startBirdService,
  withArtifactRecording,
  type BirdCliConfig,
} from "../src/cli.js";

async function fixture(): Promise<{ root: string; ir: string; projects: string }> {
  const root = await mkdtemp(join(tmpdir(), "warble-bird-cli-"));
  const ir = join(root, "ir.json");
  const projects = join(root, "projects");
  await writeFile(ir, '{"warble_ir_version":"0.7","components":[]}', "utf8");
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

function serviceConfig(
  paths: { ir: string; projects: string },
  outDir: string,
): BirdCliConfig {
  return {
    irPath: paths.ir,
    wrenProjectRoot: paths.projects,
    host: "127.0.0.1",
    port: 0,
    dbEnvironmentUrl: "http://127.0.0.1:6002",
    userSimulatorUrl: "http://127.0.0.1:6001",
    outDir,
    model: "claude-test",
    wrenBin: "wren",
  };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
}

async function stderrOf(action: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    await action();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

/**
 * `--out` used to be the one path the CLI neither checked nor created: the writer made the
 * directory lazily, during the first task, where the failure is a live task's failure rather than
 * a startup one. An operator then read a healthy `/health` beside `500`s that named nothing. It is
 * checked and created here instead, before the port is bound, so the answer is a usage error
 * naming the path.
 */
test("an unusable --out is a startup refusal, not a live task failure", async () => {
  const paths = await fixture();
  let started: Server | undefined;
  let caught: unknown;
  try {
    const blocking = join(paths.root, "artifact-root");
    await writeFile(blocking, "", "utf8");
    try {
      started = await startBirdService(serviceConfig(paths, join(blocking, "traces")));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof CliUsageError, `expected a usage error, got ${String(caught)}`);
    assert.match(caught.message, /--out/);
    assert.match(caught.message, /traces/);
  } finally {
    if (started) await close(started);
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("startup creates the artifact root before the first task runs", async () => {
  const paths = await fixture();
  const outDir = join(paths.root, "runs", "traces");
  const server = await startBirdService(serviceConfig(paths, outDir));
  try {
    assert.ok((await stat(outDir)).isDirectory());
  } finally {
    await close(server);
    await rm(paths.root, { recursive: true, force: true });
  }
});

/**
 * The masking this closes: the artifact write ran in a `finally` around the agent run, and a throw
 * from `finally` supersedes the value the `try` already produced. An unwritable artifact directory
 * therefore discarded a finished — possibly solved — answer, the service answered `500`, and the
 * orchestrator's `raise_for_status` scored that task `total_reward 0`. The same throw replaced a
 * genuine agent failure with a filesystem one, hiding why the run really ended. Recording stays
 * loud on stderr; it just no longer decides the run's outcome.
 */
test("an artifact failure neither replaces an answer nor masks a real agent failure", async () => {
  const solved = withArtifactRecording({
    taskId: "alien_1",
    agent: { run: async () => ({ message: "SELECT 1", sessionId: "sdk-1" }) },
    record: async () => {
      throw new Error("EACCES: permission denied, open 'trace.json'");
    },
  });
  let answer: { message: string; sessionId: string | null } | undefined;
  const solvedReport = await stderrOf(async () => {
    answer = await solved.run("submit now");
  });
  assert.deepEqual(answer, { message: "SELECT 1", sessionId: "sdk-1" });
  assert.match(solvedReport, /alien_1/);
  assert.match(solvedReport, /EACCES/);

  const failed = withArtifactRecording({
    taskId: "alien_2",
    agent: {
      run: async () => {
        throw new Error("provider interrupted");
      },
    },
    record: async () => {
      throw new Error("EACCES: permission denied, open 'trace.json'");
    },
  });
  let caught: unknown;
  const failedReport = await stderrOf(async () => {
    caught = await failed.run("submit now").then(
      () => undefined,
      (error: unknown) => error,
    );
  });
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /provider interrupted/);
  assert.match(failedReport, /alien_2/);
});
