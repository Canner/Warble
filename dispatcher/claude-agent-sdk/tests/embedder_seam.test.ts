import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanUseTool, Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import { composeCanUseTool, composeHooks, makeReadOnlyGuard } from "../src/guardrails.js";
import type { DispatchPlan } from "../src/options.js";
import type { StagedStep } from "../src/route.js";

// The seam an embedding host uses: its own `canUseTool` / `hooks` must COMPOSE with the guardrail
// floor rather than replace it (or be replaced by it). Two halves are tested here:
//   1. the composition semantics themselves (deny wins from either side; the floor inspects the
//      input the tool will actually receive);
//   2. that every run path is actually wired through it — the half that fails if a path is missed,
//      which is what the earlier state of this code got wrong on three of four paths.
//
// Offline: `query()` is module-mocked, so nothing here reaches the network or a subscription.

const NO_OPTS = { signal: new AbortController().signal } as unknown as Parameters<CanUseTool>[2];

function floorFor(cwd: string): CanUseTool {
  return makeReadOnlyGuard({ readOnly: true, writeScope: null, cwd, setupScope: null }).canUseTool;
}

// --- 1. composition semantics -------------------------------------------------------------------

test("with no embedder callback the floor's own callback is returned unchanged", () => {
  const floor = floorFor("/tmp");
  assert.equal(composeCanUseTool(undefined, floor), floor);
});

test("the floor still denies what it denied before, with an embedder that allows everything", async () => {
  let embedderRan = false;
  const embedder: CanUseTool = async (_t, input) => {
    embedderRan = true;
    return { behavior: "allow", updatedInput: input };
  };
  const composed = composeCanUseTool(embedder, floorFor("/tmp"));

  const verdict = await composed("Bash", { command: "rm -rf /" }, NO_OPTS);

  assert.equal(embedderRan, true, "the embedder is consulted");
  assert.equal(verdict.behavior, "deny", "an embedder allow cannot overturn the guardrail floor");
});

test("an embedder denial stands, and the floor is not consulted for it", async () => {
  const guard = makeReadOnlyGuard({ readOnly: true, writeScope: null, cwd: "/tmp", setupScope: null });
  const embedder: CanUseTool = async () => ({ behavior: "deny", message: "host policy says no" });
  const composed = composeCanUseTool(embedder, guard.canUseTool);

  // Deliberately a command the FLOOR would also deny: if the short-circuit were removed and the
  // floor were consulted anyway, it would push its own entry onto the ledger. A command the floor
  // allows could not tell the two apart — it leaves the ledger empty either way.
  const verdict = await composed("Bash", { command: "rm -rf /" }, NO_OPTS);

  assert.equal(verdict.behavior, "deny");
  assert.equal((verdict as Extract<PermissionResult, { behavior: "deny" }>).message, "host policy says no");
  assert.deepEqual(guard.denials, [], "the floor was never consulted, so its ledger stays empty");
});

test("the floor inspects the input the embedder rewrote, not the one it was offered", async () => {
  // This is why the order is embedder-first, floor-last. An embedder may return `updatedInput`; a
  // floor that ran first would clear a command that is no longer the command being run.
  const embedder: CanUseTool = async () => ({
    behavior: "allow",
    updatedInput: { command: "rm -rf /" },
  });
  const composed = composeCanUseTool(embedder, floorFor("/tmp"));

  const verdict = await composed("Bash", { command: "wren -q -o json -s 'select 1'" }, NO_OPTS);

  assert.equal(verdict.behavior, "deny", "the rewritten command is what the floor must judge");
});

test("a call both sides allow is allowed, and carries the embedder's rewritten input", async () => {
  const embedder: CanUseTool = async () => ({
    behavior: "allow",
    updatedInput: { command: "wren -q -o json -s 'select 2'" },
  });
  const composed = composeCanUseTool(embedder, floorFor("/tmp"));

  const verdict = await composed("Bash", { command: "wren -q -o json -s 'select 1'" }, NO_OPTS);

  assert.equal(verdict.behavior, "allow");
  assert.deepEqual(
    (verdict as Extract<PermissionResult, { behavior: "allow" }>).updatedInput,
    { command: "wren -q -o json -s 'select 2'" },
  );
});

