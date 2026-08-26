import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareSetup, runSetup } from "../src/index.js";
import { fakeMcp, SETUP_IR_PATH } from "./helpers.js";

if (process.env.WARBLE_CODEX_LIVE_SMOKE !== "1") {
  throw new Error("set WARBLE_CODEX_LIVE_SMOKE=1 to authorize one authenticated Codex call");
}

const cwd = mkdtempSync(join(tmpdir(), "warble-codex-live-"));
try {
  const prepared = prepareSetup({
    ir: readFileSync(SETUP_IR_PATH, "utf8"),
    component: "attach_source",
    model: process.env.WARBLE_CODEX_MODEL ?? "gpt-5.4",
    mcp: fakeMcp(),
  });
  const result = await runSetup(prepared, {
    cwd,
    request:
      "This is an isolation smoke. Call setup.probe_setup exactly once with component attach_source. " +
      "Do not call any other tool. Return attachment_summary containing the tool result.",
    timeoutMs: 120_000,
    onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  });
  const calls = result.events.filter((event) => event.t === "tool_call");
  if (
    calls.length !== 1 ||
    calls[0]?.t !== "tool_call" ||
    calls[0].name !== "setup.probe_setup"
  ) {
    throw new Error(`unexpected live tool calls: ${JSON.stringify(calls)}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, finalText: result.finalText })}\n`);
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
