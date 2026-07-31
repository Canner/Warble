#!/usr/bin/env node
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "warble-fake-setup", version: "0.1.0" },
      },
    });
  } else if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "probe_setup",
            description:
              "Return a disposable, non-secret Setup result. This tool cannot read or write files.",
            inputSchema: {
              type: "object",
              properties: {
                component: {
                  type: "string",
                  enum: ["connect_source", "build_context"],
                },
              },
              required: ["component"],
              additionalProperties: false,
            },
          },
          {
            name: "not_allowlisted",
            description: "A decoy tool that must never be advertised by the Codex dispatcher.",
            inputSchema: { type: "object", additionalProperties: false },
          },
        ],
      },
    });
  } else if (message.method === "tools/call") {
    const name = message.params?.name;
    if (name !== "probe_setup") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `unexpected tool '${name}'` },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              non_secret: true,
              component: message.params.arguments.component,
            }),
          },
        ],
      },
    });
  } else if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
