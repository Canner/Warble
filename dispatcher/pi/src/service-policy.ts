import { evaluate, validatePolicies } from "./cedar.js";

export const SERVICE_PROTOCOL = "warble-private-service/1";
export const SERVICE_SCHEMA = `namespace Service {
  entity Agent = { project: String, caller: String, role: String, zone: String };
  entity Resource = { project: String, kind: String, name: String, columns: Set<String>, recipient: String };
  type Context = { session: String, epoch: Long };
  action "invoke_component", "invoke_tool", "execute_query", "receive_metadata", "receive_answer"
    appliesTo { principal: Agent, resource: Resource, context: Context };
}`;
export interface ServiceRequest {
  caller: string; project: string; role: "planner" | "worker"; session: string; epoch: number;
  action: "invoke_component" | "invoke_tool" | "execute_query" | "receive_metadata" | "receive_answer";
  kind: string; name: string; columns: string[]; recipient: string;
}
const actions = ["invoke_component", "invoke_tool", "execute_query", "receive_metadata", "receive_answer"];
/** Trusted host API; never exposed as an MCP/model tool. Policies are intersected. */
export class ServicePolicy {
  constructor(private readonly policies: readonly string[]) {
    if (policies.length < 2 || policies.some(p => !validatePolicies(p, SERVICE_SCHEMA))) throw Error("invalid_policy");
  }
  authorize(r: ServiceRequest): boolean {
    if (!r || !actions.includes(r.action) || !["planner", "worker"].includes(r.role)
      || !Number.isSafeInteger(r.epoch) || r.epoch < 1 || !Array.isArray(r.columns)
      || !r.columns.every(c => typeof c === "string")
      || [r.caller, r.project, r.session, r.kind, r.name].some(s => typeof s !== "string" || !s || s.length > 256)) return false;
    if (r.action === "receive_answer" && r.recipient !== r.caller) return false;
    const principal = { type: "Service::Agent", id: r.caller + ":" + r.role };
    const resource = { type: "Service::Resource", id: r.kind + ":" + r.name };
    const request = { principal, resource, action: { type: "Service::Action", id: r.action },
      entities: [
        { uid: principal, attrs: { project: r.project, caller: r.caller, role: r.role,
          zone: r.role === "worker" ? "private" : "public" }, parents: [] },
        { uid: resource, attrs: { project: r.project, kind: r.kind, name: r.name,
          columns: r.columns, recipient: r.recipient }, parents: [] },
      ], context: { session: r.session, epoch: r.epoch } };
    return this.policies.every(p => evaluate(p, request, SERVICE_SCHEMA) === "allow");
  }
}
