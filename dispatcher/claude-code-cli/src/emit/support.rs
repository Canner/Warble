//! Shared constants, the `unsupported` wall-hit constructor, the enum-support predicates
//! (`realization_supported` / `trigger_supported` / `outcome_supported`), the outcome predicates
//! (`is_assertion` / `is_mutation`), and small guardrail/tier helpers used across the emit modules.

use crate::error::DispatchError;
use crate::ir::{ComponentNode, Guardrail, LlmCall, OutcomeKind, RealizationKind, TriggerKind};
use std::collections::HashSet;

pub(super) const PER_STEP_TIER_CAPABILITY: &str = "llm:per_step_tier";

pub(super) const DRIVER_TOOLS: [&str; 2] = ["Task", "Read"];
// Capabilities realized by shelling out to the `wren` CLI — any of them means the agent needs
// `Bash(wren:*)`. `semantic_introspection` (realized via `wren context show`) belongs here for the
// same reason `sql_execution:read_only`/`genbi_build` do: without the wren tool it cannot introspect.
// `schema_introspection` (+Constitutive) is the same mechanism for a component proposing a context
// edit (models/metrics/knowledge) rather than a data query.
pub(super) const DATA_ACCESS_CAPABILITIES: [&str; 4] = [
    "sql_execution:read_only",
    "genbi_build",
    "semantic_introspection",
    "schema_introspection",
];
pub(super) const READ_ONLY_GUARDRAIL_NAME: &str = "read_only_execution";
pub(super) const ARTIFACT_WRITE_GUARDRAIL_NAME: &str = "artifact_write";
pub(super) const RENDER_CONTRACT_CAPABILITY: &str = "render_contract";
pub(super) const DEFAULT_ARTIFACT_SCOPE: &str = ".";
pub(super) const DESTRUCTIVE_BASH_DENY_PATTERNS: [&str; 3] =
    ["Bash(rm:*)", "Bash(sudo:*)", "Bash(dd:*)"];

pub(super) fn unsupported(field: &str, value: &str) -> DispatchError {
    DispatchError(format!(
        "{field} '{value}' is not supported by the claude-code file target (wall-hit)"
    ))
}

// --- handler support checks (documented extension points; loud-fail today) ----------------------

/// `realization_kind`: `skill` (v1), `tool` (+Assertive), and `gated-tool` (+Mutating: a tool
/// behind a hard two-phase approval gate — dry-run diff, `warble blast-radius`, human approval,
/// only then apply) are all realized. Each emits a Claude Code agent; a `tool` is the same agent
/// invoked as an independently-scheduled monitor with its own tier + alert boundary (see
/// [`ir-schema.md`][spec-ir]); `gated-tool` additionally carries the mutation lifecycle section
/// (see `build_mutation_section`).
///
/// [spec-ir]: https://github.com/Canner/Warble/blob/v0.2.0/docs/spec/ir-schema.md
pub(super) fn realization_supported(kind: RealizationKind) -> bool {
    matches!(
        kind,
        RealizationKind::Skill | RealizationKind::Tool | RealizationKind::GatedTool
    )
}

/// `trigger.kind`: `one_shot` (v1) and `scheduled` (+Assertive; the cadence is borrowed from the
/// runtime's scheduler — cron / launchd / CI, legalized in RUN.md, never in the IR). `event`
/// (activation *by* an inbound event — proactive monitoring) is not yet a realized handler and
/// loud-fails here, even though the `event_bus` transport it would borrow is now realize-via.
pub(super) fn trigger_supported(kind: TriggerKind) -> bool {
    matches!(kind, TriggerKind::OneShot | TriggerKind::Scheduled)
}

/// `effect.outcome.kind`: `none` (render-only, v1), `assertion` (+Assertive: a read-only verdict
/// plus an emitted signal), and `mutation` (+Mutating: a gated two-phase write — dry-run diff,
/// blast-radius gate, human approval, apply+rollback). `dispatch` still maps to one borrowed
/// capability not yet built — a +1 outcome handler when it lands (dispatcher stays thin); it still
/// loud-fails.
pub(super) fn outcome_supported(kind: OutcomeKind) -> bool {
    matches!(
        kind,
        OutcomeKind::None | OutcomeKind::Assertion | OutcomeKind::Mutation
    )
}

/// A single Claude Code agent file supports one `model`. When llm_calls span more than one tier,
/// record the collapse as a visible comment rather than silently dropping it.
pub(super) fn tier_collapse_comment(llm_calls: &[LlmCall], model: &str) -> Option<String> {
    let distinct: HashSet<&str> = llm_calls.iter().map(|c| c.tier.as_str()).collect();
    if distinct.len() <= 1 {
        return None;
    }
    let steps = llm_calls
        .iter()
        .map(|c| format!("{}={}", c.name, c.tier))
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "<!-- warble: per-step tiers [{steps}] collapsed to driver model '{model}' -->"
    ))
}

pub(super) fn has_data_access_capability(caps: &[String]) -> bool {
    caps.iter()
        .any(|c| DATA_ACCESS_CAPABILITIES.contains(&c.as_str()))
}

pub(super) fn is_read_only(guardrails: &[Guardrail]) -> bool {
    guardrails
        .iter()
        .any(|g| g.name == READ_ONLY_GUARDRAIL_NAME)
}

pub(super) fn find_guardrail<'a>(guardrails: &'a [Guardrail], name: &str) -> Option<&'a Guardrail> {
    guardrails.iter().find(|g| g.name == name)
}

/// Whether this component's outcome is an `assertion` (a read-only verdict + emitted signal), the
/// +Assertive outcome handler. Keyed on the outcome enum only — never on the component's id/verb.
pub(super) fn is_assertion(node: &ComponentNode) -> bool {
    node.effect.outcome.kind == OutcomeKind::Assertion
}

/// Whether this component's outcome is a `mutation` (a gated two-phase write), the +Mutating
/// outcome handler. Keyed on the outcome enum only — never on the component's id/verb.
pub(super) fn is_mutation(node: &ComponentNode) -> bool {
    node.effect.outcome.kind == OutcomeKind::Mutation
}