test("composeHooks keeps the embedder's hooks and its other hook kinds, and appends the guard's", () => {
  const embedderHook = { hooks: [] } as never;
  const guardHook = { hooks: [] } as never;
  const merged = composeHooks(
    { PreToolUse: [embedderHook], PostToolUse: [embedderHook] },
    [guardHook],
  );

  assert.deepEqual(merged?.PreToolUse, [embedderHook, guardHook], "embedder's run first, guard's appended");
  assert.deepEqual(merged?.PostToolUse, [embedderHook], "a hook kind the guard does not use survives");
});

// --- 2. wiring: every run path goes through the seam ---------------------------------------------

/** Records the `options` every mocked `query()` call receives, in call order. */
const captured: Options[] = [];
type ToolHandler = (args: { step: string; inputs?: string }) => Promise<unknown>;
/** The `dispatch_step` handler the hybrid-tool path registers, captured so a test can invoke it
 *  without a live orchestrator turn deciding to call it. */
let toolHandler: ToolHandler | null = null;
/** Read `toolHandler` through a function so its declared type survives: control-flow analysis
 *  narrows the variable itself to `null` (it is assigned `null` here and in the test, and TS cannot
 *  see the mocked `tool()` reassign it mid-run), which would make a direct read `never`. */
function registeredToolHandler(): ToolHandler | null {
  return toolHandler;
}

function resultMessage(): unknown {
  return {
    type: "result",
    subtype: "success",
    result: "done",
    session_id: "s1",
    total_cost_usd: 0,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  };
}

mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: (args: { options: Options }) => {
      captured.push(args.options);
      return (async function* () {
        yield resultMessage();
      })();
    },
    tool: (name: string, _d: string, _s: unknown, handler: typeof toolHandler) => {
      toolHandler = handler;
      return { name };
    },
    createSdkMcpServer: () => ({ name: "warble" }),
  },
});

function step(name: string, over: Partial<StagedStep> = {}): StagedStep {
  return {
    name,
    tier: "strong",
    provider: "anthropic",
    endpoint: null,
    model: "opus",
    consumes: [],
    produces: null,
    prompt: "do it",
    conditional: false,
    when: null,
    ...over,
  };
}

function plan(cwd: string, over: Partial<DispatchPlan["meta"]> = {}): DispatchPlan {
  const embedder: CanUseTool = async (_t, input) => {
    embedderCalls.push(_t);
    return { behavior: "allow", updatedInput: input };
  };
  return {
    prompt: "question",
    options: { cwd, canUseTool: embedder } as Options,
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
      mode: "single",
      providers: ["anthropic"],
      stagedSteps: [],
      setupScope: null,
      ...over,
    } as DispatchPlan["meta"],
  };
}

/** Tool names the embedder callback was asked about, across every path. */
const embedderCalls: string[] = [];

/**
 * The assertion each path shares: the `canUseTool` that reached `query()` consults the embedder AND
 * still enforces the floor. Reverting any one path's wiring to the pre-seam `canUseTool,` drops one
 * of the two, and this fails.
 */
async function assertComposedAt(options: Options, label: string): Promise<void> {
  assert.ok(options.canUseTool, `${label}: query() received a canUseTool`);
  const before = embedderCalls.length;
  const verdict = await options.canUseTool!("Bash", { command: "rm -rf /" }, NO_OPTS);
  assert.ok(embedderCalls.length > before, `${label}: the embedder's callback was consulted`);
  assert.equal(verdict.behavior, "deny", `${label}: the guardrail floor still fired`);
}

