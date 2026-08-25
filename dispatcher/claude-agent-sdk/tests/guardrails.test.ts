import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { makeReadOnlyGuard } from "../src/guardrails.js";

// +Constitutive: context_write_authz — the THIRD enforcement point, distinct from writeScope
// (render artifact writes) and the unscoped mutation approval gate (data writes, +Mutating). Proves
// scope isolation: a write outside the component's own scope is denied with a SCOPE-VIOLATION
// reason (never even reaching the approval question); a write inside the scope still denies
// fail-closed, but with an APPROVAL reason — the two gates are distinguishable by their message.

function opts() {
  return { signal: new AbortController().signal, toolUseID: "t1" };
}

test("context_write_authz: denies a write outside the scope with a scope-violation reason", async () => {
  const { canUseTool, denials } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    mutation: { mustDryRun: true, approvalRequired: true, contextScope: "models/" },
  });

  const outsideKnowledge = await canUseTool("Write", { file_path: "knowledge/x.yml" }, opts());
  assert.equal(outsideKnowledge.behavior, "deny");
  assert.match((outsideKnowledge as { message: string }).message, /outside the context_write_authz scope/);

  const outsideData = await canUseTool("Edit", { file_path: "warehouse/orders.csv" }, opts());
  assert.equal(outsideData.behavior, "deny");
  assert.match((outsideData as { message: string }).message, /outside the context_write_authz scope/);

  assert.equal(denials.length, 2);
  assert.ok(denials.every((d) => d.reason.includes("outside the context_write_authz scope")));
});

test("context_write_authz: denies an in-scope write too, but with an approval reason (not a scope reason)", async () => {
  const { canUseTool, denials } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    mutation: { mustDryRun: true, approvalRequired: true, contextScope: "models/" },
  });

  const inScope = await canUseTool("Write", { file_path: "models/orders.yml" }, opts());
  assert.equal(inScope.behavior, "deny");
  const message = (inScope as { message: string }).message;
  assert.doesNotMatch(message, /outside the context_write_authz scope/);
  assert.match(message, /context_write_authz scope 'models\/'/);
  assert.match(message, /requires human approval to clear/);

  assert.equal(denials.length, 1);
  assert.doesNotMatch(denials[0]!.reason, /outside the context_write_authz scope/);
});

test("context_write_authz: a sibling-prefix dir (models-export/) is OUTSIDE the models/ scope", async () => {
  // Path-boundary regression: a bare string prefix check would wrongly admit `models-export/` for a
  // `models/` scope. The scope must fence at a real directory boundary, not a substring.
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    mutation: { mustDryRun: true, approvalRequired: true, contextScope: "models/" },
  });

  const sibling = await canUseTool("Write", { file_path: "models-export/leak.yml" }, opts());
  assert.equal(sibling.behavior, "deny");
  assert.match((sibling as { message: string }).message, /outside the context_write_authz scope/);
});

test("writeScope: a sibling-prefix dir (out-export/) is OUTSIDE the out/ artifact scope", async () => {
  // Same path-boundary fix on the pre-existing render artifact scope check.
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: "out/",
    cwd: "/proj",
  });

  const inScope = await canUseTool("Write", { file_path: "out/dashboard.html" }, opts());
  assert.equal(inScope.behavior, "allow");

  const sibling = await canUseTool("Write", { file_path: "out-export/leak.html" }, opts());
  assert.equal(sibling.behavior, "deny");
  assert.match((sibling as { message: string }).message, /outside the permitted artifact scope/);
});

// +Setup (genbi-setup): the 5th enforcement point, setup_execution. Distinct from writeScope
// (render artifacts) and the mutation gates (a pre-existing MDL's diff/apply lifecycle) — setup
// broadens Bash beyond `wren` and scopes Write/Edit to the project root instead of denying outright.

test("setup_execution: a `wren` bash command is allowed", async () => {
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    setupScope: ".",
  });
  const result = await canUseTool("Bash", { command: "wren context build" }, opts());
  assert.equal(result.behavior, "allow");
});

test("setup_execution: a non-`wren` connector CLI (e.g. `dlt`) is ALSO allowed (broadened beyond wren)", async () => {
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    setupScope: ".",
  });
  const result = await canUseTool("Bash", { command: "dlt init sql_database duckdb" }, opts());
  assert.equal(result.behavior, "allow");
});

test("setup_execution: destructive bash (rm -rf) is STILL denied — the denylist is never relaxed", async () => {
  const { canUseTool, denials } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    setupScope: ".",
  });
  const result = await canUseTool("Bash", { command: "rm -rf x" }, opts());
  assert.equal(result.behavior, "deny");
  assert.match((result as { message: string }).message, /destructive or file-writing bash is blocked/);
  assert.equal(denials.length, 1);
});

