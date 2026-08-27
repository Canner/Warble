#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";

import { z } from "zod";

import { isDirectExecution } from "./bin-entry.js";
import { CliUsageError } from "./cli-usage.js";
import {
  mergePublicWithGroundTruth,
  parseGroundTruthJsonl,
  parsePublicJsonl,
  selectSmokeTasks,
  serializeJsonl,
} from "./eval-data.js";
import {
  INFORMATION_SCHEMA_INTROSPECTION_SQL,
  buildIdentityMdl,
  parseIntrospectionJson,
  representativeIdentityQuery,
} from "./identity-mdl.js";
import {
  BIRD_COMMIT,
  BIRD_REPOSITORY,
  HF_COMMIT,
  HF_REPOSITORY,
  ensureBirdCheckout,
  ensurePublicSnapshot,
  type BirdCheckoutVerification,
  type PublicSnapshotVerification,
} from "./source-cache.js";
import {
  ADK_DIRECTORY,
  COMBINED_FILENAME,
  GT_FILENAME,
  IDENTITY_PROJECTS,
  PUBLIC_CACHE_DIRECTORY,
  PUBLIC_MAIN_JSONL,
  RUNTIME_DIRECTORY,
  DEFAULT_SMOKE_DATABASE,
  SMOKE_TASK_COUNT,
  assertDatabaseName,
  prepareManifestSchema,
  readPrepareManifest,
  smokeFilename,
  smokeTaskIds,
  templateDatabase,
  type PrepareManifest,
} from "./runtime-layout.js";
import { ProcessWrenPlanner, type WrenPlanner } from "./wren-planner.js";

export {
  templateDatabase,
  COMBINED_FILENAME,
  GT_FILENAME,
  PUBLIC_CACHE_DIRECTORY,
  RUNTIME_DIRECTORY,
  DEFAULT_SMOKE_DATABASE,
  SMOKE_TASK_COUNT,
  smokeFilename,
  smokeTaskIds,
  prepareManifestSchema,
  readPrepareManifest,
  type PrepareManifest,
};

const PACKAGE_VERSION = "0.1.0";

export { CliUsageError };

export const DEFAULT_POSTGRES_CONTAINER = "warble_bird_interact_postgresql";
export const DEFAULT_POSTGRES_PORT = 55_432;
export const POSTGRES_IMAGE = "docker.io/shawnxxh/bird-interact-postgresql:latest";
export const POSTGRES_PORT_IN_CONTAINER = 5432;
export const POSTGRES_USER = "root";

/**
 * The role the AUTOPSY replays as, and the password it authenticates with.
 *
 * `POSTGRES_USER` is the image's superuser, and a superuser's read-only-ness is only ever a
 * setting: `default_transaction_read_only` is `USERSET`, so a recorded statement can turn it off
 * for itself and then write — measured, a replayed `SET default_transaction_read_only = off;
 * CREATE TABLE ...` leaves a committed table on the template database every later replay reads.
 * A role that simply does not hold CREATE cannot re-enable it, which is why the guarantee is moved
 * from a setting to a privilege here. `provisionReadOnlyRole` gives it exactly `pg_read_all_data`.
 *
 * The password is not a secret and is not treated as one. This container is a local, disposable
 * fixture published on 127.0.0.1 whose superuser password is the image's own, published `123123`;
 * a password on this role protects nothing that is not already open. It exists so the role can log
 * in under the image's `scram-sha-256` host rule, and the autopsy restates it for the same reason
 * it restates the superuser's — see the comment there.
 */
export const READ_ONLY_ROLE = "warble_autopsy_readonly";
export const READ_ONLY_PASSWORD = "warble-read-only";

export const WARBLE_EVAL_LABEL = "ai.getwren.warble.eval";
export const WARBLE_EVAL_LABEL_VALUE = "bird-interact";

const STAGING_PREFIX = "runtime.next-";
const BACKUP_PREFIX = "runtime.backup-";
const DOCKER_TIMEOUT_MS = 120_000;
// A container created from the official image restores 18 databases from
// /docker-entrypoint-initdb.d before it opens TCP, which takes many minutes on first boot.
const READY_TIMEOUT_MS = 1_800_000;
const READY_NOTICE_INTERVAL_MS = 30_000;
const READY_POLL_INTERVAL_MS = 2_000;
const WREN_VERSION_TIMEOUT_MS = 60_000;

const execFileAsync = promisify(execFile);

export class PrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrepareError";
  }
}

/**
 * Raised only when docker was killed for exceeding the timeout this process gave it, never when
 * docker itself failed. `execFile` reports that kill as `code: null, signal: SIGKILL, killed: true`,
 * which is indistinguishable from a spawn failure unless it is classified here, and the two need
 * opposite handling: a stalled command may be worth retrying, a broken docker never is.
 */
export class DockerTimeoutError extends PrepareError {
  constructor(timeoutMs: number) {
    super(`Docker command did not finish within ${timeoutMs}ms`);
    this.name = "DockerTimeoutError";
  }
}

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* CLI contract                                                               */
/* -------------------------------------------------------------------------- */

export interface PrepareConfig {
  readonly database: string;
  readonly gtPath?: string;
  readonly officialCheckout?: string;
  readonly publicDataPath?: string;
  readonly postgresContainer: string;
  readonly postgresPort: number;
  readonly wrenBin: string;
}

