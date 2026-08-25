import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import {
  CliUsageError,
  DEFAULT_POSTGRES_CONTAINER,
  DEFAULT_POSTGRES_PORT,
  DockerTimeoutError,
  GT_FILENAME,
  POSTGRES_IMAGE,
  PrepareError,
  READ_ONLY_PASSWORD,
  READ_ONLY_ROLE,
  SMOKE_FILENAME,
  SMOKE_TASK_IDS,
  WARBLE_EVAL_LABEL,
  createDockerClient,
  parsePrepareArgs,
  prepareBirdRuntime,
  templateDatabase,
  type ContainerInspection,
  type ContainerRunSpec,
  type DockerClient,
  type ImageInspection,
  type PrepareConfig,
  type PrepareDependencies,
} from "../src/prepare-cli.js";
import { BIRD_COMMIT, BIRD_REPOSITORY, HF_COMMIT, HF_REPOSITORY } from "../src/source-cache.js";

type JsonRecord = Record<string, unknown>;

const CREATED_AT = "2026-08-24T12:00:00.000Z";
const IMAGE_ID = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const REPO_DIGEST = "shawnxxh/bird-interact-postgresql@sha256:2222222222222222222222222222222222222222222222222222222222222222";
const SNAPSHOT_MANIFEST_SHA = "3".repeat(64);

async function makeTempRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "warble-bird-prepare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function ids(): string[] {
  const filler = 300 - SMOKE_TASK_IDS.length;
  return [...SMOKE_TASK_IDS, ...Array.from({ length: filler }, (_, index) => `task_${index + 1}`)];
}

function publicRow(id: string): JsonRecord {
  const alien = SMOKE_TASK_IDS.includes(id as (typeof SMOKE_TASK_IDS)[number]);
  return {
    instance_id: id,
    selected_database: alien ? "alien" : "other",
    category: alien ? "Query" : "Management",
    amb_user_query: `question ${id}`,
    query: `public query ${id}`,
    user_query_ambiguity: { label: "ambiguous" },
    knowledge_ambiguity: ["knowledge"],
    follow_up: { query: `follow up ${id}`, knowledge_ambiguity: [] },
  };
}

function gtRow(id: string): JsonRecord {
  return {
    instance_id: id,
    sol_sql: [`SELECT ${id}`],
    external_knowledge: [],
    test_cases: [],
    follow_up: { sol_sql: `SELECT follow ${id}`, external_knowledge: [], test_cases: [] },
  };
}

function jsonl(rows: readonly JsonRecord[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function publicJsonl(): string {
  return jsonl(ids().map(publicRow));
}

function groundTruthJsonl(): string {
  return jsonl(ids().map(gtRow));
}

function introspection(): string {
  return JSON.stringify([
    { table_name: "weather", column_name: "condition", ordinal_position: 1, data_type: "text" },
    { table_name: "weather", column_name: "recorded_on", ordinal_position: 2, data_type: "date" },
    { table_name: "crew", column_name: "id", ordinal_position: 1, data_type: "integer" },
  ]);
}

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

interface FakeDockerOptions {
  existing?: FakeContainer | null;
  introspectionJson?: string;
  failIntrospect?: boolean;
  failReady?: boolean;
  imageId?: string;
  repoDigests?: readonly string[];
  /**
   * The container's entrypoint dies the moment docker accepts it. Both `docker run -d` and
   * `docker start` still exit 0 in that case (measured), so this is the one thing the fake changes:
   * the container docker reports afterwards is Exited, never Running.
   */
  exitsImmediately?: boolean;
}

interface FakeDocker extends DockerClient {
  readonly calls: string[];
  readonly runSpecs: ContainerRunSpec[];
  /** The cluster inside the container docker currently holds, or null when there is none. */
  cluster(): FakeCluster | null;
}

/**
 * Docker's own container record, of which an inspection is only ever a projection. The published
 * binding lives in HostConfig.PortBindings and survives a stop, but NetworkSettings.Ports - the only
 * map `publishedPostgresPort` reads - is emptied while the container is Exited. Keeping the binding
 * here instead of on the inspection is what stops the fake from expressing a stopped-but-published
 * container, a state real `docker inspect` never returns.
 */
interface FakeContainer {
  readonly name: string;
  readonly running: boolean;
  readonly imageId: string;
  readonly imageReference: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly publishedPort: number | null;
  /** The PostgreSQL cluster this container carries; removed with it, kept across a stop. */
  readonly cluster: FakeCluster;
}

/** One role as `pg_roles` holds it, with only the attributes provisioning asserts. */
interface FakeRole {
  login: boolean;
  password: string | null;
  memberOf: string[];
  settings: Record<string, string>;
}

/**
 * Every `pg_catalog` function that MINTS a new large object and that PostgreSQL 14 leaves executable
 * by PUBLIC, as the pinned image ships them.
 *
 * Measured on the pinned image (PostgreSQL 14.12): these three are exactly the functions returning
 * `oid` whose `proacl` is null, which is how PostgreSQL spells "PUBLIC still holds the default
 * EXECUTE". `lo_import`/`lo_export` ship already revoked as `{root=X/root}`, and every other
 * `lo_*` function needs a large object that already exists — `lo_put` and `lo_open` on an absent
 * oid both fail with "large object N does not exist" rather than creating one. Seeding exactly
 * these three is what makes an emptied set mean "every creation path is closed" instead of "the
 * one path this test happened to name".
 */
const LARGE_OBJECT_CREATORS = ["lo_create(oid)", "lo_creat(integer)", "lo_from_bytea(oid, bytea)"];

/**
 * The cluster inside the container, modelled only as far as provisioning reaches it.
 *
 * `publicSchemaCreate` is PUBLIC's default CREATE grant on schema `public`, which PostgreSQL 14 —
 * the pinned image's server — still hands to every role, and which is therefore the one grant that
 * decides whether a non-superuser can leave a table behind. `publicLargeObjectCreate` is the same
 * question for large objects, which no schema privilege and no read-only setting reaches at all.
 * Naming both per database is what stops a test from asserting a revoke that never named a database.
 */
interface FakeCluster {
  readonly roles: Record<string, FakeRole>;
  readonly publicSchemaCreate: Set<string>;
  /** Per database, the large-object creators PUBLIC can still execute. */
  readonly publicLargeObjectCreate: Map<string, Set<string>>;
}

function freshCluster(): FakeCluster {
  const databases = ["alien", "alien_template", "postgres"];
  return {
    // The image ships one superuser and the predefined `pg_*` roles; `root` is the only login.
    roles: { root: { login: true, password: "123123", memberOf: [], settings: {} } },
    publicSchemaCreate: new Set(databases),
    publicLargeObjectCreate: new Map(databases.map((name) => [name, new Set(LARGE_OBJECT_CREATORS)])),
  };
}

/**
 * Apply provisioning SQL to the modelled cluster, exactly as far as psql would.
 *
 * The vocabulary is small on purpose: a statement this does not recognise THROWS rather than being
 * accepted silently, so a script that grows a statement has to grow the model with it instead of
 * being waved through by a test that only ever asserted the statements it already knew.
 */
function applyProvisioningSql(cluster: FakeCluster, database: string, sql: string): void {
  for (const raw of sql.split(";")) {
    const statement = raw.trim().replace(/\s+/g, " ");
    if (statement === "") continue;
    let match = /^CREATE ROLE (\w+) (.*)$/i.exec(statement);
    if (match !== null) {
      const [, name, attributes] = match as unknown as [string, string, string];
      if (cluster.roles[name] !== undefined) throw new PrepareError(`role "${name}" already exists`);
      cluster.roles[name] = { login: false, password: null, memberOf: [], settings: {} };
      applyRoleAttributes(cluster.roles[name], attributes);
      continue;
    }
    match = /^ALTER ROLE (\w+) SET (\w+) = (\S+)$/i.exec(statement);
    if (match !== null) {
      const [, name, setting, value] = match as unknown as [string, string, string, string];
      requireRole(cluster, name).settings[setting] = value;
      continue;
    }
    match = /^ALTER ROLE (\w+) WITH (.*)$/i.exec(statement);
    if (match !== null) {
      const [, name, attributes] = match as unknown as [string, string, string];
      applyRoleAttributes(requireRole(cluster, name), attributes);
      continue;
    }
    match = /^GRANT (\w+) TO (\w+)$/i.exec(statement);
    if (match !== null) {
      const [, granted, name] = match as unknown as [string, string, string];
      requireRole(cluster, name).memberOf.push(granted);
      continue;
    }
    if (/^REVOKE CREATE ON SCHEMA public FROM PUBLIC$/i.test(statement)) {
      cluster.publicSchemaCreate.delete(database);
      continue;
    }
    match = /^REVOKE EXECUTE ON FUNCTION (.+) FROM PUBLIC$/i.exec(statement);
    if (match !== null) {
      const [, list] = match as unknown as [string, string];
      // A signature carries its own comma (`lo_from_bytea(oid, bytea)`), so the list is matched
      // rather than split, and the match must account for the whole list: a signature this could
      // not read would otherwise be silently dropped and count as revoked.
      const signatures = [...list.matchAll(/\w+\([^)]*\)/g)].map(([signature]) => signature);
      if (signatures.join(", ") !== list) throw new PrepareError(`unreadable function list: ${list}`);
      const surviving = cluster.publicLargeObjectCreate.get(database);
      if (surviving === undefined) throw new PrepareError(`database "${database}" does not exist`);
      for (const signature of signatures) {
        if (!LARGE_OBJECT_CREATORS.includes(signature)) {
          throw new PrepareError(`the fake cluster does not model the function: ${signature}`);
        }
        // Re-revoking a privilege PUBLIC no longer holds is a no-op on a real server, not an error,
        // which is what lets preparation re-run over a cluster it already provisioned.
        surviving.delete(signature);
      }
      continue;
    }
    throw new PrepareError(`the fake cluster does not model: ${statement}`);
  }
}

function requireRole(cluster: FakeCluster, name: string): FakeRole {
  const role = cluster.roles[name];
  if (role === undefined) throw new PrepareError(`role "${name}" does not exist`);
  return role;
}

function applyRoleAttributes(role: FakeRole, attributes: string): void {
  const password = /PASSWORD '([^']*)'/i.exec(attributes);
  if (password !== null) role.password = password[1] ?? null;
  if (/\bLOGIN\b/i.test(attributes)) role.login = true;
  if (/\bNOLOGIN\b/i.test(attributes)) role.login = false;
}