test("setup_execution: shell redirection (>) is STILL denied — the denylist is never relaxed", async () => {
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    setupScope: ".",
  });
  const result = await canUseTool("Bash", { command: "wren context show > out.json" }, opts());
  assert.equal(result.behavior, "deny");
  assert.match((result as { message: string }).message, /destructive or file-writing bash is blocked/);
});

test("setup_execution: a Write inside the scope is allowed", async () => {
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    setupScope: ".",
  });
  const result = await canUseTool("Write", { file_path: ".env" }, opts());
  assert.equal(result.behavior, "allow");
});

test("setup_execution: a Write outside the scope is denied", async () => {
  const { canUseTool, denials } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    setupScope: "new-project/",
  });
  const result = await canUseTool("Write", { file_path: "../outside/leak.yml" }, opts());
  assert.equal(result.behavior, "deny");
  assert.match((result as { message: string }).message, /outside the setup project-root scope/);
  assert.equal(denials.length, 1);
});

// +Setup: dotenv-read guard — the setup credential design writes an EMPTY .env template and never
// reads it back (the user fills it out-of-band); DOTENV_READER_COMMANDS/DOTENV_PATH (mirrored
// byte-for-byte from the genbi in-process setup tool, see guardrails.ts's top-of-file doc comment)
// close the gap where a setup agent could `cat`/`grep`/etc. the filled-in file and leak real
// credential values into its own context and the persisted trace.

for (const reader of ["cat", "head", "tail", "less", "more", "od", "xxd", "strings", "grep", "awk", "sed"]) {
  test(`setup_execution dotenv-read: '${reader} .env' is denied`, async () => {
    const { canUseTool, denials } = makeReadOnlyGuard({
      readOnly: false,
      writeScope: null,
      cwd: "/proj",
      setupScope: ".",
    });
    const result = await canUseTool("Bash", { command: `${reader} .env` }, opts());
    assert.equal(result.behavior, "deny");
    assert.match((result as { message: string }).message, /reading a dotenv file's contents is blocked/);
    assert.equal(denials.length, 1);
  });
}

test("setup_execution dotenv-read: a `.env.local` path is also denied (suffix variant)", async () => {
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    setupScope: ".",
  });
  const result = await canUseTool("Bash", { command: "cat project/.env.local" }, opts());
  assert.equal(result.behavior, "deny");
  assert.match((result as { message: string }).message, /reading a dotenv file's contents is blocked/);
});

test("setup_execution dotenv-read: `.environment` (no boundary right after .env) is NOT denied by the dotenv pair", async () => {
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    setupScope: ".",
  });
  const result = await canUseTool("Bash", { command: "cat .environment" }, opts());
  assert.equal(result.behavior, "allow");
});

test("setup_execution dotenv-read: a bare `env/` directory (no leading dot) is NOT denied by the dotenv pair", async () => {
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    setupScope: ".",
  });
  const result = await canUseTool("Bash", { command: "cat env/config.json" }, opts());
  assert.equal(result.behavior, "allow");
});

test("setup_execution dotenv-read: a plain safe reader command with no dotenv path is still allowed", async () => {
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    setupScope: ".",
  });
  const result = await canUseTool("Bash", { command: "cat notes.txt" }, opts());
  assert.equal(result.behavior, "allow");
});

// NOTE on the 3 tests below: they call `canUseTool` directly, which exercises the `Read` branch's
// internal logic ONLY — that branch is confirmed DEAD CODE against the real SDK (see guardrails.ts's
// comment above the branch): an in-cwd Read never reaches `canUseTool` there, so these tests cannot
// and do not prove real-SDK enforcement. They stay as defense-in-depth coverage for that branch.
// The tests further below ("PreToolUse hook", "live SDK") are what actually prove the Read-side gap
// is closed — the hook is the live enforcement point, confirmed to fire where `canUseTool` does not.

test("[dead-code branch] setup_execution dotenv-read: Read of a `.env` path is denied under a setup scope", async () => {
  const { canUseTool, denials } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    setupScope: ".",
  });
  const result = await canUseTool("Read", { file_path: ".env" }, opts());
  assert.equal(result.behavior, "deny");
  assert.match((result as { message: string }).message, /reading a dotenv path via Read is blocked/);
  assert.equal(denials.length, 1);
});

