// Example ceiling, evaluated separately from the session selection.
// Document IDs are adapter-owned identities, never paths or model-supplied attributes.
permit (
  principal,
  action == Warble::Action::"receive_metadata",
  resource
)
when {
  principal.project == resource.project &&
  principal.role == "planner" &&
  principal.zone == "public" &&
  principal.deployment == "cloud-planner" &&
  (
    (["schema.structure", "schema.descriptions"].contains(resource.kind) &&
      resource.document == "catalog") ||
    (resource.kind == "knowledge.rules" && resource.document == "approved-rules")
  )
};

permit (principal, action == Warble::Action::"invoke_component", resource)
when {
  principal.project == resource.project &&
  resource.kind == "component" && resource.document == "private-oracle"
};

permit (principal, action == Warble::Action::"receive_answer", resource)
when {
  principal.project == resource.project && resource.kind == "answer.approved"
};

forbid (principal, action, resource)
when {
  principal.zone == "public" &&
  ["mdl.expressions", "knowledge.sql", "data.samples", "data.raw"].contains(resource.kind)
};
