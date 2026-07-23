import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { aggregateTrace, DispatchSessionError, realizeRender, runDispatch } from "../src/run.js";
import { DispatchError } from "../src/error.js";
import { makeReadOnlyGuard } from "../src/guardrails.js";
import type { DispatchPlan, RenderGate } from "../src/options.js";
import type { StagedStep } from "../src/route.js";

// aggregateTrace is pure — exercise it with synthetic SDK messages (no live query() needed).
// Cast through unknown: we only touch the fields aggregateTrace reads.
function assistant(model: string, parent: string | null, inputTokens: number): unknown {
  return {
    type: "assistant",
    parent_tool_use_id: parent,
    message: { model, usage: { input_tokens: inputTokens, output_tokens: 10 } },
  };
}

function result(): unknown {
  return {
    type: "result",
    subtype: "success",
    result: '{ "blocks": [], "summary": "ok" }',
    total_cost_usd: 0.12,
    duration_ms: 3400,
    duration_api_ms: 3000,
    num_turns: 4,
    usage: { input_tokens: 100, output_tokens: 40 },
    modelUsage: {
      opus: { inputTokens: 60, outputTokens: 20, costUSD: 0.1 },
      haiku: { inputTokens: 40, outputTokens: 20, costUSD: 0.02 },
    },
  };
}

test("aggregateTrace captures per-step usage + per-model (≈per-tier) cost from the message stream", () => {
  const messages = [
    assistant("opus", null, 60), // driver / plan step
    assistant("haiku", "tool_123", 40), // subagent turn (has a parent tool use id)
    result(),
  ] as never[];

  const trace = aggregateTrace(
    messages,
    { target: "claude-agent-sdk:local", verb: "generate_dashboard", model: "sonnet", split: true },
    [],
  );

  assert.equal(trace.steps.length, 2);
  assert.equal(trace.steps[0]!.model, "opus");
  assert.equal(trace.steps[1]!.parent_tool_use_id, "tool_123");
  assert.equal(trace.run?.total_cost_usd, 0.12);
  assert.equal(trace.run?.num_turns, 4);
  // per-tier cost granularity the headless file target cannot produce:
  assert.equal(trace.modelUsage["opus"]!.costUSD, 0.1);
  assert.equal(trace.modelUsage["haiku"]!.costUSD, 0.02);
});

test("aggregateTrace with no result message yields run=null (still returns steps/denials)", () => {
  const trace = aggregateTrace(
    [assistant("opus", null, 10)] as never[],
    { target: "t", verb: "v", model: "opus", split: false },
    [{ tool: "Bash", reason: "blocked", command: "rm -rf /" }],
  );
  assert.equal(trace.run, null);
  assert.equal(trace.steps.length, 1);
  assert.equal(trace.denials[0]!.command, "rm -rf /");
});

// --- DispatchSessionError: a failed run can still carry a resumable session id -------------------

test("DispatchSessionError is a DispatchError and carries the session id it failed with", () => {
  const err = new DispatchSessionError("agent run failed (error_max_turns): ran out of turns", "sess-abc");
  assert.ok(err instanceof DispatchError);
  assert.equal(err.name, "DispatchSessionError");
  assert.equal(err.sessionId, "sess-abc");
  assert.match(err.message, /error_max_turns/);
});

test("DispatchSessionError's sessionId is null when the SDK never produced one to resume", () => {
  const err = new DispatchSessionError("the query() stream ended without a result message", null);
  assert.equal(err.sessionId, null);
});

// --- realizeRender: render_contract's best-effort degrade vs required/safety-critical fail --------
// Offline (no live SDK, no release binary needed): a deliberately-unresolvable `warbleBin` makes
// `renderEnvelope` fail deterministically (spawnSync surfaces ENOENT), which is all that matters here
// — we're exercising the onFailure branch, not the real renderer.

