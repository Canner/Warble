//! `.claude/settings.json` permission/comment derivation for the single-agent path, plus the shared
//! `.wren/config.json` payload (`wren_config`).

use super::gate::{build_tools, gate_grants_write, resolve_render_gate, GateKind};
use super::support::{
    find_guardrail, is_mutation, is_read_only, DEFAULT_ARTIFACT_SCOPE,
    DESTRUCTIVE_BASH_DENY_PATTERNS,
};
use super::types::RenderFlavor;
use crate::ir::ComponentNode;
use crate::resolve::ResolutionReport;

pub(super) fn build_settings(
    node: &ComponentNode,
    report: &ResolutionReport,
    flavor: RenderFlavor,
) -> serde_json::Value {
    let gate = resolve_render_gate(node, report, flavor);
    let allow = build_tools(node, &gate);
    let read_only = is_read_only(&node.guardrails);

    let mut comments: Vec<String> = Vec::new();
    if read_only {
        comments.push(
            "Guardrail 'read_only_execution' is locked on this component: it enforces DATA \
read-only (destructive bash patterns denied here, plus wren's strict_mode at the data layer — \
see .wren/config.json). It does NOT, by itself, withhold artifact writes."
                .to_string(),
        );
    }
    if gate_grants_write(&gate) {
        comments.push(format!(
            "Guardrail 'artifact_write' is locked, scope '{}': grants the Write tool above so the \
agent can write the rendered dashboard.html into that scope only (prompt render flavor).",
            gate.scope
                .clone()
                .unwrap_or_else(|| DEFAULT_ARTIFACT_SCOPE.to_string())
        ));
    } else if gate.kind == GateKind::Realize {
        comments.push(
            "Render flavor is programmatic: the agent stays fully read-only (no Write) and emits a \
render envelope as output; the dispatcher's warble-render produces dashboard.html."
                .to_string(),
        );
    }
    if is_mutation(node) {
        if node.effect.outcome.target.as_deref() == Some("context") {
            let context_guardrail = find_guardrail(&node.guardrails, "context_write_authz");
            let scope = context_guardrail
                .and_then(|g| g.scope.as_deref())
                .unwrap_or(DEFAULT_ARTIFACT_SCOPE);
            comments.push(format!(
                "This is a gated-tool constitutive component: the lifecycle is dry-run -> \
context_write_authz gate (scope '{scope}') -> human approval -> apply (rollback via git). \
Edit/Write are granted below, but they are GATED by that lifecycle, not free to use — writes \
outside the '{scope}' scope are never permitted, and no change may be applied before human \
approval clears."
            ));
        } else {
            comments.push(
                "This is a gated-tool mutating component: the lifecycle is dry-run -> `warble \
blast-radius` gate -> human approval -> apply (rollback via git). Edit/Write are granted below, \
but they are GATED by that lifecycle, not free to use — do not apply any change before the \
blast-radius gate and human approval have both cleared."
                    .to_string(),
            );
        }
    }

    let permissions = if read_only {
        serde_json::json!({ "allow": allow, "deny": DESTRUCTIVE_BASH_DENY_PATTERNS })
    } else {
        serde_json::json!({ "allow": allow })
    };
    if comments.is_empty() {
        serde_json::json!({ "permissions": permissions })
    } else {
        serde_json::json!({ "$comment": comments.join(" "), "permissions": permissions })
    }
}

pub(super) fn wren_config() -> serde_json::Value {
    serde_json::json!({
        "strict_mode": true,
        "denied_functions": ["pg_read_file", "dblink", "lo_import"],
    })
}