function inspectionOf(container: FakeContainer): ContainerInspection {
  return {
    name: container.name,
    running: container.running,
    imageId: container.imageId,
    imageReference: container.imageReference,
    labels: container.labels,
    hostPort: container.running ? container.publishedPort : null,
  };
}

function fakeDocker(options: FakeDockerOptions = {}): FakeDocker {
  const calls: string[] = [];
  const runSpecs: ContainerRunSpec[] = [];
  let container: FakeContainer | null = options.existing ?? null;
  return {
    calls,
    runSpecs,
    cluster: () => container?.cluster ?? null,
    async inspectContainer(name: string): Promise<ContainerInspection | null> {
      calls.push(`inspectContainer:${name}`);
      return container === null ? null : inspectionOf(container);
    },
    async runContainer(spec: ContainerRunSpec): Promise<void> {
      calls.push(`runContainer:${spec.name}`);
      runSpecs.push(spec);
      container = {
        name: spec.name,
        running: options.exitsImmediately !== true,
        imageId: options.imageId ?? IMAGE_ID,
        imageReference: spec.image,
        labels: { ...spec.labels },
        publishedPort: spec.hostPort,
        cluster: freshCluster(),
      };
    },
    async startContainer(name: string): Promise<void> {
      calls.push(`startContainer:${name}`);
      // `docker start` reports only that the daemon ACCEPTED the container, so it exits 0 even for
      // one whose PostgreSQL dies on startup; the fake therefore never fails here either.
      if (container !== null) container = { ...container, running: options.exitsImmediately !== true };
    },
    async inspectImage(reference: string): Promise<ImageInspection> {
      calls.push(`inspectImage:${reference}`);
      return { id: options.imageId ?? IMAGE_ID, repoDigests: options.repoDigests ?? [REPO_DIGEST] };
    },
    async waitForPostgres(name: string): Promise<void> {
      calls.push(`waitForPostgres:${name}`);
      if (options.failReady === true) throw new PrepareError("PostgreSQL never became ready");
    },
    async runPsqlJson(name: string, database: string, sql: string): Promise<string> {
      calls.push(`runPsqlJson:${name}:${database}`);
      if (/pg_roles/.test(sql)) {
        const asked = /rolname = '(\w+)'/.exec(sql)?.[1] ?? "";
        return `${container?.cluster.roles[asked] === undefined ? 0 : 1}\n`;
      }
      if (options.failIntrospect === true) throw new PrepareError("introspection failed");
      return options.introspectionJson ?? introspection();
    },
    async runPsqlScript(name: string, database: string, sql: string): Promise<void> {
      calls.push(`runPsqlScript:${name}:${database}`);
      if (container === null) throw new PrepareError(`no such container '${name}'`);
      applyProvisioningSql(container.cluster, database, sql);
    },
  };
}