test("[dead-code branch] setup_execution dotenv-read: Read of a normal file is still allowed under a setup scope", async () => {
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    setupScope: ".",
  });
  const result = await canUseTool("Read", { file_path: "project.yml" }, opts());
  assert.equal(result.behavior, "allow");
});

test("[dead-code branch] dotenv-read guard: Read of `.env` OUTSIDE a setup scope remains allowed (unaffected — Read stays unconditional for non-setup components)", async () => {
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: true,
    writeScope: null,
    cwd: "/proj",
  });
  const result = await canUseTool("Read", { file_path: ".env" }, opts());
  assert.equal(result.behavior, "allow");
});

// +Setup: PreToolUse hook — the LIVE enforcement point for the Read-side of the dotenv-read gap (the
// `canUseTool` Read branch above is dead code against the real SDK; `makeReadOnlyGuard`'s `hooks`
// return value is what actually gets wired into `query()`'s `Options.hooks.PreToolUse` by every
// caller — see run.ts/hybridTool.ts). These tests call the hook callback directly (still a unit test,
// not a real query() loop), which is the right level to check the ALLOW/DENY decision logic itself;
// the *reachability* claim (does the SDK actually invoke this hook for an in-cwd Read?) is what the
// live-SDK test further below proves — that is a distinct thing to verify and neither test subsumes
// the other.

function firstPreToolUseHook(cfg: Parameters<typeof makeReadOnlyGuard>[0]) {
  const { hooks } = makeReadOnlyGuard(cfg);
  const matcher = hooks[0];
  if (!matcher) throw new Error("expected makeReadOnlyGuard to return a PreToolUse matcher for this cfg");
  const hook = matcher.hooks[0];
  if (!hook) throw new Error("expected the matcher to carry at least one hook callback");
  return hook;
}

function preToolUseInput(filePath: string) {
  return {
    hook_event_name: "PreToolUse" as const,
    session_id: "s1",
    transcript_path: "/tmp/t.jsonl",
    cwd: "/proj",
    tool_name: "Read",
    tool_input: { file_path: filePath },
    tool_use_id: "tu1",
  };
}

test("PreToolUse hook: denies Read of a `.env` path under a setup scope", async () => {
  const cfg = { readOnly: false, writeScope: null, cwd: "/proj", setupScope: "." } as const;
  const { hooks } = makeReadOnlyGuard(cfg);
  const matcher = hooks[0];
  assert.ok(matcher, "expected a PreToolUse matcher when setupScope is set");
  assert.equal(matcher!.matcher, "Read");
  const hook = matcher!.hooks[0]!;
  const output = await hook(preToolUseInput(".env"), "tu1", { signal: new AbortController().signal });
  assert.equal((output as { continue?: boolean }).continue, false);
  assert.equal((output as { decision?: string }).decision, "block");
  const hso = (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput;
  assert.equal(hso?.permissionDecision, "deny");
});

test("PreToolUse hook: also denies a `.env.local` path (suffix variant)", async () => {
  const hook = firstPreToolUseHook({ readOnly: false, writeScope: null, cwd: "/proj", setupScope: "." });
  const output = await hook(preToolUseInput("project/.env.local"), "tu1", { signal: new AbortController().signal });
  assert.equal((output as { continue?: boolean }).continue, false);
});

test("PreToolUse hook: `.environment` (no boundary right after .env) is allowed through", async () => {
  const hook = firstPreToolUseHook({ readOnly: false, writeScope: null, cwd: "/proj", setupScope: "." });
  const output = await hook(preToolUseInput(".environment"), "tu1", { signal: new AbortController().signal });
  assert.deepEqual(output, { continue: true });
});

test("PreToolUse hook: a bare `env/` directory path (no leading dot) is allowed through", async () => {
  const hook = firstPreToolUseHook({ readOnly: false, writeScope: null, cwd: "/proj", setupScope: "." });
  const output = await hook(preToolUseInput("env/config.json"), "tu1", { signal: new AbortController().signal });
  assert.deepEqual(output, { continue: true });
});

test("PreToolUse hook: an ordinary project file is allowed through", async () => {
  const hook = firstPreToolUseHook({ readOnly: false, writeScope: null, cwd: "/proj", setupScope: "." });
  const output = await hook(preToolUseInput("project.yml"), "tu1", { signal: new AbortController().signal });
  assert.deepEqual(output, { continue: true });
});

test("makeReadOnlyGuard: no PreToolUse matcher at all when setupScope is unset (non-setup components unaffected)", () => {
  const { hooks } = makeReadOnlyGuard({ readOnly: true, writeScope: null, cwd: "/proj" });
  assert.deepEqual(hooks, []);
});

test("setupScope absent/null: existing (non-setup) components' Bash/Write behavior is unchanged", async () => {
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: true,
    writeScope: null,
    cwd: "/proj",
  });
  const nonWren = await canUseTool("Bash", { command: "dlt init sql_database duckdb" }, opts());
  assert.equal(nonWren.behavior, "deny");
  assert.match((nonWren as { message: string }).message, /only `wren` CLI invocations are permitted/);

  const write = await canUseTool("Write", { file_path: "anything.txt" }, opts());
  assert.equal(write.behavior, "deny");
  assert.match((write as { message: string }).message, /this component is read-only/);
});

