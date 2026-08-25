import assert from "node:assert/strict";
import test from "node:test";

import { CliUsageError } from "../src/cli-usage.js";
import { parseAutopsyArgs, runAutopsy } from "../src/autopsy-cli.js";

test("exactly one run is required", () => {
  const parsed = parseAutopsyArgs(["alien-5"]);
  assert.equal(parsed.kind, "run");
  if (parsed.kind !== "run") return;
  assert.equal(parsed.config.run, "alien-5");
  assert.throws(() => parseAutopsyArgs([]), CliUsageError);
  assert.throws(() => parseAutopsyArgs(["a", "b"]), CliUsageError);
});

test("an unreachable database fails loudly, naming container and port", async () => {
  await assert.rejects(
    runAutopsy({
      run: "alien-5",
      container: "warble_bird_interact_postgresql",
      port: 55432,
      tasks: [],
      probe: async () => false,
      query: async () => {
        throw new Error("unreachable");
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("warble_bird_interact_postgresql") &&
      error.message.includes("55432"),
  );
});

test("a reachable database degrades per task, never per section", async () => {
  const result = await runAutopsy({
    run: "alien-5",
    container: "c",
    port: 55432,
    tasks: [
      { taskId: "ok", goldSql: "SELECT 1", agentSql: "SELECT 1", ambiguous: "a", clear: "b", category: "Query" },
      { taskId: "bad", goldSql: "SELECT 1", agentSql: "BOOM", ambiguous: "a", clear: "b", category: "Query" },
    ],
    probe: async () => true,
    query: async (sql: string) => {
      if (sql.includes("BOOM")) throw new Error('syntax error at or near "BOOM"');
      return [[1]];
    },
  });
  assert.equal(result.tolerant.ok, true);
  assert.equal(result.tasks.find((t) => t.taskId === "bad")?.unmeasured, 'syntax error at or near "BOOM"');
  assert.equal(result.tolerant.bad, undefined);
});

test("a Management task is skipped for the gap, with a stated reason", async () => {
  const result = await runAutopsy({
    run: "alien-5",
    container: "c",
    port: 55432,
    tasks: [
      {
        taskId: "m",
        goldSql: "UPDATE t SET x = 1",
        agentSql: "UPDATE t SET x = 1",
        ambiguous: "a",
        clear: "b",
        category: "Management",
      },
    ],
    probe: async () => true,
    query: async () => [[1]],
  });
  assert.match(result.tasks[0]?.unmeasured ?? "", /management/i);
});
