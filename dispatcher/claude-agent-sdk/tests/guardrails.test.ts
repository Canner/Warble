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

test("context_write_authz: a sibling-prefix dir (models-export/) is OUTSIDE the models/ scope", async () => {
  // Path-boundary regression: a bare string prefix check would wrongly admit `models-export/` for a
  // `models/` scope. The scope must fence at a real directory boundary, not a substring.
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    mutation: { mustDryRun: true, approvalRequired: true, contextScope: "models/" },
  });

  const sibling = await canUseTool("Write", { file_path: "models-export/leak.yml" }, opts());
  assert.equal(sibling.behavior, "deny");
  assert.match((sibling as { message: string }).message, /outside the context_write_authz scope/);
});

test("writeScope: a sibling-prefix dir (out-export/) is OUTSIDE the out/ artifact scope", async () => {
  // Same path-boundary fix on the pre-existing render artifact scope check.
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: "out/",
    cwd: "/proj",
  });

  const inScope = await canUseTool("Write", { file_path: "out/dashboard.html" }, opts());
  assert.equal(inScope.behavior, "allow");

  const sibling = await canUseTool("Write", { file_path: "out-export/leak.html" }, opts());
  assert.equal(sibling.behavior, "deny");
  assert.match((sibling as { message: string }).message, /outside the permitted artifact scope/);
});

// +Setup (genbi-setup): the 5th enforcement point, setup_execution. Distinct from writeScope
// (render artifacts) and the mutation gates (a pre-existing MDL's diff/apply lifecycle) — setup
// broadens Bash beyond `wren` and scopes Write/Edit to the project root instead of denying outright.

test("setup_execution: a `wren` bash command is allowed", async () => {
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    setupScope: ".",
  });
  const result = await canUseTool("Bash", { command: "wren context build" }, opts());
  assert.equal(result.behavior, "allow");
});

test("setup_execution: a non-`wren` connector CLI (e.g. `dlt`) is ALSO allowed (broadened beyond wren)", async () => {
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    setupScope: ".",
  });
  const result = await canUseTool("Bash", { command: "dlt init sql_database duckdb" }, opts());
  assert.equal(result.behavior, "allow");
});

test("setup_execution: destructive bash (rm -rf) is STILL denied — the denylist is never relaxed", async () => {
  const { canUseTool, denials } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    setupScope: ".",
  });
  const result = await canUseTool("Bash", { command: "rm -rf x" }, opts());
  assert.equal(result.behavior, "deny");
  assert.match((result as { message: string }).message, /destructive or file-writing bash is blocked/);
  assert.equal(denials.length, 1);
});

test("setup_execution: shell redirection (>) is STILL denied — the denylist is never relaxed", async () => {
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    setupScope: ".",
  });
  const result = await canUseTool("Bash", { command: "wren context show > out.json" }, opts());
  assert.equal(result.behavior, "deny");
  assert.match((result as { message: string }).message, /destructive or file-writing bash is blocked/);
});

test("setup_execution: a Write inside the scope is allowed", async () => {
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    setupScope: ".",
  });
  const result = await canUseTool("Write", { file_path: ".env" }, opts());
  assert.equal(result.behavior, "allow");
});

test("setup_execution: a Write outside the scope is denied", async () => {
  const { canUseTool, denials } = makeReadOnlyGuard({
    readOnly: false,
    writeScope: null,
    cwd: "/proj",
    setupScope: "new-project/",
  });
  const result = await canUseTool("Write", { file_path: "../outside/leak.yml" }, opts());
  assert.equal(result.behavior, "deny");
  assert.match((result as { message: string }).message, /outside the setup project-root scope/);
  assert.equal(denials.length, 1);
});

test("setupScope absent/null: existing (non-setup) components' Bash/Write behavior is unchanged", async () => {
  const { canUseTool } = makeReadOnlyGuard({
    readOnly: true,
    writeScope: null,
    cwd: "/proj",
  });
  const nonWren = await canUseTool("Bash", { command: "dlt init sql_database duckdb" }, opts());
  assert.equal(nonWren.behavior, "deny");
  assert.match((nonWren as { message: string }).message, /only `wren` CLI invocations are permitted/);

  const write = await canUseTool("Write", { file_path: "anything.txt" }, opts());
  assert.equal(write.behavior, "deny");
  assert.match((write as { message: string }).message, /this component is read-only/);
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
