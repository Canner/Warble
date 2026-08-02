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
          {
            name: "get_context",
            description: "Return a disposable semantic schema fragment for Ask isolation tests.",
            inputSchema: {
              type: "object",
              properties: { question: { type: "string" } },
              required: ["question"],
              additionalProperties: true,
            },
          },
          {
            name: "run_sql",
            description: "Return one disposable, non-secret query result for Ask isolation tests.",
            inputSchema: {
              type: "object",
              properties: { sql: { type: "string" }, limit: { type: "integer" } },
              required: ["sql"],
              additionalProperties: false,
            },
          },
        ],
      },
    });
  } else if (message.method === "tools/call") {
    const name = message.params?.name;
    if (!new Set(["probe_setup", "get_context", "run_sql"]).has(name)) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `unexpected tool '${name}'` },
      });
      return;
    }
    const payload = name === "probe_setup"
      ? {
          ok: true,
          non_secret: true,
          component: message.params.arguments.component,
        }
      : name === "get_context"
        ? {
            strategy: "disposable",
            schema: "orders(order_id integer, amount integer)",
          }
        : {
            columns: ["orders"],
            rows: [[42]],
            truncated: false,
          };
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload),
          },
        ],
      },
    });
  } else if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