const UNRESOLVABLE_BIN = "/definitely/not/a/real/warble/binary";

function realizeGate(onFailure: RenderGate["onFailure"]): RenderGate {
  return { kind: "realize", scope: ".", flavor: "programmatic", onFailure };
}

test("realizeRender: a best-effort render_contract failure degrades — htmlPath null, no throw, degradation recorded", () => {
  const gate = realizeGate("degrade");
  const out = realizeRender(gate, "the agent's own final text", "/tmp/warble-does-not-matter/dashboard.html", {
    warbleBin: UNRESOLVABLE_BIN,
  });
  assert.equal(out.htmlPath, null);
  assert.ok(out.renderDegraded, "degradation must be recorded");
  assert.ok(out.renderDegraded!.reason.length > 0, "the reason should carry the underlying failure");
});

test("realizeRender: onFailure 'fail' (required/safety-critical) rethrows — never silently degrades", () => {
  const gate = realizeGate("fail");
  assert.throws(() =>
    realizeRender(gate, "text", "/tmp/warble-does-not-matter/dashboard.html", { warbleBin: UNRESOLVABLE_BIN }),
  );
});

test("realizeRender: onFailure absent (additive default) rethrows exactly like 'fail' — old behavior preserved", () => {
  const gate = realizeGate(undefined);
  assert.throws(() =>
    realizeRender(gate, "text", "/tmp/warble-does-not-matter/dashboard.html", { warbleBin: UNRESOLVABLE_BIN }),
  );
});

