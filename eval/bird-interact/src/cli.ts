#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants, existsSync, statSync } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { WarbleBirdAgent } from "./agent.js";
import { TaskArtifactWriter } from "./artifacts.js";
import { isDirectExecution } from "./bin-entry.js";
import { FetchBirdClient } from "./bird-client.js";
import { CliUsageError } from "./cli-usage.js";
import { BIRD_SERVICE_PORTS } from "./protocol.js";
import { createBirdSystemAgentServer, type BirdAgentRunner } from "./server.js";
import { BirdToolRuntime, createBirdMcpServer } from "./tools.js";
import { ProcessWrenPlanner } from "./wren-planner.js";

const PACKAGE_VERSION = "0.1.0";

export { CliUsageError };

export interface BirdCliConfig {
  irPath: string;
  wrenProjectRoot: string;
  host: string;
  port: number;
  dbEnvironmentUrl: string;
  userSimulatorUrl: string;
  outDir: string;
  model: string;
  requestTimeoutMs?: number;
  wrenBin: string;
}

export type BirdCliParseResult =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; config: BirdCliConfig };


function requireString(
  values: Record<string, string | boolean | undefined>,
  name: string,
): string {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new CliUsageError(`--${name} is required`);
  }
  return value;
}

function parseInteger(value: string, flag: string, maximum?: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || (maximum !== undefined && parsed > maximum)) {
    throw new CliUsageError(`${flag} must be a positive integer${maximum ? ` <= ${maximum}` : ""}`);
  }
  return parsed;
}

function existingPath(path: string, kind: "file" | "directory", flag: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new CliUsageError(`${flag} path does not exist: ${absolute}`);
  const stats = statSync(absolute);
  if ((kind === "file" && !stats.isFile()) || (kind === "directory" && !stats.isDirectory())) {
    throw new CliUsageError(`${flag} must name a ${kind}: ${absolute}`);
  }
  return absolute;
}

function httpUrl(value: string, flag: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    return value.replace(/\/$/, "");
  } catch {
    throw new CliUsageError(`${flag} must be an HTTP(S) URL`);
  }
}

