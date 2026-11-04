import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import {
  PolicyAuthority, selectionPreset, METADATA_KINDS, DISCLOSURE_SCHEMA,
} from "../src/index.js";
import type {
  Audit, AuthorizationRequest, Resource, RecipientHandle,
  SessionSelection, MetadataKind, GrantHandle,
} from "../src/index.js";
import { evaluate, validatePolicies } from "../src/cedar.js";
import type { Request } from "../src/cedar.js";

const permit = "permit(principal, action, resource);";
const recipient = { project: "project-a", role: "planner" as const, zone: "public" as const, deployment: "cloud-a" };
const selected = (kind: MetadataKind, documents: readonly string[] | "*" = ["doc-a"]): SessionSelection =>
  ({ metadata: [{ kind, documents }], approvedAnswers: false, components: [] });
function setup(policy = permit, selection = selected("schema.structure")) {
  const authority = new PolicyAuthority(policy);
  const agent = authority.registerRecipient(recipient);
  const session = authority.openSession(agent, selection, true);
  const resource = authority.registerResource({ project: "project-a", kind: "schema.structure", document: "doc-a" });
  const request: AuthorizationRequest = { session, resource, action: "receive_metadata" };
  return { authority, agent, session, resource, request };
}

test("deployment and session are separate Cedar decisions whose intersection is required", () => {
  const onlyStructure = `permit(principal, action, resource) when { resource.kind == "schema.structure" };`;
  const { authority, session, request } = setup(onlyStructure, {
    metadata: METADATA_KINDS.map(kind => ({ kind, documents: "*" })), approvedAnswers: true, components: ["oracle"],
  });
  assert.equal(authority.authorize(request).decision, "allow");
  const raw = authority.registerResource({ project: "project-a", kind: "data.raw", document: "doc-a" });
  assert.equal(authority.authorize({ session, resource: raw, action: "receive_metadata" }).reason, "deployment_denied");
  const restricted = setup(permit, selectionPreset("blind"));
  assert.equal(restricted.authority.authorize(restricted.request).reason, "selection_denied");
  const empty = setup("");
  assert.equal(empty.authority.authorize(empty.request).reason, "deployment_denied");
});

test("forbid overrides matching permit and neither selection nor wildcard removes it", () => {
  const s = setup(`${permit}
    forbid(principal, action, resource) when { resource.document == "doc-a" };`);
  assert.equal(s.authority.authorize(s.request).reason, "deployment_denied");
});

test("the documented deployment example validates and caps a broad session selection", () => {
  const policy = readFileSync(new URL("../examples/deployment.cedar", import.meta.url), "utf8");
  const a = new PolicyAuthority(policy);
  const agent = a.registerRecipient({ ...recipient, deployment: "cloud-planner" });
  const session = a.openSession(agent, {
    metadata: METADATA_KINDS.map(kind => ({ kind, documents: "*" })),
    approvedAnswers: true, components: ["private-oracle"],
  }, true);
  for (const kind of METADATA_KINDS) {
    const document = kind === "knowledge.rules" ? "approved-rules" : "catalog";
    const resource = a.registerResource({ project: "project-a", kind, document });
    assert.equal(a.authorize({ session, resource, action: "receive_metadata" }).decision,
      ["schema.structure", "schema.descriptions", "knowledge.rules"].includes(kind) ? "allow" : "deny");
  }
});

test("a preset without explicit document IDs grants no metadata", () => {
  for (const mode of ["blind", "schema-aware", "business-aware"] as const) {
    const { authority, request } = setup(permit, selectionPreset(mode));
    assert.equal(authority.authorize(request).reason, "selection_denied");
  }
});

