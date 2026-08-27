import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ProcessWrenPlanner,
  WrenPlanningError,
  isQueryLikeStatement,
} from "../src/wren-planner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_WREN = resolve(HERE, "fixtures/fake-wren.mjs");
chmodSync(FAKE_WREN, 0o755);

test("classifies only the pinned BIRD query prefixes after stripping comments", () => {
  const queryLike = [
    "SELECT 1",
    "  with x as (select 1) select * from x",
    "\nEXPLAIN SELECT 1",
    "-- purpose\nSELECT * FROM t",
    "/* purpose */ WITH x AS (SELECT 1) SELECT * FROM x",
    "/* multi\nline */ -- line\n explain select 1",
  ];
  const notQueryLike = [
    "",
    "INSERT INTO t VALUES (1)",
    "UPDATE t SET a = 1",
    "DELETE FROM t",
    "CREATE TABLE t(a int)",
    "ALTER TABLE t ADD b int",
  ];
  for (const sql of queryLike) assert.equal(isQueryLikeStatement(sql), true, sql);
  for (const sql of notQueryLike) assert.equal(isQueryLikeStatement(sql), false, sql);
});

test("runs wren dry-plan without a shell in the task project", async () => {
  const root = await mkdtemp(join(tmpdir(), "bird-wren-"));
  const project = join(root, "alien");
  mkdirSync(join(project, "target"), { recursive: true });
  writeFileSync(join(project, "target", "mdl.json"), "{}", "utf8");
  const record = join(root, "record.json");
  const planner = new ProcessWrenPlanner({
    projectRoot: root,
    wrenBin: FAKE_WREN,
    env: {
      ...process.env,
      FAKE_WREN_RECORD: record,
      FAKE_WREN_STDOUT: "SELECT native_sql\n",
    },
  });

  assert.equal(await planner.plan("alien", "SELECT semantic_sql"), "SELECT native_sql");
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), {
    argv: [
      "dry-plan",
      "--sql",
      "SELECT semantic_sql",
      "--datasource",
      "postgres",
      "--mdl",
      join(project, "target", "mdl.json"),
    ],
    cwd: realpathSync(project),
  });
  assert.equal(planner.projectPath("alien"), project);
});

test("rejects a database name that escapes the configured project root", async () => {
  const root = await mkdtemp(join(tmpdir(), "bird-wren-"));
  const planner = new ProcessWrenPlanner({ projectRoot: root, wrenBin: FAKE_WREN });
  assert.throws(() => planner.projectPath("../secret"), /outside configured root/);
});

test("reports stderr on failure without leaking unrelated environment values", async () => {
  const root = await mkdtemp(join(tmpdir(), "bird-wren-"));
  const project = join(root, "alien");
  mkdirSync(join(project, "target"), { recursive: true });
  writeFileSync(join(project, "target", "mdl.json"), "{}", "utf8");
  const planner = new ProcessWrenPlanner({
    projectRoot: root,
    wrenBin: FAKE_WREN,
    env: {
      ...process.env,
      FAKE_WREN_EXIT: "2",
      FAKE_WREN_STDERR: "invalid semantic SQL",
      TOP_SECRET_TOKEN: "must-not-leak",
    },
  });

  await assert.rejects(
    planner.plan("alien", "SELECT broken"),
    (error: unknown) => {
      assert.ok(error instanceof WrenPlanningError);
      assert.match(error.message, /invalid semantic SQL/);
      assert.doesNotMatch(error.message, /must-not-leak/);
      return true;
    },
  );
});

test("fails when wren returns empty planned SQL", async () => {
  const root = await mkdtemp(join(tmpdir(), "bird-wren-"));
  const project = join(root, "alien");
  mkdirSync(join(project, "target"), { recursive: true });
  writeFileSync(join(project, "target", "mdl.json"), "{}", "utf8");
  const planner = new ProcessWrenPlanner({
    projectRoot: root,
    wrenBin: FAKE_WREN,
    env: { ...process.env, FAKE_WREN_STDOUT: "  " },
  });
  await assert.rejects(planner.plan("alien", "SELECT 1"), /empty SQL/);
});

test("kills a stuck wren dry-plan at the configured planning deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "bird-wren-"));
  const project = join(root, "alien");
  mkdirSync(join(project, "target"), { recursive: true });
  writeFileSync(join(project, "target", "mdl.json"), "{}", "utf8");
  const planner = new ProcessWrenPlanner({
    projectRoot: root,
    wrenBin: FAKE_WREN,
    planningTimeoutMs: 20,
    env: { ...process.env, FAKE_WREN_DELAY_MS: "10000" },
  });
  const startedAt = Date.now();

  await assert.rejects(
    planner.plan("alien", "SELECT 1"),
    /Wren dry-plan timed out after 20ms/,
  );
  assert.ok(Date.now() - startedAt < 2_000, "stuck planner must be killed promptly");
});
