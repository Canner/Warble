#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import { REQUEST_TRANSPORT_TOOL } from "./request_transport.js";

const { values } = parseArgs({
  options: { "request-file": { type: "string" } },
});
const requestFile = values["request-file"];
if (!requestFile || !isAbsolute(requestFile)) {
  process.stderr.write("request transport requires an absolute --request-file\n");
  process.exit(2);
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line) as {
    id?: unknown;
    method?: unknown;
    params?: { name?: unknown };
  };
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "warble-request-transport", version: "0.1.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{
          name: REQUEST_TRANSPORT_TOOL,
          description: "Return the authoritative original request for this Warble turn exactly as received by the dispatcher.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        }],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    if (message.params?.name !== REQUEST_TRANSPORT_TOOL) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown request transport tool" } });
      return;
    }
    try {
      const request = readFileSync(requestFile, "utf8");
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: request }] },
      });
    } catch {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "original request is unavailable" } });
    }
    return;
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
});