function ownedContainer(overrides: Partial<FakeContainer> = {}): FakeContainer {
  return {
    name: DEFAULT_POSTGRES_CONTAINER,
    running: true,
    imageId: IMAGE_ID,
    imageReference: POSTGRES_IMAGE,
    labels: { [WARBLE_EVAL_LABEL]: "bird-interact" },
    publishedPort: DEFAULT_POSTGRES_PORT,
    cluster: freshCluster(),
    ...overrides,
  };
}

interface HarnessOptions {
  docker?: FakeDocker;
  publicText?: string;
  planner?: PrepareDependencies["createPlanner"];
  wrenVersion?: () => Promise<string>;
  snapshotManifestSha?: string;
}

type PrepareOverrides = { [K in keyof PrepareConfig]?: PrepareConfig[K] | undefined };

interface Harness {
  readonly dataRoot: string;
  readonly gtSource: string;
  readonly docker: FakeDocker;
  readonly deps: PrepareDependencies;
  readonly plannedSql: string[];
  config(overrides?: PrepareOverrides): PrepareConfig;
}

async function makeHarness(t: TestContext, options: HarnessOptions = {}): Promise<Harness> {
  const root = await makeTempRoot(t);
  const dataRoot = join(root, "data");
  const gtSource = join(root, "source-gt.jsonl");
  await writeFile(gtSource, groundTruthJsonl(), "utf8");
  const docker = options.docker ?? fakeDocker();
  const plannedSql: string[] = [];

  const deps: PrepareDependencies = {
    dataRoot,
    docker,
    acquireCheckout: async ({ cacheDir }) => {
      await mkdir(join(cacheDir, "BIRD-Interact-ADK"), { recursive: true });
      return { path: cacheDir, commit: BIRD_COMMIT };
    },
    acquireSnapshot: async ({ cacheDir }) => {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(join(cacheDir, "bird_interact_data.jsonl"), options.publicText ?? publicJsonl(), "utf8");
      return {
        path: cacheDir,
        repository: HF_REPOSITORY,
        commit: HF_COMMIT,
        fileCount: 57,
        manifestSha256: options.snapshotManifestSha ?? SNAPSHOT_MANIFEST_SHA,
      };
    },
    createPlanner: options.planner ?? ((projectRoot) => ({
      projectPath: (dbName: string) => resolve(projectRoot, dbName),
      plan: async (_dbName: string, sql: string) => {
        plannedSql.push(sql);
        return "SELECT planned";
      },
    })),
    wrenVersion: options.wrenVersion ?? (async () => "0.8.1"),
    now: () => CREATED_AT,
  };

  return {
    dataRoot,
    gtSource,
    docker,
    deps,
    plannedSql,
    config: (overrides: PrepareOverrides = {}) => {
      const gtPath = "gtPath" in overrides ? overrides.gtPath : gtSource;
      const { officialCheckout, publicDataPath } = overrides;
      return {
        ...(gtPath === undefined ? {} : { gtPath }),
        ...(officialCheckout === undefined ? {} : { officialCheckout }),
        ...(publicDataPath === undefined ? {} : { publicDataPath }),
        postgresContainer: overrides.postgresContainer ?? DEFAULT_POSTGRES_CONTAINER,
        postgresPort: overrides.postgresPort ?? DEFAULT_POSTGRES_PORT,
        wrenBin: overrides.wrenBin ?? "wren",
      };
    },
  };
}

async function listing(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(relative: string): Promise<void> {
    const absolute = relative === "" ? root : join(root, relative);
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        entries.push(`dir ${child}`);
        await walk(child);
      } else if (entry.isSymbolicLink()) {
        entries.push(`link ${child} -> ${await readlink(join(root, child))}`);
      } else {
        entries.push(`file ${child} ${sha256(await readFile(join(root, child)))}`);
      }
    }
  }
  await walk("");
  return entries.sort();
}

async function seedRuntime(dataRoot: string): Promise<string[]> {
  const runtime = join(dataRoot, "runtime");
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, "sentinel"), "previous runtime\n", "utf8");
  return listing(runtime);
}

async function dataRootSiblings(dataRoot: string): Promise<string[]> {
  return (await readdir(dataRoot)).sort();
}

test("parses the exact preparation CLI contract with documented defaults", () => {
  const parsed = parsePrepareArgs([]);
  assert.equal(parsed.kind, "run");
  assert.deepEqual(parsed.kind === "run" ? parsed.config : null, {
    postgresContainer: DEFAULT_POSTGRES_CONTAINER,
    postgresPort: DEFAULT_POSTGRES_PORT,
    wrenBin: "wren",
  });
  assert.equal(DEFAULT_POSTGRES_CONTAINER, "warble_bird_interact_postgresql");
  assert.equal(DEFAULT_POSTGRES_PORT, 55_432);

  assert.equal(parsePrepareArgs(["--help"]).kind, "help");
  assert.equal(parsePrepareArgs(["--version"]).kind, "version");
});

test("resolves optional import sources and rejects malformed flags", async (t) => {
  const root = await makeTempRoot(t);
  const gt = join(root, "gt.jsonl");
  const publicData = join(root, "public.jsonl");
  const checkout = join(root, "checkout");
  await writeFile(gt, "{}\n", "utf8");
  await writeFile(publicData, "{}\n", "utf8");
  await mkdir(checkout);

  const parsed = parsePrepareArgs([
    "--gt", gt,
    "--official-checkout", checkout,
    "--public-data", publicData,
    "--postgres-container", "custom_pg",
    "--postgres-port", "6543",
    "--wren-bin", "/opt/wren/bin/wren",
  ]);
  assert.equal(parsed.kind, "run");
  assert.deepEqual(parsed.kind === "run" ? parsed.config : null, {
    gtPath: resolve(gt),
    officialCheckout: resolve(checkout),
    publicDataPath: resolve(publicData),
    postgresContainer: "custom_pg",
    postgresPort: 6543,
    wrenBin: "/opt/wren/bin/wren",
  });

  assert.throws(() => parsePrepareArgs(["--gt", join(root, "missing.jsonl")]), CliUsageError);
  assert.throws(() => parsePrepareArgs(["--official-checkout", gt]), CliUsageError);
  assert.throws(() => parsePrepareArgs(["--public-data", checkout]), CliUsageError);
  assert.throws(() => parsePrepareArgs(["--postgres-port", "0"]), CliUsageError);
  assert.throws(() => parsePrepareArgs(["--postgres-port", "70000"]), CliUsageError);
  assert.throws(() => parsePrepareArgs(["--postgres-container", ""]), CliUsageError);
  assert.throws(() => parsePrepareArgs(["--unknown"]), CliUsageError);
  assert.throws(() => parsePrepareArgs(["positional"]), CliUsageError);
});

