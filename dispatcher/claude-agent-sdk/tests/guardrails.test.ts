import { test } from "node:test";
import assert from "node:assert/strict";

import { makeReadOnlyGuard } from "../src/guardrails.js";

// +Constitutive: context_write_authz — the THIRD enforcement point, distinct from writeScope
// (render artifact writes) and the unscoped mutation approval gate (data writes, +Mutating). Proves
// scope isolation: a write outside the component's own scope is denied with a SCOPE-VIOLATION
// reason (never even reaching the approval question); a write inside the scope still denies
// fail-closed, but with an APPROVAL reason — the two gates are distinguishable by their message.

function opts() {
  return { signal: new AbortController().signal, toolUseID: "t1" };
}

test("context_write_authz: denies a write outside the scope with a scope-violation reason", async () => {
  const { canUseTool, denials } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    mutation: { mustDryRun: true, approvalRequired: true, contextScope: "models/" },
  });

  const outsideKnowledge = await canUseTool("Write", { file_path: "knowledge/x.yml" }, opts());
  assert.equal(outsideKnowledge.behavior, "deny");
  assert.match((outsideKnowledge as { message: string }).message, /outside the context_write_authz scope/);

  const outsideData = await canUseTool("Edit", { file_path: "warehouse/orders.csv" }, opts());
  assert.equal(outsideData.behavior, "deny");
  assert.match((outsideData as { message: string }).message, /outside the context_write_authz scope/);

  assert.equal(denials.length, 2);
  assert.ok(denials.every((d) => d.reason.includes("outside the context_write_authz scope")));
});

test("context_write_authz: denies an in-scope write too, but with an approval reason (not a scope reason)", async () => {
  const { canUseTool, denials } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    mutation: { mustDryRun: true, approvalRequired: true, contextScope: "models/" },
  });

  const inScope = await canUseTool("Write", { file_path: "models/orders.yml" }, opts());
  assert.equal(inScope.behavior, "deny");
  const message = (inScope as { message: string }).message;
  assert.doesNotMatch(message, /outside the context_write_authz scope/);
  assert.match(message, /context_write_authz scope 'models\/'/);
  assert.match(message, /requires human approval to clear/);

  assert.equal(denials.length, 1);
  assert.doesNotMatch(denials[0]!.reason, /outside the context_write_authz scope/);
});

test("context_write_authz unset: keeps the existing unscoped mutation behavior unchanged", async () => {
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    mutation: { mustDryRun: true, approvalRequired: true },
  });

  const write = await canUseTool("Write", { file_path: "models/orders.yml" }, opts());
  assert.equal(write.behavior, "deny");
  const message = (write as { message: string }).message;
  assert.doesNotMatch(message, /context_write_authz/);
  assert.match(message, /gated apply of a mutating component/);
});