export function parseCliArgs(argv: readonly string[]): BirdCliParseResult {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
        ir: { type: "string" },
        "wren-project-root": { type: "string" },
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "string", default: String(BIRD_SERVICE_PORTS.system_agent) },
        "db-environment-url": {
          type: "string",
          default: `http://127.0.0.1:${BIRD_SERVICE_PORTS.db_environment}`,
        },
        "user-simulator-url": {
          type: "string",
          default: `http://127.0.0.1:${BIRD_SERVICE_PORTS.user_simulator}`,
        },
        out: { type: "string", default: "runs/bird-interact" },
        model: { type: "string", default: "claude-sonnet-4-5-20250929" },
        "request-timeout-ms": { type: "string" },
        "wren-bin": { type: "string", default: "wren" },
      },
    }));
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }

  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };
  const irPath = existingPath(requireString(values, "ir"), "file", "--ir");
  const wrenProjectRoot = existingPath(
    requireString(values, "wren-project-root"),
    "directory",
    "--wren-project-root",
  );
  return {
    kind: "run",
    config: {
      irPath,
      wrenProjectRoot,
      host: requireString(values, "host"),
      port: parseInteger(requireString(values, "port"), "--port", 65_535),
      dbEnvironmentUrl: httpUrl(
        requireString(values, "db-environment-url"),
        "--db-environment-url",
      ),
      userSimulatorUrl: httpUrl(
        requireString(values, "user-simulator-url"),
        "--user-simulator-url",
      ),
      outDir: resolve(requireString(values, "out")),
      model: requireString(values, "model"),
      ...(values["request-timeout-ms"] === undefined
        ? {}
        : {
            requestTimeoutMs: parseInteger(
              requireString(values, "request-timeout-ms"),
              "--request-timeout-ms",
            ),
          }),
      wrenBin: requireString(values, "wren-bin"),
    },
  };
}

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function optionalFileHash(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * The sibling back-end's version, read through its own `exports` map rather than off a relative
 * path. `"./package.json"` is a published entry point of `@warble/claude-agent-sdk`, so this is a
 * supported resolution: it survives the sibling relocating or renaming its build output, and it
 * does not silently depend on `src/` and `dist/` sitting at the same depth the way walking
 * `import.meta.dirname` up three levels did.
 */
async function warbleAgentSdkVersion(): Promise<string> {
  const manifest = import.meta.resolve("@warble/claude-agent-sdk/package.json");
  const parsed = JSON.parse(await readFile(new URL(manifest), "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string") throw new Error("Warble Agent SDK package has no version");
  return parsed.version;
}

type ArtifactStage = "event append" | "final trace";

/**
 * Loud, but never fatal. A run whose artifacts failed still produced the answer it produced and
 * must keep it — yet it is not the fully recorded run this package promises either, so the failure
 * is named on stderr and the task's trace directory is left visibly incomplete rather than quietly
 * passed off as finished.
 */
function reportArtifactFailure(
  taskId: string,
  stage: ArtifactStage,
  error: unknown,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `BIRD artifact ${stage} failed for task '${taskId}'; the run stands but its trace is incomplete: ${reason}\n`,
  );
}

/**
 * Artifact recording is a record of a run, never part of one. It has to happen on both paths and
 * `finally` is the only place that runs on both — but a throw from `finally` supersedes the value
 * the `try` already produced. An unwritable artifact directory therefore discarded a finished,
 * possibly solved answer and answered `500` instead, which the pinned orchestrator's
 * `raise_for_status` records as `total_reward 0`; the same throw also replaced a genuine agent
 * failure with a filesystem one, hiding why the run really ended. Reporting and dropping the
 * failure here leaves both outcomes to reach the caller unchanged.
 */
export function withArtifactRecording(input: {
  taskId: string;
  agent: BirdAgentRunner;
  record: () => Promise<void>;
}): BirdAgentRunner {
  return {
    run: async (message) => {
      try {
        return await input.agent.run(message);
      } finally {
        try {
          await input.record();
        } catch (error) {
          reportArtifactFailure(input.taskId, "final trace", error);
        }
      }
    },
  };
}

/**
 * `--ir` and `--wren-project-root` are checked while the arguments are parsed; `--out` cannot be,
 * because that directory is this service's to create. Left to the writer's first lazy `mkdir`, an
 * unusable artifact root surfaces one live task at a time — a `500` beside a healthy `/health`,
 * scored `total_reward 0` — instead of at the one moment when nothing has been scored yet. So the
 * root is created and probed before the port is bound, and an unusable one is a usage error that
 * names the path.
 */
async function ensureArtifactRoot(outDir: string): Promise<void> {
  const absolute = resolve(outDir);
  try {
    await mkdir(absolute, { recursive: true });
    await access(absolute, constants.W_OK | constants.X_OK);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(`--out must name a writable directory: ${absolute} (${reason})`);
  }
}

export async function startBirdService(config: BirdCliConfig): Promise<Server> {
  await ensureArtifactRoot(config.outDir);
  const irText = await readFile(config.irPath, "utf8");
  const irValue = JSON.parse(irText) as { warble_ir_version?: unknown };
  if (typeof irValue.warble_ir_version !== "string") {
    throw new CliUsageError("IR is missing warble_ir_version");
  }
  const irHash = sha256(irText);
  const sdkVersion = await warbleAgentSdkVersion();
  const planner = new ProcessWrenPlanner({
    projectRoot: config.wrenProjectRoot,
    wrenBin: config.wrenBin,
  });
  const client = new FetchBirdClient({
    dbEnvironmentUrl: config.dbEnvironmentUrl,
    userSimulatorUrl: config.userSimulatorUrl,
    ...(config.requestTimeoutMs === undefined
      ? {}
      : { timeoutMs: config.requestTimeoutMs }),
  });

  const server = createBirdSystemAgentServer({
    model: config.model,
    agentFactory: (state) => {
      const runtime = new BirdToolRuntime(state, client, planner);
      const writer = new TaskArtifactWriter(config.outDir, state.task_id);
      const project = planner.projectPath(state.db_name);
      const startedAt = new Date().toISOString();
      const agent = new WarbleBirdAgent({
        state,
        ir: irText,
        irPath: config.irPath,
        planner,
        mcpServer: createBirdMcpServer(runtime),
        model: config.model,
        onEvent: async (event) => {
          try {
            await writer.appendAgentEvent(event);
          } catch (error) {
            reportArtifactFailure(state.task_id, "event append", error);
          }
        },
      });
      return withArtifactRecording({
        taskId: state.task_id,
        agent,
        record: async () => {
          await writer.finalize(state, {
            taskId: state.task_id,
            model: config.model,
            dbEnvironmentUrl: config.dbEnvironmentUrl,
            userSimulatorUrl: config.userSimulatorUrl,
            warbleAgentSdkVersion: sdkVersion,
            irVersion: irValue.warble_ir_version as string,
            irHash,
            wrenProjectPath: project,
            mdlHash: await optionalFileHash(resolve(project, "target", "mdl.json")),
            startedAt,
            finishedAt: new Date().toISOString(),
          });
        },
      });
    },
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  return server;
}

const HELP = `Usage: warble-bird-interact --ir <ir.json> --wren-project-root <directory> [options]

Options:
  --host <host>                    Listen host (default: 127.0.0.1)
  --port <port>                    System-agent port (default: 6000)
  --db-environment-url <url>      Official DB environment (default: http://127.0.0.1:6002)
  --user-simulator-url <url>      Official user simulator (default: http://127.0.0.1:6001)
  --out <directory>               Artifact root (default: runs/bird-interact)
  --model <model>                 Strong-tier Claude model
  --request-timeout-ms <ms>       Override all official per-operation timeouts
  --wren-bin <path>               Wren executable (default: wren)
  -h, --help                      Show help
  -V, --version                   Show version`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliArgs(argv);
  if (parsed.kind === "help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (parsed.kind === "version") {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }
  await startBirdService(parsed.config);
  process.stdout.write(
    `warble-bird-interact listening on http://${parsed.config.host}:${parsed.config.port}\n`,
  );
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
