import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { ENRICH_IR_PATH, FAKE_APP_SERVER } from "./helpers.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `warble-codex-cli-enrich-${label}-`));
  scratch.push(path);
  return path;
}

function fakeCodex(label: string): string {
  const path = join(temp(label), "codex");
  copyFileSync(FAKE_APP_SERVER, path);
  chmodSync(path, 0o755);
  return path;
}

function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf8" });
}

function common(component: "survey_context" | "propose_changes") {
  return [
    ENRICH_IR_PATH,
    "--component",
    component,
    "--server-command",
    process.execPath,
    "--server-arg",
    FAKE_APP_SERVER,
    "--semantic-tool",
    "get_context",
    "--raw-material-tool",
    "read_raw_material",
  ];
}

function assertExited(pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
    return;
  }
  assert.fail(`app-server process ${pid} remained alive after CLI cleanup`);
}

function forgedApplyIr(): string {
  const ir = JSON.parse(readFileSync(ENRICH_IR_PATH, "utf8")) as {
    components: Array<Record<string, unknown>>;
  };
  const apply = ir.components.find((component) => component["id"] === "apply_changes");
  assert.ok(apply, "missing apply_changes fixture component");
  Object.assign(apply, {
    type: "analytical",
    realization_kind: "skill",
    required_capabilities: ["semantic_introspection", "llm:strong"],
    llm_calls: [{
      name: "propose",
      tier: "strong",
      prompt: "forged read-only shape",
      produces: "enrichment_proposal",
      consumes: [],
      conditional: false,
      when: null,
    }],
    guardrails: [{ name: "read_only_execution", locked: true }],
    effect: { render_blocks: [], outcome: { kind: "none" } },
  });
  const path = join(temp("forged-apply-ir"), "ir.json");
  writeFileSync(path, JSON.stringify(ir));
  return path;
}

test("generic manifest and describe select the scoped read-only enrichment contract from IR", () => {
  const manifest = run(["manifest", ...common("survey_context")]);
  assert.equal(manifest.status, 0, manifest.stderr);
  const parsedManifest = JSON.parse(manifest.stdout) as {
    agents: Array<{ capabilities: Array<{ capability: string; outcome: string }>; tools: Array<{ name: string }> }>;
  };
  assert.deepEqual(parsedManifest.agents[0]!.tools.map((tool) => tool.name), ["get_context", "read_raw_material"]);
  assert.deepEqual(parsedManifest.agents[0]!.capabilities.map((capability) => capability.outcome), [
    "realize-via",
    "realize-via",
    "native",
  ]);

  const described = run(["describe", ...common("propose_changes")]);
  assert.equal(described.status, 0, described.stderr);
  const parsedDescription = JSON.parse(described.stdout) as { phase: string; tools: string[] };
  assert.equal(parsedDescription.phase, "enrich-parity");
  assert.deepEqual(parsedDescription.tools, ["get_context"]);
});

test("generic dispatch crosses the real CLI and app-server seam for inspect and draft", () => {
  for (const [component, request, field, tools] of [
    ["survey_context", "enrich-inspect-success", "enrichment_gaps", ["get_context", "read_raw_material"]],
    ["propose_changes", "enrich-draft-success", "enrichment_proposal", ["get_context"]],
  ] as const) {
    const codexHome = temp(`${component}-home`);
    const project = temp(`${component}-project`);
    const dispatched = run([
      "dispatch",
      ...common(component),
      request,
      "--project",
      project,
      "--codex-home",
      codexHome,
      "--codex-bin",
      fakeCodex(`${component}-bin`),
      "--stream-json",
    ]);
    assert.equal(dispatched.status, 0, dispatched.stderr);
    const events = dispatched.stdout.trim().split("\n").map((line) => JSON.parse(line) as { t: string; text?: string });
    const answer = events.find((event) => event.t === "answer");
    assert.ok(answer?.text);
    assert.ok(field in (JSON.parse(answer.text) as Record<string, unknown>));
    assert.ok(events.some((event) => event.t === "turn_completed"));

    const state = JSON.parse(readFileSync(join(codexHome, "fake-app-state.json"), "utf8")) as {
      pid: number;
      billingEnvPresent: boolean;
      argv: string[];
      requests: Array<{ method: string; params: Record<string, unknown> }>;
    };
    assert.equal(state.billingEnvPresent, false);
    assert.ok(state.argv.includes(`mcp_servers.enrich.enabled_tools=${JSON.stringify(tools)}`));
    const start = state.requests.find((entry) => entry.method === "thread/start");
    assert.ok(start, "missing thread/start request");
    assert.equal(start.params.approvalPolicy, "never");
    assert.equal(start.params.sandbox, "read-only");
    assert.deepEqual(start.params.runtimeWorkspaceRoots, []);
    assert.ok(state.requests.some((entry) => entry.method === "turn/start"));
    assertExited(state.pid);
  }
});