for (const mode of ["blind", "schema-aware", "business-aware"] as const) {
  test(`${mode}: independent categories, document constraints and no implicit answer permission`, () => {
    const a = new PolicyAuthority(permit);
    const p = a.registerRecipient(recipient);
    const session = a.openSession(p, selectionPreset(mode, ["doc-a"], ["rule-a"]), true);
    for (const kind of METADATA_KINDS) {
      for (const document of ["doc-a", "rule-a", "other"]) {
        const r = a.registerResource({ project: "project-a", kind, document });
        const expected = (mode !== "blind" && document === "doc-a"
          && ["schema.structure", "schema.descriptions"].includes(kind))
          || (mode === "business-aware" && document === "rule-a" && kind === "knowledge.rules");
        assert.equal(a.authorize({ session, resource: r, action: "receive_metadata" }).decision,
          expected ? "allow" : "deny", `${kind}/${document}`);
      }
    }
    const answer = a.registerApprovedAnswer({ project: "project-a", document: "result-a" }, p);
    assert.equal(a.authorize({ session, resource: answer, action: "receive_answer" }).reason, "selection_denied");
  });
}

for (const category of METADATA_KINDS) {
  test(`${category} can be individually selected without granting adjacent categories`, () => {
    const { authority, session } = setup(permit, selected(category));
    for (const kind of METADATA_KINDS) {
      const resource = authority.registerResource({ project: "project-a", kind, document: "doc-a" });
      assert.equal(authority.authorize({ session, resource, action: "receive_metadata" }).decision,
        kind === category ? "allow" : "deny");
    }
  });
}

test("deployment document, role, zone and model-deployment constraints are effective", () => {
  const policy = `permit(principal, action, resource)
    when { principal.project == resource.project && principal.zone == "public"
      && principal.role == "planner" && principal.deployment == "cloud-a"
      && resource.document == "doc-a" };`;
  const { authority, request } = setup(policy, selected("schema.structure", "*"));
  assert.equal(authority.authorize(request).decision, "allow");
  const otherDoc = authority.registerResource({ project: "project-a", document: "doc-b", kind: "schema.structure" });
  assert.equal(authority.authorize({ ...request, resource: otherDoc }).decision, "deny");
  for (const attrs of [{ zone: "private" as const }, { role: "worker" as const }, { deployment: "cloud-b" }]) {
    const agent = authority.registerRecipient({ ...recipient, ...attrs });
    const session = authority.openSession(agent, selected("schema.structure"), true);
    assert.equal(authority.authorize({ ...request, session }).decision, "deny");
  }
});

test("even blanket deployment permits cannot bypass project, operator or action boundaries", () => {
  const { authority, agent, request } = setup();
  const otherProject = authority.registerResource({ project: "project-b", kind: "schema.structure", document: "doc-a" });
  assert.equal(authority.authorize({ ...request, resource: otherProject }).reason, "project_mismatch");
  const noOperator = authority.openSession(agent, selected("schema.structure"), false);
  assert.equal(authority.authorize({ ...request, session: noOperator }).reason, "operator_denied");
  assert.equal(authority.authorize({ ...request, action: "receive_answer" }).reason, "action_mismatch");
});

test("component invocation is independent from metadata and never grants an IR edge", () => {
  const { authority, agent, request } = setup();
  const component = authority.registerResource({ project: "project-a", kind: "component", document: "oracle" });
  assert.equal(authority.authorize({ ...request, resource: component, action: "invoke_component" }).reason, "selection_denied");
  const session = authority.openSession(agent, { ...selectionPreset("blind"), components: ["oracle"] }, true);
  assert.equal(authority.authorize({ session, resource: component, action: "invoke_component" }).decision, "allow");
  assert.equal(authority.authorize({ ...request, session }).reason, "selection_denied");
});

