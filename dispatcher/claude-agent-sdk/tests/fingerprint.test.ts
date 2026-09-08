import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  fingerprintPrompts,
  fingerprintSurfaces,
  parseIr,
  prepareDispatch,
  promptSurfaces,
  promptSurfacesOf,
} from "../src/index.js";

// The property under test: an IR hash no longer identifies what a model was told, because slots let
// dispatch choose among variants the IR carries. So these drive the SAME IR through two different
// slot supplies and assert the fingerprint separates them — the thing `sha256(irText)` cannot do.

const IR_PATH = fileURLToPath(new URL("../../../examples/analysis-agent/ir.golden.json", import.meta.url));

function slottedIr(): Record<string, unknown> {
  const ir = parseIr(readFileSync(IR_PATH, "utf8"));
  ir.slots = [
    { name: "charter", default: "base", variants: { base: "BASE-CHARTER", alt: "ALT-CHARTER" } },
  ];
  const node = ir.components[0]!;
  node.brief = `${node.brief ?? ""}\n{{ slot.charter }}`;
  return ir as unknown as Record<string, unknown>;
}

function fingerprintFor(slots: Record<string, string | null> | undefined): ReturnType<typeof fingerprintPrompts> {
  const prepared = prepareDispatch({
    ir: slottedIr() as never,
    question: "give me an overview",
    irPath: IR_PATH,
    ...(slots === undefined ? {} : { slots }),
  });
  return fingerprintPrompts(prepared.components[0]!.plan);
}

test("two variant selections of the SAME IR produce different fingerprints", () => {
  // This is the whole ticket: `sha256(irText)` is identical across these two runs, because the IR is
  // byte-identical — every variant travels in it and only the selection differs.
  const base = fingerprintFor({ charter: "base" });
  const alt = fingerprintFor({ charter: "alt" });

  assert.notEqual(base.digest, alt.digest, "the fingerprint must separate them");
  assert.equal(
    JSON.stringify(slottedIr()),
    JSON.stringify(slottedIr()),
    "the IR itself is identical between the two runs, which is why its hash cannot separate them",
  );
});

test("the same selection reproduces the same fingerprint", () => {
  assert.equal(fingerprintFor({ charter: "alt" }).digest, fingerprintFor({ charter: "alt" }).digest);
});

test("no supply and the explicit default agree, because that is the same prompt", () => {
  assert.equal(fingerprintFor(undefined).digest, fingerprintFor({ charter: "base" }).digest);
});

test("the per-surface digests localize WHICH prompt changed, not just that something did", () => {
  // Uses a slot referenced from ONE step's prompt of a MULTI-step component. Two things make that
  // necessary, both learned by getting it wrong first:
  //   - the charter slot above lives in `brief`, which is prepended to every subagent prompt and the
  //     driver's, so changing it legitimately changes every surface and localizes nothing;
  //   - a single-step component takes the collapse path, whose system prompt is built from `brief`
  //     plus `prompt_fragment` and never reads `llm_calls[].prompt` at all — so a slot placed in the
  //     step prompt of a one-step component reaches no surface, and the test would have passed for
  //     the wrong reason.
  const MULTI_STEP = "answer_query";
  const withStepSlot = (variant: string): ReturnType<typeof fingerprintPrompts> => {
    const ir = parseIr(readFileSync(IR_PATH, "utf8"));
    ir.slots = [{ name: "hint", default: "a", variants: { a: "HINT-A", b: "HINT-B" } }];
    const node = ir.components.find((c) => c.id === MULTI_STEP)!;
    assert.ok(node.llm_calls.length > 1, "the component must be split for subagent surfaces to exist");
    const call = node.llm_calls[0]!;
    call.prompt = `${call.prompt}\n{{ slot.hint }}`;
    const prepared = prepareDispatch({
      ir: ir as never,
      question: "q",
      irPath: IR_PATH,
      componentId: MULTI_STEP,
      slots: { hint: variant },
    });
    return fingerprintPrompts(prepared.components[0]!.plan);
  };

  const a = withStepSlot("a");
  const b = withStepSlot("b");
  assert.notEqual(a.digest, b.digest, "the total digest moved");

  const changed = Object.keys(a.surfaces).filter((k) => a.surfaces[k] !== b.surfaces[k]);
  const unchanged = Object.keys(a.surfaces).filter((k) => a.surfaces[k] === b.surfaces[k]);
  assert.equal(changed.length, 1, `exactly one surface should differ, got: ${changed.join(", ")}`);
  assert.ok(
    unchanged.length > 0,
    "and the rest must not — a fingerprint that changed everywhere would localize nothing",
  );
});

