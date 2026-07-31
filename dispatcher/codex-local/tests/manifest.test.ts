import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildManifest, describeTarget, prepareAllSetup } from "../src/index.js";
import { fakeMcp, SETUP_IR_PATH } from "./helpers.js";

const GOLDEN = fileURLToPath(
  new URL("./fixtures/genbi-setup.manifest.golden.json", import.meta.url),
);

function prepared() {
  return prepareAllSetup(readFileSync(SETUP_IR_PATH, "utf8"), {
    model: "gpt-5.4",
    mcp: fakeMcp(),
  });
}

test("target-resolved Setup manifest matches the committed golden", () => {
  const actual = buildManifest(prepared());
  const expected = JSON.parse(readFileSync(GOLDEN, "utf8"));
  assert.deepEqual(actual, expected);
});

test("describe exposes target, steps' tier surface, capabilities, tools, and guardrails", () => {
  assert.deepEqual(describeTarget(prepared()), {
    target: "codex:local",
    phase: "setup-only",
    execution_modes: ["one_shot", "persistent_session"],
    session_persistence: "codex_thread_history",
    lifecycle_operations: ["start", "resume", "read", "turn", "steer", "interrupt", "fork"],
    supported_components: ["connect_source", "build_context"],
    tiers: ["strong"],
    capabilities: ["source_connect", "llm:strong", "context_build"],
    tools: ["probe_setup"],
    guardrails: ["setup_execution", "isolated_codex_config"],
  });
});
