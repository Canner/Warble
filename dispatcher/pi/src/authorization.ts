import { createHash, randomUUID } from "node:crypto";
import type { EntityJson } from "@cedar-policy/cedar-wasm/nodejs";
import { CEDAR_VERSION, evaluate, validatePolicies } from "./cedar.js";
import { SCHEMA_VERSION } from "./schema.js";
import { identifier, METADATA_KINDS, record, selectionPolicies } from "./selection.js";
import type { Action, MetadataKind, ResourceKind, SessionSelection } from "./selection.js";

declare const recipientBrand: unique symbol;
declare const resourceBrand: unique symbol;
declare const sessionBrand: unique symbol;
declare const grantBrand: unique symbol;
export interface RecipientHandle { readonly [recipientBrand]: true }
export interface ResourceHandle { readonly [resourceBrand]: true }
export interface SessionHandle { readonly [sessionBrand]: true }
export interface GrantHandle { readonly [grantBrand]: true }
export interface Recipient {
  readonly project: string;
  readonly role: "planner" | "worker";
  readonly zone: "public" | "private";
  /** Opaque deployment reference, not credentials or a provider URL. */
  readonly deployment: string;
}
export interface Resource {
  readonly project: string;
  readonly kind: MetadataKind | "component";
  readonly document: string;
}
export type Reason = "allowed" | "deployment_denied" | "selection_denied" | "cedar_error"
  | "invalid_policy" | "invalid_request" | "stale_session" | "stale_resource" | "stale_grant"
  | "project_mismatch" | "action_mismatch" | "recipient_mismatch" | "operator_denied" | "audit_failed";
export interface Audit {
  readonly decision: "allow" | "deny";
  readonly reason: Reason;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly policyDigest: string;
  readonly schemaVersion: string;
  readonly cedarVersion: string;
  readonly sessionId: string | null;
  readonly epoch: number | null;
  readonly selectionDigest: string | null;
  readonly resourceId: string | null;
  readonly resourceVersion: number | null;
  readonly role: Recipient["role"] | null;
  readonly zone: Recipient["zone"] | null;
  readonly action: Action | null;
}
export interface Decision {
  readonly decision: "allow" | "deny";
  readonly reason: Reason;
  readonly audit: Audit;
  readonly grant?: GrantHandle;
}
export interface AuthorizationRequest {
  readonly session: SessionHandle;
  readonly resource: ResourceHandle;
  readonly action: Action;
}
interface StoredRecipient extends Recipient { id: string }
interface StoredResource {
  id: string; version: number; project: string; kind: ResourceKind; document: string;
  approvedRecipient: string;
}
interface Session {
  id: string; epoch: number; policyVersion: number; closed: boolean;
  recipient: StoredRecipient; selection: string; operatorAuthorized: boolean;
}
const actions: readonly Action[] = ["invoke_component", "receive_metadata", "receive_answer"];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const handle = <T>(): T => Object.freeze({}) as T;
const entity = (type: string, id: string) => ({ type: `Warble::${type}`, id });
const lookup = <T>(map: WeakMap<object, T>, key: unknown): T | undefined =>
  typeof key === "object" && key !== null ? map.get(key) : undefined;

/**
 * Trusted control plane only. Never register these methods as model tools.
 * Model-facing integration may retain only opaque handles and authorize/checkGrant.
 * This module decides authority; it neither reads content nor sends model requests.
 */
export class PolicyAuthority {
  #recipients = new WeakMap<object, StoredRecipient>();
  #resources = new WeakMap<object, StoredResource>();
  #versions = new Map<string, number>();
  #sessions = new WeakMap<object, Session>();
  #grants = new WeakMap<object, AuthorizationRequest>();
  #policy = "";
  #valid = false;
  #policyId = randomUUID();
  #policyVersion = 0;
  #epoch = 0;
  #audit: ((event: Audit) => void) | undefined;
  #listeners = new Set<() => void>();