test("generic enrichment dispatch fails closed for malformed and terminal app-server protocol output", () => {
  for (const [request, expected] of [
    // Message text is now shared with Setup's identical judgment (`step_engine.ts`'s
    // `parseStepTerminal`, used by both engines so a step's produces-field discipline is judged by
    // one rule) rather than an Enrich-only phrasing.
    ["enrich-malformed-terminal", /step terminal is not JSON/],
    ["enrich-invalid-status", /notification violated the session contract/],
    ["enrich-terminal-error", /notification violated the session contract/],
  ] as const) {
    const codexHome = temp(`${request}-home`);
    const dispatched = run([
      "dispatch",
      ...common("survey_context"),
      request,
      "--project",
      temp(`${request}-project`),
      "--codex-home",
      codexHome,
      "--codex-bin",
      fakeCodex(`${request}-bin`),
    ]);
    assert.equal(dispatched.status, 1);
    assert.match(dispatched.stderr, expected);
    assert.doesNotMatch(dispatched.stderr, /must-not-leak/);
    const state = JSON.parse(readFileSync(join(codexHome, "fake-app-state.json"), "utf8")) as { pid: number };
    assertExited(state.pid);
  }
});

test("generic enrichment dispatch bounds provider and app-server failures and cleans up the child process", () => {
  for (const [request, model, expected] of [
    ["enrich-provider-failure", "provider-failure", /thread\/start' failed/],
    ["enrich-crash-after-start", "gpt-5.4", /app-server disconnected during an active turn/],
  ] as const) {
    const codexHome = temp(`${request}-home`);
    const dispatched = run([
      "dispatch",
      ...common("survey_context"),
      request,
      "--model",
      model,
      "--project",
      temp(`${request}-project`),
      "--codex-home",
      codexHome,
      "--codex-bin",
      fakeCodex(`${request}-bin`),
    ]);
    assert.equal(dispatched.status, 1);
    assert.match(dispatched.stderr, expected);
    assert.doesNotMatch(dispatched.stderr, /must-not-leak/);
    const state = JSON.parse(readFileSync(join(codexHome, "fake-app-state.json"), "utf8")) as { pid: number };
    assertExited(state.pid);
  }
});

test("apply_changes wall-hits through the generic public CLI", () => {
  const refused = run([
    "manifest",
    ...common("survey_context").map((value, index, values) =>
      value === "survey_context" && values[index - 1] === "--component" ? "apply_changes" : value,
    ),
  ]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /apply_changes/);
  assert.match(refused.stderr, /host-executed/);
  assert.doesNotMatch(refused.stderr, /must-not-leak/);
});

test("a reshaped apply_changes IR declaring only honestly-realizable capabilities is dispatchable, by design", () => {
  // Its declared contract requests nothing this target cannot guarantee, and a component's id/verb
  // carries no dispatch meaning (invariant #1) — so this reshape is legalized like any other
  // Enrich-shaped component. apply remains host-owned in practice, not because the dispatcher
  // recognizes the name "apply_changes", but because nothing in the actual git-authored profile
  // ever declares this honest shape for it.
  const irPath = forgedApplyIr();
  for (const command of ["manifest", "describe"] as const) {
    const accepted = run([command, ...common("survey_context").map((value, index, values) =>
      index === 0 ? irPath : value === "survey_context" && values[index - 1] === "--component" ? "apply_changes" : value,
    )]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.doesNotMatch(accepted.stderr, /must-not-leak/);
  }
});
