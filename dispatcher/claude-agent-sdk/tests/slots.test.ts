import { test } from "node:test";
import assert from "node:assert/strict";

import { applySlots, assertNoSlotReferences, resolveSlots } from "../src/slots.js";
import type { SlotDecl } from "../src/ir.js";

// Slot resolution: the IR carries every variant and picks none, so unless something substitutes
// before dispatch the literal `{{ slot.… }}` reaches the model. These tests cover the substitution,
// the two ways a host answers, and the guard that catches a surface nobody routed through it.

function slot(over: Partial<SlotDecl> = {}): SlotDecl {
  return {
    name: over.name ?? "policy",
    default: over.default ?? "base",
    variants: over.variants ?? { base: "BASE", terse: "TERSE" },
    ...(over.present_when === undefined ? {} : { present_when: over.present_when }),
  };
}

const SCOPE = "component 'c'";

// --- the scanner must agree with the compiler's ---------------------------------------------------

test("a reference is recognised with and without inner spacing, as the compiler recognises it", () => {
  const r = resolveSlots([slot()], {}, SCOPE);
  assert.equal(applySlots("a {{slot.policy}} b", r, SCOPE), "a BASE b");
  assert.equal(applySlots("a {{ slot.policy }} b", r, SCOPE), "a BASE b");
  assert.equal(applySlots("a {{   slot.policy   }} b", r, SCOPE), "a BASE b");
});

test("an unterminated '{{' is left alone, matching the compiler's scanner", () => {
  const r = resolveSlots([slot()], {}, SCOPE);
  // The name must run to the end of the string with nothing after it. An earlier version of this
  // test wrote `{{ slot.policy and nothing closes it`, whose body fails the name check for its
  // spaces — so it passed whether or not the scanner honoured the missing `}}`, and could not fail.
  const raw = "keep {{ slot.policy";
  assert.equal(applySlots(raw, r, SCOPE), raw);
});

test("other placeholders are somebody else's substitution and must survive untouched", () => {
  const r = resolveSlots([slot()], {}, SCOPE);
  assert.equal(applySlots("{{project}} / {{project_name}}", r, SCOPE), "{{project}} / {{project_name}}");
});

test("a name the compiler would not accept is not treated as a reference", () => {
  const r = resolveSlots([slot()], {}, SCOPE);
  // `[a-z_][a-z0-9_]*` — an uppercase name is not a slot name, so this is not a reference at all
  // and must not be substituted, nor reported as an unknown slot.
  assert.equal(applySlots("{{ slot.Policy }}", r, SCOPE), "{{ slot.Policy }}");
});

// --- how a host answers ---------------------------------------------------------------------------

test("no answer renders the declared default", () => {
  const r = resolveSlots([slot()], {}, SCOPE);
  assert.equal(applySlots("[{{ slot.policy }}]", r, SCOPE), "[BASE]");
});

test("a named variant is rendered instead of the default", () => {
  const r = resolveSlots([slot()], { policy: "terse" }, SCOPE);
  assert.equal(applySlots("[{{ slot.policy }}]", r, SCOPE), "[TERSE]");
});

test("null removes the slot entirely rather than falling back to a variant", () => {
  const r = resolveSlots([slot()], { policy: null }, SCOPE);
  assert.equal(applySlots("[{{ slot.policy }}]", r, SCOPE), "[]");
});

test("an unanswered present_when is a loud failure, not a silent default", () => {
  // The whole reason a slot is conditional is that its wording describes something that may have
  // been withheld. Defaulting there ships instructions for a tool the model cannot see.
  assert.throws(
    () => resolveSlots([slot({ present_when: { flag: "x" } })], {}, SCOPE),
    /declares a present_when condition, and nothing answered it/,
  );
});

test("a conditional slot that IS answered resolves normally", () => {
  const decls = [slot({ present_when: { flag: "x" } })];
  assert.equal(applySlots("[{{ slot.policy }}]", resolveSlots(decls, { policy: "terse" }, SCOPE), SCOPE), "[TERSE]");
  assert.equal(applySlots("[{{ slot.policy }}]", resolveSlots(decls, { policy: null }, SCOPE), SCOPE), "[]");
});

test("a variant the slot does not declare is refused, naming what it does declare", () => {
  assert.throws(
    () => resolveSlots([slot()], { policy: "nope" }, SCOPE),
    /was given variant 'nope', which it does not declare \(declared: base, terse\)/,
  );
});

// --- nesting and cycles ---------------------------------------------------------------------------

test("a variant may reference another slot, because the compiler validates such references", () => {
  const decls = [
    slot({ name: "outer", default: "only", variants: { only: "<{{ slot.inner }}>" } }),
    slot({ name: "inner", default: "only", variants: { only: "IN" } }),
  ];
  const r = resolveSlots(decls, {}, SCOPE);
  assert.equal(applySlots("[{{ slot.outer }}]", r, SCOPE), "[<IN>]");
});

