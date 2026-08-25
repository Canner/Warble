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
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

import { z } from "zod";

import { CliUsageError } from "./cli-usage.js";
import {
  mergePublicWithGroundTruth,
  parseGroundTruthJsonl,
  parsePublicJsonl,
  selectAlienSmoke,
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
  SMOKE_DATABASE,
  SMOKE_FILENAME,
  SMOKE_TASK_IDS,
  prepareManifestSchema,
  readPrepareManifest,
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
  SMOKE_DATABASE,
  SMOKE_FILENAME,
  SMOKE_TASK_IDS,
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

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* CLI contract                                                               */
/* -------------------------------------------------------------------------- */

export interface PrepareConfig {
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
      const failed = error as { stdout?: string; stderr?: string; code: unknown };
      if (typeof failed.code === "number") {
        return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: failed.code };
      }
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
        const probe = await runDockerCommand(probeArgs, READY_POLL_INTERVAL_MS * 5);
        if (probe.code === 0) return;
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
  if (inspection.hostPort === null) {
    throw new PrepareError(
      `Container '${config.postgresContainer}' does not publish ${POSTGRES_PORT_IN_CONTAINER}/tcp to a host port`,
    );
  }

  await docker.waitForPostgres(config.postgresContainer);
  return inspection;
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
  const smokeRows = selectAlienSmoke(combinedRows);

  // 4. Verify or start PostgreSQL, pin its provenance, and introspect the smoke database.
  const container = await resolveContainer(deps.docker, config);
  const image = await deps.docker.inspectImage(container.imageId);
  assertContainerProvenance(previous, container, image);
  const template = templateDatabase(SMOKE_DATABASE);
  const mdl = buildIdentityMdl(
    parseIntrospectionJson(
      await deps.docker.runPsqlJson(config.postgresContainer, template, INFORMATION_SCHEMA_INTROSPECTION_SQL),
    ),
  );

  const staging = join(dataRoot, `${STAGING_PREFIX}${randomUUID()}`);
  try {
    // 5. Stage every runtime output beside, never inside, the promoted runtime.
    const mdlPath = join(staging, IDENTITY_PROJECTS, SMOKE_DATABASE, "target", "mdl.json");
    await mkdir(dirname(mdlPath), { recursive: true });
    const combinedText = serializeJsonl(combinedRows);
    const smokeText = serializeJsonl(smokeRows);
    const mdlText = `${JSON.stringify(mdl, null, 2)}\n`;
    await writeFile(join(staging, COMBINED_FILENAME), combinedText, "utf8");
    await writeFile(join(staging, SMOKE_FILENAME), smokeText, "utf8");
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
          file: `${RUNTIME_DIRECTORY}/${SMOKE_FILENAME}`,
          rows: smokeRows.length,
          sha256: sha256(smokeText),
        },
        mdl: {
          file: `${RUNTIME_DIRECTORY}/${IDENTITY_PROJECTS}/${SMOKE_DATABASE}/target/mdl.json`,
          sha256: sha256(mdlText),
        },
      },
      database: {
        name: SMOKE_DATABASE,
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
      .plan(SMOKE_DATABASE, representativeIdentityQuery(mdl));

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
runtime for the fixed ${SMOKE_TASK_IDS.join(", ")} Query smoke.

Options:
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

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
