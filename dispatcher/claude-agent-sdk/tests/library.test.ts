import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Import through the public barrel — this is the embeddable surface consumers see.
import {
  prepareDispatch,
  resolveProjectCwd,
  dispatch,
  buildDispatchPlan,
  ModelConfig,
  parseIr,
  DispatchError,
} from "../src/index.js";

const RENDER_DEMO_IR = fileURLToPath(new URL("../../../examples/render-demo/ir.golden.json", import.meta.url));
const DEMO_AGENT_IR = fileURLToPath(new URL("../../../examples/demo-agent/ir.golden.json", import.meta.url));

test("barrel exposes the high-level + low-level API", () => {
  assert.equal(typeof prepareDispatch, "function");
  assert.equal(typeof dispatch, "function");
  assert.equal(typeof buildDispatchPlan, "function");
  assert.equal(typeof resolveProjectCwd, "function");
  assert.equal(typeof ModelConfig.default, "function");
});

test("prepareDispatch (raw JSON + irPath) resolves cwd relative to the IR file and builds a plan", () => {
  const prepared = prepareDispatch({
    ir: readFileSync(RENDER_DEMO_IR, "utf8"),
    question: "orders overview",
    irPath: RENDER_DEMO_IR,
  });
  assert.equal(prepared.target, "claude-agent-sdk:local");
  assert.equal(prepared.components.length, 1);
  const c = prepared.components[0]!;
  assert.equal(c.plan.meta.model, "opus");
  assert.equal(c.plan.meta.render.kind, "realize");
  // cwd resolved against the IR dir → repo/examples/jaffle-wren
  const expected = resolve(dirname(RENDER_DEMO_IR), "../jaffle-wren");
  assert.equal(c.plan.options.cwd, expected);
});

test("prepareDispatch accepts an already-parsed IR and honors an explicit project override", () => {
  const ir = parseIr(readFileSync(DEMO_AGENT_IR, "utf8"));
  const prepared = prepareDispatch({ ir, question: "q", project: "/abs/proj" });
  assert.equal(prepared.components[0]!.plan.options.cwd, "/abs/proj");
  assert.equal(prepared.components[0]!.plan.meta.split, true); // demo-agent is multi-tier
});

test("prepareDispatch validates tier→model up front (loud-fail before building)", () => {
  const models = ModelConfig.fromFlags("opus", "haiku", "sonnet");
  // demo-agent uses strong+cheap — fine. Now drop `cheap` by using a config missing it:
  const bad = ModelConfig.fromYaml("tiers:\n  strong: opus\n  orchestrator: sonnet\n");
  assert.doesNotThrow(() =>
    prepareDispatch({ ir: readFileSync(DEMO_AGENT_IR, "utf8"), question: "q", models }),
  );
  assert.throws(
    () => prepareDispatch({ ir: readFileSync(DEMO_AGENT_IR, "utf8"), question: "q", models: bad }),
    (e: unknown) => e instanceof DispatchError && /tier 'cheap' has no model binding/.test((e as Error).message),
  );
});

test("resolveProjectCwd: absolute project passes through; relative resolves against irPath dir", () => {
  const node = parseIr(readFileSync(RENDER_DEMO_IR, "utf8")).components[0]!;
  assert.equal(resolveProjectCwd(node, { project: "/x/y" }), "/x/y");
  const rel = resolveProjectCwd(node, { irPath: RENDER_DEMO_IR });
  assert.ok(rel.endsWith("/examples/jaffle-wren"));
});
