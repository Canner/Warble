//! The render gate (`GateKind` / `RenderGate` / `resolve_render_gate` / `gate_grants_write`) and the
//! tool-grant + description derivation (`build_tools` / `requires_blast_radius_gate` /
//! `build_description`) for an emitted agent's frontmatter.

use super::support::{
    find_guardrail, has_data_access_capability, is_mutation, is_read_only,
    ARTIFACT_WRITE_GUARDRAIL_NAME, DEFAULT_ARTIFACT_SCOPE, RENDER_CONTRACT_CAPABILITY,
};
use super::types::RenderFlavor;
use crate::ir::ComponentNode;
use crate::provider::ToolMap;
use crate::resolve::ResolutionReport;
use crate::targets::CapabilityOutcome;

// --- render gate --------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum GateKind {
    Realize,
    Degrade,
    None,
}

pub(super) struct RenderGate {
    pub(super) kind: GateKind,
    pub(super) scope: Option<String>,
    pub(super) flavor: Option<RenderFlavor>,
}

/// The render gate only resolves to `realize` when `render_contract` is `realize-via` on the
/// target — in this POC only `claude-code:headless`, which always has `structured_output_capture`
/// native, so the requested flavor is honored as-is. Interactive degrades render to markdown and
/// never reaches `realize`.
pub(super) fn resolve_render_gate(
    node: &ComponentNode,
    report: &ResolutionReport,
    flavor: RenderFlavor,
) -> RenderGate {
    let artifact_write = find_guardrail(&node.guardrails, ARTIFACT_WRITE_GUARDRAIL_NAME);
    let Some(artifact_write) = artifact_write else {
        return RenderGate {
            kind: GateKind::None,
            scope: None,
            flavor: None,
        };
    };
    if node.effect.render_blocks.is_empty() {
        return RenderGate {
            kind: GateKind::None,
            scope: None,
            flavor: None,
        };
    }
    let render_entry = report
        .iter()
        .find(|r| r.capability == RENDER_CONTRACT_CAPABILITY);
    match render_entry.map(|e| e.outcome) {
        Some(CapabilityOutcome::RealizeVia) => RenderGate {
            kind: GateKind::Realize,
            scope: Some(
                artifact_write
                    .scope
                    .clone()
                    .unwrap_or_else(|| DEFAULT_ARTIFACT_SCOPE.to_string()),
            ),
            flavor: Some(flavor),
        },
        Some(CapabilityOutcome::Degrade) => RenderGate {
            kind: GateKind::Degrade,
            scope: None,
            flavor: None,
        },
        _ => RenderGate {
            kind: GateKind::None,
            scope: None,
            flavor: None,
        },
    }
}

/// Only the prompt flavor needs the agent to write the file itself; programmatic keeps it read-only.
pub(super) fn gate_grants_write(gate: &RenderGate) -> bool {
    gate.kind == GateKind::Realize && gate.flavor == Some(RenderFlavor::Prompt)
}

pub(super) fn build_tools(
    node: &ComponentNode,
    gate: &RenderGate,
    tool_map: &ToolMap,
) -> Vec<String> {
    let mut tools: Vec<String> = vec!["Read".to_string()];
    // A mutation outcome needs `wren` to analyze the target before proposing a diff, same as any
    // other data-access capability; keyed on the outcome enum, not on whether the component
    // separately declared a data-access capability.
    if has_data_access_capability(&node.required_capabilities) || is_mutation(node) {
        tools.push("Bash(wren:*)".to_string());
    }
    // +Mutating (data target): the blast-radius gate is a separate CLI, not a wren subcommand — the
    // agent needs its own tool grant to invoke it before an edit may be applied. +Constitutive
    // (`outcome.target == "context"`) reuses this same mutation arm but is gated by the path-scoped
    // `context_write_authz` instead of blast-radius, so it must NOT get this grant unless the node
    // actually requires the blast-radius gate — keyed on that requirement, not on bare `is_mutation`.
    if requires_blast_radius_gate(node) {
        tools.push("Bash(warble:*)".to_string());
    }
    // Domain capabilities are bound by provider fragments, not by this back-end: whatever a
    // fragment says realizes a required capability is granted here, and warble never learns whose
    // product that is. An MCP-backed grant is also why such a capability costs no bash widening —
    // the call gets its own permission gate and a read-only agent stays read-only
    // (capability-model §7.2).
    for capability in &node.required_capabilities {
        if let Some(binding) = tool_map.get(capability.as_str()) {
            tools.extend(binding.names.iter().cloned());
        }
    }
    let mutating = !is_read_only(&node.guardrails);
    if mutating {
        tools.push("Edit".to_string());
    }
    if mutating || gate_grants_write(gate) {
        tools.push("Write".to_string());
    }
    tools
}

/// Whether `node` requires the blast-radius gate: declared directly in `required_capabilities`, or
/// via a `blast_radius_limit` guardrail. Distinct from bare `is_mutation` — a +Constitutive
/// component (`outcome.target == "context"`) reuses the mutation outcome arm without blast-radius,
/// so it must not pick up `Bash(warble:*)` just for being a mutation.
fn requires_blast_radius_gate(node: &ComponentNode) -> bool {
    node.required_capabilities
        .iter()
        .any(|c| c == "blast_radius")
        || find_guardrail(&node.guardrails, "blast_radius_limit").is_some()
}

/// The frontmatter `description` of a component's **entry** agent.
///
/// The runtime reads this field to decide whether to hand work to the agent, so an authored purpose
/// wins over anything the back-end can synthesize from the IR: a shape line ("analytical skill that
/// renders no render blocks") describes what the component *is* and says nothing about when to send
/// it a request. Authored examples ride along here rather than only in the scope's inventory,
/// because this is the string the selector actually sees.
///
/// Entry agents only. A per-step subagent keeps its own step-scoped line — it is not a destination
/// anything may choose, and lending it the component's purpose would advertise a step as an entry.
pub(super) fn build_description(node: &ComponentNode) -> String {
    if let Some(authored) = authored_description(node) {
        return authored;
    }
    synthesized_description(node)
}

/// The authored purpose (plus examples), when the component carries one.
///
/// Separate from [`build_description`] so the paths that synthesize a *different* shape line for a
/// delegating entry agent — the per-step split driver, the isolating parent — can prefer the
/// authored text without inheriting the non-delegating fallback.
pub(super) fn authored_description(node: &ComponentNode) -> Option<String> {
    let purpose = node.description.as_deref()?.trim();
    if purpose.is_empty() {
        return None;
    }
    if node.examples.is_empty() {
        return Some(purpose.to_string());
    }
    Some(format!(
        "{purpose} Examples: {}",
        node.examples
            .iter()
            .map(|example| format!("\"{}\"", example.trim()))
            .collect::<Vec<_>>()
            .join("; ")
    ))
}

fn synthesized_description(node: &ComponentNode) -> String {
    let block_types: Vec<&str> = node
        .effect
        .render_blocks
        .iter()
        .map(|b| b.block_type.as_str())
        .collect();
    let blocks = if block_types.is_empty() {
        "no render blocks".to_string()
    } else {
        block_types.join(", ")
    };
    format!(
        "{} {} that renders {blocks} (outcome: {}).",
        node.component_type.as_str(),
        node.realization_kind.as_str(),
        node.effect.outcome.kind.as_str()
    )
}
