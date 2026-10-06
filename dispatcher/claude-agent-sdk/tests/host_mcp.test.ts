import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CanUseTool, Options } from "@anthropic-ai/claude-agent-sdk";

// Kept in its own file because the SDK mock must be installed before `run.ts` loads; `run.ts` and
// `session.ts` are therefore imported dynamically inside the tests below.
import { composeHooks, makeReadOnlyGuard } from "../src/guardrails.js";
import { loadHostMcpConfig, parseHostMcpConfig, type HostMcpConfig } from "../src/hostMcp.js";
import type { DispatchPlan } from "../src/options.js";

const NO_OPTS = { signal: new AbortController().signal } as unknown as Parameters<CanUseTool>[2];
const CLI_TS = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const DEMO_IR = fileURLToPath(new URL("../../../examples/demo-agent/ir.golden.json", import.meta.url));

const sent: Options[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: (args: { options: Options }) => {
      sent.push(args.options);
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "done",
          session_id: `s${sent.length}`,
          total_cost_usd: 0,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          usage: { input_tokens: 1, output_tokens: 1 },
          modelUsage: {},
        };
      })();
    },
    tool: (name: string) => ({ name }),
    createSdkMcpServer: () => ({ name: "warble" }),
  },
});

const VALID = {
  name: "host_tools",
  command: "/usr/local/bin/host-mcp",
  args: ["--token-file", "/run/host/secret-token-path"],
  tools: ["query", "persist"],
  instruction: "Use host_tools.query to run read-only SQL through the host.",
};

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "host-mcp-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfig(dir: string, value: unknown, mode = 0o600, file = "host-mcp.json"): string {
  const path = join(dir, file);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  chmodSync(path, mode);
  return path;
}

