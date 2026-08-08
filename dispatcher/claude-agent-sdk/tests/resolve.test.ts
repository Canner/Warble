import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseIr, type ComponentNode } from "../src/ir.js";
import {
  collectRequiredCapabilities,
  resolveNodeCapabilities,
  resolveCapabilities,
} from "../src/resolve.js";
import { localProfile } from "../src/targets.js";
import { DispatchError } from "../src/error.js";

const DEMO_AGENT_IR = fileURLToPath(new URL("../../../examples/demo-agent/ir.golden.json", import.meta.url));
const RENDER_DEMO_IR = fileURLToPath(new URL("../../../examples/render-demo/ir.golden.json", import.meta.url));
const GENBI_SETUP_IR = fileURLToPath(new URL("../../../genbi-setup/ir.golden.json", import.meta.url));

function node(path: string): ComponentNode {
  return parseIr(readFileSync(path, "utf8")).components[0]!;
}

function nodeByVerb(path: string, verb: string): ComponentNode {
  const found = parseIr(readFileSync(path, "utf8")).components.find((c) => c.verb === verb);
  if (!found) throw new Error(`no component with verb '${verb}' in ${path}`);
  return found;
}

function outcomeOf(report: ReturnType<typeof resolveNodeCapabilities>, cap: string) {
  return report.find((r) => r.capability === cap)?.outcome;
}

test("render-demo (single tier + render) resolves fully on claude-agent-sdk:local", () => {
  const report = resolveNodeCapabilities(node(RENDER_DEMO_IR), "claude-agent-sdk:local");
  assert.equal(outcomeOf(report, "sql_execution:read_only"), "native");
  assert.equal(outcomeOf(report, "render_contract"), "realize-via");
  assert.equal(outcomeOf(report, "artifact_write"), "realize-via");
  assert.equal(outcomeOf(report, "llm:strong"), "native");
  assert.ok(!report.some((r) => r.outcome === "fail"));
});

test("per-step tier is NATIVE here (the differentiator vs the file target's realize-via)", () => {
  // demo-agent has two tiers → llm:per_step_tier is implied, and native on this target.
  const report = resolveNodeCapabilities(node(DEMO_AGENT_IR), "claude-agent-sdk:local");
  const perStep = report.find((r) => r.capability === "llm:per_step_tier");
  assert.equal(perStep?.outcome, "native");
  assert.equal(perStep?.provided_by, "runtime");
});

test("collectRequiredCapabilities unions declared + implied (per_step_tier, render_contract)", () => {
  const caps = collectRequiredCapabilities(node(DEMO_AGENT_IR));
  assert.ok(caps.includes("llm:per_step_tier"), "implied by 2 distinct tiers");
  assert.ok(caps.includes("render_contract"), "implied by non-empty render_blocks");
  // order-preserving + de-duplicated (per_step_tier already declared, appears once)
  assert.equal(caps.filter((c) => c === "llm:per_step_tier").length, 1);
});

test("semantic_introspection resolves realize-via on claude-agent-sdk:local", () => {
  const base = node(RENDER_DEMO_IR);
  const introspecting: ComponentNode = {
    ...base,
    required_capabilities: [...base.required_capabilities, "semantic_introspection"],
  };
  const report = resolveNodeCapabilities(introspecting, "claude-agent-sdk:local");
  const entry = report.find((r) => r.capability === "semantic_introspection");
  assert.equal(entry?.outcome, "realize-via");
  assert.equal(entry?.provided_by, "runtime");
  assert.ok(!report.some((r) => r.outcome === "fail"));
});

test("raw_material_read resolves natively through the cwd-scoped SDK Read tool", () => {
  const base = node(RENDER_DEMO_IR);
  const rawReader: ComponentNode = {
    ...base,
    required_capabilities: [...base.required_capabilities, "raw_material_read"],
  };
  const report = resolveNodeCapabilities(rawReader, "claude-agent-sdk:local");
  const entry = report.find((r) => r.capability === "raw_material_read");
  assert.equal(entry?.outcome, "native");
  assert.equal(entry?.provided_by, "runtime");
  assert.ok(!report.some((r) => r.outcome === "fail"));
});

test("unknown target loud-fails", () => {
  assert.throws(
    () => resolveNodeCapabilities(node(RENDER_DEMO_IR), "langgraph:local"),
    (e: unknown) => e instanceof DispatchError && /no capability profile/.test((e as Error).message),
  );
});

