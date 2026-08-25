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
  GT_FILENAME,
  POSTGRES_IMAGE,
  PrepareError,
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
  return [...SMOKE_TASK_IDS, ...Array.from({ length: 297 }, (_, index) => `task_${index + 1}`)];
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
  existing?: ContainerInspection | null;
  introspectionJson?: string;
  failIntrospect?: boolean;
  failReady?: boolean;
  imageId?: string;
  repoDigests?: readonly string[];
}

interface FakeDocker extends DockerClient {
  readonly calls: string[];
  readonly runSpecs: ContainerRunSpec[];
}

function fakeDocker(options: FakeDockerOptions = {}): FakeDocker {
  const calls: string[] = [];
  const runSpecs: ContainerRunSpec[] = [];
  let container: ContainerInspection | null = options.existing ?? null;
  return {
    calls,
    runSpecs,
    async inspectContainer(name: string): Promise<ContainerInspection | null> {
      calls.push(`inspectContainer:${name}`);
      return container;
    },
    async runContainer(spec: ContainerRunSpec): Promise<void> {
      calls.push(`runContainer:${spec.name}`);
      runSpecs.push(spec);
      container = {
        name: spec.name,
        running: true,
        imageId: options.imageId ?? IMAGE_ID,
        imageReference: spec.image,
        labels: { ...spec.labels },
        hostPort: spec.hostPort,
      };
    },
    async startContainer(name: string): Promise<void> {
      calls.push(`startContainer:${name}`);
      if (container !== null) container = { ...container, running: true };
    },
    async inspectImage(reference: string): Promise<ImageInspection> {
      calls.push(`inspectImage:${reference}`);
      return { id: options.imageId ?? IMAGE_ID, repoDigests: options.repoDigests ?? [REPO_DIGEST] };
    },
    async waitForPostgres(name: string): Promise<void> {
      calls.push(`waitForPostgres:${name}`);
      if (options.failReady === true) throw new PrepareError("PostgreSQL never became ready");
    },
    async runPsqlJson(name: string, database: string): Promise<string> {
      calls.push(`runPsqlJson:${name}:${database}`);
      if (options.failIntrospect === true) throw new PrepareError("introspection failed");
      return options.introspectionJson ?? introspection();
    },
  };
}

function ownedContainer(overrides: Partial<ContainerInspection> = {}): ContainerInspection {
  return {
    name: DEFAULT_POSTGRES_CONTAINER,
    running: true,
    imageId: IMAGE_ID,
    imageReference: POSTGRES_IMAGE,
    labels: { [WARBLE_EVAL_LABEL]: "bird-interact" },
    hostPort: DEFAULT_POSTGRES_PORT,
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
  const smoke = await readFile(join(result.runtimeDir, "smoke-alien-3.jsonl"), "utf8");
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
  const smoke = await readFile(join(runtimeDir, "smoke-alien-3.jsonl"), "utf8");
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
      smoke: { file: "runtime/smoke-alien-3.jsonl", rows: 3, sha256: sha256(smoke) },
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
  ]);
  assert.equal(runningResult.manifest.database.hostPort, DEFAULT_POSTGRES_PORT);

  const stopped = await makeHarness(t, {
    docker: fakeDocker({ existing: ownedContainer({ running: false, hostPort: 6001 }) }),
  });
  const stoppedResult = await prepareBirdRuntime(stopped.config(), stopped.deps);
  assert.deepEqual(stopped.docker.calls, [
    `inspectContainer:${DEFAULT_POSTGRES_CONTAINER}`,
    `startContainer:${DEFAULT_POSTGRES_CONTAINER}`,
    `waitForPostgres:${DEFAULT_POSTGRES_CONTAINER}`,
    `inspectImage:${IMAGE_ID}`,
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
    docker: fakeDocker({ existing: ownedContainer({ hostPort: null }) }),
  });
  await assert.rejects(prepareBirdRuntime(unmapped.config(), unmapped.deps), /5432/);
});

test("accepts an explicitly named existing official container but never creates one", async (t) => {
  const custom = ownedContainer({ name: "team_bird_pg", labels: {}, hostPort: 6544 });
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
