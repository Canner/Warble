import { randomUUID } from "node:crypto";
import { PolicyAuthority } from "./authorization.js";
import type { RecipientHandle, ResourceHandle, SessionHandle } from "./authorization.js";
import type { MetadataKind } from "./selection.js";

export interface ArtifactHandle { readonly __artifact: unique symbol }
export interface Projection {
  /** Trusted, deterministic adapter code; never an LLM-provided function/schema. */
  project(raw: unknown): unknown;
  validate(value: unknown): boolean;
  /** Optional private judge can only veto an already projected, validated artifact. */
  judge?(value: unknown, signal: AbortSignal): Promise<boolean>;
}
export interface PublicResult {
  content: { type: "text"; text: string }[];
  structuredContent: unknown;
  details: Record<string, never>;
  isError?: boolean;
}
export function unavailable(): PublicResult {
  return { content: [{ type: "text", text: '{"status":"unavailable"}' }],
    structuredContent: { status: "unavailable" }, details: {}, isError: true };
}
/** Copy only JSON values. Reject getters, prototypes, toJSON, cycles and non-finite values. */
export function jsonBytes(value: unknown, maxBytes = 1048576): string {
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 64) throw new Error("invalid_json");
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || seen.has(v)) throw new Error("invalid_json");
    const proto = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) throw new Error("invalid_json");
    seen.add(v);
    for (const key of Reflect.ownKeys(v)) {
      if (Array.isArray(v) && key === "length") continue;
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (typeof key !== "string" || !d.enumerable || !('value' in d)) throw new Error("invalid_json");
      visit(d.value, depth + 1);
    }
    seen.delete(v);
  };
  visit(value, 0);
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > maxBytes) throw new Error("output_limit");
  return bytes;
}

/** Payloads and their authority stay together, privately; callers cannot relabel an artifact. */
export class DisclosureBoundary {
  #artifacts = new WeakMap<object, { resource: ResourceHandle; bytes: string; action: "receive_metadata" | "receive_answer" }>();
  constructor(readonly authority: PolicyAuthority, readonly maxBytes = 1048576) {}

  metadata(project: string, kind: MetadataKind, document: string, value: unknown): ArtifactHandle {
    const bytes = jsonBytes(value, this.maxBytes);
    const resource = this.authority.registerResource({ project, kind, document });
    return this.#store(resource, bytes, "receive_metadata");
  }

  async answer(project: string, recipient: RecipientHandle, raw: unknown, projection: Projection,
    signal: AbortSignal): Promise<ArtifactHandle> {
    signal.throwIfAborted();
    const bytes = jsonBytes(projection.project(raw), this.maxBytes);
    // Validator and judge receive separate copies, never the bytes retained for disclosure.
    if (projection.validate(JSON.parse(bytes)) !== true) throw new Error("invalid_answer");
    if (projection.judge && await projection.judge(JSON.parse(bytes), signal) !== true) throw new Error("judge_denied");
    signal.throwIfAborted();
    const resource = this.authority.registerApprovedAnswer({ project, document: randomUUID() }, recipient);
    return this.#store(resource, bytes, "receive_answer");
  }

  #store(resource: ResourceHandle, bytes: string, action: "receive_metadata" | "receive_answer"): ArtifactHandle {
    const handle = Object.freeze({}) as ArtifactHandle;
    this.#artifacts.set(handle, { resource, bytes, action });
    return handle;
  }

  read(session: SessionHandle, handle: ArtifactHandle): unknown {
    const artifact = this.#artifacts.get(handle);
    if (!artifact) throw new Error("disclosure_denied");
    const decision = this.authority.authorize({ session, resource: artifact.resource, action: artifact.action });
    if (!decision.grant || this.authority.checkGrant(decision.grant).decision !== "allow") throw new Error("disclosure_denied");
    return JSON.parse(artifact.bytes);
  }

  result(session: SessionHandle, handle: ArtifactHandle): PublicResult {
    const value = this.read(session, handle);
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, details: {} };
  }

  revoke(handle: ArtifactHandle): void {
    const artifact = this.#artifacts.get(handle);
    if (artifact) this.authority.revokeResource(artifact.resource);
    this.#artifacts.delete(handle);
  }
}
