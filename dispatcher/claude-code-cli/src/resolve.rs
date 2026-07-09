//! The capability resolution pass — dispatch's "capability linker" (`spec/capability-model.md`).
//!
//! Given an IR component node and a target's capability profile, resolves every capability the
//! node requires (declared + implied) into a report, or aborts loudly naming the unsupported
//! capability + target (no silent degradation).

use crate::error::DispatchError;
use crate::ir::{ComponentNode, LlmTier, RealizationKind, TriggerKind};
use crate::targets::{
    CapabilityEntry, CapabilityOutcome, CapabilityProfile, Criticality, ProvidedBy,
};
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedCapability {
    pub capability: String,
    pub outcome: CapabilityOutcome,
    pub provided_by: ProvidedBy,
    pub criticality: Criticality,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

pub type ResolutionReport = Vec<ResolvedCapability>;

/// Capability entry used for a capability absent from the target profile entirely — unknown means
/// it cannot be guaranteed, so it fails as safety-critical.
fn unknown_capability_entry() -> CapabilityEntry {
    CapabilityEntry {
        outcome: CapabilityOutcome::Fail,
        via: None,
        provided_by: ProvidedBy::None,
        criticality: Criticality::SafetyCritical,
        note: Some(
            "capability is not declared in the target's capability profile — unknown means it cannot be guaranteed",
        ),
    }
}

/// Capabilities implied by IR shape beyond the node's declared `required_capabilities`.
fn implied_capabilities(node: &ComponentNode) -> Vec<String> {
    let mut implied = Vec::new();

    if node.realization_kind == RealizationKind::Skill {
        let distinct_tiers: HashSet<LlmTier> = node.llm_calls.iter().map(|c| c.tier).collect();
        if distinct_tiers.len() > 1 {
            implied.push("llm:per_step_tier".to_string());
        }
    }

    match node.trigger.kind {
        TriggerKind::Scheduled => implied.push("scheduler".to_string()),
        TriggerKind::Event => implied.push("event_bus".to_string()),
        TriggerKind::OneShot => {}
    }

    if !node.effect.render_blocks.is_empty() {
        implied.push("render_contract".to_string());
    }

    implied
}

/// Union of declared + implied required capabilities, de-duplicated, order-preserving.
pub fn collect_required_capabilities(node: &ComponentNode) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for cap in node
        .required_capabilities
        .iter()
        .cloned()
        .chain(implied_capabilities(node))
    {
        if seen.insert(cap.clone()) {
            out.push(cap);
        }
    }
    out
}

/// Resolve every capability required by `node` against `profile`. Returns the report on success;
/// errors (loud-fail) naming the capability + target if any required capability resolves to `fail`.
pub fn resolve_capabilities(
    node: &ComponentNode,
    target_id: &str,
    profile: &CapabilityProfile,
) -> Result<ResolutionReport, DispatchError> {
    let required = collect_required_capabilities(node);
    let fallback = unknown_capability_entry();

    let report: ResolutionReport = required
        .into_iter()
        .map(|capability| {
            let e = profile.get(capability.as_str()).unwrap_or(&fallback);
            ResolvedCapability {
                capability,
                outcome: e.outcome,
                provided_by: e.provided_by,
                criticality: e.criticality,
                note: e.note.map(|s| s.to_string()),
            }
        })
        .collect();

    if let Some(failed) = report.iter().find(|r| r.outcome == CapabilityOutcome::Fail) {
        let reason = failed
            .note
            .clone()
            .unwrap_or_else(|| "unsupported on this target".to_string());
        return Err(DispatchError(format!(
            "{}: fail on {target_id} ({reason}) — component '{}' cannot be dispatched",
            failed.capability, node.verb
        )));
    }

    Ok(report)
}
