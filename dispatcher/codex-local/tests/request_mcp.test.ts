import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REQUEST_MCP = fileURLToPath(new URL("../src/request_mcp.ts", import.meta.url));

test("request transport returns the private bound request byte-for-byte", async () => {
  const directory = mkdtempSync(join(tmpdir(), "warble-request-mcp-test-"));
  const requestFile = join(directory, "request.txt");
  const request = 'User: insight\nAssistant: {"rows":[{"value":42}]}\n\nBuild it.\n';
  writeFileSync(requestFile, request, { encoding: "utf8", mode: 0o600 });
  const child = spawn(process.execPath, ["--import", "tsx", REQUEST_MCP, "--request-file", requestFile], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.ok(child.stdin);
  assert.ok(child.stdout);
  const lines = createInterface({ input: child.stdout });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const responses = new Map<number, (value: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const id = message["id"];
    if (typeof id === "number") responses.get(id)?.(message);
  });
  let id = 0;
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      id += 1;
      responses.set(id, resolve);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    await call("initialize", { protocolVersion: "2025-06-18" });
    const listed = await call("tools/list");
    assert.deepEqual(
      (listed["result"] as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
      ["get_original_request"],
    );
    const result = await call("tools/call", { name: "get_original_request", arguments: {} });
    assert.equal((result["result"] as { content: Array<{ text: string }> }).content[0]!.text, request);
  } finally {
    lines.close();
    child.kill("SIGTERM");
    await closed;
    rmSync(directory, { recursive: true, force: true });
  }
});