/** The hooks that reached `query()` must contain the embedder's, not just the guard's. */
function assertHooksKept(options: Options, embedderHook: unknown, label: string): void {
  assert.ok(
    (options.hooks?.PreToolUse ?? []).includes(embedderHook as never),
    `${label}: the embedder's PreToolUse hook survived`,
  );
}

test("main path composes the embedder's enforcement with the floor", async () => {
  const { runDispatch } = await import("../src/run.js");
  const dir = mkdtempSync(join(tmpdir(), "seam-main-"));
  try {
    captured.length = 0;
    const embedderHook = { hooks: [] } as never;
    const p = plan(dir);
    p.options.hooks = { PreToolUse: [embedderHook] };

    await runDispatch(p, { outDir: dir, warbleBin: "warble" });

    assert.equal(captured.length, 1);
    await assertComposedAt(captured[0]!, "main");
    assertHooksKept(captured[0]!, embedderHook, "main");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hybrid-staged step path composes the embedder's enforcement with the floor", async () => {
  const { runDispatch } = await import("../src/run.js");
  const dir = mkdtempSync(join(tmpdir(), "seam-staged-"));
  const prior = process.env["WARBLE_HYBRID_MODE"];
  delete process.env["WARBLE_HYBRID_MODE"];
  try {
    captured.length = 0;
    const embedderHook = { hooks: [] } as never;
    const p = plan(dir, { mode: "hybrid-staged", stagedSteps: [step("only_step")] });
    p.options.hooks = { PreToolUse: [embedderHook] };

    await runDispatch(p, { outDir: dir, warbleBin: "warble" });

    assert.equal(captured.length, 1, "one cloud step ran");
    await assertComposedAt(captured[0]!, "hybrid-staged");
    assertHooksKept(captured[0]!, embedderHook, "hybrid-staged");
  } finally {
    if (prior !== undefined) process.env["WARBLE_HYBRID_MODE"] = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hybrid-tool composes on both the orchestrator turn and the cloud step it spawns", async () => {
  const { runDispatch } = await import("../src/run.js");
  const dir = mkdtempSync(join(tmpdir(), "seam-tool-"));
  const prior = process.env["WARBLE_HYBRID_MODE"];
  process.env["WARBLE_HYBRID_MODE"] = "tool";
  try {
    captured.length = 0;
    toolHandler = null;
    const p = plan(dir, { mode: "hybrid-staged", stagedSteps: [step("only_step")] });

    await runDispatch(p, { outDir: dir, warbleBin: "warble" });

    assert.equal(captured.length, 1, "the orchestrator turn ran");
    // The orchestrator turn is guarded like any other. `allowedTools` only auto-approves; it does
    // not restrict, and `tools` is unset, so the built-in Bash/Write set is reachable on this turn —
    // an embedder allow must not be the only thing standing in front of it.
    await assertComposedAt(captured[0]!, "hybrid-tool orchestrator turn");

    // …and the one tool this turn legitimately needs is not caught by the floor's fail-closed arm.
    // The SDK's auto-approval list is documented to skip the callback, but nothing here exercises
    // that for an MCP name, so the callback answers for it either way: without this the whole path
    // would break the moment the SDK did consult it.
    const dispatch = await captured[0]!.canUseTool!(
      "mcp__warble__dispatch_step",
      { step: "only_step" },
      NO_OPTS,
    );
    assert.equal(dispatch.behavior, "allow", "the orchestrator can still dispatch its own steps");

    // Reach the cloud step the way the orchestrator would, without depending on a model deciding to.
    const handler = registeredToolHandler();
    if (handler === null) throw new Error("dispatch_step was never registered");
    captured.length = 0;
    await handler({ step: "only_step" });
    assert.equal(captured.length, 1, "the cloud step ran");
    await assertComposedAt(captured[0]!, "hybrid-tool cloud step");
  } finally {
    if (prior !== undefined) process.env["WARBLE_HYBRID_MODE"] = prior;
    else delete process.env["WARBLE_HYBRID_MODE"];
    rmSync(dir, { recursive: true, force: true });
  }
});