test("the digest is independent of the order the surfaces were inserted in", () => {
  // An earlier version of this test compared `names.sort()` with `names.sort()` — a tautology that
  // passed whether or not the digest sorted anything. Insert the same pairs in opposite orders and
  // the sort is actually load-bearing.
  const forwards = fingerprintSurfaces({ "a.one": "X", "b.two": "Y", "c.three": "Z" });
  const backwards = fingerprintSurfaces({ "c.three": "Z", "b.two": "Y", "a.one": "X" });
  assert.equal(forwards.digest, backwards.digest);
});

test("surfaces are namespaced by what they are, so a plan's keys say where text came from", () => {
  const prepared = prepareDispatch({
    ir: slottedIr() as never,
    question: "q",
    irPath: IR_PATH,
    slots: { charter: "base" },
  });
  const names = Object.keys(promptSurfaces(prepared.components[0]!.plan));
  assert.ok(names.length > 0, "the plan has at least one prompt surface");
  for (const name of names) {
    assert.match(name, /^(driver|subagent|step)\./, `surface '${name}' must name its kind`);
  }
});

test("the plan helper claims no step surface, because a step is not sent as its prompt", () => {
  // This replaces a test that asserted the opposite. Review showed the claim was false: the staged
  // executor sends `preamble + "\n\n" + step.prompt`, so a `step.<name>` digest of the bare prompt
  // named bytes that were never sent — the failure this module's header calls worse than none.
  // Staged and hybrid turns are fingerprinted by the runtime instead, where the bytes exist.
  const plan = {
    prompt: "q",
    options: { systemPrompt: "S" },
    meta: { stagedSteps: [{ name: "resolve_intent", prompt: "STEP" }] },
  } as unknown as Parameters<typeof fingerprintPrompts>[0];

  const surfaces = promptSurfaces(plan);
  assert.ok(!("step.resolve_intent" in surfaces), "no step surface is claimed from a plan");
  assert.deepEqual(Object.keys(surfaces), ["driver.systemPrompt"]);
});

test("the same text under a different surface name is a different fingerprint", () => {
  // This is what hashing the name alongside its text buys. Swapping two texts between two surfaces
  // does NOT prove it — sorted position already encodes which surface is which, so that comparison
  // passes with the name omitted. The discriminating case is one surface, same text, different name:
  // telling subagent A something is not the same event as telling subagent B the same thing.
  const asOne = fingerprintSurfaces({ "subagent.one": "SHARED" });
  const asTwo = fingerprintSurfaces({ "subagent.two": "SHARED" });
  assert.notEqual(asOne.digest, asTwo.digest);
});

test("a name/text boundary cannot be re-split into a different pair", () => {
  // What the length prefixes are for. Concatenating `name text` unprefixed makes these two produce
  // the identical byte stream ("a b c"), so they would collide. A back-end's own surface names have
  // no spaces today, but `fingerprintSurfaces` is exported and takes an arbitrary map — the guard
  // has to hold for what the function accepts, not for what today's callers happen to pass.
  const split = fingerprintSurfaces({ a: "b c" });
  const joined = fingerprintSurfaces({ "a b": "c" });
  assert.notEqual(split.digest, joined.digest);
});

test("the options a host rebuilt are fingerprinted, not the plan it started from", () => {
  // The eval adapter does exactly this: it takes the plan's options as a base and replaces the
  // system prompt with the component's `prompt_fragment`. Fingerprinting the plan there would
  // record a prompt that was never sent — worse than recording nothing, because it reads as
  // evidence. So `promptSurfacesOf` is the primitive and the plan helper is the convenience.
  const prepared = prepareDispatch({
    ir: slottedIr() as never,
    question: "q",
    irPath: IR_PATH,
    slots: { charter: "base" },
  });
  const plan = prepared.components[0]!.plan;

  const asPlanned = fingerprintPrompts(plan);
  const asSent = fingerprintSurfaces(
    promptSurfacesOf({ ...plan.options, systemPrompt: "REPLACED BY THE HOST" }),
  );

  assert.notEqual(
    asPlanned.digest,
    asSent.digest,
    "a host that rebuilt the system prompt must not get the plan's fingerprint",
  );
  assert.equal(
    asSent.surfaces["driver.systemPrompt"],
    fingerprintSurfaces({ "driver.systemPrompt": "REPLACED BY THE HOST" }).surfaces[
      "driver.systemPrompt"
    ],
    "the recorded driver digest is of the text the host actually sent",
  );
});