export type PrepareParseResult =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; config: PrepareConfig };

function existingPath(path: string, kind: "file" | "directory", flag: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new CliUsageError(`${flag} path does not exist: ${absolute}`);
  const stats = statSync(absolute);
  if ((kind === "file" && !stats.isFile()) || (kind === "directory" && !stats.isDirectory())) {
    throw new CliUsageError(`${flag} must name a ${kind}: ${absolute}`);
  }
  return absolute;
}

function optionalPath(
  values: Record<string, string | boolean | undefined>,
  name: string,
  kind: "file" | "directory",
): string | undefined {
  const value = values[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new CliUsageError(`--${name} requires a path`);
  }
  return existingPath(value, kind, `--${name}`);
}

export function parsePrepareArgs(argv: readonly string[]): PrepareParseResult {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
        database: { type: "string", default: DEFAULT_SMOKE_DATABASE },
        gt: { type: "string" },
        "official-checkout": { type: "string" },
        "public-data": { type: "string" },
        "postgres-container": { type: "string", default: DEFAULT_POSTGRES_CONTAINER },
        "postgres-port": { type: "string", default: String(DEFAULT_POSTGRES_PORT) },
        "wren-bin": { type: "string", default: "wren" },
      },
    }));
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }

  if (values.help === true) return { kind: "help" };
  if (values.version === true) return { kind: "version" };

  const database = values.database;
  if (typeof database !== "string" || database.length === 0) {
    throw new CliUsageError("--database requires a BIRD-Interact database name");
  }
  try {
    assertDatabaseName(database);
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }

  const container = values["postgres-container"];
  if (typeof container !== "string" || container.length === 0) {
    throw new CliUsageError("--postgres-container requires a container name");
  }
  const port = typeof values["postgres-port"] === "string" ? Number(values["postgres-port"]) : Number.NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new CliUsageError("--postgres-port must be a positive integer <= 65535");
  }
  const wrenBin = values["wren-bin"];
  if (typeof wrenBin !== "string" || wrenBin.length === 0) {
    throw new CliUsageError("--wren-bin requires a path or command name");
  }

  const gtPath = optionalPath(values, "gt", "file");
  const officialCheckout = optionalPath(values, "official-checkout", "directory");
  const publicDataPath = optionalPath(values, "public-data", "file");

  return {
    kind: "run",
    config: {
      database,
      ...(gtPath === undefined ? {} : { gtPath }),
      ...(officialCheckout === undefined ? {} : { officialCheckout }),
      ...(publicDataPath === undefined ? {} : { publicDataPath }),
      postgresContainer: container,
      postgresPort: port,
      wrenBin,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Docker seam                                                                */
/* -------------------------------------------------------------------------- */

export interface ContainerInspection {
  readonly name: string;
  readonly running: boolean;
  readonly imageId: string;
  readonly imageReference: string;
  readonly labels: Readonly<Record<string, string>>;
  /** Host port published for the container's PostgreSQL port, or null when unmapped. */
  readonly hostPort: number | null;
}

export interface ImageInspection {
  readonly id: string;
  readonly repoDigests: readonly string[];
}

export interface ContainerRunSpec {
  readonly name: string;
  readonly image: string;
  readonly hostPort: number;
  readonly containerPort: number;
  readonly labels: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
  readonly command: readonly string[];
}

export interface DockerClient {
  inspectContainer(name: string): Promise<ContainerInspection | null>;
  runContainer(spec: ContainerRunSpec): Promise<void>;
  startContainer(name: string): Promise<void>;
  inspectImage(reference: string): Promise<ImageInspection>;
  waitForPostgres(name: string): Promise<void>;
  runPsqlJson(name: string, database: string, sql: string): Promise<string>;
  /** Run provisioning DDL, which returns nothing and must not half-apply. */
  runPsqlScript(name: string, database: string, sql: string): Promise<void>;
}

const portBindingSchema = z.array(z.object({ HostPort: z.string() }).passthrough()).nullable();
const networkSettingsSchema = z
  .object({ Ports: z.record(z.string(), portBindingSchema).nullable().optional() })
  .passthrough();
const containerInspectionSchema = z
  .object({
    Image: z.string().min(1),
    State: z.object({ Running: z.boolean() }).passthrough(),
    Config: z
      .object({ Image: z.string().min(1), Labels: z.record(z.string(), z.string()).nullable().optional() })
      .passthrough(),
    NetworkSettings: networkSettingsSchema,
  })
  .passthrough();
const imageInspectionSchema = z
  .object({ Id: z.string().min(1), RepoDigests: z.array(z.string()).nullable().optional() })
  .passthrough();

interface DockerOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export type DockerRunner = (args: readonly string[], timeoutMs: number) => Promise<DockerOutcome>;

export interface DockerClientOptions {
  readonly runner?: DockerRunner;
  readonly readyTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onWaiting?: (elapsedMs: number) => void;
}

async function runDocker(args: readonly string[], timeoutMs = DOCKER_TIMEOUT_MS): Promise<DockerOutcome> {
  try {
    const result = await execFileAsync("docker", [...args], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error) {
      const failed = error as { stdout?: string; stderr?: string; code: unknown; killed?: unknown };
      if (typeof failed.code === "number") {
        return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: failed.code };
      }
      // `killed` is set only by the kill this process issued, so an out-of-band SIGKILL - an OOM
      // reaper, an operator - still falls through to the unexecutable case rather than posing as a
      // slow command.
      if (failed.killed === true) throw new DockerTimeoutError(timeoutMs);
    }
    throw new PrepareError("Docker command could not be executed");
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PrepareError(`Docker returned malformed ${label} JSON`);
  }
}

/**
 * How the docker CLI says, on stderr, that it never ran the command at all.
 *
 * The readiness loop retries a failed probe, so it needs to tell "the server is not up yet" from
 * "nothing asked the server anything". The exit code cannot: measured against docker 29.4.0, a
 * removed container, a stopped one and an unreachable daemon all exit 1 - and so does `pg_isready`
 * when the server is up but rejecting connections, which is an ordinary moment in the first-boot
 * restore this wait exists for. The STREAM separates them. `pg_isready` writes its verdict to
 * stdout and leaves stderr empty even for arguments it rejects outright, so only docker writes here.
 *
 * These match the four measured messages and nothing broader, which is what makes the failure modes
 * asymmetric: a message not listed here degrades to the bounded polling that happened before this
 * existed, while a pattern loose enough to catch a healthy probe would abandon a restore that was
 * still working. A container that is merely RESTARTING is deliberately absent - it can still come
 * up, and waiting for it is the safe direction.
 */
const DOCKER_NEVER_RAN_THE_PROBE: readonly RegExp[] = [
  /^Error response from daemon: No such container/i,
  /^Error response from daemon: container .* is not running/i,
  /^Cannot connect to the Docker daemon/i,
  /^failed to connect to the docker API/i,
];

/** The line with which docker reported it never ran the probe, or null when it did run it. */
function dockerNeverRanTheProbe(stderr: string): string | null {
  for (const raw of stderr.split("\n")) {
    const line = raw.trim();
    if (line !== "" && DOCKER_NEVER_RAN_THE_PROBE.some((pattern) => pattern.test(line))) return line;
  }
  return null;
}

function publishedPostgresPort(settings: z.infer<typeof networkSettingsSchema>): number | null {
  const bindings = settings.Ports?.[`${POSTGRES_PORT_IN_CONTAINER}/tcp`] ?? null;
  const first = bindings?.[0];
  if (first === undefined) return null;
  const port = Number(first.HostPort);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/** Production Docker adapter; every invocation uses an argument array, never a shell string. */
export function createDockerClient(options: DockerClientOptions = {}): DockerClient {
  const runDockerCommand = options.runner ?? runDocker;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((wake) => setTimeout(wake, ms)));
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const onWaiting =
    options.onWaiting ??
    ((elapsedMs: number) => {
      process.stderr.write(
        `Waiting for the official PostgreSQL image to finish initializing (${Math.round(elapsedMs / 1000)}s)\n`,
      );
    });
  return {
    async inspectContainer(name: string): Promise<ContainerInspection | null> {
      const result = await runDockerCommand(["container", "inspect", name, "--format", "{{json .}}"], DOCKER_TIMEOUT_MS);
      if (result.code !== 0) {
        if (/no such (container|object)/i.test(result.stderr)) return null;
        throw new PrepareError(`Docker could not inspect container '${name}'`);
      }
      const parsed = containerInspectionSchema.safeParse(parseJson(result.stdout, "container"));
      if (!parsed.success) {
        throw new PrepareError(`Docker returned an unsupported inspection for container '${name}'`);
      }
      return {
        name,
        running: parsed.data.State.Running,
        imageId: parsed.data.Image,
        imageReference: parsed.data.Config.Image,
        labels: parsed.data.Config.Labels ?? {},
        hostPort: publishedPostgresPort(parsed.data.NetworkSettings),
      };
    },

    async runContainer(spec: ContainerRunSpec): Promise<void> {
      const args = ["run", "-d", "--name", spec.name];
      for (const [key, value] of Object.entries(spec.labels)) args.push("--label", `${key}=${value}`);
      for (const [key, value] of Object.entries(spec.env)) args.push("-e", `${key}=${value}`);
      args.push("-p", `${spec.hostPort}:${spec.containerPort}`, spec.image, ...spec.command);
      const result = await runDockerCommand(args, DOCKER_TIMEOUT_MS);
      if (result.code !== 0) throw new PrepareError(`Docker could not create container '${spec.name}'`);
    },

    async startContainer(name: string): Promise<void> {
      const result = await runDockerCommand(["start", name], DOCKER_TIMEOUT_MS);
      if (result.code !== 0) throw new PrepareError(`Docker could not start container '${name}'`);
    },

    async inspectImage(reference: string): Promise<ImageInspection> {
      const result = await runDockerCommand(["image", "inspect", reference, "--format", "{{json .}}"], DOCKER_TIMEOUT_MS);
      if (result.code !== 0) throw new PrepareError(`Docker could not inspect image '${reference}'`);
      const parsed = imageInspectionSchema.safeParse(parseJson(result.stdout, "image"));
      if (!parsed.success) throw new PrepareError("Docker returned an unsupported image inspection");
      return { id: parsed.data.Id, repoDigests: parsed.data.RepoDigests ?? [] };
    },

    async waitForPostgres(name: string): Promise<void> {
      // Probe TCP, not the local socket: the official entrypoint answers on /var/run/postgresql
      // while its init scripts are still importing table dumps, so a socket probe reports "ready"
      // against databases that have no tables yet.
      const probeArgs = [
        "exec", name,
        "pg_isready", "-h", "127.0.0.1", "-p", String(POSTGRES_PORT_IN_CONTAINER), "-U", POSTGRES_USER,
      ];
      const started = Date.now();
      const deadline = started + readyTimeoutMs;
      let nextNotice = started + READY_NOTICE_INTERVAL_MS;
      for (;;) {
        // A probe killed for overrunning its own timeout is a database still restoring, not a broken
        // docker, so it counts as one more failed poll - dropping the whole wait there would forfeit
        // it to the very condition READY_TIMEOUT_MS was sized for. A missing `docker` binary is the
        // only failure that arrives as a THROW: `execFile` reports it as `code: "ENOENT"`, a string
        // `runDocker` cannot return as an exit code, so it raises and this rethrows.
        //
        // Everything else arrives as an ordinary nonzero exit, retryable or not, and only
        // `dockerNeverRanTheProbe` can tell which - see it for why the exit code cannot.
        let ready = false;
        let refusal: string | null = null;
        try {
          const probe = await runDockerCommand(probeArgs, READY_POLL_INTERVAL_MS * 5);
          ready = probe.code === 0;
          refusal = ready ? null : dockerNeverRanTheProbe(probe.stderr);
        } catch (error) {
          if (!(error instanceof DockerTimeoutError)) throw error;
        }
        if (ready) return;
        // Asking again cannot change any of these answers, and asking for the rest of the deadline
        // would spend half an hour hiding a container that is simply not there.
        if (refusal !== null) {
          throw new PrepareError(
            `Docker never ran the readiness probe for container '${name}' (${refusal});` +
              ` check 'docker ps -a' and 'docker logs ${name}'`,
          );
        }
        const now = Date.now();
        if (now >= deadline) {
          throw new PrepareError(`PostgreSQL in container '${name}' never became ready`);
        }
        if (now >= nextNotice) {
          onWaiting(now - started);
          nextNotice = now + READY_NOTICE_INTERVAL_MS;
        }
        await sleep(READY_POLL_INTERVAL_MS);
      }
    },

    async runPsqlJson(name: string, database: string, sql: string): Promise<string> {
      const result = await runDockerCommand([
        "exec", name,
        "psql", "-X", "-A", "-t",
        "-v", "ON_ERROR_STOP=1",
        "-U", POSTGRES_USER,
        "-d", database,
        "-c", sql,
      ], DOCKER_TIMEOUT_MS);
      if (result.code !== 0) {
        throw new PrepareError(`PostgreSQL introspection of database '${database}' failed`);
      }
      return result.stdout;
    },

    async runPsqlScript(name: string, database: string, sql: string): Promise<void> {
      const result = await runDockerCommand([
        "exec", name,
        "psql", "-X", "-A", "-t", "-q",
        "-v", "ON_ERROR_STOP=1",
        // One transaction for the whole script: a half-provisioned cluster - a role that exists but
        // holds no grant - would be a role the autopsy connects as and then cannot read with, which
        // reads on the page as the run's own failure rather than as a preparation that stopped.
        "--single-transaction",
        "-U", POSTGRES_USER,
        "-d", database,
        "-c", sql,
      ], DOCKER_TIMEOUT_MS);
      if (result.code !== 0) {
        throw new PrepareError(`PostgreSQL provisioning in database '${database}' failed`);
      }
    },
  };
}

function normalizeImageReference(reference: string): string {
  let normalized = reference;
  for (const prefix of ["index.docker.io/", "docker.io/"]) {
    if (normalized.startsWith(prefix)) normalized = normalized.slice(prefix.length);
  }
  if (!normalized.includes("@") && normalized.lastIndexOf(":") <= normalized.lastIndexOf("/")) {
    normalized = `${normalized}:latest`;
  }
  return normalized;
}

function isOfficialImage(reference: string): boolean {
  return normalizeImageReference(reference) === normalizeImageReference(POSTGRES_IMAGE);
}

/* -------------------------------------------------------------------------- */
/* Runtime manifest                                                           */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */

export interface PrepareDependencies {
  /** Root of the ignored local data tree; tests inject a temporary directory. */
  readonly dataRoot: string;
  readonly docker: DockerClient;
  readonly acquireCheckout?: (
    options: { cacheDir: string; seedDir?: string },
  ) => Promise<BirdCheckoutVerification>;
  readonly acquireSnapshot?: (
    options: { cacheDir: string; publicDataPath?: string },
  ) => Promise<PublicSnapshotVerification>;
  readonly createPlanner?: (projectRoot: string, wrenBin: string) => WrenPlanner;
  readonly wrenVersion?: (wrenBin: string) => Promise<string>;
  readonly now?: () => string;
}

export interface PrepareResult {
  readonly runtimeDir: string;
  readonly manifest: PrepareManifest;
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

/** Proves a path is a direct managed sibling of the data root before any recursive removal. */
function assertManagedSibling(dataRoot: string, target: string, prefix: string): void {
  const root = resolve(dataRoot);
  const candidate = resolve(target);
  if (dirname(candidate) !== root || !basename(candidate).startsWith(prefix)) {
    throw new PrepareError("Refusing to remove a path outside the managed runtime staging area");
  }
}

async function removeManaged(dataRoot: string, target: string, prefix: string): Promise<void> {
  assertManagedSibling(dataRoot, target, prefix);
  await rm(target, { recursive: true, force: true });
}

async function defaultWrenVersion(wrenBin: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(wrenBin, ["--version"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: WREN_VERSION_TIMEOUT_MS,
      killSignal: "SIGKILL",
    }));
  } catch {
    throw new PrepareError(`Could not run '${wrenBin} --version'; install the wren CLI or pass --wren-bin`);
  }
  const version = stdout.trim();
  if (version === "") throw new PrepareError(`'${wrenBin} --version' reported no version`);
  return version;
}

