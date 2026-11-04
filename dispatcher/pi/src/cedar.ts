import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import type { AuthorizationCall, EntityUid, Schema } from "@cedar-policy/cedar-wasm/nodejs";
import { DISCLOSURE_SCHEMA } from "./schema.js";

export const CEDAR_VERSION = cedar.getCedarVersion();
export type Evaluation = "allow" | "deny" | "error";
export type Request = Omit<AuthorizationCall, "schema" | "policies" | "validateRequest">;

/** No raw Cedar error, policy text, entity or diagnostic ever leaves this adapter. */
export function validatePolicies(policies: string, schema: Schema = DISCLOSURE_SCHEMA): boolean {
  try {
    if (typeof policies !== "string" || Buffer.byteLength(policies) > 65536) return false;
    if (cedar.checkParseSchema(schema).type !== "success") return false;
    const result = cedar.validate({ schema, policies: { staticPolicies: policies },
      validationSettings: { mode: "strict" } });
    return result.type === "success" && result.validationErrors.length === 0;
  } catch {
    return false;
  }
}

/** Cedar's skip-on-error semantics are deliberately strengthened to application-level deny. */
export function evaluate(policies: string, request: Request, schema: Schema = DISCLOSURE_SCHEMA): Evaluation {
  try {
    const key = (value: EntityUid) => {
      const uid = "__entity" in value ? value.__entity : value;
      return JSON.stringify([uid.type, uid.id]);
    };
    // Cedar permits policies that do not dereference an absent entity. This application requires
    // complete principal/resource records even for a blanket permit.
    const present = new Set(request.entities.map(e => key(e.uid)));
    if (!present.has(key(request.principal)) || !present.has(key(request.resource))) return "error";
    if (cedar.checkParseEntities({ entities: request.entities, schema }).type !== "success") return "error";
    const result = cedar.isAuthorized({ ...request, schema, validateRequest: true,
      policies: { staticPolicies: policies } });
    if (result.type !== "success" || result.response.diagnostics.errors.length !== 0) return "error";
    return result.response.decision === "allow" ? "allow" : "deny";
  } catch {
    return "error";
  }
}
