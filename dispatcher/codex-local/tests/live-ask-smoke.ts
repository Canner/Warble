import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CodexAskRuntime, prepareAsk } from "../src/index.js";
import { ASK_IR_PATH, fakeAskMcp } from "./helpers.js";

if (process.env.WARBLE_CODEX_ASK_LIVE_SMOKE !== "1") {
  throw new Error(
    "set WARBLE_CODEX_ASK_LIVE_SMOKE=1 to authorize one authenticated Ask parity run",
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
const cwd = mkdtempSync(join(tmpdir(), "warble-codex-ask-live-"));
const events: unknown[] = [];
let runtime: CodexAskRuntime | null = null;
try {
  const prepared = prepareAsk({
    ir: readFileSync(ASK_IR_PATH, "utf8"),
    component: "answer_query",
    models: {
      orchestrator: process.env.WARBLE_CODEX_ORCHESTRATOR_MODEL ?? "gpt-5.6-luna",
      cheap: process.env.WARBLE_CODEX_CHEAP_MODEL ?? "gpt-5.6-terra",
      strong: process.env.WARBLE_CODEX_STRONG_MODEL ?? "gpt-5.6-sol",
    },
    mcp: fakeAskMcp(),
  });
  runtime = await CodexAskRuntime.connect(prepared, {
    codexHome,
    cwd,
    externalAuthentication: "provisioned",
    timeoutMs: 30_000,
    turnTimeoutMs: 180_000,
    ...(codexJsEntry
      ? { codexBin: process.execPath, codexArgsPrefix: [resolve(codexJsEntry)] }
      : {}),
    onAskEvent: (event) => {
      events.push(event);
      process.stdout.write(`${JSON.stringify(event)}\n`);
    },
  });
  const session = await runtime.start();
  const result = await runtime.run(
    session,
    "How many orders are in the disposable test dataset? Return the verified table result.",
  );
  if (
    result.steps.length !== 2 ||
    result.steps[0]?.agentRole !== "warble_resolve_intent" ||
    result.steps[0]?.model !== "gpt-5.6-terra" ||
    result.steps[1]?.agentRole !== "warble_generate_sql" ||
    result.steps[1]?.model !== "gpt-5.6-sol" ||
    result.steps[1]?.artifacts.filter((artifact) => artifact.tool === "run_sql" && artifact.ok)
      .length !== 1
  ) {
    throw new Error("authenticated Ask run did not preserve named-agent/model/tool attribution");
  }
  if (JSON.stringify({ result, events }).includes("must-not-leak")) {
    throw new Error("authenticated Ask run exposed a redacted fixture value");
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, threadId: session.threadId, steps: result.steps.length })}\n`,
  );
} finally {
  await runtime?.close().catch(() => undefined);
  rmSync(cwd, { recursive: true, force: true });
}