/** Validates the gated GT, copies it into the private tree mode 0600, and returns its bytes. */
async function importGroundTruth(dataRoot: string, gtPath: string | undefined): Promise<string> {
  const privateDir = join(dataRoot, "private");
  const destination = join(privateDir, GT_FILENAME);

  if (gtPath !== undefined) {
    const sourceText = await readFile(gtPath, "utf8");
    parseGroundTruthJsonl(sourceText);
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    const staging = join(privateDir, `.${GT_FILENAME}.tmp-${randomUUID()}`);
    await writeFile(staging, sourceText, { encoding: "utf8", mode: 0o600 });
    await rename(staging, destination);
    await chmod(destination, 0o600);
    return sourceText;
  }

  let existing: string;
  try {
    existing = await readFile(destination, "utf8");
  } catch {
    throw new PrepareError(
      `No private ground truth at private/${GT_FILENAME}; pass --gt <file> once to import it`,
    );
  }
  parseGroundTruthJsonl(existing);
  await chmod(destination, 0o600);
  return existing;
}

/** Makes the unchanged official ADK resolve public metadata from the Warble-local verified cache. */
async function ensureAdkPublicDataLink(cacheDir: string): Promise<void> {
  const publicCache = resolve(cacheDir, PUBLIC_CACHE_DIRECTORY);
  const adkDir = resolve(cacheDir, "BIRD-Interact", ADK_DIRECTORY);
  const link = join(adkDir, PUBLIC_CACHE_DIRECTORY);

  const publicStats = await lstatOrNull(publicCache);
  if (publicStats === null || !publicStats.isDirectory()) {
    throw new PrepareError("Verified Warble-local public-data cache is missing");
  }
  const adkStats = await lstatOrNull(adkDir);
  if (adkStats === null || !adkStats.isDirectory()) {
    throw new PrepareError("Official BIRD checkout is missing its ADK directory");
  }

  const existing = await lstatOrNull(link);
  if (existing === null) {
    await symlink(relative(adkDir, publicCache), link);
    return;
  }
  if (!existing.isSymbolicLink()) {
    throw new PrepareError(
      "Official ADK public-data entry must be the Warble-managed symlink; move or remove it",
    );
  }
  if (resolve(adkDir, await readlink(link)) !== publicCache) {
    throw new PrepareError(
      "Official ADK public-data link must point at the Warble-local verified public snapshot",
    );
  }
}

