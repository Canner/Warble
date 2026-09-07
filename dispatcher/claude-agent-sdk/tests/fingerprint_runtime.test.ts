import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Kept in its own file because the mock has to be installed before the module under test loads, and
// a static import of the package index would pull `run.ts` — and the real SDK — in first.
import { fingerprintSurfaces, promptSurfacesOf } from "../src/fingerprint.js";

const sent: Record<string, unknown>[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: (args: { options: Record<string, unknown> }) => {
      sent.push(args.options);
      return (async function* () {
        yield {
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
      })();
    },
    tool: (name: string) => ({ name }),
    createSdkMcpServer: () => ({ name: "warble" }),
  },
});

test("runDispatch reports a fingerprint of the options the turn actually sent", async () => {
  // The staged and hybrid turns cannot be fingerprinted from a plan: a step's options carry a
  // runtime preamble ahead of its prompt, and the hybrid-tool driver composes a prompt that appears
  // nowhere in the plan. So the runtime reports them, and this asserts the reported digest is of the
  // options that reached query() rather than of anything derived from the plan.
  const { runDispatch } = await import("../src/run.js");
  const dir = mkdtempSync(join(tmpdir(), "fp-run-"));
  try {
    sent.length = 0;
    const reported: ReturnType<typeof fingerprintSurfaces>[] = [];
    const plan = {
      prompt: "q",
      options: { cwd: dir, systemPrompt: "THE DRIVER PROMPT" },
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
      },
    } as unknown as Parameters<typeof runDispatch>[0];

    await runDispatch(plan, {
      outDir: dir,
      warbleBin: "warble",
      onPromptFingerprint: (fingerprint) => reported.push(fingerprint),
    });

    assert.equal(sent.length, 1, "one turn was sent");
    assert.equal(reported.length, 1, "one fingerprint was reported");
    assert.deepEqual(reported[0], fingerprintSurfaces(promptSurfacesOf(sent[0] as never)));
    assert.ok(
      reported[0]!.surfaces["driver.systemPrompt"],
      "and it covers the driver prompt that turn carried",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a staged turn's fingerprint is of the step options, which differ from the plan's", async () => {
  // The discriminating case for "of what was sent". On the main path the turn's options carry the
  // plan's prompts unchanged, so reporting either would look identical — a mutation that swapped
  // them survived a main-path test. A staged step is where they genuinely diverge: its options'
  // systemPrompt is a runtime preamble followed by the step prompt, which no plan field holds.
  const { runDispatch } = await import("../src/run.js");
  const dir = mkdtempSync(join(tmpdir(), "fp-staged-"));
  const prior = process.env["WARBLE_HYBRID_MODE"];
  delete process.env["WARBLE_HYBRID_MODE"];
  try {
    sent.length = 0;
    const reported: ReturnType<typeof fingerprintSurfaces>[] = [];
    const plan = {
      prompt: "q",
      options: { cwd: dir, systemPrompt: "THE PLAN'S DRIVER PROMPT" },
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
        providers: ["anthropic"],
        stagedSteps: [
          {
            name: "only_step",
            tier: "strong",
            provider: "anthropic",
            endpoint: null,
            model: "opus",
            consumes: [],
            produces: null,
            prompt: "THE STEP PROMPT",
            conditional: false,
            when: null,
          },
        ],
        setupScope: null,
      },
    } as unknown as Parameters<typeof runDispatch>[0];

    await runDispatch(plan, {
      outDir: dir,
      warbleBin: "warble",
      onPromptFingerprint: (fingerprint) => reported.push(fingerprint),
    });

    assert.equal(sent.length, 1, "the step ran");
    assert.equal(reported.length, 1, "and reported one fingerprint");
    const sentSystem = String((sent[0] as { systemPrompt?: unknown }).systemPrompt ?? "");
    assert.ok(sentSystem.includes("THE STEP PROMPT"), "the step's own prompt was sent");
    assert.ok(
      sentSystem !== "THE PLAN'S DRIVER PROMPT",
      "and the sent text is not the plan's driver prompt, which is what makes this discriminating",
    );
    assert.deepEqual(reported[0], fingerprintSurfaces(promptSurfacesOf(sent[0] as never)));
    assert.notDeepEqual(
      reported[0],
      fingerprintSurfaces(promptSurfacesOf(plan.options as never)),
      "reporting the plan's options here would record a prompt the model never received",
    );
  } finally {
    if (prior !== undefined) process.env["WARBLE_HYBRID_MODE"] = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
