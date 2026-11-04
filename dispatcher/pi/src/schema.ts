/** Application schema version, independent of Warble IR and native launch versions. */
export const SCHEMA_VERSION = "1";

/** Fixed schema: callers may supply policies, never redefine entity/request types. */
export const DISCLOSURE_SCHEMA = `
namespace Warble {
  entity Agent = {
    project: String,
    role: String,
    zone: String,
    deployment: String
  };
  entity Resource = {
    project: String,
    kind: String,
    document: String,
    version: Long,
    approvedRecipient: String
  };
  type RequestContext = {
    session: String,
    epoch: Long,
    operatorAuthorized: Bool
  };
  action "invoke_component", "receive_metadata", "receive_answer"
    appliesTo {
      principal: Agent,
      resource: Resource,
      context: RequestContext
    };
}
`;