test("approved results require trusted verification registration and the exact recipient", () => {
  const { authority, agent } = setup();
  const selection = { ...selectionPreset("blind"), approvedAnswers: true };
  const session = authority.openSession(agent, selection, true);
  const answer = authority.registerApprovedAnswer({ project: "project-a", document: "result" }, agent);
  assert.equal(authority.authorize({ session, resource: answer, action: "receive_answer" }).decision, "allow");
  const second = authority.registerRecipient(recipient);
  const secondSession = authority.openSession(second, selection, true);
  assert.equal(authority.authorize({ session: secondSession, resource: answer, action: "receive_answer" }).reason,
    "recipient_mismatch");
  assert.throws(() => authority.registerResource({ project: "project-a", document: "result",
    kind: "answer.approved" } as unknown as Resource), /^Error: invalid_resource$/);
  assert.throws(() => authority.registerApprovedAnswer({ project: "project-b", document: "result" }, agent),
    /^Error: invalid_approval$/);
  assert.throws(() => authority.registerApprovedAnswer({ project: "project-a", document: "result" }, {} as RecipientHandle),
    /^Error: invalid_approval$/);
});

test("classification is closed: context containers, unknown/mixed kinds and raw payload fields reject", () => {
  const { authority } = setup();
  for (const kind of ["context", "metadata", "knowledge", "unknown", ["knowledge.rules", "data.raw"], null, undefined]) {
    assert.throws(() => authority.registerResource({ project: "project-a", document: "doc-a", kind } as Resource),
      /^Error: invalid_resource$/);
  }
  assert.throws(() => authority.registerResource({ project: "project-a", document: "doc-a", kind: "knowledge.rules",
    content: "SECRET_PAYLOAD" } as Resource), /^Error: invalid_resource$/);
});

test("serialized, copied, cross-authority and forged handles never acquire authority", () => {
  const { authority, request } = setup();
  for (const mutation of [
    { session: {} }, { session: JSON.parse(JSON.stringify(request.session)) }, { resource: { ...request.resource } },
    { role: "worker", zone: "private" }, { classification: "answer.approved" }, { project: "project-a" },
    { action: "unknown" }, { context: { operatorAuthorized: true } }, { resource: null },
  ]) assert.equal(authority.authorize({ ...request, ...mutation } as AuthorizationRequest).decision, "deny");
  assert.equal(new PolicyAuthority(permit).authorize(request).reason, "invalid_request");
  assert.equal(authority.checkGrant({} as GrantHandle).reason, "stale_grant");
  assert.equal(authority.authorize(null as unknown as AuthorizationRequest).reason, "invalid_request");
});

test("invalid policies and entity attribute types are rejected before session admission", () => {
  for (const policy of ["permit (", 'permit(principal, action, resource) when { principal.missing };',
    'permit(principal, action, resource) when { resource.version == "one" };', "x".repeat(65537)]) {
    const a = new PolicyAuthority(policy);
    const p = a.registerRecipient(recipient);
    assert.throws(() => a.openSession(p, selectionPreset("blind"), true), /^Error: invalid_policy$/);
  }
  const a = new PolicyAuthority(permit);
  assert.throws(() => a.registerRecipient({ ...recipient, zone: true } as never), /^Error: invalid_recipient$/);
  const p = a.registerRecipient(recipient);
  for (const selection of [{ metadata: [], approvedAnswers: "yes", components: [] },
    { metadata: [{ kind: "unknown", documents: "*" }], approvedAnswers: false, components: [] },
    { ...selected("schema.structure"), extra: true },
    { ...selected("schema.structure"), metadata: [{ kind: "schema.structure", documents: ['doc"; permit'] }] }]) {
    assert.throws(() => a.openSession(p, selection as SessionSelection, true), /^Error: invalid_selection$/);
  }
});

test("session attributes and selection are immutable copies, and close invalidates grants", () => {
  const a = new PolicyAuthority(permit);
  const attrs = { ...recipient };
  const agent = a.registerRecipient(attrs);
  const selection = { metadata: [{ kind: "schema.structure" as const, documents: ["doc-a"] }],
    approvedAnswers: false, components: [] as string[] };
  const session = a.openSession(agent, selection, true);
  attrs.project = "project-b";
  selection.metadata[0]!.documents.push("doc-b");
  selection.approvedAnswers = true;
  const r = a.registerResource({ project: "project-a", kind: "schema.structure", document: "doc-a" });
  const q: AuthorizationRequest = { session, resource: r, action: "receive_metadata" };
  const allowed = a.authorize(q);
  assert.equal(allowed.decision, "allow");
  const b = a.registerResource({ project: "project-a", kind: "schema.structure", document: "doc-b" });
  assert.equal(a.authorize({ ...q, resource: b }).reason, "selection_denied");
  a.closeSession(session);
  assert.equal(a.checkGrant(allowed.grant!).reason, "stale_session");
});

