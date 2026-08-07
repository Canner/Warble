import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CodexAskRuntime, prepareAsk } from "../src/index.js";
import { ASK_IR_PATH, fakeAskMcp } from "./helpers.js";

if (process.env.WARBLE_CODEX_DASHBOARD_LIVE_SMOKE !== "1") {
  throw new Error(
    "set WARBLE_CODEX_DASHBOARD_LIVE_SMOKE=1 to authorize one authenticated dashboard parity run",
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
const cwd = mkdtempSync(join(tmpdir(), "warble-codex-dashboard-live-"));
const events: unknown[] = [];
let runtime: CodexAskRuntime | null = null;
try {
  const prepared = prepareAsk({
    ir: readFileSync(ASK_IR_PATH, "utf8"),
    component: "generate_dashboard",
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
    turnTimeoutMs: 240_000,
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
    "Build a verified dashboard of orders from the disposable dataset with a KPI, chart, table, and definition.",
  );
  if (
    result.steps.length !== 2 ||
    result.steps[0]?.agentRole !== "warble_plan_dashboard" ||
    result.steps[0]?.model !== "gpt-5.6-sol" ||
    result.steps[0]?.artifacts.filter((artifact) => artifact.tool === "get_context" && artifact.ok)
      .length < 1 ||
    result.steps[1]?.agentRole !== "warble_compose_layout" ||
    result.steps[1]?.model !== "gpt-5.6-terra" ||
    result.steps[1]?.artifacts.filter((artifact) => artifact.tool === "run_sql" && artifact.ok)
      .length < 1 ||
    result.artifact?.kind !== "render_envelope" ||
    result.artifact.verified !== true
  ) {
    throw new Error("authenticated dashboard run did not preserve agent/model/tool/artifact parity");
  }
  const blockTypes = new Set(result.artifact.blockTypes);
  for (const required of ["kpi_card", "chart", "table", "definition"]) {
    if (!blockTypes.has(required)) throw new Error(`authenticated dashboard omitted ${required}`);
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, threadId: session.threadId, artifact: result.artifact })}\n`,
  );
} finally {
  await runtime?.close().catch(() => undefined);
  rmSync(cwd, { recursive: true, force: true });
}
