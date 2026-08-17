#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

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

if (scenario === "descendant-ignore-term") {
  const descendant = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  if (process.env.FAKE_CODEX_DESCENDANT_RECORD) {
    writeFileSync(process.env.FAKE_CODEX_DESCENDANT_RECORD, String(descendant.pid));
  }
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else if (scenario === "ignore-term") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else if (scenario === "hang") {
  setInterval(() => {}, 1_000);
} else if (scenario === "nonzero") {
  process.stderr.write("fixture failure\n");
  process.exit(7);
} else if (scenario === "nonzero-secret") {
  process.stderr.write("postgres://user:secret@example.test/db\n");
  process.exit(8);
} else if (scenario === "malformed") {
  process.stdout.write("not-json\n");
} else if (scenario === "multi-step") {
  // AC#3 evidence fixture: Setup spawns one fresh process per step (see run.ts's runOneStep), so
  // there is no shared in-process state to key a scripted per-step response off of. Instead this
  // reads the produces-field name straight out of the piped prompt -- `buildPrompt` always states
  // "the produced field '<name>'" for a Setup step -- and echoes it back, so a real two-process
  // multi-step dispatch can be asserted end to end without inventing a new transport mechanism.
  //
  // Since each step is a fresh process with no shared memory, the only way a test can inspect what
  // a given step's process actually received (as opposed to what it merely answered, which would be
  // the same either way and so cannot distinguish working marshalling from broken marshalling) is
  // for this fixture to persist its own received prompt somewhere the test can read after both
  // processes have exited. FAKE_CODEX_MULTISTEP_RECORD, when set, appends one JSON line per
  // invocation with the raw piped prompt -- additive, opt-in, and scoped to this scenario only.
  if (process.env.FAKE_CODEX_MULTISTEP_RECORD) {
    appendFileSync(process.env.FAKE_CODEX_MULTISTEP_RECORD, `${JSON.stringify({ prompt })}\n`);
  }
  const match = /produced field '([^']+)'/.exec(prompt);
  if (!match) {
    process.stderr.write("fixture: could not find produced field in prompt\n");
    process.exit(1);
  }
  const field = match[1];
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
    {
      type: "item.completed",
      item: { id: "message-1", type: "agent_message", text: JSON.stringify({ [field]: { ok: true } }) },
    },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`);
} else if (scenario === "on-failure") {
  // AC#3 evidence fixture: proves the on_failure(target) guard is actually evaluated at run time,
  // not merely accepted at prepare time. Setup spawns a fresh process per step, so which behavior
  // this process exhibits is selected by which step it was invoked for (parsed the same way as the
  // "multi-step" scenario above) plus FAKE_CODEX_ONFAILURE_MODE, which the test sets once per run:
  // "fail" makes the guarded target step emit the wrong produced field (a genuine step failure the
  // guard must observe); "success" (the default) makes it succeed, so the guarded repair step must
  // never even be spawned.
  const stepMatch = /Run exactly one profile step: [^.]+\.([^.]+)\./.exec(prompt);
  if (!stepMatch) {
    process.stderr.write("fixture: could not find step name in prompt\n");
    process.exit(1);
  }
  const stepName = stepMatch[1];
  const producesMatch = /produced field '([^']+)'/.exec(prompt);
  if (!producesMatch) {
    process.stderr.write("fixture: could not find produced field in prompt\n");
    process.exit(1);
  }
  const mode = process.env.FAKE_CODEX_ONFAILURE_MODE ?? "success";
  const shouldFail = stepName === "connect" && mode === "fail";
  const answerText = shouldFail
    ? JSON.stringify({ wrong_field: { ok: true } })
    : JSON.stringify({ [producesMatch[1]]: { ok: true } });
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
    {
      type: "item.completed",
      item: { id: "message-1", type: "agent_message", text: answerText },
    },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`);
} else if (scenario === "assertion-success" || scenario === "assertion-invalid" || scenario === "assertion-mcp") {
  const match = /exactly one JSON object with field '([^']+)'/.exec(prompt);
  if (!match) {
    process.stderr.write("fixture: could not find assertion produced field in prompt\n");
    process.exit(1);
  }
  const field = match[1];
  const lines = [
    { type: "thread.started", thread_id: "thread-fixture" },
    { type: "turn.started" },
  ];
  if (scenario === "assertion-mcp") {
    lines.push({
      type: "item.started",
      item: { id: "tool-1", type: "mcp_tool_call", server: "wren", tool: "run_sql" },
    });
  }
  lines.push(
    {
      type: "item.completed",
      item: {
        id: "message-1",
        type: "agent_message",
        text:
          scenario === "assertion-invalid"
            ? JSON.stringify({ [field]: { severity: "emergency", rationale: "bad" } })
            : JSON.stringify({ [field]: { severity: "critical", rationale: "lag exceeds the expected cadence" } }),
      },
    },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  );
  for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`);
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