/** Verifies, starts, or creates the Warble-owned official PostgreSQL container. */
async function resolveContainer(
  docker: DockerClient,
  config: PrepareConfig,
): Promise<ContainerInspection> {
  const isDefault = config.postgresContainer === DEFAULT_POSTGRES_CONTAINER;
  let inspection = await docker.inspectContainer(config.postgresContainer);

  if (inspection === null) {
    if (!isDefault) {
      throw new PrepareError(
        `Container '${config.postgresContainer}' does not exist; Warble only creates the default '${DEFAULT_POSTGRES_CONTAINER}'`,
      );
    }
    await docker.runContainer({
      name: DEFAULT_POSTGRES_CONTAINER,
      image: POSTGRES_IMAGE,
      hostPort: config.postgresPort,
      containerPort: POSTGRES_PORT_IN_CONTAINER,
      labels: { [WARBLE_EVAL_LABEL]: WARBLE_EVAL_LABEL_VALUE },
      env: { POSTGRES_USER, POSTGRES_PASSWORD: "123123", TZ: "Asia/Hong_Kong" },
      command: ["-c", "max_connections=300", "-c", "shared_buffers=256MB"],
    });
    inspection = await docker.inspectContainer(config.postgresContainer);
    if (inspection === null) {
      throw new PrepareError("Docker reported no container after creating the default PostgreSQL container");
    }
  } else if (!inspection.running) {
    await docker.startContainer(config.postgresContainer);
    // Every check below reads the post-start snapshot because a stopped container inspects with an
    // empty NetworkSettings.Ports map - the published binding only survives in HostConfig.PortBindings,
    // which no inspection field exposes - so validating the pre-start snapshot would reject the
    // container for not publishing 5432/tcp on the first prepare after any host or docker restart.
    inspection = await docker.inspectContainer(config.postgresContainer);
    if (inspection === null) {
      throw new PrepareError("Docker reported no container after starting the existing PostgreSQL container");
    }
  }

  if (!isOfficialImage(inspection.imageReference)) {
    throw new PrepareError(
      `Container '${config.postgresContainer}' runs image '${inspection.imageReference}', not the official BIRD-Interact PostgreSQL image`,
    );
  }
  if (isDefault && inspection.labels[WARBLE_EVAL_LABEL] !== WARBLE_EVAL_LABEL_VALUE) {
    throw new PrepareError(
      `Container '${config.postgresContainer}' has no ${WARBLE_EVAL_LABEL}=${WARBLE_EVAL_LABEL_VALUE} label; Warble refuses to adopt or replace it`,
    );
  }
  // Both `docker run -d` and `docker start` exit 0 once the daemon has ACCEPTED the container, not
  // once it has stayed up, so either can hand back a container whose PostgreSQL is already dead -
  // a host port already taken, an unreadable PGDATA. Such a container inspects as
  // `Running:false, Ports:{}` while `HostConfig.PortBindings` still carries the mapping, so without
  // this the empty Ports map is what gets noticed and the run blames a port mapping that is fine,
  // sending the reader away from the only thing that says what happened.
  if (!inspection.running) {
    throw new PrepareError(
      `Container '${config.postgresContainer}' exited immediately after docker accepted it;` +
        ` run 'docker logs ${config.postgresContainer}' to see why PostgreSQL stopped`,
    );
  }
  if (inspection.hostPort === null) {
    throw new PrepareError(
      `Container '${config.postgresContainer}' does not publish ${POSTGRES_PORT_IN_CONTAINER}/tcp to a host port`,
    );
  }

  await docker.waitForPostgres(config.postgresContainer);
  return inspection;
}

