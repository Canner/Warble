#!/usr/bin/env node
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function selectedColumns(sql) {
  const select = sql.match(/^\s*select\s+(.+?)\s+from\s+/i)?.[1];
  if (!select) return [];
  return select.split(",").map((expression) => {
    const alias = expression.match(/\bas\s+([a-z_][a-z0-9_]*)\s*$/i)?.[1];
    if (alias) return alias;
    return expression.trim().match(/(?:^|\.)([a-z_][a-z0-9_]*)$/i)?.[1] ?? "value";
  });
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
                  enum: ["attach_source", "compose_context"],
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
    const sql = message.params.arguments.sql ?? "";
    const columns = selectedColumns(sql);
    const hasAggregate = /\b(?:count|sum|avg)\s*\(/i.test(sql);
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
        : /\bas\s+metric\b/i.test(sql) && /\bas\s+definition\b/i.test(sql)
          ? {
              columns: ["metric", "definition"],
              rows: [["Total Orders", "Count of orders in the disposable dataset"]],
              truncated: false,
            }
          : hasAggregate && columns.length > 0
          ? {
              columns,
              rows: /\bgroup\s+by\b/i.test(sql)
                ? [
                    columns.map((column) => column === "amount" ? 10 : column === "order_id" ? 1 : 1),
                    columns.map((column) => column === "amount" ? 32 : column === "order_id" ? 2 : 1),
                  ]
                : [columns.map((_, index) => 42 + index)],
              truncated: false,
            }
          : {
              columns: ["order_id", "amount"],
              rows: [[1, 10], [2, 32]],
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
