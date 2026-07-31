import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test } from "node:test";

import { FAKE_MCP } from "./helpers.js";

test("disposable fake MCP implements initialize, list, and one non-secret call", async () => {
  const child = spawn(process.execPath, [FAKE_MCP], { stdio: ["pipe", "pipe", "pipe"] });
  assert.ok(child.stdin);
  assert.ok(child.stdout);
  const lines = createInterface({ input: child.stdout });
  const responses = new Map<number, (value: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const id = message["id"];
    if (typeof id === "number") responses.get(id)?.(message);
  });
  let id = 0;
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      id += 1;
      responses.set(id, resolve);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  try {
    const initialized = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "warble-test", version: "0.1.0" },
    });
    assert.equal(
      (initialized["result"] as { serverInfo: { name: string } }).serverInfo.name,
      "warble-fake-setup",
    );

    const listed = await request("tools/list");
    const tools = (listed["result"] as { tools: Array<{ name: string }> }).tools;
    assert.deepEqual(tools.map((tool) => tool.name), ["probe_setup", "not_allowlisted"]);

    const called = await request("tools/call", {
      name: "probe_setup",
      arguments: { component: "connect_source" },
    });
    const content = (called["result"] as { content: Array<{ text: string }> }).content;
    const payload = JSON.parse(content[0]!.text) as Record<string, unknown>;
    assert.equal(payload["non_secret"], true);
    assert.doesNotMatch(JSON.stringify(payload), /password|token|secret\s*[:=]/i);
  } finally {
    lines.close();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }
});