  /** Trusted runtime lifecycle: revoke first, then synchronously abort affected work. */
  onInvalidate(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #invalidate(): void {
    for (const listener of [...this.#listeners]) { try { listener(); } catch { /* no undo */ } }
  }

  isSessionFor(session: SessionHandle, recipient: RecipientHandle, zone: Recipient["zone"]): boolean {
    const s = lookup(this.#sessions, session), r = lookup(this.#recipients, recipient);
    return !!s && !!r && s.recipient === r && r.zone === zone && !s.closed
      && this.#valid && s.policyVersion === this.#policyVersion && s.operatorAuthorized;
  }

  constructor(deploymentPolicy: string, audit?: (event: Audit) => void) {
    this.#audit = audit;
    this.replaceDeployment(deploymentPolicy);
  }

  /** Every replacement invalidates old sessions, even if invalid or identical to the old policy. */
  replaceDeployment(policies: string): boolean {
    this.#policyVersion++;
    this.#valid = false;
    this.#policy = "";
    this.#invalidate();
    if (!validatePolicies(policies)) return false;
    this.#policy = policies;
    this.#valid = true;
    return true;
  }

  registerRecipient(value: Recipient): RecipientHandle {
    if (!record(value, ["project", "role", "zone", "deployment"]) || !identifier(value.project)
      || !identifier(value.deployment) || !["planner", "worker"].includes(value.role as string)
      || !["public", "private"].includes(value.zone as string)) throw new Error("invalid_recipient");
    const h = handle<RecipientHandle>();
    this.#recipients.set(h, Object.freeze({ ...value, id: randomUUID() }));
    return h;
  }

  registerResource(value: Resource): ResourceHandle {
    return this.#storeResource(value);
  }

  /**
   * Only the trusted result verifier may call this, after content projection/validation.
   * An LLM cannot self-classify a summary as approved. No content is accepted by this API.
   */
  registerApprovedAnswer(value: Omit<Resource, "kind">, recipient: RecipientHandle): ResourceHandle {
    const r = lookup(this.#recipients, recipient);
    if (!record(value, ["project", "document"]) || !r || r.project !== value.project) {
      throw new Error("invalid_approval");
    }
    return this.#storeResource({ ...value, kind: "answer.approved" }, undefined, r.id);
  }

  #storeResource(value: unknown, previous?: StoredResource, approvedRecipient = ""): ResourceHandle {
    if (!record(value, ["project", "kind", "document"]) || !identifier(value.project)
      || !identifier(value.document) || !(value.kind === "component"
        || METADATA_KINDS.includes(value.kind as MetadataKind)
        || (value.kind === "answer.approved" && approvedRecipient !== ""))) throw new Error("invalid_resource");
    const h = handle<ResourceHandle>();
    const resource: StoredResource = Object.freeze({
      id: previous?.id ?? randomUUID(), version: (previous?.version ?? 0) + 1,
      project: value.project, document: value.document, kind: value.kind as ResourceKind, approvedRecipient,
    });
    this.#resources.set(h, resource);
    this.#versions.set(resource.id, resource.version);
    return h;
  }

  /** Invalid replacement revokes the old resource too; no fallback to outdated authority. */
  replaceResource(previous: ResourceHandle, value: Resource): ResourceHandle {
    const old = lookup(this.#resources, previous);
    if (!old || this.#versions.get(old.id) !== old.version) throw new Error("stale_resource");
    this.#versions.delete(old.id);
    this.#invalidate();
    return this.#storeResource(value, old);
  }

  revokeResource(resource: ResourceHandle): void {
    const old = lookup(this.#resources, resource);
    if (old && this.#versions.get(old.id) === old.version) {
      this.#versions.delete(old.id);
      this.#invalidate();
    }
  }

  openSession(recipient: RecipientHandle, selection: SessionSelection, operatorAuthorized: boolean): SessionHandle {
    const r = lookup(this.#recipients, recipient);
    if (!r || typeof operatorAuthorized !== "boolean") throw new Error("invalid_session");
    if (!this.#valid) throw new Error("invalid_policy");
    const policies = selectionPolicies(selection); // Copy to immutable policy text immediately.
    if (!validatePolicies(policies)) throw new Error("invalid_selection");
    const h = handle<SessionHandle>();
    this.#sessions.set(h, { id: randomUUID(), epoch: ++this.#epoch, policyVersion: this.#policyVersion,
      closed: false, recipient: r, selection: policies, operatorAuthorized });
    return h;
  }

  closeSession(session: SessionHandle): void {
    const s = lookup(this.#sessions, session);
    if (s) s.closed = true;
    this.#invalidate();
  }

  authorize(request: AuthorizationRequest): Decision {
    try {
      return this.#authorize(request);
    } catch {
      return this.#result("invalid_request");
    }
  }

  #authorize(request: AuthorizationRequest): Decision {
    if (!record(request, ["session", "resource", "action"]) || !actions.includes(request.action as Action)) {
      return this.#result("invalid_request");
    }
    const s = lookup(this.#sessions, request.session);
    const r = lookup(this.#resources, request.resource);
    const a = request.action;
    const deny = (reason: Reason) => this.#result(reason, s, r, a);
    if (!s || !r) return deny("invalid_request");
    if (!this.#valid) return deny("invalid_policy");
    if (s.closed || s.policyVersion !== this.#policyVersion) return deny("stale_session");
    if (this.#versions.get(r.id) !== r.version) return deny("stale_resource");
    if (!s.operatorAuthorized) return deny("operator_denied");
    if (s.recipient.project !== r.project) return deny("project_mismatch");
    const expected: Action = r.kind === "component" ? "invoke_component"
      : r.kind === "answer.approved" ? "receive_answer" : "receive_metadata";
    if (a !== expected) return deny("action_mismatch");
    if (r.kind === "answer.approved" && r.approvedRecipient !== s.recipient.id) return deny("recipient_mismatch");
    const principal = entity("Agent", s.recipient.id);
    const resource = entity("Resource", r.id);
    const entities: EntityJson[] = [
      { uid: principal, attrs: { project: s.recipient.project, role: s.recipient.role,
        zone: s.recipient.zone, deployment: s.recipient.deployment }, parents: [] },
      { uid: resource, attrs: { project: r.project, kind: r.kind, document: r.document,
        version: r.version, approvedRecipient: r.approvedRecipient }, parents: [] },
    ];
    const input = { principal, resource, action: entity("Action", a), entities,
      context: { session: s.id, epoch: s.epoch, operatorAuthorized: s.operatorAuthorized } };
    // Independent evaluations: merging permit policies would incorrectly take their union.
    const deployment = evaluate(this.#policy, input);
    const selection = evaluate(s.selection, input);
    if (deployment === "error" || selection === "error") return deny("cedar_error");
    if (deployment !== "allow") return deny("deployment_denied");
    if (selection !== "allow") return deny("selection_denied");
    return this.#result("allowed", s, r, a, request);
  }

  /** Re-evaluate immediately before use; a prior allow is not a transferable/replayable permit. */
  checkGrant(grant: GrantHandle): Decision {
    const request = lookup(this.#grants, grant);
    return request ? this.authorize(request) : this.#result("stale_grant");
  }

  #result(reason: Reason, s?: Session, r?: StoredResource, action?: Action, request?: AuthorizationRequest): Decision {
    const authorizedRequest = request ? Object.freeze({ ...request }) : undefined;
    let audit: Audit = Object.freeze({
      decision: reason === "allowed" ? "allow" : "deny", reason,
      policyId: this.#policyId, policyVersion: this.#policyVersion, policyDigest: hash(this.#policy),
      schemaVersion: SCHEMA_VERSION, cedarVersion: CEDAR_VERSION,
      sessionId: s?.id ?? null, epoch: s?.epoch ?? null, selectionDigest: s ? hash(s.selection) : null,
      resourceId: r?.id ?? null, resourceVersion: r?.version ?? null,
      role: s?.recipient.role ?? null, zone: s?.recipient.zone ?? null, action: action ?? null,
    });
    try { this.#audit?.(audit); } catch {
      reason = "audit_failed";
      audit = Object.freeze({ ...audit, decision: "deny", reason });
    }
    // A synchronous audit integration can revoke authority reentrantly. Do not mint a grant
    // from a decision that ceased to be current while its audit was being delivered.
    if (reason === "allowed") {
      if (!this.#valid) reason = "invalid_policy";
      else if (s?.closed || s?.policyVersion !== this.#policyVersion) reason = "stale_session";
      else if (!r || this.#versions.get(r.id) !== r.version) reason = "stale_resource";
      if (reason !== "allowed") audit = Object.freeze({ ...audit, decision: "deny", reason });
    }
    if (reason !== "allowed" || !authorizedRequest) return Object.freeze({ decision: "deny", reason, audit });
    const grant = handle<GrantHandle>();
    this.#grants.set(grant, authorizedRequest);
    return Object.freeze({ decision: "allow", reason, audit, grant });
  }
}