/**
 * Give the cluster the role the AUTOPSY replays as, and take away the one grant that would let any
 * role write to the database it is inspecting.
 *
 * Five statements, each load-bearing:
 *
 * - `CREATE ROLE`, only when it is absent, because `CREATE ROLE` on an existing role is an error
 *   and preparation is re-run on every tree. The existence question is asked in SQL rather than
 *   answered by a `DO` block so the condition is visible here, and testable, instead of being a
 *   program inside a string.
 * - `ALTER ROLE ... WITH` on every run, which re-asserts every attribute: a role someone edited by
 *   hand is put back rather than trusted.
 * - `GRANT pg_read_all_data`, which is SELECT on every table and USAGE on every schema in one
 *   grant that no later table can fall outside of, and which carries no write of any kind. It is a
 *   predefined role of PostgreSQL 14, and the image is pinned to 14 — an older server would fail
 *   here, loudly, which is the right outcome for a server this cannot secure.
 * - `REVOKE CREATE ON SCHEMA public FROM PUBLIC`, which is what makes "cannot create" TRUE on this
 *   server. PostgreSQL 14 still hands PUBLIC the CREATE grant on schema `public`, so a role with
 *   no privileges of its own can create a table there anyway; measured on the pinned image, whose
 *   `alien_template` carries `{root=UC/root,=UC/root}` — that second entry is PUBLIC's. Revoking
 *   it costs nothing real: `root` is the cluster's only login role and is a superuser, which ACLs
 *   do not apply to, so every write the harness itself makes is unaffected.
 * - `REVOKE EXECUTE ON FUNCTION lo_create, lo_creat, lo_from_bytea FROM PUBLIC`, which is what
 *   closes large objects. They are the one thing a role with no privileges could still leave
 *   behind, because nothing else here reaches them: `pg_read_all_data` does not cover them, the
 *   schema revoke above does not either — they live in no schema — and PostgreSQL prevents no
 *   large-object CREATION in a read-only transaction at all, so both read-only layers pass it
 *   through. Measured on the pinned image, the replay role minted large objects that outlived the
 *   run while the page still printed the strong claim. These three are precisely the `pg_catalog`
 *   functions that mint one and whose `proacl` is null, PostgreSQL's spelling of "PUBLIC still
 *   holds the default EXECUTE": `lo_import`/`lo_export` ship revoked already as `{root=X/root}`,
 *   and every other `lo_*` function needs an object that exists, which this role can neither
 *   write nor unlink. The revoke costs the harness nothing, for the same reason the one above
 *   does: `root` is a SUPERUSER, and superusers bypass ACL checks entirely — measured after the
 *   revoke, `root` still creates, writes, reads and unlinks large objects, and the official
 *   restore never calls a large-object function in the first place. The role cannot undo it
 *   either: it may not GRANT a privilege on a function it does not own, and `lo_compat_privileges`
 *   is SUSET, so it cannot relax large-object permissions the way a USERSET setting would let it.
 *
 * `ALTER ROLE ... SET default_transaction_read_only = on` is defence in depth on the server side,
 * for a connection that arrives without the autopsy's `PGOPTIONS`. It is deliberately NOT the
 * guarantee: any role may set it back for itself, which is the whole reason this function exists.
 *
 * It runs against the TEMPLATE database because that is the one the autopsy replays against, and
 * the one the official environment clones per task, so both revokes reach the clones too —
 * `CREATE DATABASE ... TEMPLATE` copies the catalogs, ACLs and all, which was measured rather
 * than assumed.
 */
