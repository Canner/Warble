//! The capability resolution pass — dispatch's "capability linker" (see
//! [`capability-model.md`][spec-cap]).
//!
//! Given an IR component node and a target's capability profile, resolves every capability the
//! node requires (declared + implied) into a report, or aborts loudly naming the unsupported
//! capability + target (no silent degradation).
//!
//! [spec-cap]: https://github.com/Canner/Warble/blob/v0.2.0/docs/spec/capability-model.md

use crate::error::DispatchError;
use crate::ir::{ComponentNode, OutcomeKind, RealizationKind, TriggerKind};
use crate::targets::{
    CapabilityEntry, CapabilityOutcome, CapabilityProfile, Criticality, ProvidedBy,
};
use serde::Serialize;
use std::borrow::Cow;
use std::collections::HashSet;

/// The one capability whose resolution depends on binding *shape* rather than a static per-target
/// table entry — see `has_fine_grained_binding`.
const BLAST_RADIUS_CAPABILITY: &str = "blast_radius";

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
        note: Some(Cow::Borrowed(
            "capability is not declared in the target's capability profile — unknown means it cannot be guaranteed",
        )),
    }
}

/// Capabilities implied by IR shape beyond the node's declared `required_capabilities`.
fn implied_capabilities(node: &ComponentNode) -> Vec<String> {
    let mut implied = Vec::new();

    if node.realization_kind == RealizationKind::Skill {
        let distinct_tiers: HashSet<&str> =
            node.llm_calls.iter().map(|c| c.tier.as_str()).collect();
        if distinct_tiers.len() > 1 {
            implied.push("llm:per_step_tier".to_string());
        }
    }

    match node.trigger.kind {
        TriggerKind::Scheduled => implied.push("scheduler".to_string()),
        TriggerKind::Event => implied.push("event_bus".to_string()),
        TriggerKind::OneShot => {}
    }

    // Emitting a signal is the producer side of the event transport, symmetric to a `event` trigger
    // consuming one — both borrow `event_bus`. Shape-derived (from `effect.outcome.emits`), so it
    // stays enum/shape-keyed, never per-component. The `notify_channel` for concrete on-breach
    // actions (notify_slack / open_ticket) is a *declared* capability, not implied here.
    if node
        .effect
        .outcome
        .emits
        .as_ref()
        .is_some_and(|e| !e.is_empty())
    {
        implied.push("event_bus".to_string());
    }

    if !node.effect.render_blocks.is_empty() {
        implied.push("render_contract".to_string());
    }

    // +Mutating: a mutation outcome always needs a version-control checkpoint to roll back from —
    // shape-derived from the outcome enum, symmetric to how `emits` implies `event_bus`. `human_
    // approval` and `blast_radius` are NOT implied here: those come from the component's declared
    // `required_capabilities` / guardrails, not the bare outcome kind.
    //
    // +Constitutive reuses this same arm: `outcome.target == "context"` needs the path-scoped
    // `context_write_authz` gate instead of `write_authz` (the two scopes — models/knowledge vs
    // data — must never cross). Every other target value (a data path, or none) keeps `write_authz`.
    if node.effect.outcome.kind == OutcomeKind::Mutation {
        implied.push("version_control".to_string());
        if node.effect.outcome.target.as_deref() == Some("context") {
            implied.push("context_write_authz".to_string());
        } else {
            implied.push("write_authz".to_string());
        }
    }

    implied
}

/// Whether `node`'s context binding is fine-grained enough for Warble to compute `blast_radius`
/// natively: `context_binding.resolved` must be present and its `lineage.resolvable` must be
/// `true`. Keyed on binding *shape*, never on the component's id/verb.
fn has_fine_grained_binding(node: &ComponentNode) -> bool {
    node.context_binding
        .resolved
        .as_ref()
        .and_then(|resolved| resolved.get("lineage"))
        .and_then(|lineage| lineage.get("resolvable"))
        .and_then(|resolvable| resolvable.as_bool())
        .unwrap_or(false)
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
    let fine_grained_binding = has_fine_grained_binding(node);

    let report: ResolutionReport = required
        .into_iter()
        .map(|capability| {
            let e = profile.get(capability.as_str()).unwrap_or(&fallback);
            // `blast_radius` is the one capability resolved by binding shape rather than the
            // static profile table: fine-grained binding lets Warble compute it natively; coarse
            // binding keeps it a loud fail (never silently degraded — it's safety-critical).
            if capability == BLAST_RADIUS_CAPABILITY && fine_grained_binding {
                ResolvedCapability {
                    capability,
                    outcome: CapabilityOutcome::Native,
                    provided_by: ProvidedBy::Warble,
                    criticality: e.criticality,
                    note: None,
                }
            } else if capability == BLAST_RADIUS_CAPABILITY {
                ResolvedCapability {
                    capability,
                    outcome: CapabilityOutcome::Fail,
                    provided_by: e.provided_by,
                    criticality: e.criticality,
                    note: Some(
                        "requires fine_grained_binding (coarse binding on this target)".to_string(),
                    ),
                }
            } else {
                ResolvedCapability {
                    capability,
                    outcome: e.outcome,
                    provided_by: e.provided_by,
                    criticality: e.criticality,
                    note: e.note.as_deref().map(|s| s.to_string()),
                }
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
