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

// Genuinely non-dispatchable on IR grounds alone, with id/verb left untouched: a component's
// identity carries no dispatch meaning (invariant #1), so these forgeries prove the wall-hit is
// about the declared contract, not the name.
function nonSkillRealizationKindIr(source: string, component: string): string {
  const ir = JSON.parse(readFileSync(source, "utf8")) as { components: Array<Record<string, unknown>> };
  const node = ir.components.find((candidate) => candidate["id"] === component);
  assert.ok(node, `missing fixture component ${component}`);
  node["realization_kind"] = "gated-tool";
  const path = join(temp(`non-skill-${component}`), "ir.json");
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

function setupArgs(irPath: string, component: string, command: "dispatch" | "manifest" | "describe"): string[] {
  return [
    command,
    irPath,
    ...(command === "dispatch" ? ["forged setup request"] : []),
    "--component",
    component,
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
  component: string,
  command: "dispatch" | "manifest" | "describe",
  codexHome: string,
): string[] {
  return [
    command,
    irPath,
    ...(command === "dispatch" ? ["forged Ask request"] : []),
    "--component",
    component,
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

function assertHostExecuted(result: ReturnType<typeof run>, componentId: string): void {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, new RegExp(`${componentId}.*host-executed`));
}

test("a setup-shaped component with a non-skill realization_kind is rejected for every generic command before its one-shot process starts", () => {
  const irPath = nonSkillRealizationKindIr(SETUP_IR_PATH, "connect_source");
  const record = join(temp("one-shot-record"), "started.json");
  const priorRecord = process.env["FAKE_CODEX_RECORD"];
  process.env["FAKE_CODEX_RECORD"] = record;
  try {
    for (const command of ["manifest", "describe", "dispatch"] as const) {
      assertHostExecuted(run(setupArgs(irPath, "connect_source", command)), "connect_source");
    }
  } finally {
    if (priorRecord === undefined) delete process.env["FAKE_CODEX_RECORD"];
    else process.env["FAKE_CODEX_RECORD"] = priorRecord;
  }
  assert.equal(existsSync(record), false, "must fail before one-shot Codex launch");

  // The aggregate manifest/describe path scans the complete IR before deciding whether Setup can
  // be represented as a whole profile, so omitting --component cannot skip this wall.
  for (const command of ["manifest", "describe"] as const) {
    assertHostExecuted(
      run([
        command,
        irPath,
        "--server-command",
        process.execPath,
        "--source-tool",
        "probe_setup",
        "--context-tool",
        "probe_setup",
      ]),
      "connect_source",
    );
  }
});

test("an Ask-shaped component with a non-skill realization_kind is rejected for every generic command before app-server launch", () => {
  const irPath = nonSkillRealizationKindIr(ASK_IR_PATH, "answer_query");
  for (const command of ["manifest", "describe", "dispatch"] as const) {
    const codexHome = temp(`ask-${command}-home`);
    assertHostExecuted(run(askArgs(irPath, "answer_query", command, codexHome)), "answer_query");
    assert.equal(existsSync(join(codexHome, "fake-app-state.json")), false, "must fail before app-server launch");
  }
});
