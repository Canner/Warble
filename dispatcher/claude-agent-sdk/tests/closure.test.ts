import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DispatchError,
  parseIr,
  preflightDispatchAssets,
  prepareDispatch,
  resolveComponentClosure,
  type ComponentNode,
  type WarbleIr,
} from "../src/index.js";

const dir = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(dir, "..", "..", "conformance-fixtures", "component-composition-unsupported.json");
const closureFixturePath = join(dir, "..", "..", "conformance-fixtures", "component-call-closure.json");

interface GraphScenario {
  name: string;
  roots: string[];
  mounts: Array<{ id: string; entrypoint: boolean; calls: string[] }>;
  expected_entries: Array<{ root: string; components: string[] }>;
  expected_callees: string[];
}

function fixtureIr(): WarbleIr {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { ir: unknown };
  return parseIr(JSON.stringify(fixture.ir));
}

function graphIr(scenario: GraphScenario): WarbleIr {
  const template = fixtureIr();
  const base = template.components[1]!;
  template.components = scenario.mounts.map((mount) => {
    const node = structuredClone(base) as ComponentNode;
    node.id = mount.id;
    node.verb = mount.id;
    node.entrypoint = mount.entrypoint;
    node.llm_calls[0]!.component_calls = mount.calls.map((component, index) => ({
      alias: `call_${index}`,
      component,
    }));
    if (mount.calls.length > 0) node.required_capabilities.push("component_invocation");
    return node;
  });
  return template;
}

test("shared closure conformance scenarios resolve exactly", () => {
  const fixture = JSON.parse(readFileSync(closureFixturePath, "utf8")) as { scenarios: GraphScenario[] };
  assert.deepEqual(fixture.scenarios.map((scenario) => scenario.name), [
    "shared_callee",
    "transitive_chain",
    "unreachable_unsupported_sibling",
  ]);
  for (const scenario of fixture.scenarios) {
    const closure = resolveComponentClosure(graphIr(scenario), scenario.roots);
    assert.deepEqual(closure.entries, scenario.expected_entries, scenario.name);
    assert.deepEqual(closure.callees.map((node) => node.id), scenario.expected_callees, scenario.name);
  }
});

test("closure keeps shared callees out of the entry-plan list and deduplicates their registry record", () => {
  const ir = fixtureIr();
  const second = structuredClone(ir.components[0]!) as ComponentNode;
  second.id = "second_caller";
  second.verb = "second_caller";
  ir.components.push(second);

  const closure = resolveComponentClosure(ir);
  assert.deepEqual(closure.roots.map((node) => node.id), ["caller", "second_caller"]);
  assert.deepEqual(closure.entries, [
    { root: "caller", components: ["caller", "callee"] },
    { root: "second_caller", components: ["second_caller", "callee"] },
  ]);
  assert.deepEqual(closure.callees.map((node) => node.id), ["callee"]);
  assert.ok(Object.isFrozen(closure));
  assert.ok(Object.isFrozen(closure.entries));
});

test("closure follows a transitive chain in declaration order", () => {
  const ir = fixtureIr();
  const leaf = structuredClone(ir.components[1]!) as ComponentNode;
  leaf.id = "leaf";
  leaf.verb = "leaf";
  ir.components[1]!.llm_calls[0]!.component_calls = [{ alias: "leaf", component: "leaf" }];
  ir.components[1]!.required_capabilities.push("component_invocation");
  ir.components.push(leaf);

  const closure = resolveComponentClosure(ir, ["caller"]);
  assert.deepEqual(closure.entries[0], {
    root: "caller",
    components: ["caller", "callee", "leaf"],
  });
  assert.deepEqual(closure.callees.map((node) => node.id), ["callee", "leaf"]);
});