test("a removed slot referenced from another variant leaves nothing behind", () => {
  const decls = [
    slot({ name: "outer", default: "only", variants: { only: "<{{ slot.inner }}>" } }),
    slot({ name: "inner", default: "only", variants: { only: "IN" }, present_when: { flag: "x" } }),
  ];
  const r = resolveSlots(decls, { inner: null }, SCOPE);
  assert.equal(applySlots("[{{ slot.outer }}]", r, SCOPE), "[<>]");
});

test("a cycle between variants is reported rather than spun on", () => {
  const decls = [
    slot({ name: "a", default: "only", variants: { only: "{{ slot.b }}" } }),
    slot({ name: "b", default: "only", variants: { only: "{{ slot.a }}" } }),
  ];
  assert.throws(() => resolveSlots(decls, {}, SCOPE), /is defined in terms of itself/);
});

// --- the guard ------------------------------------------------------------------------------------

test("the guard refuses text that still carries a reference, naming the slot", () => {
  assert.throws(
    () => assertNoSlotReferences("before {{ slot.policy }} after", "the system prompt"),
    /still contains unresolved slot reference\(s\) \(policy\)/,
  );
});

test("the guard passes text with no references, and text whose braces are not references", () => {
  assertNoSlotReferences("plain text", "x");
  assertNoSlotReferences("{{project}} and a lone {{ that never closes", "x");
});

// --- wiring: prepareDispatch must actually apply the above ---------------------------------------
//
// The module being correct says nothing about whether anything calls it — which is exactly the
// defect this ticket fixes, one layer up: the IR grew slots and no consumer was taught about them.
// So this drives a real golden IR with a slot spliced in and asserts the resolved text reaches the
// built plan.

test("prepareDispatch resolves slots into the prompts it builds", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { prepareDispatch } = await import("../src/index.js");

  const path = fileURLToPath(new URL("../../../examples/analysis-agent/ir.golden.json", import.meta.url));
  const ir = JSON.parse(readFileSync(path, "utf8")) as {
    slots?: unknown[];
    components: { brief?: string; llm_calls: { prompt: string }[] }[];
  };
  ir.slots = [{ name: "charter", default: "base", variants: { base: "BASE-CHARTER", alt: "ALT-CHARTER" } }];
  const node = ir.components[0]!;
  node.brief = `${node.brief ?? ""}\n{{ slot.charter }}`;

  const withDefault = prepareDispatch({ ir: ir as never, question: "q", irPath: path });
  const defaultText = JSON.stringify(withDefault.components[0]!.plan);
  assert.ok(defaultText.includes("BASE-CHARTER"), "the default variant reached the plan");
  assert.ok(!defaultText.includes("slot.charter"), "no placeholder survived into the plan");

  const withChoice = prepareDispatch({
    ir: ir as never,
    question: "q",
    irPath: path,
    slots: { charter: "alt" },
  });
  const chosenText = JSON.stringify(withChoice.components[0]!.plan);
  assert.ok(chosenText.includes("ALT-CHARTER"), "the host's chosen variant reached the plan");
  assert.ok(!chosenText.includes("BASE-CHARTER"), "and the default did not");
});

test("prepareDisplayManifest resolves too, and a conditional slot renders rather than crashing", async () => {
  // Review found this path unresolved while the plan guard was unconditional, so any slotted IR
  // crashed a shipped command. It is a display: its own manifest schema carries prompt text, so it
  // needs resolved text, and an unanswered condition must render its default rather than refuse —
  // the loud-failure rule protects a model, and a reader is not one.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { prepareDisplayManifest } = await import("../src/index.js");

  const path = fileURLToPath(new URL("../../../examples/analysis-agent/ir.golden.json", import.meta.url));
  const ir = JSON.parse(readFileSync(path, "utf8")) as {
    slots?: unknown[];
    components: { brief?: string }[];
  };
  ir.slots = [
    { name: "charter", default: "base", variants: { base: "BASE-CHARTER", alt: "ALT-CHARTER" } },
    {
      name: "verification",
      default: "on",
      variants: { on: "VERIFY-ON" },
      present_when: { flag: "x" },
    },
  ];
  const node = ir.components[0]!;
  node.brief = `${node.brief ?? ""}\n{{ slot.charter }} {{ slot.verification }}`;

  const manifest = prepareDisplayManifest({ ir: ir as never, irPath: path });
  const text = JSON.stringify(manifest);
  assert.ok(text.includes("BASE-CHARTER"), "the default variant reached the manifest");
  assert.ok(text.includes("VERIFY-ON"), "an unanswered condition rendered its default here");
  assert.ok(!text.includes("slot.charter"), "no placeholder survived into the manifest");

  // …and the same unanswered condition is still refused on the path that reaches a model.
  const { prepareDispatch } = await import("../src/index.js");
  assert.throws(
    () => prepareDispatch({ ir: ir as never, question: "q", irPath: path }),
    /declares a present_when condition, and nothing answered it/,
  );
});
