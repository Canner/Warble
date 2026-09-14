import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStepToolBindings, toolsForStep, validateStepToolBindings } from "../src/tool_bindings.js";

test("caller bindings preserve step authority, deduplicate tools, and leave unbound steps empty", () => {
  const bindings = parseStepToolBindings(["first=read", "first=read", "second=inspect"], ["first"]);
  validateStepToolBindings(bindings, ["first", "second", "unbound", "toString"]);
  assert.deepEqual(toolsForStep(bindings, "first"), ["read"]);
  assert.deepEqual(toolsForStep(bindings, "second"), ["inspect"]);
  assert.deepEqual(toolsForStep(bindings, "unbound"), []);
  assert.deepEqual(toolsForStep(bindings, "toString"), []);
});

test("malformed CLI bindings fail before preparation", () => {
  for (const binding of ["step", "=tool", "step=", "step=tool=extra", " =tool", "step= "]) {
    assert.throws(() => parseStepToolBindings([binding], []), /requires <step>=<tool>/);
  }
});

test("unknown steps and required tools without a binding fail closed", () => {
  assert.throws(() => validateStepToolBindings(parseStepToolBindings(["typo=read"], []), ["first"]), /unknown step 'typo'/);
  assert.throws(() => validateStepToolBindings(parseStepToolBindings([], ["typo"]), ["first"]), /unknown step 'typo'/);
  assert.throws(() => validateStepToolBindings(parseStepToolBindings([], ["first"]), ["first"]), /no allowlisted MCP tools/);
  assert.throws(() => validateStepToolBindings({ toolsByStep: { first: [""] } }, ["first"]), /nonempty MCP tool names/);
});