test("pinned preparation ignores an unreachable unsupported sibling", () => {
  const ir = fixtureIr();
  ir.components[0]!.llm_calls[0]!.component_calls = [];
  ir.components[0]!.required_capabilities = ["llm:cheap"];
  const unsupported = structuredClone(ir.components[0]!) as ComponentNode;
  unsupported.id = "unsupported_sibling";
  unsupported.verb = "unsupported_sibling";
  unsupported.required_capabilities = ["not_supported_anywhere"];
  unsupported.llm_calls[0]!.tier = "unbound_tier";
  ir.components.push(unsupported);

  const prepared = prepareDispatch({ ir, componentId: "caller" });
  assert.deepEqual(prepared.components.map((component) => component.id), ["caller"]);
  assert.deepEqual(prepared.preparedCallees, []);
  assert.deepEqual(prepared.entries, [{ root: "caller", components: ["caller"] }]);
});

test("pinned asset preflight never reads an unreachable internal mount", () => {
  const ir = fixtureIr();
  ir.components[0]!.llm_calls[0]!.component_calls = [];
  ir.components[0]!.required_capabilities = ["llm:cheap"];
  ir.components[1]!.assets = [{
    path: "missing.css",
    hash: `sha256:${"0".repeat(64)}`,
    bytes: 0,
  }];
  const input = { ir, componentId: "caller" } as const;
  const prepared = prepareDispatch(input);
  assert.doesNotThrow(() => preflightDispatchAssets(input, prepared));
});

test("prepared execution records and nested plans are immutable after preflight", () => {
  const ir = fixtureIr();
  ir.components[0]!.llm_calls[0]!.component_calls = [];
  ir.components[0]!.required_capabilities = ["llm:cheap"];
  const prepared = prepareDispatch({ ir, componentId: "caller" });
  const component = prepared.components[0]!;

  for (const value of [
    prepared,
    prepared.components,
    prepared.preparedCallees,
    prepared.entries,
    prepared.dependencies,
    component,
    component.node,
    component.report,
    component.plan,
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => prepared.components.push(component), TypeError);
});

test("a reachable invocation wall-hits with the target realization and authorized edge", () => {
  const ir = fixtureIr();
  const fixture = JSON.parse(readFileSync(closureFixturePath, "utf8")) as {
    unsupported_target: { error_contains: string[] };
  };
  assert.throws(
    () => prepareDispatch({ ir, componentId: "caller" }),
    (error: unknown) =>
      error instanceof DispatchError &&
      fixture.unsupported_target.error_contains.every((part) => error.message.includes(part)),
  );
});

test("a forged caller cannot remove the implied capability and bypass the invocation wall", () => {
  const ir = fixtureIr();
  ir.components[0]!.required_capabilities = ir.components[0]!.required_capabilities.filter(
    (capability) => capability !== "component_invocation",
  );
  assert.throws(
    () => prepareDispatch({ ir, componentId: "caller" }),
    (error: unknown) =>
      error instanceof DispatchError &&
      error.message.includes("caller") &&
      error.message.includes("does not require component_invocation") &&
      error.message.includes("bypassed"),
  );
});

test("an explicit invocation requirement without an outgoing call still resolves fail", () => {
  const ir = fixtureIr();
  ir.components[0]!.llm_calls[0]!.component_calls = [];
  assert.throws(
    () => prepareDispatch({ ir, componentId: "caller" }),
    (error: unknown) =>
      error instanceof DispatchError &&
      error.message.includes("component_invocation: fail") &&
      error.message.includes("caller"),
  );
});

test("a callee with its own unsupported invocation requirement fails as a capability, not an edge lookup", () => {
  const ir = fixtureIr();
  ir.components[1]!.required_capabilities.push("component_invocation");
  assert.throws(
    () => prepareDispatch({ ir, componentId: "caller" }),
    (error: unknown) =>
      error instanceof DispatchError &&
      error.message.includes("component_invocation: fail") &&
      error.message.includes("callee"),
  );
});

test("entrypoint:false cannot be selected directly", () => {
  assert.throws(
    () => resolveComponentClosure(fixtureIr(), ["callee"]),
    (error: unknown) => error instanceof DispatchError && /entrypoint:false.*root entry/.test(error.message),
  );
});