test("successful and failed policy replacement invalidate old sessions and old grants", () => {
  const { authority, agent, request } = setup();
  const first = authority.authorize(request);
  assert.equal(first.decision, "allow");
  assert.equal(authority.replaceDeployment(""), true);
  assert.equal(authority.authorize(request).reason, "stale_session");
  assert.equal(authority.checkGrant(first.grant!).reason, "stale_session");
  const session = authority.openSession(agent, selected("schema.structure"), true);
  assert.equal(authority.authorize({ ...request, session }).reason, "deployment_denied");
  assert.equal(authority.replaceDeployment("invalid-policy"), false);
  assert.equal(authority.authorize({ ...request, session }).reason, "invalid_policy");
  assert.throws(() => authority.openSession(agent, selected("schema.structure"), true), /invalid_policy/);
  assert.equal(authority.replaceDeployment(permit), true);
  assert.equal(authority.authorize(request).reason, "stale_session");
  const fresh = authority.openSession(agent, selected("schema.structure"), true);
  const latest = authority.authorize({ ...request, session: fresh });
  assert.equal(latest.decision, "allow");
  assert.equal(latest.audit.policyVersion, 4);
  assert.notEqual(latest.audit.epoch, first.audit.epoch);
});

test("resource replacement and revocation reject stale handles, even after a permit", () => {
  const { authority, resource, request } = setup();
  const first = authority.authorize(request);
  const next = authority.replaceResource(resource, { project: "project-a", kind: "data.raw", document: "doc-a" });
  assert.equal(authority.authorize(request).reason, "stale_resource");
  assert.equal(authority.checkGrant(first.grant!).reason, "stale_resource");
  const denied = authority.authorize({ ...request, resource: next });
  assert.equal(denied.reason, "selection_denied");
  assert.equal(denied.audit.resourceId, first.audit.resourceId);
  assert.equal(denied.audit.resourceVersion, 2);
  // A stale handle cannot revoke the current resource.
  authority.revokeResource(resource);
  assert.equal(authority.authorize({ ...request, resource: next }).reason, "selection_denied");
  authority.revokeResource(next);
  assert.equal(authority.authorize({ ...request, resource: next }).reason, "stale_resource");
});

test("failed resource replacement revokes the old version instead of keeping an unsafe fallback", () => {
  const { authority, request, resource } = setup();
  assert.throws(() => authority.replaceResource(resource, { project: "project-a", kind: "unknown", document: "doc-a" } as unknown as Resource));
  assert.equal(authority.authorize(request).reason, "stale_resource");
});

test("audit excludes raw identifiers, policies, payloads and Cedar error messages", () => {
  const audits: Audit[] = [];
  const a = new PolicyAuthority(`${permit}
    forbid(principal, action, resource) when { resource.document == "PRIVATE_DOC" && false };`,
  event => audits.push(event));
  const agent = a.registerRecipient({ ...recipient, project: "PRIVATE_PROJECT", deployment: "SECRET_DEPLOYMENT" });
  const session = a.openSession(agent, selected("schema.structure", ["PRIVATE_DOC"]), true);
  const resource = a.registerResource({ project: "PRIVATE_PROJECT", kind: "schema.structure", document: "PRIVATE_DOC" });
  const result = a.authorize({ session, resource, action: "receive_metadata" });
  assert.equal(result.decision, "allow");
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.policyVersion, 1);
  assert.equal(audits[0]?.resourceVersion, 1);
  assert.match(audits[0]!.policyDigest, /^[a-f0-9]{64}$/);
  assert.match(audits[0]!.sessionId!, /^[a-f0-9-]{36}$/);
  const text = JSON.stringify(result);
  for (const forbidden of ["PRIVATE", "SECRET", "permit", "forbid", "content", "prompt", "entities", "diagnostics"]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  assert.ok(Object.isFrozen(result.audit));
  assert.ok(Object.isFrozen(result));
});