test("prepares a complete runtime in the documented order and promotes it last", async (t) => {
  const harness = await makeHarness(t);
  const order: string[] = [];
  const deps: PrepareDependencies = {
    ...harness.deps,
    acquireCheckout: async (options) => {
      order.push("checkout");
      return harness.deps.acquireCheckout!(options);
    },
    acquireSnapshot: async (options) => {
      order.push("snapshot");
      return harness.deps.acquireSnapshot!(options);
    },
    createPlanner: (projectRoot) => ({
      projectPath: (dbName: string) => resolve(projectRoot, dbName),
      plan: async (dbName: string, sql: string) => {
        order.push("dry-plan");
        harness.plannedSql.push(sql);
        assert.equal(dbName, "alien");
        // The staged project, not the promoted runtime, must be planned.
        await lstat(join(projectRoot, "alien", "target", "mdl.json"));
        await assert.rejects(lstat(join(harness.dataRoot, "runtime")), /ENOENT/);
        return "SELECT planned";
      },
    }),
  };

  const result = await prepareBirdRuntime(harness.config(), deps);

  assert.deepEqual(order, ["checkout", "snapshot", "dry-plan"]);
  assert.deepEqual(harness.docker.calls, [
    `inspectContainer:${DEFAULT_POSTGRES_CONTAINER}`,
    `runContainer:${DEFAULT_POSTGRES_CONTAINER}`,
    `inspectContainer:${DEFAULT_POSTGRES_CONTAINER}`,
    `waitForPostgres:${DEFAULT_POSTGRES_CONTAINER}`,
    `inspectImage:${IMAGE_ID}`,
    // Provisioning asks whether the replay role is there and writes it, before the introspection
    // that reads the schema: both are database work, and neither may precede the provenance check.
    `runPsqlJson:${DEFAULT_POSTGRES_CONTAINER}:alien_template`,
    `runPsqlScript:${DEFAULT_POSTGRES_CONTAINER}:alien_template`,
    `runPsqlJson:${DEFAULT_POSTGRES_CONTAINER}:alien_template`,
  ]);
  assert.deepEqual(harness.docker.runSpecs, [{
    name: DEFAULT_POSTGRES_CONTAINER,
    image: POSTGRES_IMAGE,
    hostPort: DEFAULT_POSTGRES_PORT,
    containerPort: 5432,
    labels: { [WARBLE_EVAL_LABEL]: "bird-interact" },
    env: { POSTGRES_USER: "root", POSTGRES_PASSWORD: "123123", TZ: "Asia/Hong_Kong" },
    command: ["-c", "max_connections=300", "-c", "shared_buffers=256MB"],
  }]);
  assert.deepEqual(harness.plannedSql, ['SELECT * FROM "crew" LIMIT 1']);

  assert.equal(result.runtimeDir, join(harness.dataRoot, "runtime"));
  assert.deepEqual(await dataRootSiblings(harness.dataRoot), ["cache", "private", "runtime"]);

  const combined = await readFile(join(result.runtimeDir, "bird_interact_data_with_gt.jsonl"), "utf8");
  assert.equal(combined.split("\n").filter((line) => line !== "").length, 300);
  const smoke = await readFile(join(result.runtimeDir, SMOKE_FILENAME), "utf8");
  const smokeRows = smoke.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as JsonRecord);
  assert.deepEqual(smokeRows.map((row) => row.instance_id), [...SMOKE_TASK_IDS]);
  assert.deepEqual(smokeRows.map((row) => row.sol_sql), SMOKE_TASK_IDS.map((id) => [`SELECT ${id}`]));

  const mdl = JSON.parse(await readFile(join(result.runtimeDir, "identity-projects", "alien", "target", "mdl.json"), "utf8")) as JsonRecord;
  assert.deepEqual(mdl, {
    catalog: "wren",
    schema: "public",
    models: [
      { name: "crew", tableReference: { schema: "public", table: "crew" }, columns: [{ name: "id", type: "INTEGER" }] },
      {
        name: "weather",
        tableReference: { schema: "public", table: "weather" },
        columns: [{ name: "condition", type: "VARCHAR" }, { name: "recorded_on", type: "DATE" }],
      },
    ],
    relationships: [],
    views: [],
  });
});

test("copies and revalidates the private ground truth with owner-only permissions", async (t) => {
  const harness = await makeHarness(t);
  await prepareBirdRuntime(harness.config(), harness.deps);

  const privateGt = join(harness.dataRoot, "private", GT_FILENAME);
  assert.equal(await readFile(privateGt, "utf8"), groundTruthJsonl());
  assert.equal(((await lstat(privateGt)).mode & 0o777), 0o600);
  assert.equal(GT_FILENAME, "bird_interact_gt_kg_testcases_1008.jsonl");

  // A later run without --gt reuses and revalidates the private copy.
  const reused = await prepareBirdRuntime(harness.config({ gtPath: undefined }), harness.deps);
  assert.equal(reused.manifest.groundTruth.sha256, sha256(groundTruthJsonl()));

  // A corrupt private copy fails instead of being silently accepted.
  await writeFile(privateGt, "not json\n", { encoding: "utf8", mode: 0o600 });
  await assert.rejects(
    prepareBirdRuntime(harness.config({ gtPath: undefined }), harness.deps),
    /ground-truth/i,
  );
});

test("requires an importable ground truth when no private copy exists", async (t) => {
  const harness = await makeHarness(t);
  await assert.rejects(
    prepareBirdRuntime(harness.config({ gtPath: undefined }), harness.deps),
    /--gt/,
  );
  await assert.rejects(lstat(join(harness.dataRoot, "runtime")), /ENOENT/);
});

test("validates the source ground truth before writing anything private", async (t) => {
  const harness = await makeHarness(t);
  const broken = join(harness.dataRoot, "..", "broken-gt.jsonl");
  await writeFile(broken, jsonl(ids().map((id) => ({ instance_id: id }))), "utf8");

  await assert.rejects(prepareBirdRuntime(harness.config({ gtPath: broken }), harness.deps), /ground-truth/i);
  await assert.rejects(lstat(join(harness.dataRoot, "private", GT_FILENAME)), /ENOENT/);
  assert.deepEqual(harness.docker.calls, []);
});

