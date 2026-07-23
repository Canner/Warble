import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { prepareDispatch, emitAgentModule } from "../src/index.js";

const RENDER_DEMO_IR = fileURLToPath(new URL("../../../examples/render-demo/ir.golden.json", import.meta.url));
const DEMO_AGENT_IR = fileURLToPath(new URL("../../../examples/demo-agent/ir.golden.json", import.meta.url));

function emit(irPath: string, standalone: boolean): string {
  const prepared = prepareDispatch({ ir: readFileSync(irPath, "utf8"), irPath });
  return emitAgentModule(prepared, { standalone });
}

test("emit thin: imports the SDK + @warble helpers and exports a per-verb run()", () => {
  const src = emit(DEMO_AGENT_IR, false);
  assert.match(src, /from "@anthropic-ai\/claude-agent-sdk"/);
  assert.match(src, /from "@warble\/claude-agent-sdk"/);
  assert.match(src, /export async function generate_dashboard\(question: string/);
  assert.match(src, /satisfies Options/);
  assert.match(src, /Mode: thin/);
  // the split driver's frozen options carry the orchestrator model + subagents
  assert.match(src, /"model": "sonnet"/);
  assert.match(src, /generate_dashboard__plan_dashboard/);
});

test("emit standalone: no @warble import, inlines guard + trace + render shell", () => {
  const src = emit(RENDER_DEMO_IR, true);
  assert.doesNotMatch(src, /from "@warble\/claude-agent-sdk"/);
  assert.match(src, /Mode: standalone/);
  assert.match(src, /function makeReadOnlyGuard\(/);
  assert.match(src, /function aggregateTrace\(/);
  assert.match(src, /function renderEnvelope\(/);
  assert.match(src, /from "@anthropic-ai\/claude-agent-sdk"/);
  assert.match(src, /export async function dashboard\(question: string/);
});

test("emitted run() wraps renderEnvelope in try/catch and degrades on a best-effort render failure (never throws)", () => {
  const src = emit(RENDER_DEMO_IR, false);
  assert.match(src, /renderDegraded: \{ reason: string \} \| null/, "RunResult type carries renderDegraded");
  assert.match(src, /let renderDegraded: \{ reason: string \} \| null = null;/);
  assert.match(src, /if \(gate\.onFailure !== "degrade"\) throw err;/, "onFailure absent/'fail' still rethrows");
  assert.match(src, /renderDegraded = \{ reason: err instanceof Error \? err\.message : String\(err\) \};/);
  assert.match(src, /return \{ finalText, trace, htmlPath, denials, renderDegraded \};/);
  // render-demo resolves render_contract as best-effort on this target — the emitted per-component
  // meta must carry that decision as the additive onFailure facet.
  assert.match(src, /"onFailure": "degrade"/);
});

test("emitted standalone mode shares the identical degrade-on-failure run() body (thin and standalone are one shared template)", () => {
  const src = emit(RENDER_DEMO_IR, true);
  assert.match(src, /if \(gate\.onFailure !== "degrade"\) throw err;/);
  assert.match(src, /"onFailure": "degrade"/);
});

test("emitted frozen options round-trip as JSON (the resolved query options)", () => {
  const src = emit(RENDER_DEMO_IR, false);
  // pull the `dashboard_options = { ... } satisfies Options;` object and parse it
  const m = /const dashboard_options = (\{[\s\S]*?\}) satisfies Options;/.exec(src);
  assert.ok(m, "found the frozen options literal");
  const options = JSON.parse(m![1]!) as Record<string, unknown>;
  assert.equal(options["model"], "opus");
  assert.equal(options["permissionMode"], "default");
  assert.deepEqual(options["tools"], ["Read", "Bash"]);
  assert.match(String(options["systemPrompt"]), /FINAL message must be a SINGLE JSON object/);
});
