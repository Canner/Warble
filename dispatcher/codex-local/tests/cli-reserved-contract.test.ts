import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ASK_IR_PATH, FAKE_APP_SERVER, FAKE_CODEX, FAKE_MCP, SETUP_IR_PATH } from "./helpers.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `warble-codex-reserved-${label}-`));
  scratch.push(path);
  return path;
}

function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf8" });
}

function forgedIr(source: string, sourceComponent: string): string {
  const ir = JSON.parse(readFileSync(source, "utf8")) as { components: Array<Record<string, unknown>> };
  const node = ir.components.find((candidate) => candidate["id"] === sourceComponent);
  assert.ok(node, `missing fixture component ${sourceComponent}`);
  node["id"] = "apply_enrichment";
  node["verb"] = "apply_enrichment";
  const path = join(temp(`forged-${sourceComponent}`), "ir.json");
  writeFileSync(path, JSON.stringify(ir));
  return path;
}

function appServerFixture(): string {
  const path = join(temp("app-server-bin"), "codex");
  copyFileSync(FAKE_APP_SERVER, path);
  chmodSync(path, 0o755);
  return path;
}

function oneShotFixture(): string {
  const path = join(temp("one-shot-bin"), "codex");
  copyFileSync(FAKE_CODEX, path);
  chmodSync(path, 0o755);
  return path;
}

function setupArgs(irPath: string, command: "dispatch" | "manifest" | "describe"): string[] {
  return [
    command,
    irPath,
    ...(command === "dispatch" ? ["forged setup request"] : []),
    "--component",
    "apply_enrichment",
    "--server-command",
    process.execPath,
    "--server-arg",
    FAKE_MCP,
    "--source-tool",
    "probe_setup",
    "--context-tool",
    "probe_setup",
    "--codex-bin",
    oneShotFixture(),
  ];
}

function askArgs(
  irPath: string,
  command: "dispatch" | "manifest" | "describe",
  codexHome: string,
): string[] {
  return [
    command,
    irPath,
    ...(command === "dispatch" ? ["forged Ask request"] : []),
    "--component",
    "apply_enrichment",
    "--server-command",
    process.execPath,
    "--server-arg",
    FAKE_APP_SERVER,
    "--inspect-tool",
    "get_context",
    "--query-tool",
    "run_sql",
    "--orchestrator-model",
    "gpt-5.6",
    "--cheap-model",
    "gpt-5.6-terra",
    "--strong-model",
    "gpt-5.6-sol",
    "--codex-home",
    codexHome,
    "--codex-bin",
    appServerFixture(),
  ];
}

function assertHostExecuted(result: ReturnType<typeof run>): void {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /apply_enrichment.*host-executed/);
}

test("a setup-shaped reserved identity is rejected for every generic command before its one-shot process starts", () => {
  const irPath = forgedIr(SETUP_IR_PATH, "connect_source");
  const record = join(temp("one-shot-record"), "started.json");
  const priorRecord = process.env["FAKE_CODEX_RECORD"];
  process.env["FAKE_CODEX_RECORD"] = record;
  try {
    for (const command of ["manifest", "describe", "dispatch"] as const) {
      assertHostExecuted(run(setupArgs(irPath, command)));
    }
  } finally {
    if (priorRecord === undefined) delete process.env["FAKE_CODEX_RECORD"];
    else process.env["FAKE_CODEX_RECORD"] = priorRecord;
  }
  assert.equal(existsSync(record), false, "must fail before one-shot Codex launch");

  // The aggregate manifest/describe path scans the complete IR before deciding whether Setup can
  // be represented as a whole profile, so omitting --component cannot skip this host-only wall.
  for (const command of ["manifest", "describe"] as const) {
    assertHostExecuted(run([
      command,
      irPath,
      "--server-command",
      process.execPath,
      "--source-tool",
      "probe_setup",
      "--context-tool",
      "probe_setup",
    ]));
  }
});

test("an Ask-shaped reserved identity is rejected for every generic command before app-server launch", () => {
  const irPath = forgedIr(ASK_IR_PATH, "answer_query");
  for (const command of ["manifest", "describe", "dispatch"] as const) {
    const codexHome = temp(`ask-${command}-home`);
    assertHostExecuted(run(askArgs(irPath, command, codexHome)));
    assert.equal(existsSync(join(codexHome, "fake-app-state.json")), false, "must fail before app-server launch");
  }
});

test("a marker-mixed forged shape rejects before any generic dispatch routing", () => {
  const irPath = forgedIr(ASK_IR_PATH, "answer_query");
  const ir = JSON.parse(readFileSync(irPath, "utf8")) as { components: Array<Record<string, unknown>> };
  const node = ir.components.find((candidate) => candidate["id"] === "apply_enrichment")!;
  (node["guardrails"] as Array<Record<string, unknown>>).push({
    name: "setup_execution",
    locked: true,
    scope: ".",
  });
  writeFileSync(irPath, JSON.stringify(ir));
  assertHostExecuted(run(askArgs(irPath, "dispatch", temp("marker-mixed-home"))));
});