test("records complete non-secret provenance and no absolute input paths", async (t) => {
  const harness = await makeHarness(t);
  const { manifest, runtimeDir } = await prepareBirdRuntime(harness.config(), harness.deps);

  const combined = await readFile(join(runtimeDir, "bird_interact_data_with_gt.jsonl"), "utf8");
  const smoke = await readFile(join(runtimeDir, SMOKE_FILENAME), "utf8");
  const mdl = await readFile(join(runtimeDir, "identity-projects", "alien", "target", "mdl.json"), "utf8");

  assert.deepEqual(manifest, {
    version: 1,
    createdAt: CREATED_AT,
    official: { repository: BIRD_REPOSITORY, commit: BIRD_COMMIT },
    publicSnapshot: {
      repository: HF_REPOSITORY,
      commit: HF_COMMIT,
      fileCount: 57,
      manifestSha256: SNAPSHOT_MANIFEST_SHA,
    },
    groundTruth: { file: `private/${GT_FILENAME}`, sha256: sha256(groundTruthJsonl()) },
    outputs: {
      combined: { file: "runtime/bird_interact_data_with_gt.jsonl", rows: 300, sha256: sha256(combined) },
      smoke: { file: `runtime/${SMOKE_FILENAME}`, rows: SMOKE_TASK_IDS.length, sha256: sha256(smoke) },
      mdl: { file: "runtime/identity-projects/alien/target/mdl.json", sha256: sha256(mdl) },
    },
    database: {
      name: "alien",
      template: "alien_template",
      container: DEFAULT_POSTGRES_CONTAINER,
      hostPort: DEFAULT_POSTGRES_PORT,
      imageReference: POSTGRES_IMAGE,
      imageId: IMAGE_ID,
      repoDigests: [REPO_DIGEST],
    },
    wren: { version: "0.8.1" },
    taskIds: [...SMOKE_TASK_IDS],
  });

  const onDisk = await readFile(join(runtimeDir, "manifest.json"), "utf8");
  assert.deepEqual(JSON.parse(onDisk), manifest);
  assert.ok(!onDisk.includes(harness.gtSource));
  assert.ok(!onDisk.includes(harness.dataRoot));
  assert.ok(!/123123/.test(onDisk));
});

test("creates and then revalidates the official ADK public-data symlink", async (t) => {
  const harness = await makeHarness(t);
  await prepareBirdRuntime(harness.config(), harness.deps);

  const link = join(harness.dataRoot, "cache", "BIRD-Interact", "BIRD-Interact-ADK", "bird-interact-lite");
  const publicCache = join(harness.dataRoot, "cache", "bird-interact-lite");
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.equal(resolve(join(link, ".."), await readlink(link)), publicCache);

  // Idempotent reuse keeps the same link.
  await prepareBirdRuntime(harness.config(), harness.deps);
  assert.ok((await lstat(link)).isSymbolicLink());

  // A link pointing somewhere else is rejected rather than repaired.
  const decoy = join(harness.dataRoot, "decoy");
  await mkdir(decoy, { recursive: true });
  await rm(link);
  await symlink(decoy, link);
  await assert.rejects(prepareBirdRuntime(harness.config(), harness.deps), /public-data/i);
  assert.equal(resolve(join(link, ".."), await readlink(link)), decoy);
});

test("rejects a non-symlink official ADK public-data entry", async (t) => {
  const harness = await makeHarness(t);
  await prepareBirdRuntime(harness.config(), harness.deps);

  const link = join(harness.dataRoot, "cache", "BIRD-Interact", "BIRD-Interact-ADK", "bird-interact-lite");
  await rm(link);
  await mkdir(link, { recursive: true });
  await assert.rejects(prepareBirdRuntime(harness.config(), harness.deps), /public-data/i);
  assert.ok((await lstat(link)).isDirectory());
});

test("reuses a healthy Warble-labeled container and starts a stopped one", async (t) => {
  const running = await makeHarness(t, { docker: fakeDocker({ existing: ownedContainer() }) });
  const runningResult = await prepareBirdRuntime(running.config(), running.deps);
  assert.deepEqual(running.docker.calls, [
    `inspectContainer:${DEFAULT_POSTGRES_CONTAINER}`,
    `waitForPostgres:${DEFAULT_POSTGRES_CONTAINER}`,
    `inspectImage:${IMAGE_ID}`,
    `runPsqlJson:${DEFAULT_POSTGRES_CONTAINER}:alien_template`,
    `runPsqlScript:${DEFAULT_POSTGRES_CONTAINER}:alien_template`,
    `runPsqlJson:${DEFAULT_POSTGRES_CONTAINER}:alien_template`,
  ]);
  assert.equal(runningResult.manifest.database.hostPort, DEFAULT_POSTGRES_PORT);

  const stopped = await makeHarness(t, {
    docker: fakeDocker({ existing: ownedContainer({ running: false, publishedPort: 6001 }) }),
  });
  const stoppedResult = await prepareBirdRuntime(stopped.config(), stopped.deps);
  assert.deepEqual(stopped.docker.calls, [
    `inspectContainer:${DEFAULT_POSTGRES_CONTAINER}`,
    `startContainer:${DEFAULT_POSTGRES_CONTAINER}`,
    `inspectContainer:${DEFAULT_POSTGRES_CONTAINER}`,
    `waitForPostgres:${DEFAULT_POSTGRES_CONTAINER}`,
    `inspectImage:${IMAGE_ID}`,
    `runPsqlJson:${DEFAULT_POSTGRES_CONTAINER}:alien_template`,
    `runPsqlScript:${DEFAULT_POSTGRES_CONTAINER}:alien_template`,
    `runPsqlJson:${DEFAULT_POSTGRES_CONTAINER}:alien_template`,
  ]);
  assert.equal(stoppedResult.manifest.database.hostPort, 6001);
});

test("refuses to adopt or replace an unrelated container", async (t) => {
  const foreignImage = await makeHarness(t, {
    docker: fakeDocker({ existing: ownedContainer({ imageReference: "postgres:16", imageId: "sha256:" + "9".repeat(64) }) }),
  });
  await assert.rejects(prepareBirdRuntime(foreignImage.config(), foreignImage.deps), /image/i);
  assert.ok(!foreignImage.docker.calls.some((call) => call.startsWith("runContainer")));

  const unlabeled = await makeHarness(t, {
    docker: fakeDocker({ existing: ownedContainer({ labels: {} }) }),
  });
  await assert.rejects(prepareBirdRuntime(unlabeled.config(), unlabeled.deps), /label/i);

  const unmapped = await makeHarness(t, {
    docker: fakeDocker({ existing: ownedContainer({ publishedPort: null }) }),
  });
  await assert.rejects(prepareBirdRuntime(unmapped.config(), unmapped.deps), /5432/);
});

test("accepts an explicitly named existing official container but never creates one", async (t) => {
  const custom = ownedContainer({ name: "team_bird_pg", labels: {}, publishedPort: 6544 });
  const existing = await makeHarness(t, { docker: fakeDocker({ existing: custom }) });
  const result = await prepareBirdRuntime(existing.config({ postgresContainer: "team_bird_pg" }), existing.deps);
  assert.equal(result.manifest.database.container, "team_bird_pg");
  assert.equal(result.manifest.database.hostPort, 6544);

  const absent = await makeHarness(t);
  await assert.rejects(
    prepareBirdRuntime(absent.config({ postgresContainer: "team_bird_pg" }), absent.deps),
    /does not exist/i,
  );
  assert.deepEqual(absent.docker.runSpecs, []);
});