async function provisionReadOnlyRole(
  docker: DockerClient,
  container: string,
  database: string,
): Promise<void> {
  const existing = await docker.runPsqlJson(
    container,
    database,
    `SELECT count(*) FROM pg_roles WHERE rolname = '${READ_ONLY_ROLE}'`,
  );
  const attributes =
    `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS LOGIN PASSWORD '${READ_ONLY_PASSWORD}'`;
  const statements = [
    ...(Number(existing.trim()) >= 1 ? [] : [`CREATE ROLE ${READ_ONLY_ROLE} ${attributes}`]),
    `ALTER ROLE ${READ_ONLY_ROLE} WITH ${attributes}`,
    `ALTER ROLE ${READ_ONLY_ROLE} SET default_transaction_read_only = on`,
    `GRANT pg_read_all_data TO ${READ_ONLY_ROLE}`,
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
    "REVOKE EXECUTE ON FUNCTION lo_create(oid), lo_creat(integer), lo_from_bytea(oid, bytea) FROM PUBLIC",
  ];
  await docker.runPsqlScript(container, database, `${statements.join(";\n")};`);
}

/** The mutable `latest` tag is never provenance; the recorded image ID and digests are. */
function assertContainerProvenance(
  previous: PrepareManifest | null,
  container: ContainerInspection,
  image: ImageInspection,
): void {
  if (previous === null) return;
  const sameId = previous.database.imageId === image.id;
  const sameDigests =
    previous.database.repoDigests.length === image.repoDigests.length &&
    previous.database.repoDigests.every((digest) => image.repoDigests.includes(digest));
  if (!sameId || !sameDigests) {
    throw new PrepareError(
      `Container '${container.name}' now runs a different PostgreSQL image than the recorded runtime;` +
        " restore the recorded image or remove data/runtime deliberately to re-pin it",
    );
  }
}

