import assert from "node:assert/strict";
import { PolicyAuthority, selectionPreset } from "../dist/index.js";

const a = new PolicyAuthority('permit(principal, action, resource);');
const recipient = a.registerRecipient({ project: "fixture", role: "planner", zone: "public", deployment: "fixture" });
const resource = a.registerResource({ project: "fixture", kind: "schema.structure", document: "catalog" });
const session = a.openSession(recipient, selectionPreset("schema-aware", ["catalog"]), true);
assert.equal(a.authorize({ session, resource, action: "receive_metadata" }).decision, "allow");
assert.equal(a.replaceDeployment(""), true);
assert.equal(a.authorize({ session, resource, action: "receive_metadata" }).decision, "deny");
console.log("Built ESM package loads Cedar WASM and enforces policy replacement.");