test("pins container provenance against the previous runtime manifest", async (t) => {
  const harness = await makeHarness(t, { docker: fakeDocker({ existing: ownedContainer() }) });
  await prepareBirdRuntime(harness.config(), harness.deps);
  const before = await listing(join(harness.dataRoot, "runtime"));

  const drifted = await makeHarness(t, {
    docker: fakeDocker({ existing: ownedContainer(), imageId: "sha256:" + "a".repeat(64) }),
  });
  // Reuse the already-prepared runtime tree by pointing the drifted harness at it.
  const deps: PrepareDependencies = { ...drifted.deps, dataRoot: harness.dataRoot };
  await assert.rejects(prepareBirdRuntime(drifted.config(), deps), /image/i);
  assert.deepEqual(await listing(join(harness.dataRoot, "runtime")), before);
});

test("leaves an existing runtime byte-for-byte intact when any stage fails", async (t) => {
  const failures: ReadonlyArray<readonly [string, (t: TestContext) => Promise<Harness>, RegExp]> = [
    ["merge", async (context) => makeHarness(context, { publicText: jsonl(ids().slice(0, 299).map(publicRow)) }), /300/],
    ["docker", async (context) => makeHarness(context, { docker: fakeDocker({ failReady: true }) }), /ready/i],
    ["introspection", async (context) => makeHarness(context, { docker: fakeDocker({ failIntrospect: true }) }), /introspection/i],
    [
      "type mapping",
      async (context) => makeHarness(context, {
        docker: fakeDocker({
          introspectionJson: JSON.stringify([
            { table_name: "weather", column_name: "tags", ordinal_position: 1, data_type: "ARRAY" },
          ]),
        }),
      }),
      /Unsupported PostgreSQL type/,
    ],
    [
      "dry-plan",
      async (context) => makeHarness(context, {
        planner: (projectRoot) => ({
          projectPath: (dbName: string) => resolve(projectRoot, dbName),
          plan: async () => { throw new Error("wren dry-plan failed"); },
        }),
      }),
      /dry-plan/i,
    ],
    [
      "wren version",
      async (context) => makeHarness(context, { wrenVersion: async () => { throw new Error("wren is not installed"); } }),
      /wren/i,
    ],
  ];

  for (const [name, build, expected] of failures) {
    await t.test(name, async (subtest) => {
      const harness = await build(subtest);
      const before = await seedRuntime(harness.dataRoot);
      await assert.rejects(prepareBirdRuntime(harness.config(), harness.deps), expected);
      assert.deepEqual(await listing(join(harness.dataRoot, "runtime")), before);
      assert.deepEqual(
        (await dataRootSiblings(harness.dataRoot)).filter((entry) => entry.startsWith("runtime")),
        ["runtime"],
      );
    });
  }
});

test("rejects a symlinked runtime target instead of deleting outside the data root", async (t) => {
  const harness = await makeHarness(t);
  const outside = join(harness.dataRoot, "..", "outside-runtime");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "keep.txt"), "keep\n", "utf8");
  await mkdir(harness.dataRoot, { recursive: true });
  await symlink(outside, join(harness.dataRoot, "runtime"));

  await assert.rejects(prepareBirdRuntime(harness.config(), harness.deps), /runtime/i);
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep\n");
});

test("replaces a previous runtime atomically on a successful rerun", async (t) => {
  const harness = await makeHarness(t);
  const before = await seedRuntime(harness.dataRoot);
  const result = await prepareBirdRuntime(harness.config(), harness.deps);

  const after = await listing(result.runtimeDir);
  assert.notDeepEqual(after, before);
  await assert.rejects(lstat(join(result.runtimeDir, "sentinel")), /ENOENT/);
  assert.deepEqual(
    (await dataRootSiblings(harness.dataRoot)).filter((entry) => entry.startsWith("runtime")),
    ["runtime"],
  );
});

test("forwards import sources to the pinned acquisition helpers exactly once", async (t) => {
  const harness = await makeHarness(t);
  const checkoutOptions: Array<Record<string, unknown>> = [];
  const snapshotOptions: Array<Record<string, unknown>> = [];
  const deps: PrepareDependencies = {
    ...harness.deps,
    acquireCheckout: async (options) => {
      checkoutOptions.push({ ...options });
      return harness.deps.acquireCheckout!(options);
    },
    acquireSnapshot: async (options) => {
      snapshotOptions.push({ ...options });
      return harness.deps.acquireSnapshot!(options);
    },
  };

  await prepareBirdRuntime(
    harness.config({ officialCheckout: "/seed/BIRD-Interact", publicDataPath: "/seed/public.jsonl" }),
    deps,
  );

  assert.deepEqual(checkoutOptions, [{
    cacheDir: join(harness.dataRoot, "cache", "BIRD-Interact"),
    seedDir: "/seed/BIRD-Interact",
  }]);
  assert.deepEqual(snapshotOptions, [{
    cacheDir: join(harness.dataRoot, "cache", "bird-interact-lite"),
    publicDataPath: "/seed/public.jsonl",
  }]);
});

test("introspects the official template database, never the task database name", async (t) => {
  const harness = await makeHarness(t);
  const { manifest } = await prepareBirdRuntime(harness.config(), harness.deps);

  // The official DB environment runs `createdb <task_db> --template <base_db>_template`, so the
  // physical schema only ever exists in the template.
  assert.equal(templateDatabase("alien"), "alien_template");
  assert.equal(manifest.database.name, "alien");
  assert.equal(manifest.database.template, "alien_template");
  assert.ok(harness.docker.calls.includes(`runPsqlJson:${DEFAULT_POSTGRES_CONTAINER}:alien_template`));
  assert.ok(!harness.docker.calls.includes(`runPsqlJson:${DEFAULT_POSTGRES_CONTAINER}:alien`));
});

