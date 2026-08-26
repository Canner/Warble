import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// propose-apply-agent mixes two read-only components (survey_context, propose_changes) with one
// gated-tool (apply_changes) that this target cannot satisfy — no approval channel, no
// context_write_authz — so it's the live regression fixture for scoped `chat --component` dispatch:
// a component that isn't apply_changes must legalize on its own requirements, never on a
// sibling's.
import { DispatchError, prepareDispatch } from "../src/index.js";

const ENRICH_IR = fileURLToPath(
  new URL("../../../examples/propose-apply-agent/ir.golden.json", import.meta.url),
);

function irText(): string {
  return readFileSync(ENRICH_IR, "utf8");
}

test("whole-profile prepareDispatch (no componentId) still fails on apply_changes — manifest-shape unchanged", () => {
  // AC3: `manifest`/`emit`/whole-profile `dispatch` never pass componentId, so this call shape is
  // untouched by the fix — it must still loud-fail exactly as before.
  assert.throws(
    () => prepareDispatch({ ir: irText(), irPath: ENRICH_IR }),
    (error: unknown) =>
      error instanceof DispatchError && /context_write_authz/.test(error.message) &&
      /apply_changes/.test(error.message),
    "whole-profile preparation must still wall-hit on apply_changes's unmet context_write_authz",
  );
});

test("chat --component propose_changes: scoped dispatch succeeds despite apply_changes's unmet capabilities", () => {
  // AC1 + AC6: this is the exact live failure from the bug report — dispatching a read-only
  // component must not be blocked by a *different*, ungated-capability-lacking component in the
  // same profile.
  const prepared = prepareDispatch({
    ir: irText(),
    irPath: ENRICH_IR,
    componentId: "propose_changes",
  });
  assert.equal(prepared.components.length, 1, "scoped dispatch prepares exactly the requested component");
  assert.equal(prepared.components[0]?.id, "propose_changes");
  assert.ok(
    !prepared.components[0]?.report.some((r) => r.outcome === "fail"),
    "propose_changes's own capabilities must all resolve without a fail",
  );
});

test("chat --component survey_context: scoped dispatch also succeeds", () => {
  // AC1, second read-only component — confirms the fix isn't accidentally keyed to propose_changes
  // specifically.
  const prepared = prepareDispatch({
    ir: irText(),
    irPath: ENRICH_IR,
    componentId: "survey_context",
  });
  assert.equal(prepared.components.length, 1);
  assert.equal(prepared.components[0]?.id, "survey_context");
  assert.ok(!prepared.components[0]?.report.some((r) => r.outcome === "fail"));
});

test("chat --component apply_changes: still fails, same capability, same clarity", () => {
  // AC2: scoping which component gates the dispatch must never relax what apply_changes itself
  // requires — dispatching it directly on an incapable target must still wall-hit, loudly and by
  // name.
  assert.throws(
    () => prepareDispatch({ ir: irText(), irPath: ENRICH_IR, componentId: "apply_changes" }),
    (error: unknown) =>
      error instanceof DispatchError && /context_write_authz/.test(error.message) &&
      /apply_changes/.test(error.message) &&
      /cannot be dispatched/.test(error.message),
    "apply_changes must still fail preflight on this target, naming the same unmet capability",
  );
});

test("chat --component <unknown>: not-found error names every available component", () => {
  assert.throws(
    () => prepareDispatch({ ir: irText(), irPath: ENRICH_IR, componentId: "does_not_exist" }),
    (error: unknown) =>
      error instanceof DispatchError &&
      /component 'does_not_exist' not found in IR/.test(error.message) &&
      /survey_context, propose_changes, apply_changes/.test(error.message),
  );
});