test("an audit sink failure cannot issue a usable grant", () => {
  const a = new PolicyAuthority(permit, () => { throw new Error("SECRET_SINK_ERROR"); });
  const p = a.registerRecipient(recipient);
  const session = a.openSession(p, selected("schema.structure"), true);
  const resource = a.registerResource({ project: "project-a", document: "doc-a", kind: "schema.structure" });
  const decision = a.authorize({ session, resource, action: "receive_metadata" });
  assert.equal(decision.reason, "audit_failed");
  assert.equal(decision.grant, undefined);
  assert.equal(JSON.stringify(decision).includes("SECRET"), false);
});

test("reentrant audit revocation cannot return an allow or issue a stale grant", () => {
  const a = new PolicyAuthority(permit, event => {
    if (event.decision === "allow") a.replaceDeployment("");
  });
  const p = a.registerRecipient(recipient);
  const session = a.openSession(p, selected("schema.structure"), true);
  const resource = a.registerResource({ project: "project-a", document: "doc-a", kind: "schema.structure" });
  const decision = a.authorize({ session, resource, action: "receive_metadata" });
  assert.equal(decision.reason, "stale_session");
  assert.equal(decision.decision, "deny");
  assert.equal(decision.grant, undefined);
});

function wireRequest(): Request {
  return {
    principal: { type: "Warble::Agent", id: "agent" },
    action: { type: "Warble::Action", id: "receive_metadata" },
    resource: { type: "Warble::Resource", id: "resource" },
    context: { session: "session", epoch: 1, operatorAuthorized: true },
    entities: [
      { uid: { type: "Warble::Agent", id: "agent" }, attrs: {
        project: "p", role: "planner", zone: "public", deployment: "d" }, parents: [] },
      { uid: { type: "Warble::Resource", id: "resource" }, attrs: {
        project: "p", kind: "schema.structure", document: "doc-a", version: 1, approvedRecipient: "" }, parents: [] },
    ],
  };
}

test("real Cedar erroneous forbid is never masked by a successful permit", () => {
  const policy = `${permit} forbid(principal, action, resource)
    when { 9223372036854775807 + context.epoch > 0 };`;
  assert.equal(validatePolicies(policy), true);
  const native = cedar.isAuthorized({ ...wireRequest(), policies: { staticPolicies: policy },
    schema: DISCLOSURE_SCHEMA, validateRequest: true });
  assert.equal(native.type, "success");
  if (native.type !== "success") assert.fail();
  assert.equal(native.response.decision, "allow");
  assert.equal(native.response.diagnostics.errors.length, 1);
  assert.equal(evaluate(policy, wireRequest()), "error");
  const { authority, request } = setup(policy);
  assert.equal(authority.authorize(request).reason, "cedar_error");
  assert.equal(authority.authorize(request).grant, undefined);
});

test("schema/entity/request parsing and validation failures become generic errors", () => {
  assert.equal(validatePolicies(permit, "invalid schema"), false);
  assert.equal(evaluate(permit, wireRequest(), "invalid schema"), "error");
  const mutations: ((r: Request) => void)[] = [
    r => { r.entities = []; },
    r => { r.entities[0]!.attrs.zone = 9; },
    r => { delete r.entities[1]!.attrs.kind; },
    r => { r.entities[1]!.attrs.extra = "SECRET"; },
    r => { r.context.epoch = "not-long"; },
    r => { r.context.extra = true; },
    r => { r.action = { type: "Warble::Action", id: "unknown" }; },
    r => { r.principal = { type: "Warble::Resource", id: "resource" }; },
  ];
  for (const mutate of mutations) {
    const r = wireRequest(); mutate(r);
    assert.equal(evaluate(permit, r), "error");
  }
});