test("a stopped container inspects with no published port, so the restart path must re-read it", async () => {
  // Verbatim shape from `docker container inspect --format '{{json .}}'` against one container that
  // was created with `-p 57731:5432` and then stopped: NetworkSettings.Ports empties on stop while
  // HostConfig.PortBindings keeps the binding, so an Exited container always inspects as unpublished.
  const stopped = {
    Image: IMAGE_ID,
    State: { Running: false, Status: "exited" },
    Config: { Image: POSTGRES_IMAGE, Labels: { [WARBLE_EVAL_LABEL]: "bird-interact" } },
    NetworkSettings: { Ports: {} },
    HostConfig: { PortBindings: { "5432/tcp": [{ HostIp: "", HostPort: "57731" }] } },
  };
  const running = {
    ...stopped,
    State: { Running: true, Status: "running" },
    NetworkSettings: {
      Ports: {
        "5432/tcp": [
          { HostIp: "0.0.0.0", HostPort: "57731" },
          { HostIp: "::", HostPort: "57731" },
        ],
      },
    },
  };

  let started = false;
  const client = createDockerClient({
    runner: async (args) => {
      if (args[0] === "start") {
        started = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: JSON.stringify(started ? running : stopped), stderr: "", code: 0 };
    },
  });

  assert.deepEqual(await client.inspectContainer("warble_bird_interact_postgresql"), {
    name: "warble_bird_interact_postgresql",
    running: false,
    imageId: IMAGE_ID,
    imageReference: POSTGRES_IMAGE,
    labels: { [WARBLE_EVAL_LABEL]: "bird-interact" },
    hostPort: null,
  });

  await client.startContainer("warble_bird_interact_postgresql");
  const afterStart = await client.inspectContainer("warble_bird_interact_postgresql");
  assert.equal(afterStart?.running, true);
  assert.equal(afterStart?.hostPort, 57_731);
});

/**
 * What this closes: a container that dies the moment docker accepts it was reported as one that
 * "does not publish 5432/tcp to a host port" — a loud failure naming a cause that is not the cause.
 * Measured, `docker start` and `docker run -d` both exit 0 for such a container, and the inspection
 * a moment later reads `Running:false, Status:exited, ExitCode:3, NetworkSettings.Ports:{}` while
 * `HostConfig.PortBindings` still carries `5432/tcp -> 55993`. The mapping was never the problem,
 * so a reader sent to look at port mappings is sent away from the logs that say what happened.
 */
test("a container that starts and instantly dies is diagnosed as exited, not as unpublished", async (t) => {
  for (const [label, docker] of [
    ["restarted", fakeDocker({ existing: ownedContainer({ running: false }), exitsImmediately: true })],
    ["created", fakeDocker({ exitsImmediately: true })],
  ] as const) {
    const harness = await makeHarness(t, { docker });
    await assert.rejects(
      prepareBirdRuntime(harness.config(), harness.deps),
      (error: unknown) => {
        assert.ok(error instanceof PrepareError, label);
        assert.match(error.message, /exited/i, `${label}: must name that the container exited`);
        assert.match(error.message, /docker logs warble_bird_interact_postgresql/, `${label}: must say where to look`);
        // The port mapping is intact on such a container, so blaming it is the wrong diagnosis.
        assert.doesNotMatch(error.message, /5432|publish/i, `${label}: must not blame the port mapping`);
        return true;
      },
    );
    // Nothing may be provisioned into a cluster that is not running.
    assert.ok(!docker.calls.some((call) => call.startsWith("runPsqlScript")), `${label}: provisioned a dead container`);
    assert.ok(!docker.calls.some((call) => call.startsWith("waitForPostgres")), `${label}: waited on a dead container`);
  }
});

test("readiness probes TCP so an initializing image is never mistaken for ready", async () => {
  const calls: string[][] = [];
  let attempts = 0;
  const notices: number[] = [];
  const client = createDockerClient({
    runner: async (args) => {
      calls.push([...args]);
      attempts += 1;
      // The official entrypoint answers on the local socket while it is still importing dumps.
      return attempts < 3
        ? { stdout: "", stderr: "no response", code: 2 }
        : { stdout: "accepting connections", stderr: "", code: 0 };
    },
    sleep: async () => {},
    onWaiting: (elapsed) => notices.push(elapsed),
  });

  await client.waitForPostgres("warble_bird_interact_postgresql");
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.deepEqual(call, [
      "exec", "warble_bird_interact_postgresql",
      "pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "root",
    ]);
  }

  const deadlined = createDockerClient({
    runner: async () => ({ stdout: "", stderr: "no response", code: 2 }),
    readyTimeoutMs: 0,
    sleep: async () => {},
    onWaiting: () => {},
  });
  await assert.rejects(deadlined.waitForPostgres("x"), /never became ready/);
});

test("a stalled readiness probe is another poll, while docker refusing to run one aborts the wait", async () => {
  // The 30-minute wait exists because the official image spends many minutes restoring 18 databases,
  // and that restore I/O is exactly what makes `docker exec pg_isready` overrun its own 10s timeout.
  // Aborting on the stall would surrender the wait to the one condition it was written for.
  let attempts = 0;
  const stalling = createDockerClient({
    runner: async () => {
      attempts += 1;
      if (attempts < 3) throw new DockerTimeoutError(10_000);
      return { stdout: "accepting connections", stderr: "", code: 0 };
    },
    sleep: async () => {},
    onWaiting: () => {},
  });
  await stalling.waitForPostgres("warble_bird_interact_postgresql");
  assert.equal(attempts, 3);

  // Retrying a stall must not turn every docker failure into a retry. Only ONE of the failures that
  // can never become ready reaches this as a thrown error: a missing `docker` binary, which
  // `execFile` reports as `code: "ENOENT"` - a string, so `runDocker` cannot return it as an exit
  // code and raises instead (measured).
  let brokenAttempts = 0;
  const broken = createDockerClient({
    runner: async () => {
      brokenAttempts += 1;
      throw new PrepareError("Docker command could not be executed");
    },
    sleep: async () => {},
    onWaiting: () => {},
  });
  await assert.rejects(broken.waitForPostgres("x"), /could not be executed/);
  assert.equal(brokenAttempts, 1);

  // The other three arrive as an ordinary NUMERIC exit code, which is why a test that only ever
  // injected a thrower proved nothing about them. Verbatim stderr from docker 29.4.0, each measured
  // by running the probe against that condition; all three exit 1, exactly as `pg_isready` does
  // when the server is merely rejecting connections, so the exit code cannot tell them apart.
  const fatal = [
    ["container removed", "Error response from daemon: No such container: warble_bird_interact_postgresql"],
    ["container stopped", "Error response from daemon: container 34200a6385625ef629403f2cefef53cafa15b83707fa71118ed8863b3954c170 is not running"],
    ["daemon socket gone", "failed to connect to the docker API at unix:///tmp/no-such.sock; check if the path is correct and if the daemon is running: dial unix /tmp/no-such.sock: connect: no such file or directory"],
    ["daemon unreachable", "Cannot connect to the Docker daemon at tcp://127.0.0.1:1. Is the docker daemon running?"],
  ] as const;
  for (const [label, stderr] of fatal) {
    let attempts = 0;
    const client = createDockerClient({
      runner: async () => {
        attempts += 1;
        // Ready on the fourth probe, so a loop that polls this resolves instead of hanging the test:
        // the failure then reads as "it kept polling", which is the behaviour under test.
        return attempts > 3 ? { stdout: "accepting connections", stderr: "", code: 0 } : { stdout: "", stderr, code: 1 };
      },
      sleep: async () => {},
      onWaiting: () => {},
    });
    await assert.rejects(client.waitForPostgres("warble_bird_interact_postgresql"), (error: unknown) => {
      assert.ok(error instanceof PrepareError, label);
      assert.match(error.message, /warble_bird_interact_postgresql/, `${label}: must name the container`);
      assert.match(error.message, /docker logs|docker ps/, `${label}: must say where to look`);
      assert.ok(error.message.includes(stderr), `${label}: must quote what docker actually said`);
      return true;
    });
    assert.equal(attempts, 1, `${label}: asking again cannot change the answer`);
  }

  // The other side of that discriminator, and the one that must never regress: `pg_isready` reports
  // a server that is up but still rejecting connections with exit 1 too - and writes it to STDOUT,
  // leaving stderr empty (measured, even for arguments it rejects outright). That is the ordinary
  // shape of the first-boot restore this whole wait exists for, so it must keep polling.
  let rejectingAttempts = 0;
  const rejecting = createDockerClient({
    runner: async () => {
      rejectingAttempts += 1;
      return rejectingAttempts < 3
        ? { stdout: "127.0.0.1:5432 - rejecting connections", stderr: "", code: 1 }
        : { stdout: "127.0.0.1:5432 - accepting connections", stderr: "", code: 0 };
    },
    sleep: async () => {},
    onWaiting: () => {},
  });
  await rejecting.waitForPostgres("warble_bird_interact_postgresql");
  assert.equal(rejectingAttempts, 3);

  // A probe that only ever stalls is still bounded by the overall readiness deadline.
  const stuck = createDockerClient({
    runner: async () => {
      throw new DockerTimeoutError(10_000);
    },
    readyTimeoutMs: 0,
    sleep: async () => {},
    onWaiting: () => {},
  });
  await assert.rejects(stuck.waitForPostgres("x"), /never became ready/);
});