async function promoteRuntime(dataRoot: string, staging: string, runtimeDir: string): Promise<void> {
  let backup: string | null = null;
  if ((await lstatOrNull(runtimeDir)) !== null) {
    backup = join(dataRoot, `${BACKUP_PREFIX}${randomUUID()}`);
    await rename(runtimeDir, backup);
  }
  try {
    await rename(staging, runtimeDir);
  } catch (error) {
    if (backup !== null) await rename(backup, runtimeDir);
    throw error instanceof PrepareError
      ? error
      : new PrepareError("Could not promote the staged BIRD-Interact runtime");
  }
  if (backup !== null) await removeManaged(dataRoot, backup, BACKUP_PREFIX);
}

/**
 * Prepares the pinned BIRD-Interact runtime transactionally: every external input is validated and
 * staged first, and promoting `data/runtime` is the last mutation.
 */
export async function prepareBirdRuntime(
  config: PrepareConfig,
  deps: PrepareDependencies,
): Promise<PrepareResult> {
  const dataRoot = resolve(deps.dataRoot);
  const runtimeDir = join(dataRoot, RUNTIME_DIRECTORY);
  const cacheDir = join(dataRoot, "cache");
  const acquireCheckout = deps.acquireCheckout ?? ((options) => ensureBirdCheckout(options));
  const acquireSnapshot = deps.acquireSnapshot ?? ((options) => ensurePublicSnapshot(options));
  const createPlanner =
    deps.createPlanner ?? ((projectRoot, wrenBin) => new ProcessWrenPlanner({ projectRoot, wrenBin }));
  const wrenVersion = deps.wrenVersion ?? defaultWrenVersion;
  const now = deps.now ?? (() => new Date().toISOString());

  const runtimeStats = await lstatOrNull(runtimeDir);
  if (runtimeStats !== null && (runtimeStats.isSymbolicLink() || !runtimeStats.isDirectory())) {
    throw new PrepareError("Existing data/runtime must be a real directory before preparation");
  }
  const previous = runtimeStats === null ? null : await readPrepareManifest(runtimeDir);

  // 1. Validate the gated GT before copying it into the private tree.
  const gtText = await importGroundTruth(dataRoot, config.gtPath);

  // 2. Import or verify the pinned official sources inside the Warble-local data tree.
  await acquireCheckout({
    cacheDir: join(cacheDir, "BIRD-Interact"),
    ...(config.officialCheckout === undefined ? {} : { seedDir: config.officialCheckout }),
  });
  const snapshot = await acquireSnapshot({
    cacheDir: join(cacheDir, PUBLIC_CACHE_DIRECTORY),
    ...(config.publicDataPath === undefined ? {} : { publicDataPath: config.publicDataPath }),
  });

  // 3. Verify both ID sets, merge only the official GT fields, and select the fixed smoke.
  const publicText = await readFile(join(snapshot.path, PUBLIC_MAIN_JSONL), "utf8");
  const combinedRows = mergePublicWithGroundTruth(
    parsePublicJsonl(publicText),
    parseGroundTruthJsonl(gtText),
  );
  const taskIds = smokeTaskIds(config.database);
  const smokeRows = selectSmokeTasks(combinedRows, config.database, taskIds);

  // 4. Verify or start PostgreSQL, pin its provenance, and introspect the smoke database.
  const container = await resolveContainer(deps.docker, config);
  const image = await deps.docker.inspectImage(container.imageId);
  assertContainerProvenance(previous, container, image);
  const template = templateDatabase(config.database);
  // Provision before introspecting, and only after provenance passed: this is the one place that
  // changes the container's DATABASES rather than its lifecycle, so it may not touch a container
  // whose image was just rejected. The autopsy asks the cluster itself whether the role is there,
  // so a runtime prepared before this existed keeps working and says which role it replayed as.
  await provisionReadOnlyRole(deps.docker, config.postgresContainer, template);
  const mdl = buildIdentityMdl(
    parseIntrospectionJson(
      await deps.docker.runPsqlJson(config.postgresContainer, template, INFORMATION_SCHEMA_INTROSPECTION_SQL),
    ),
  );

  const staging = join(dataRoot, `${STAGING_PREFIX}${randomUUID()}`);
  try {
    // 5. Stage every runtime output beside, never inside, the promoted runtime.
    const smokeFile = smokeFilename(config.database);
    const mdlPath = join(staging, IDENTITY_PROJECTS, config.database, "target", "mdl.json");
    await mkdir(dirname(mdlPath), { recursive: true });
    const combinedText = serializeJsonl(combinedRows);
    const smokeText = serializeJsonl(smokeRows);
    const mdlText = `${JSON.stringify(mdl, null, 2)}\n`;
    await writeFile(join(staging, COMBINED_FILENAME), combinedText, "utf8");
    await writeFile(join(staging, smokeFile), smokeText, "utf8");
    await writeFile(mdlPath, mdlText, "utf8");

    const manifest: PrepareManifest = {
      version: 1,
      createdAt: now(),
      official: { repository: BIRD_REPOSITORY, commit: BIRD_COMMIT },
      publicSnapshot: {
        repository: HF_REPOSITORY,
        commit: HF_COMMIT,
        fileCount: snapshot.fileCount,
        manifestSha256: snapshot.manifestSha256,
      },
      groundTruth: { file: `private/${GT_FILENAME}`, sha256: sha256(gtText) },
      outputs: {
        combined: {
          file: `${RUNTIME_DIRECTORY}/${COMBINED_FILENAME}`,
          rows: combinedRows.length,
          sha256: sha256(combinedText),
        },
        smoke: {
          file: `${RUNTIME_DIRECTORY}/${smokeFile}`,
          rows: smokeRows.length,
          sha256: sha256(smokeText),
        },
        mdl: {
          file: `${RUNTIME_DIRECTORY}/${IDENTITY_PROJECTS}/${config.database}/target/mdl.json`,
          sha256: sha256(mdlText),
        },
      },
      database: {
        name: config.database,
        template,
        container: config.postgresContainer,
        hostPort: container.hostPort ?? config.postgresPort,
        imageReference: POSTGRES_IMAGE,
        imageId: image.id,
        repoDigests: [...image.repoDigests],
      },
      wren: { version: await wrenVersion(config.wrenBin) },
      taskIds: smokeRows.map((row) => row.instance_id),
    };
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    // 6. Point the unchanged official ADK at the Warble-local verified public snapshot.
    await ensureAdkPublicDataLink(cacheDir);

    // 7. Prove the staged identity project actually plans through Wren.
    await createPlanner(join(staging, IDENTITY_PROJECTS), config.wrenBin)
      .plan(config.database, representativeIdentityQuery(mdl));

    // 8. Promote the validated staging directory as the final mutation.
    await promoteRuntime(dataRoot, staging, runtimeDir);
    return { runtimeDir, manifest };
  } finally {
    if ((await lstatOrNull(staging)) !== null) await removeManaged(dataRoot, staging, STAGING_PREFIX);
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

const HELP = `Usage: warble-bird-prepare [options]

Imports the pinned BIRD-Interact sources into eval/bird-interact/data and promotes a verified
runtime for one database's fixed ${SMOKE_TASK_COUNT}-task Query smoke (${smokeTaskIds(DEFAULT_SMOKE_DATABASE).join(", ")} by default).

data/runtime holds exactly one prepared database at a time, and the smoke reads which one out of the
manifest this writes. Re-running with a different --database replaces it; runs already recorded under
data/runs keep their own copy of the manifest they were measured against.

It also provisions ${READ_ONLY_ROLE} on the template database: the role the autopsy replays
as, which holds SELECT on everything and CREATE on nothing, so a replayed statement cannot write
whatever it sets. Re-run this after any container re-create; an autopsy against a runtime without
that role replays as the superuser and says so on its page.

Options:
  --database <name>              BIRD-Interact database to prepare (default: ${DEFAULT_SMOKE_DATABASE})
  --gt <file>                    Gated GT JSONL to import once into data/private
  --official-checkout <dir>      Existing pinned BIRD-Interact checkout to clone locally
  --public-data <file>           Existing pinned ${PUBLIC_MAIN_JSONL} to copy instead of downloading
  --postgres-container <name>    Official container (default: ${DEFAULT_POSTGRES_CONTAINER})
  --postgres-port <port>         Host port used only when creating the default container (default: ${DEFAULT_POSTGRES_PORT})
  --wren-bin <path>              Wren executable (default: wren)
  -h, --help                     Show help
  -V, --version                  Show version`;

/** The package-local ignored data root used by the installed CLI. */
export function packageDataRoot(): string {
  return resolve(import.meta.dirname, "..", "data");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parsePrepareArgs(argv);
  if (parsed.kind === "help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (parsed.kind === "version") {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }
  const result = await prepareBirdRuntime(parsed.config, {
    dataRoot: packageDataRoot(),
    docker: createDockerClient(),
  });
  process.stdout.write(`Prepared ${result.runtimeDir}\n`);
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
