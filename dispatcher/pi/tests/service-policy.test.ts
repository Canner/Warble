import test from "node:test";
import assert from "node:assert/strict";
import { ServicePolicy } from "../src/service-policy.js";
import type { ServiceRequest } from "../src/service-policy.js";
const all = "permit(principal, action, resource);";
const request: ServiceRequest = { caller: "a", project: "p", role: "planner", session: "s", epoch: 1,
  action: "execute_query", kind: "query", name: "orders", columns: ["date"], recipient: "" };
test("service policies intersect; explicit deny and evaluator failures never allow", () => {
  assert.equal(new ServicePolicy([all, all]).authorize(request), true);
  assert.equal(new ServicePolicy([all, "forbid(principal, action, resource);"]).authorize(request), false);
  assert.equal(new ServicePolicy([all, "permit(principal, action, resource) when { resource.name == \"other\" };"]).authorize(request), false);
  assert.throws(() => new ServicePolicy([all, "not Cedar"]));
  assert.throws(() => new ServicePolicy([all]));
});
test("query scope can constrain columns and the original caller independently of worker role", () => {
  const policy = new ServicePolicy([all, 'permit(principal, action, resource) when { principal.caller == "a" && ["date"].containsAll(resource.columns) };']);
  assert.equal(policy.authorize({ ...request, role: "worker" }), true);
  assert.equal(policy.authorize({ ...request, role: "worker", caller: "b" }), false);
  assert.equal(policy.authorize({ ...request, columns: ["secret"] }), false);
});
test("approved results cannot be reassigned and unknown requests deny", () => {
  const policy = new ServicePolicy([all, all]);
  assert.equal(policy.authorize({ ...request, action: "receive_answer", recipient: "b" }), false);
  assert.equal(policy.authorize({ ...request, action: "receive_answer", recipient: "a" }), true);
  assert.equal(policy.authorize({ ...request, epoch: 0 }), false);
  assert.equal(policy.authorize({ ...request, action: "write" as any }), false);
});
