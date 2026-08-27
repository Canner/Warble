import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";

import {
  BirdClientError,
  FetchBirdClient,
  birdRequestTimeoutMs,
} from "../src/bird-client.js";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("calls every pinned DB and user endpoint with its exact payload", async () => {
  const seen: Array<{ path: string; body: unknown }> = [];
  await withServer(async (req, res) => {
    const path = req.url ?? "";
    seen.push({ path, body: await readJson(req) });
    const responses: Record<string, unknown> = {
      "/execute": { success: true, result: "rows", error: null },
      "/schema": { schema: "CREATE TABLE t" },
      "/all_column_meanings": { column_meanings: "{\"t.a\":\"A\"}" },
      "/column_meaning": { meaning: "A" },
      "/knowledge_names": { names: ["metric_a"] },
      "/knowledge": { knowledge: "definition" },
      "/submit": {
        passed: true,
        message: "ok",
        reward: 0.7,
        phase_completed: 1,
        has_follow_up: true,
        follow_up_query: "next",
      },
      "/ask": { answer: "clarified" },
      "/phase_transition": { status: "ok" },
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(responses[path]));
  }, async (url) => {
    const client = new FetchBirdClient({
      dbEnvironmentUrl: url,
      userSimulatorUrl: url,
    });
    assert.equal((await client.execute("alien_1", "SELECT 1")).result, "rows");
    assert.equal(await client.getSchema("alien_1"), "CREATE TABLE t");
    assert.equal(await client.getAllColumnMeanings("alien_1"), '{"t.a":"A"}');
    assert.equal(await client.getColumnMeaning("alien_1", "t", "a"), "A");
    assert.deepEqual(await client.getAllKnowledgeNames("alien_1"), ["metric_a"]);
    assert.equal(await client.getKnowledge("alien_1", "metric_a"), "definition");
    assert.equal(await client.getKnowledge("alien_1"), "definition");
    assert.equal(await client.askUser("alien_1", "which one?"), "clarified");
    await client.phaseTransition("alien_1");
    assert.equal((await client.submit("alien_1", "SELECT 1")).passed, true);
  });

  assert.deepEqual(seen, [
    { path: "/execute", body: { task_id: "alien_1", sql: "SELECT 1" } },
    { path: "/schema", body: { task_id: "alien_1" } },
    { path: "/all_column_meanings", body: { task_id: "alien_1" } },
    {
      path: "/column_meaning",
      body: { task_id: "alien_1", table_name: "t", column_name: "a" },
    },
    { path: "/knowledge_names", body: { task_id: "alien_1" } },
    { path: "/knowledge", body: { task_id: "alien_1", knowledge_name: "metric_a" } },
    { path: "/knowledge", body: { task_id: "alien_1" } },
    { path: "/ask", body: { task_id: "alien_1", question: "which one?" } },
    { path: "/phase_transition", body: { task_id: "alien_1" } },
    { path: "/submit", body: { task_id: "alien_1", sql: "SELECT 1" } },
  ]);
});

test("uses the pinned official per-operation timeout classes", () => {
  assert.equal(birdRequestTimeoutMs("execute"), 120_000);
  assert.equal(birdRequestTimeoutMs("submit"), 120_000);
  assert.equal(birdRequestTimeoutMs("phase_transition"), 120_000);
  assert.equal(birdRequestTimeoutMs("ask"), 60_000);
  assert.equal(birdRequestTimeoutMs("schema"), 30_000);
  assert.equal(birdRequestTimeoutMs("knowledge"), 30_000);
  assert.equal(birdRequestTimeoutMs("execute", 5_000), 5_000);
});

test("turns non-2xx and malformed JSON into bounded BirdClientError messages", async () => {
  await withServer((_req, res) => {
    res.writeHead(503, { "content-type": "text/plain" });
    res.end(`API_KEY=upstream-body-secret ${"x".repeat(5000)}`);
  }, async (url) => {
    const client = new FetchBirdClient({ dbEnvironmentUrl: url, userSimulatorUrl: url });
    await assert.rejects(client.getSchema("alien_1"), (error: unknown) => {
      assert.ok(error instanceof BirdClientError);
      assert.match(error.message, /503/);
      assert.ok(error.message.length < 700);
      assert.doesNotMatch(error.message, /upstream-body-secret|API_KEY/);
      return true;
    });
  });

  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("not-json");
  }, async (url) => {
    const client = new FetchBirdClient({ dbEnvironmentUrl: url, userSimulatorUrl: url });
    await assert.rejects(client.getSchema("alien_1"), /invalid JSON/);
  });
});

test("times out stalled upstream requests", async () => {
  await withServer(() => undefined, async (url) => {
    const client = new FetchBirdClient({
      dbEnvironmentUrl: url,
      userSimulatorUrl: url,
      timeoutMs: 20,
    });
    await assert.rejects(client.getSchema("alien_1"), /timed out/);
  });
});

test("rejects malformed successful response shapes", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ schema: 42 }));
  }, async (url) => {
    const client = new FetchBirdClient({ dbEnvironmentUrl: url, userSimulatorUrl: url });
    await assert.rejects(client.getSchema("alien_1"), /invalid response/);
  });
});
