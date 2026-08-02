import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CodexSessionRuntime,
  prepareSetup,
} from "../src/index.js";
import { fakeMcp, SETUP_IR_PATH } from "./helpers.js";

if (process.env.WARBLE_CODEX_SESSION_LIVE_SMOKE !== "1") {
  throw new Error(
    "set WARBLE_CODEX_SESSION_LIVE_SMOKE=1 to authorize one authenticated persistent Codex call",
  );
}
const configuredHome = process.env.WARBLE_CODEX_SESSION_HOME;
if (!configuredHome) {
  throw new Error(
    "set WARBLE_CODEX_SESSION_HOME to an externally provisioned and authenticated dedicated CODEX_HOME",
  );
}

const codexHome = resolve(configuredHome);
const codexJsEntry = process.env.WARBLE_CODEX_JS_ENTRY;
const cwd = mkdtempSync(join(tmpdir(), "warble-codex-session-live-"));
const events: unknown[] = [];
let runtime: CodexSessionRuntime | null = null;
let resumedRuntime: CodexSessionRuntime | null = null;
try {
  const prepared = prepareSetup({
    ir: readFileSync(SETUP_IR_PATH, "utf8"),
    component: "connect_source",
    model: process.env.WARBLE_CODEX_MODEL ?? "gpt-5.4",
    mcp: fakeMcp(),
  });
  const options = {
    codexHome,
    cwd,
    externalAuthentication: "provisioned" as const,
    timeoutMs: 120_000,
    ...(codexJsEntry
      ? { codexBin: process.execPath, codexArgsPrefix: [resolve(codexJsEntry)] }
      : {}),
    onEvent: (event: unknown) => {
      events.push(event);
      process.stdout.write(`${JSON.stringify(event)}\n`);
    },
  };

  runtime = await CodexSessionRuntime.connect(prepared, options);
  const session = await runtime.start();
  const turn = await runtime.turn(
    session,
    "This is a persistent-session isolation smoke. Call setup.probe_setup exactly once with " +
      "component connect_source. Do not call any other tool. Return connection_summary containing " +
      "the non-secret tool result.",
  );
  const completed = await runtime.waitForTurn(turn);
  await runtime.close();
  runtime = null;
  if (completed.status !== "completed") {
    throw new Error(`unexpected live turn status: ${completed.status}`);
  }

  resumedRuntime = await CodexSessionRuntime.connect(prepared, options);
  const resumed = await resumedRuntime.resume(session);
  const history = await resumedRuntime.read(resumed);
  await resumedRuntime.close();
  resumedRuntime = null;
  if (resumed.threadId !== session.threadId || history.turns.length === 0) {
    throw new Error("persistent live session did not resume its original thread history");
  }

  const calls = events.filter(
    (event): event is { t: "tool_call"; name: string } =>
      typeof event === "object" &&
      event !== null &&
      "t" in event &&
      event.t === "tool_call" &&
      "name" in event &&
      typeof event.name === "string",
  );
  if (calls.length !== 1 || calls[0]?.name !== "setup.probe_setup") {
    throw new Error(`unexpected live tool calls: ${JSON.stringify(calls)}`);
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, threadId: session.threadId, resumed: true })}\n`,
  );
} finally {
  await runtime?.close().catch(() => undefined);
  await resumedRuntime?.close().catch(() => undefined);
  rmSync(cwd, { recursive: true, force: true });
}