function plan(cwd: string, over: Partial<DispatchPlan["meta"]> = {}): DispatchPlan {
  return {
    prompt: "question",
    options: {
      cwd,
      systemPrompt: "THE PLAN'S SYSTEM PROMPT",
      tools: ["Read", "Bash"],
      allowedTools: ["Read"],
      disallowedTools: [],
    } as Options,
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

/** A fixed battery of tool calls whose decisions must not move when no host config is given. */
const BATTERY: [string, Record<string, unknown>][] = [
  ["Read", { file_path: "x.txt" }],
  ["Bash", { command: "wren -q -o json -s 'select 1'" }],
  ["Bash", { command: "rm -rf /" }],
  ["Bash", { command: "cat notes.txt" }],
  ["Write", { file_path: "out.txt" }],
  ["Task", {}],
  ["mcp__host_tools__query", {}],
  ["mcp__genbi_session__query", {}],
  ["mcp__anything__else", {}],
  ["WebFetch", { url: "https://example.test" }],
];

async function decisions(canUseTool: CanUseTool): Promise<string[]> {
  const out: string[] = [];
  for (const [tool, input] of BATTERY) out.push((await canUseTool(tool, input, NO_OPTS)).behavior);
  return out;
}

// --- config validation --------------------------------------------------------------------------

test("a valid config loads, keeping exactly the declared fields", () => {
  withTempDir((dir) => {
    assert.deepEqual(loadHostMcpConfig(writeConfig(dir, VALID)), VALID);
    const { instruction: _omit, ...noInstruction } = VALID;
    assert.deepEqual(loadHostMcpConfig(writeConfig(dir, noInstruction, 0o600, "b.json")), noInstruction);
  });
});

test("a relative path is rejected", () => {
  assert.throws(() => loadHostMcpConfig("host-mcp.json"), /path must be absolute/);
});

test("a symlink is rejected even when it points at a valid config", () => {
  withTempDir((dir) => {
    const real = writeConfig(dir, VALID);
    const link = join(dir, "link.json");
    symlinkSync(real, link);
    assert.throws(() => loadHostMcpConfig(link), /must not be a symbolic link/);
  });
});

test("a group- or world-accessible file is rejected", () => {
  withTempDir((dir) => {
    for (const mode of [0o640, 0o604, 0o620, 0o602, 0o644]) {
      const path = writeConfig(dir, VALID, mode, `m${mode.toString(8)}.json`);
      assert.throws(
        () => loadHostMcpConfig(path),
        /not be accessible by group or others/,
        `mode ${mode.toString(8)} must be rejected`,
      );
    }
  });
});

test("a directory is rejected", () => {
  withTempDir((dir) => {
    assert.throws(() => loadHostMcpConfig(dir), /regular file/);
  });
});

test("field validation rejects bad names, tools, instructions and unknown keys", () => {
  const cases: [string, unknown, RegExp][] = [
    ["bad name", { ...VALID, name: "Host-Tools" }, /'name' must match/],
    ["long name", { ...VALID, name: "a".repeat(33) }, /'name' must match/],
    ["empty tools", { ...VALID, tools: [] }, /'tools' must be a non-empty array/],
    ["bad tool", { ...VALID, tools: ["query", "Drop*"] }, /each of 'tools' must match/],
    ["dup tool", { ...VALID, tools: ["query", "query"] }, /must not repeat/],
    ["unknown key", { ...VALID, env: { A: "b" } }, /unknown key 'env'/],
    ["relative command", { ...VALID, command: "host-mcp" }, /'command' must be an absolute path/],
    ["non-string arg", { ...VALID, args: ["--x", 1] }, /'args' must be an array of strings/],
    ["multi-line instruction", { ...VALID, instruction: "one\ntwo" }, /single line/],
    ["long instruction", { ...VALID, instruction: "x".repeat(301) }, /at most 300/],
    ["not an object", ["name"], /JSON object/],
  ];
  for (const [label, value, re] of cases) {
    assert.throws(() => parseHostMcpConfig(value), re, label);
  }
  assert.doesNotThrow(() => parseHostMcpConfig({ ...VALID, instruction: "x".repeat(300) }));
});

test("rejections never echo the file's contents or args", () => {
  withTempDir((dir) => {
    const leaky = writeConfig(dir, { ...VALID, name: "BAD", args: ["secret-arg-value"] });
    const notJson = writeConfig(dir, "{ secret-arg-value", 0o600, "nj.json");
    for (const path of [leaky, notJson]) {
      try {
        loadHostMcpConfig(path);
        assert.fail("expected a rejection");
      } catch (e) {
        assert.doesNotMatch((e as Error).message, /secret-arg-value/);
      }
    }
  });
});

// --- guardrail ----------------------------------------------------------------------------------

test("the guard allows exactly the listed host tools and nothing else under mcp__", async () => {
  const guard = makeReadOnlyGuard({
    readOnly: true,
    writeScope: null,
    cwd: "/tmp",
    setupScope: null,
    hostMcpTools: ["mcp__host_tools__query", "mcp__host_tools__persist"],
  });
  const verdict = async (tool: string) => (await guard.canUseTool(tool, {}, NO_OPTS)).behavior;

  assert.equal(await verdict("mcp__host_tools__query"), "allow");
  assert.equal(await verdict("mcp__host_tools__persist"), "allow");
  assert.equal(await verdict("mcp__host_tools__drop_table"), "deny", "unlisted tool, same server");
  assert.equal(await verdict("mcp__other__query"), "deny", "listed tool name, other server");
  assert.equal(await verdict("mcp__host_tools__query_all"), "deny", "prefix of a listed tool");
  assert.equal(await verdict("mcp__host_tools__"), "deny");
  // The Bash rules are untouched by the host tools.
  const bash = async (command: string) => (await guard.canUseTool("Bash", { command }, NO_OPTS)).behavior;
  assert.equal(await bash("wren -q -o json -s 'select 1'"), "allow");
  assert.equal(await bash("rm -rf /"), "deny");
  assert.equal(await bash("curl https://example.test"), "deny");
});

// --- chat session wiring (query() mocked) -------------------------------------------------------

test("chat with a host config hands query() the stdio server, the guard and the instruction", async () => {
  const { createChatSession } = await import("../src/session.js");
  const dir = mkdtempSync(join(tmpdir(), "host-mcp-chat-"));
  try {
    sent.length = 0;
    const hostMcp: HostMcpConfig = { ...VALID, tools: ["query"] };
    const p = plan(dir);
    const session = createChatSession(p, { outDir: dir, warbleBin: "warble", hostMcp });
    await session.ask("first");
    await session.ask("second");

    assert.equal(sent.length, 2);
    for (const options of sent) {
      assert.deepEqual(options.mcpServers, {
        host_tools: { type: "stdio", command: VALID.command, args: VALID.args },
      });
      const canUseTool = options.canUseTool!;
      assert.equal((await canUseTool("mcp__host_tools__query", {}, NO_OPTS)).behavior, "allow");
      assert.equal((await canUseTool("mcp__host_tools__persist", {}, NO_OPTS)).behavior, "deny");
      assert.equal((await canUseTool("mcp__other__query", {}, NO_OPTS)).behavior, "deny");

      const system = options.systemPrompt as string;
      assert.equal(system, `THE PLAN'S SYSTEM PROMPT\n${VALID.instruction}`);
      assert.equal(system.split(VALID.instruction).length - 1, 1, "instruction appears exactly once");
    }
    assert.equal(p.options.systemPrompt, "THE PLAN'S SYSTEM PROMPT", "the plan itself is not mutated");
    assert.equal(p.options.mcpServers, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat without a host config sends exactly today's options and guard decisions", async () => {
  const { createChatSession } = await import("../src/session.js");
  const dir = mkdtempSync(join(tmpdir(), "host-mcp-none-"));
  try {
    sent.length = 0;
    const p = plan(dir);
    await createChatSession(p, { outDir: dir, warbleBin: "warble" }).ask("q");

    assert.equal(sent.length, 1);
    const { canUseTool, hooks, env, ...rest } = sent[0]!;
    assert.deepEqual(rest, p.options, "every non-runtime option is the plan's, byte for byte");
    assert.ok(!("mcpServers" in sent[0]!), "no mcpServers key at all");
    assert.deepEqual(hooks, composeHooks(undefined, []));
    assert.equal(typeof env, "object");

    const stock = makeReadOnlyGuard({ readOnly: true, writeScope: null, cwd: dir, setupScope: null });
    assert.deepEqual(await decisions(canUseTool!), await decisions(stock.canUseTool));
    assert.ok((await decisions(canUseTool!)).every((d, i) => !BATTERY[i]![0].startsWith("mcp__") || d === "deny"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a host config is refused on a hybrid-staged plan and on a server-name collision", async () => {
  const { runDispatch } = await import("../src/run.js");
  const dir = mkdtempSync(join(tmpdir(), "host-mcp-refuse-"));
  try {
    await assert.rejects(
      runDispatch(plan(dir, { mode: "hybrid-staged" }), { outDir: dir, warbleBin: "warble", hostMcp: VALID }),
      /not supported for a hybrid-staged plan/,
    );
    const p = plan(dir);
    p.options.mcpServers = { host_tools: { type: "stdio", command: "/bin/true" } };
    await assert.rejects(
      runDispatch(p, { outDir: dir, warbleBin: "warble", hostMcp: VALID }),
      /already used by this plan/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI ----------------------------------------------------------------------------------------

function runCli(args: string[]): { stderr: string; status: number } {
  try {
    execFileSync(process.execPath, ["--import", "tsx", CLI_TS, ...args], {
      encoding: "utf8",
      input: "",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stderr?: string; status?: number };
    return { stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

test("the CLI refuses a rejected config before dispatching, and the flag outside chat", () => {
  withTempDir((dir) => {
    const relative = runCli(["chat", DEMO_IR, "--out", dir, "--host-mcp-config", "host-mcp.json"]);
    assert.notEqual(relative.status, 0);
    assert.match(relative.stderr, /path must be absolute/);

    const open = writeConfig(dir, VALID, 0o644);
    const worldReadable = runCli(["chat", DEMO_IR, "--out", dir, "--host-mcp-config", open]);
    assert.notEqual(worldReadable.status, 0);
    assert.match(worldReadable.stderr, /not be accessible by group or others/);
    assert.doesNotMatch(worldReadable.stderr, /secret-token-path/);

    const elsewhere = runCli(["manifest", DEMO_IR, "--host-mcp-config", open]);
    assert.notEqual(elsewhere.status, 0);
    assert.match(elsewhere.stderr, /only accepted by `chat`/);
  });
});
