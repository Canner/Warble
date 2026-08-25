/**
 * Phase 3 litmus e2e (SDK back-end, prepare-level) — dispatch the REAL committed monitor-agent
 * golden IR (assertive · tool · scheduled · assertion) and assert the plan the SDK would run.
 *
 * The live query() loop is runtime-gated (needs the subscription runtime + a queryable fixture at a
 * known lag, same caveat as the GenBI live eval), so this exercises `prepareDispatch` — the pure
 * seam that builds the exact `query({options})` — which is where every +Assertive property is
 * decided: read-only tools, the deterministic-assert contract, the borrowed transports, tier binding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { prepareDispatch } from "../src/dispatch.js";

const MONITOR_IR = fileURLToPath(new URL("../../../examples/monitor-agent/ir.golden.json", import.meta.url));

test("monitor-agent golden IR prepares into a read-only, scheduled assertion plan on the SDK target", () => {
  const ir = readFileSync(MONITOR_IR, "utf8");
  const prepared = prepareDispatch({ ir, question: "Is the orders model fresh?", irPath: MONITOR_IR });

  assert.equal(prepared.components.length, 1);
  const { node, report, plan } = prepared.components[0]!;

  // The structurally-new anatomy positions survive the seam intact.
  assert.equal(node.type, "assertive");
  assert.equal(node.realization_kind, "tool");
  assert.equal(node.trigger.kind, "scheduled");
  assert.equal(node.effect.outcome.kind, "assertion");

  // The plan is an assertion, read-only (no Write/Edit), single cheap tier (no per-step split).
  assert.equal(plan.meta.assertion, true);
  assert.equal(plan.meta.readOnly, true);
  assert.equal(plan.meta.split, false);
  assert.equal(plan.meta.model, "haiku"); // cheap tier → haiku
  assert.ok(!(plan.options.tools as string[]).includes("Write"), "read-only: no Write");
  assert.ok(!(plan.options.tools as string[]).includes("Edit"), "read-only: no Edit");

  // The system prompt carries the deterministic-assert contract + verdict + emitted signal + notify.
  const sys = plan.options.systemPrompt as string;
  assert.match(sys, /## Assertion output/);
  assert.match(sys, /DETERMINISTIC/);
  assert.match(sys, /freshness_verdict/);
  assert.match(sys, /freshness_breach/);
  assert.match(sys, /notify_slack|open_ticket/);
  // status block (the verdict facet) is in the contract, dashboard blocks are not.
  assert.match(sys, /`status`/);

  // Borrowed transports resolve realize-via; nothing fails.
  const outcomeOf = (cap: string) => report.find((r) => r.capability === cap)?.outcome;
  assert.equal(outcomeOf("scheduler"), "realize-via");
  assert.equal(outcomeOf("event_bus"), "realize-via"); // implied by emits
  assert.equal(outcomeOf("notify_channel"), "realize-via");
  assert.equal(outcomeOf("sql_execution:read_only"), "native");
  assert.ok(!report.some((r) => r.outcome === "fail"));
});