test("the production docker adapter issues the documented psql introspection", async () => {
  const calls: string[][] = [];
  const client = createDockerClient({
    runner: async (args) => {
      calls.push([...args]);
      return { stdout: "[]", stderr: "", code: 0 };
    },
  });
  await client.runPsqlJson("container", "alien_template", "SELECT 1");
  assert.deepEqual(calls[0], [
    "exec", "container",
    "psql", "-X", "-A", "-t",
    "-v", "ON_ERROR_STOP=1",
    "-U", "root",
    "-d", "alien_template",
    "-c", "SELECT 1",
  ]);
});

/* -------------------------------------------------------------------------- */
/* The replay role: a privilege, not a setting                                */
/* -------------------------------------------------------------------------- */

/**
 * What this closes: the autopsy replayed as `root`, the image's SUPERUSER. Its read-only guarantee
 * was `default_transaction_read_only`, which every role may turn off for itself — measured, a
 * recorded statement that runs `SET default_transaction_read_only = off` outside a transaction and
 * then creates a table leaves it committed on the template database every later replay reads. A
 * setting a session can change is not a guarantee; a privilege the role does not hold is, so
 * preparation provisions the role the autopsy connects as.
 */
test("preparation provisions a read-only replay role that cannot create anything", async (t) => {
  const harness = await makeHarness(t);
  await prepareBirdRuntime(harness.config(), harness.deps);

  const cluster = harness.docker.cluster();
  const role = cluster?.roles[READ_ONLY_ROLE];
  assert.ok(role !== undefined, `preparation must provision ${READ_ONLY_ROLE}`);
  assert.equal(role.login, true, "the autopsy connects as it, so it must be able to log in");
  assert.equal(role.password, READ_ONLY_PASSWORD, "the autopsy authenticates with the same password");
  // Read everything, own nothing: `pg_read_all_data` is SELECT on every table and USAGE on every
  // schema, in one grant that no later table can fall outside of, and it carries no write of any kind.
  assert.deepEqual(role.memberOf, ["pg_read_all_data"]);
  // Defence in depth, now on the SERVER: a connection that arrives without PGOPTIONS is still
  // read-only by default. It is not the guarantee — the missing privileges are.
  assert.equal(role.settings.default_transaction_read_only, "on");
  // PostgreSQL 14 hands PUBLIC the CREATE grant on schema `public`, so a role with no privileges of
  // its own could still create a table there. This is the revoke that makes "cannot create" true.
  assert.equal(cluster?.publicSchemaCreate.has("alien_template"), false);
  // Large objects are the one thing left that "cannot create" would otherwise be false about:
  // `pg_read_all_data` does not gate them, `default_transaction_read_only` does not gate them —
  // PostgreSQL refuses no large-object CREATION in a read-only transaction — and PUBLIC holds
  // EXECUTE on the creators. Measured on the pinned image, the replay role could mint new large
  // objects that survived the run, which is what made the page's `caveat: null` false.
  assert.deepEqual([...(cluster?.publicLargeObjectCreate.get("alien_template") ?? [])], []);
  // Only the template is provisioned, so nothing here may claim a database it never named.
  assert.deepEqual([...(cluster?.publicLargeObjectCreate.get("postgres") ?? [])], LARGE_OBJECT_CREATORS);
  assert.ok(harness.docker.calls.includes(`runPsqlScript:${DEFAULT_POSTGRES_CONTAINER}:alien_template`));
});

/**
 * Preparation is re-run on every tree, and `CREATE ROLE` on an existing role is an ERROR — the fake
 * cluster raises it exactly as psql would. So the second run must ask first and create nothing,
 * while still re-asserting the attributes, which is what puts a tampered role back.
 */
test("provisioning the replay role again is not an error", async (t) => {
  const docker = fakeDocker({ existing: ownedContainer() });
  const first = await makeHarness(t, { docker });
  await prepareBirdRuntime(first.config(), first.deps);
  const second = await makeHarness(t, { docker });
  await prepareBirdRuntime(second.config(), second.deps);

  const cluster = docker.cluster();
  assert.equal(Object.keys(cluster?.roles ?? {}).length, 2, "one superuser and one replay role");
  assert.equal(cluster?.roles[READ_ONLY_ROLE]?.password, READ_ONLY_PASSWORD);
  assert.deepEqual(cluster?.roles[READ_ONLY_ROLE]?.memberOf, ["pg_read_all_data", "pg_read_all_data"]);
});

test("the production docker adapter runs provisioning as one all-or-nothing script", async () => {
  const calls: string[][] = [];
  const client = createDockerClient({
    runner: async (args) => {
      calls.push([...args]);
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  await client.runPsqlScript("container", "alien_template", "CREATE ROLE x");
  assert.deepEqual(calls[0], [
    "exec", "container",
    "psql", "-X", "-A", "-t", "-q",
    "-v", "ON_ERROR_STOP=1",
    "--single-transaction",
    "-U", "root",
    "-d", "alien_template",
    "-c", "CREATE ROLE x",
  ]);
});