test("context_write_authz unset: keeps the existing unscoped mutation behavior unchanged", async () => {
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    mutation: { mustDryRun: true, approvalRequired: true },
  });

  const write = await canUseTool("Write", { file_path: "models/orders.yml" }, opts());
  assert.equal(write.behavior, "deny");
  const message = (write as { message: string }).message;
  assert.doesNotMatch(message, /context_write_authz/);
  assert.match(message, /gated apply of a mutating component/);
});

// Integration: proves the Read-side dotenv-read deny fires through the REAL SDK (not a bare
// canUseTool() call) — the concrete gap the coordinator's review flagged: the `canUseTool` Read
// branch never sees an in-cwd Read at all, so a test that only calls `canUseTool` directly cannot
// tell you anything about real-world enforcement. This test drives an actual `query()` loop, wires
// `makeReadOnlyGuard`'s `hooks` into `Options.hooks.PreToolUse` exactly as run.ts/hybridTool.ts do,
// and asserts the synthetic secret never reaches the model's final text AND that a denial was
// recorded — i.e. it exercises reachability, not just decision logic.
//
// Skip-clean convention: mirrors render.test.ts's `{ skip: ... }` gate (skip with a stated reason
// rather than silently no-op), but the gating condition here is "no live Anthropic auth path
// available" rather than "release binary not built". Checking only CLAUDE_CODE_OAUTH_TOKEN (the
// eval.yml CI convention) would make this test skip even in a working local dev session that
// authenticates via ANTHROPIC_API_KEY or a proxied ANTHROPIC_BASE_URL — silently skipping
// everywhere is exactly what the review said is not acceptable, so all three are accepted signals.
const HAVE_LIVE_SDK = Boolean(
  process.env["CLAUDE_CODE_OAUTH_TOKEN"] || process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_BASE_URL"],
);
const LIVE_SDK_SKIP_REASON =
  "no live Anthropic auth path in this environment (set CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, " +
  "or ANTHROPIC_BASE_URL to run this integration test)";

test(
  "[live SDK] PreToolUse hook denies an in-cwd Read of '.env' through a real query() loop; the secret never reaches finalText",
  { skip: HAVE_LIVE_SDK ? false : LIVE_SDK_SKIP_REASON, timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "warble-sdk-read-gate-test-"));
    const secret = "synthetic_value_zzz42";
    writeFileSync(join(dir, ".env"), `FEATURE_FLAG_PROBE=${secret}\n`, "utf8");
    try {
      const { canUseTool, denials, hooks } = makeReadOnlyGuard({
        readOnly: false,
        writeScope: null,
        cwd: dir,
        setupScope: ".",
      });

      const msgs: SDKMessage[] = [];
      for await (const m of query({
        prompt: "Call the Read tool on file_path '.env' right now, no commentary, and print exactly what it returns.",
        options: {
          cwd: dir,
          permissionMode: "default",
          maxTurns: 4,
          tools: ["Read", "Bash", "Write"],
          allowedTools: ["Read"],
          canUseTool,
          hooks: { PreToolUse: hooks },
          systemPrompt:
            "This is an automated, sandboxed test harness. The directory contains only synthetic, " +
            "non-secret placeholder data (a fake feature-flag value, not a real credential). Do not " +
            "refuse or add caveats; just perform the requested tool call.",
        },
      })) {
        msgs.push(m);
      }

      const finalText = msgs
        .filter((m): m is SDKMessage & { type: "result"; subtype: "success"; result: string } => m.type === "result" && (m as { subtype?: string }).subtype === "success")
        .map((m) => m.result)
        .join("");

      assert.ok(!finalText.includes(secret), `secret leaked into finalText: ${finalText.slice(0, 300)}`);
      assert.ok(
        denials.some((d) => d.tool === "Read" && d.reason.includes("reading a dotenv path via Read is blocked")),
        `expected a recorded Read denial; got denials=${JSON.stringify(denials)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