test("safety-critical fail aborts (never silently degrades)", () => {
  // human_approval is a safety-critical `fail` on the local (programmatic) target — a required
  // component capability that resolves to fail must abort, never silently degrade.
  const base = node(RENDER_DEMO_IR);
  const needsApproval: ComponentNode = {
    ...base,
    required_capabilities: [...base.required_capabilities, "human_approval"],
  };
  assert.throws(
    () => resolveCapabilities(needsApproval, "claude-agent-sdk:local", localProfile()),
    (e: unknown) =>
      e instanceof DispatchError && /human_approval: fail on claude-agent-sdk:local/.test((e as Error).message),
  );
});

test("+Assertive borrowed transports resolve realize-via (scheduler, event_bus via emits, notify_channel)", () => {
  const base = node(RENDER_DEMO_IR);
  const assertive: ComponentNode = {
    ...base,
    trigger: { kind: "scheduled" },
    effect: { ...base.effect, outcome: { kind: "assertion", emits: ["freshness_breach"] } },
    required_capabilities: [...base.required_capabilities, "notify_channel"],
  };
  const report = resolveNodeCapabilities(assertive, "claude-agent-sdk:local");
  for (const cap of ["scheduler", "event_bus", "notify_channel"]) {
    assert.equal(report.find((r) => r.capability === cap)?.outcome, "realize-via", `${cap} realize-via`);
  }
  assert.ok(!report.some((r) => r.outcome === "fail"));
});

test("version_control resolves realize-via on claude-agent-sdk:local", () => {
  const base = node(RENDER_DEMO_IR);
  const mutating: ComponentNode = {
    ...base,
    effect: { ...base.effect, outcome: { kind: "mutation" } },
  };
  const report = resolveNodeCapabilities(mutating, "claude-agent-sdk:local");
  assert.equal(outcomeOf(report, "version_control"), "realize-via");
  assert.equal(outcomeOf(report, "write_authz"), "realize-via");
  assert.ok(!report.some((r) => r.outcome === "fail"));
});

test("+Mutating: a mutating component that REQUIRES human_approval loud-fails resolution (safety edge)", () => {
  // Mirrors the plain human_approval fail test above: this SDK target has no approval channel
  // wired, so a mutating component that declares human_approval as a required capability must
  // abort resolution — never silently degrade or run unapproved.
  const base = node(RENDER_DEMO_IR);
  const mutatingNeedsApproval: ComponentNode = {
    ...base,
    realization_kind: "gated-tool",
    effect: { ...base.effect, outcome: { kind: "mutation" } },
    required_capabilities: [...base.required_capabilities, "human_approval"],
  };
  assert.throws(
    () => resolveCapabilities(mutatingNeedsApproval, "claude-agent-sdk:local", localProfile()),
    (e: unknown) =>
      e instanceof DispatchError && /human_approval: fail on claude-agent-sdk:local/.test((e as Error).message),
  );
});

test("+Setup: connect_source (source_connect) resolves realize-via, no fail, on claude-agent-sdk:local", () => {
  const report = resolveNodeCapabilities(nodeByVerb(GENBI_SETUP_IR, "connect_source"), "claude-agent-sdk:local");
  assert.equal(outcomeOf(report, "source_connect"), "realize-via");
  assert.equal(report.find((r) => r.capability === "source_connect")?.provided_by, "runtime");
  assert.equal(outcomeOf(report, "llm:strong"), "native");
  assert.ok(!report.some((r) => r.outcome === "fail"));
});

test("+Setup: build_context (context_build) resolves realize-via, no fail, on claude-agent-sdk:local", () => {
  const report = resolveNodeCapabilities(nodeByVerb(GENBI_SETUP_IR, "build_context"), "claude-agent-sdk:local");
  assert.equal(outcomeOf(report, "context_build"), "realize-via");
  assert.equal(report.find((r) => r.capability === "context_build")?.provided_by, "runtime");
  assert.ok(!report.some((r) => r.outcome === "fail"));
});

test("an unknown declared capability fails as safety-critical", () => {
  const base = node(RENDER_DEMO_IR);
  const weird: ComponentNode = {
    ...base,
    required_capabilities: [...base.required_capabilities, "quantum_entanglement"],
  };
  assert.throws(
    () => resolveCapabilities(weird, "claude-agent-sdk:local", localProfile()),
    (e: unknown) => e instanceof DispatchError && /quantum_entanglement: fail/.test((e as Error).message),
  );
});