test("realizeRender: a successful render is unaffected by onFailure — htmlPath set, no degradation", () => {
  // Reuse the real renderer path's happy contract without needing the release binary: point
  // `warbleBin` at a fake, always-succeeding "renderer" (a POSIX sh script that just writes the `--out`
  // path), so `renderEnvelope`'s success branch (not the failure branch under test elsewhere) is
  // exercised end to end through `realizeRender`.
  const outDir = mkdtempSync(join(tmpdir(), "warble-realize-ok-"));
  try {
    const script = join(outDir, "fake-warble.sh");
    const out = join(outDir, "dashboard.html");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        'prev=""',
        'out=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--out" ]; then out="$arg"; fi',
        '  prev="$arg"',
        "done",
        'echo "<!doctype html>ok" > "$out"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const result = realizeRender(realizeGate("degrade"), "final text", out, { warbleBin: script });
    assert.equal(result.htmlPath, out);
    assert.equal(result.renderDegraded, null);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- guardrail runtime enforcement (the differentiator) ----------------------------------------

test("read-only guard: allows `wren` bash, denies non-wren + destructive + Write", async () => {
  const { canUseTool, denials } = makeReadOnlyGuard({ readOnly: true, writeScope: null, cwd: "/proj" });

  assert.equal((await canUseTool("Bash", { command: 'wren --sql "select 1"' }, opts())).behavior, "allow");
  assert.equal((await canUseTool("Read", { file_path: "x" }, opts())).behavior, "allow");

  const psql = await canUseTool("Bash", { command: "psql -c 'select 1'" }, opts());
  assert.equal(psql.behavior, "deny");

  const rm = await canUseTool("Bash", { command: "wren --sql x && rm -rf /" }, opts());
  assert.equal(rm.behavior, "deny");

  const redirect = await canUseTool("Bash", { command: "wren --sql x > /tmp/out" }, opts());
  assert.equal(redirect.behavior, "deny");

  const write = await canUseTool("Write", { file_path: "dashboard.html" }, opts());
  assert.equal(write.behavior, "deny");

  // every denial is recorded (proves enforcement fired) and carries a reason
  assert.ok(denials.length >= 4);
  assert.ok(denials.every((d) => d.reason.length > 0));
});

test("read-only guard: prompt flavor allows Write inside scope, denies outside", async () => {
  const { canUseTool } = makeReadOnlyGuard({ readOnly: true, writeScope: ".", cwd: "/proj" });
  assert.equal((await canUseTool("Write", { file_path: "dashboard.html" }, opts())).behavior, "allow");
  assert.equal((await canUseTool("Write", { file_path: "/etc/passwd" }, opts())).behavior, "deny");
});

function opts() {
  return { signal: new AbortController().signal, toolUseID: "t1" };
}

// --- hybrid-staged conditional realization (integration, offline) -------------------------------
// These drive the real staged executor through runDispatch. Every step is a local `openai_compat`
// step with no endpoint, which fails deterministically offline (never touching the network), so we
// can observe the conditional control flow — which step the run reaches and how it fails — end to end.

function mkStep(over: Partial<StagedStep> & { name: string }): StagedStep {
  return {
    name: over.name,
    tier: over.tier ?? "cheap",
    provider: over.provider ?? "openai_compat",
    endpoint: over.endpoint ?? null,
    model: over.model ?? "local-model",
    consumes: over.consumes ?? [],
    produces: "produces" in over ? (over.produces ?? null) : null,
    prompt: over.prompt ?? `prompt for ${over.name}`,
    conditional: over.conditional ?? false,
    when: over.when ?? null,
  };
}

function hybridPlan(stagedSteps: StagedStep[]): DispatchPlan {
  return {
    prompt: "question",
    options: { cwd: process.cwd() },
    meta: {
      verb: "answer_query",
      target: "claude-agent-sdk:local",
      readOnly: true,
      split: false,
      render: { kind: "none", scope: null, flavor: null },
      assertion: false,
      mutation: false,
      model: "sonnet",
      subagentModels: {},
      tierCollapseNote: null,
      mode: "hybrid-staged",
      providers: ["openai_compat"],
      stagedSteps,
      setupScope: null,
    },
  };
}

async function withTmpDir(fn: (outDir: string) => Promise<void>): Promise<void> {
  const outDir = mkdtempSync(join(tmpdir(), "warble-hybrid-"));
  try {
    await fn(outDir);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

test("hybrid-staged: an on_failure guarded step runs after its (non-repair) target fails, not aborting at the target", async () => {
  // 'fallback' guards on 'risky' failing but does NOT consume 'risky's output → guarded-skip, not a
  // repair fold. The target must still be tolerated so the guard can observe its failure and fire.
  // Proof it fired: the run reaches 'fallback' and fails THERE, rather than aborting at 'risky'.
  await withTmpDir(async (outDir) => {
    const plan = hybridPlan([
      mkStep({ name: "risky", produces: "sql" }),
      mkStep({
        name: "fallback",
        consumes: [],
        produces: "note",
        conditional: true,
        when: { guard: "on_failure", target: "risky" },
      }),
    ]);
    await assert.rejects(runDispatch(plan, { outDir, warbleBin: "warble" }), (err: Error) => {
      assert.match(err.message, /local step 'fallback' has no endpoint/);
      assert.doesNotMatch(err.message, /'risky'/);
      return true;
    });
  });
});

test("hybrid-staged: repair exhaustion loud-fails and folds the last failure text into the error", async () => {
  // 'repair' consumes 'generate's output → repair fold. Both fail offline, so the single attempt is
  // exhausted; the run must loud-fail (never silently skip) and carry the underlying failure text.
  await withTmpDir(async (outDir) => {
    const plan = hybridPlan([
      mkStep({ name: "generate", produces: "sql" }),
      mkStep({
        name: "repair",
        consumes: ["sql"],
        produces: "sql",
        conditional: true,
        when: { guard: "on_failure", target: "generate" },
      }),
    ]);
    await assert.rejects(runDispatch(plan, { outDir, warbleBin: "warble" }), (err: Error) => {
      assert.match(err.message, /repair step 'repair' did not recover 'generate'/);
      assert.match(err.message, /last failure: local step 'repair' has no endpoint/);
      return true;
    });
  });
});
