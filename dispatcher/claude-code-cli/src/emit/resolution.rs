//! Capability resolution against a target profile (`resolve_node_capabilities` /
//! `resolve_node_with_shared_binding`) and the stderr resolution summary
//! (`print_resolution_summary`).

use crate::error::DispatchError;
use crate::ir::ComponentNode;
use crate::resolve::{resolve_capabilities, ResolutionReport};
use crate::targets::{is_known_target, known_target_names, TargetId};

// --- capability resolution + summary --------------------------------------------------------------

fn format_summary_line(entry: &crate::resolve::ResolvedCapability) -> String {
    let outcome = serde_json::to_value(entry.outcome)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    let provided = serde_json::to_value(entry.provided_by)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    let criticality = serde_json::to_value(entry.criticality)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    let suffix = entry
        .note
        .as_ref()
        .map(|n| format!(" — {n}"))
        .unwrap_or_default();
    format!(
        "  {:<28} {:<12} ({provided}, {criticality}){suffix}",
        entry.capability, outcome
    )
}

pub(super) fn print_resolution_summary(target_label: &str, report: &ResolutionReport) {
    eprintln!("warble-dispatch: capability resolution for target '{target_label}':");
    for entry in report {
        eprintln!("{}", format_summary_line(entry));
    }
}

/// Resolve one node's required capabilities against `target_id`, erroring on any `fail` outcome
/// (no silent degradation). Callers must not emit files when this errors.
pub fn resolve_node_capabilities(
    node: &ComponentNode,
    target_id: &str,
) -> Result<ResolutionReport, DispatchError> {
    if !is_known_target(target_id) {
        return Err(DispatchError(format!(
            "target '{target_id}' has no capability profile (known targets: {})",
            known_target_names().join(", ")
        )));
    }
    let profile = TargetId::parse(target_id)
        .expect("known target parses")
        .profile();
    resolve_capabilities(node, target_id, &profile)
}

/// Resolve a node using the IR's shared top-level fine-grained binding. The compiler emits the
/// `resolved` block once at `ir.context_binding` (a single coarse binding is shared by every mounted
/// component — ir-schema §v0.3), so a per-node `context_binding` is coarse. Binding-shape capability
/// resolution (`blast_radius`) reads the node's own `context_binding.resolved`, so mirror the shared
/// top-level `resolved` onto the node before resolving. Dispatcher-side hydration only — this is why
/// `core` can keep `resolved` at the top level (it is never edited here; hard invariant: `core/`
/// stays untouched).
pub(super) fn resolve_node_with_shared_binding(
    node: &ComponentNode,
    top: &crate::ir::ContextBinding,
    target_id: &str,
) -> Result<ResolutionReport, DispatchError> {
    if node.context_binding.resolved.is_some() || top.resolved.is_none() {
        return resolve_node_capabilities(node, target_id);
    }
    let mut hydrated = node.clone();
    hydrated.context_binding.resolved = top.resolved.clone();
    resolve_node_capabilities(&hydrated, target_id)
}
