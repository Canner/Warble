#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const scenario = process.env.FAKE_CODEX_SCENARIO ?? "success";
const recordPath = process.env.FAKE_CODEX_RECORD;
const prompt = readFileSync(0, "utf8");

if (recordPath) {
  writeFileSync(
    recordPath,
    JSON.stringify(
      {
        argv: process.argv.slice(2),
        prompt,
        env: {
          OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
          CODEX_API_KEY: process.env.CODEX_API_KEY ?? null,
          AZURE_OPENAI_API_KEY: process.env.AZURE_OPENAI_API_KEY ?? null,
          CODEX_HOME: process.env.CODEX_HOME ?? null,
        },
      },
      null,
      2,
    ),
  );
}

if (scenario === "hang") {
  setInterval(() => {}, 1_000);
} else if (scenario === "nonzero") {
  process.stderr.write("fixture failure\n");
  process.exit(7);
} else if (scenario === "malformed") {
  process.stdout.write("not-json\n");
} else {
  const lines = [
    { type: "thread.started", thread_id: "thread-fixture" },
    { type: "turn.started" },
    {
      type: "item.started",
      item: {
        id: "tool-1",
        type: "mcp_tool_call",
        server: "setup",
        tool: "probe_setup",
        arguments: { component: "connect_source" },
      },
    },
    {
      type: "item.completed",
      item: {
        id: "tool-1",
        type: "mcp_tool_call",
        server: "setup",
        tool: "probe_setup",
        status: "completed",
        result: { ok: true },
      },
    },
  ];
  if (scenario === "forbidden") {
    lines.push({
      type: "item.completed",
      item: {
        id: "cmd-1",
        type: "command_execution",
        status: "completed",
      },
    });
  }
  lines.push(
    {
      type: "item.completed",
      item: {
        id: "message-1",
        type: "agent_message",
        text: '{"connection_summary":{"ok":true}}',
      },
    },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  );
  for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`);
}
