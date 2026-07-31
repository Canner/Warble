//! The vercel bundle emitter — the only place in this crate that touches the filesystem.
//!
//! Dispatch is keyed on IR enums (`realization_kind`, `trigger.kind`, `effect.outcome.kind`),
//! never on a component's id/verb. Enum values this target does not yet realize fail loudly (a
//! "wall-hit"), and so does any capability that fails to resolve — and so does any
//! `conditional`/`when` shape this target does not realize (see [`check_conditional_shapes`] and
//! `classify.rs`'s module doc for exactly which shapes those are).
//!
//! **Atomicity guarantee**: every component's wall-hit checks *and* its full capability resolution
//! run in a single pre-pass, over every component in the IR, before any bundle content is built or
//! any filesystem write happens. Emission is therefore all-or-nothing — either the pre-pass
//! succeeds for every component, in which case the whole bundle is built and `bundle.json` is
//! written exactly once, or it errors and `out_dir` is left exactly as it was found, never holding
//! a bundle that reflects only some of the IR's components.

use crate::bundle::{
    AgentBundle, CompatibilityPolicy, StepBundle, VercelBundle, WhenGuardOut, VERCEL_BUNDLE_VERSION,
};
use crate::classify::classify_step;
use crate::error::DispatchError;
use crate::guardrails::build_guardrails;
use crate::ir::{ComponentNode, OutcomeKind, RealizationKind, TriggerKind, WarbleIr};
use crate::provider::{compose_target, ProviderFragment};
use crate::resolve::{resolve_capabilities, ResolutionReport};
use crate::schema::output_schema_for;
use crate::targets::TargetId;
use crate::tools::{base_tool_map, build_tools, ToolMap};
use std::fs;
use std::path::Path;

/// The IR version window this bundle format was built against, independent of whatever version the
/// input IR happens to declare — a harness checks a bundle's own compat window, not the source IR.
const MIN_SUPPORTED_IR_VERSION: &str = "0.3";
const MAX_SUPPORTED_IR_VERSION: &str = "0.3";

/// IR version this back-end actually accepts as *input* — distinct from the `MIN`/`MAX` pair above,
/// which is advisory output metadata describing the bundle format's own compat window regardless of
/// what an input IR declares. Copied (not shared via a `core` dependency — dispatchers never depend
/// on `warble`) from the same source of truth as `docs/spec/ir-schema.md`'s title and the TS
/// back-end's `SUPPORTED_IR_VERSIONS` in `dispatcher/claude-agent-sdk/src/ir.ts`; kept in lockstep by
/// `ir_version_tests.rs`. An out-of-range input is rejected before any bundle content is built (see
/// the atomicity guarantee in this module's doc comment) — never silently accepted and mislabeled.
pub const SUPPORTED_IR_VERSION: &str = "0.3";

/// The one version gate every IR-consuming entry point in this crate (and the `cli` binary, at IR
/// parse time) must call before doing anything else with `ir`: `emit_vercel` calls this as its
/// first statement, and `cli::load_vercel_ir` calls it right after deserializing, so every
/// subcommand that reads an `ir.json` for this target is covered by the same check instead of each
/// reimplementing (and potentially forgetting) it.
pub fn validate_ir_version(ir: &WarbleIr) -> Result<(), DispatchError> {
    if ir.warble_ir_version != SUPPORTED_IR_VERSION {
        return Err(DispatchError::new(format!(
            "unsupported warble_ir_version '{}' (this back-end understands: {SUPPORTED_IR_VERSION})",
            ir.warble_ir_version
        )));
    }
    Ok(())
}

fn unsupported(field: &str, value: &str) -> DispatchError {
    DispatchError::new(format!(
        "{field} '{value}' is not supported by the vercel bundle target (wall-hit)"
    ))
}

/// The closed `when.guard` vocabulary this back-end recognizes — must stay in lockstep with
/// `core::compile::GUARD_VOCABULARY`, the upstream source of truth. Kept as an independent copy
/// (dispatchers never depend on `warble`/`core`, see invariant #1 in the crate's `CLAUDE.md`), the
/// same way `SUPPORTED_IR_VERSION` above is an independent copy of the IR version window.
const GUARD_VOCABULARY: &[&str] = &["on_failure", "on_flag", "on_missing"];

fn unsupported_conditional(step_name: &str, component_id: &str, detail: &str) -> DispatchError {
    DispatchError::new(format!(
        "step '{step_name}' on component '{component_id}': {detail} — this is a limitation of the \
         vercel bundle target (wall-hit), not the IR"
    ))
}

/// Reject any `(conditional, when)` shape on a component's `llm_calls` that `classify_step` is not
/// prepared to classify into a defined [`crate::classify::StepRealization`] — a wall-hit at this
/// Deserialize-only seam rather than a silent fold into the wrong realization (invariant #1). Three
/// shapes are rejected:
///
/// - `conditional: true` with no `when` at all — `classify_step` would return `Independent`,
///   silently running a step declared conditional as if it were unconditional. `core`'s own
///   `check_when_guards` already refuses this shape at compile time; refusing it again here keeps
///   this seam consistent with that upstream rule rather than looser than it.
/// - `conditional: false` with a `when` guard present — the mirror image: a guard with nothing
///   declared to guard it. `core` refuses this too (see `check_when_guards`), and `classify_step`
///   never reads `conditional` at all, so without this check a step could set `conditional: false`
///   and still be silently realized as R1/R2 purely off `when`'s presence — a shape `core` never
///   intended to reach a back-end at all.
/// - `when.guard` outside the closed vocabulary (`on_failure`, `on_flag`, `on_missing`) —
///   `classify_step`'s else-branch does not check the guard string, so any name that isn't an
///   adjacent-preceding `on_failure` (a typo, or a future vocabulary word this back-end doesn't
///   know yet) currently folds silently into `GuardedSkip`. That is exactly "an enum arm the
///   target doesn't support, silently emitting something wrong."
///
/// `(true, Some(guard))` where `guard` is recognized, and `(false, None)`, are the only two shapes
/// left standing — precisely the ones `classify_step` is documented to handle, and R1/R2 behavior
/// for those is unchanged by this check.
fn check_conditional_shapes(node: &ComponentNode) -> Result<(), DispatchError> {
    for call in &node.llm_calls {
        match (call.conditional, &call.when) {
            (true, None) => {
                return Err(unsupported_conditional(
                    &call.name,
                    &node.id,
                    "declares 'conditional: true' with no 'when' guard",
                ));
            }
            (false, Some(when)) => {
                return Err(unsupported_conditional(
                    &call.name,
                    &node.id,
                    &format!(
                        "declares a 'when' guard ('{}') but is not 'conditional: true'",
                        when.guard
                    ),
                ));
            }
            (true, Some(when)) if !GUARD_VOCABULARY.contains(&when.guard.as_str()) => {
                return Err(unsupported_conditional(
                    &call.name,
                    &node.id,
                    &format!(
                        "declares an unrecognized 'when' guard '{}' (known: {})",
                        when.guard,
                        GUARD_VOCABULARY.join(", ")
                    ),
                ));
            }
            (true, Some(_)) | (false, None) => {}
        }
    }
    Ok(())
}

/// `realization_kind`: all three v1 shapes (`skill`, `tool`, `gated-tool`) are supported — the
/// bundle format doesn't need to special-case any of them, it just carries whichever one a
/// component declares through to the harness.
fn realization_supported(kind: RealizationKind) -> bool {
    matches!(
        kind,
        RealizationKind::Skill | RealizationKind::Tool | RealizationKind::GatedTool
    )
}

/// `trigger.kind`: `one_shot` and `scheduled` are supported (the cadence is a runtime concern, out
/// of scope for this crate). `event` (activation by an inbound event) is not yet realized.
fn trigger_supported(kind: TriggerKind) -> bool {
    matches!(kind, TriggerKind::OneShot | TriggerKind::Scheduled)
}

/// `effect.outcome.kind`: `none`, `assertion`, and `mutation` are supported. `dispatch` is not yet
/// realized.
fn outcome_supported(kind: OutcomeKind) -> bool {
    matches!(
        kind,
        OutcomeKind::None | OutcomeKind::Assertion | OutcomeKind::Mutation
    )
}

fn build_agent_bundle(
    node: &ComponentNode,
    capabilities: ResolutionReport,
    tool_map: &ToolMap,
) -> AgentBundle {
    let steps = node
        .llm_calls
        .iter()
        .enumerate()
        .map(|(step_index, call)| StepBundle {
            name: call.name.clone(),
            tier: call.tier.clone(),
            consumes: call.consumes.clone(),
            produces: call.produces.clone(),
            prompt: call.prompt.clone(),
            when: call.when.as_ref().map(WhenGuardOut::from),
            realization: classify_step(node, step_index),
        })
        .collect();

    AgentBundle {
        id: node.id.clone(),
        verb: node.verb.clone(),
        component_type: node.component_type,
        realization_kind: node.realization_kind,
        trigger: node.trigger.kind,
        outcome: node.effect.outcome.kind,
        steps,
        guardrails: build_guardrails(node),
        tools: build_tools(node, tool_map),
        output_schema: output_schema_for(&node.effect),
        capabilities,
    }
}

/// Emit a vercel bundle for `ir` targeting `target_id` into `out_dir`, composing the target's base
/// capability profile + tool map with `providers` (see `provider::compose_target`), and returning
/// the bundle that was written. See the module doc comment for the atomicity guarantee this
/// function provides. Pass an empty `providers` slice for a bare dispatch — any component that
/// requires a domain capability then correctly loud-fails (no provider is where a capability's
/// name comes from; a provider only tells us how a capability the IR already asked for is realized).
pub fn emit_vercel(
    ir: &WarbleIr,
    target_id: TargetId,
    out_dir: &Path,
    providers: &[ProviderFragment],
) -> Result<VercelBundle, DispatchError> {
    validate_ir_version(ir)?;

    let composed = compose_target(target_id.profile(), base_tool_map(), providers, target_id)?;
    let profile = composed.profile;
    let tool_map = composed.tool_map;
    let target_str = target_id.as_str();

    // Single atomic pre-pass over every component: wall-hit checks first, then capability
    // resolution. Nothing below this loop runs until every component has cleared both.
    let mut resolved: Vec<(&ComponentNode, ResolutionReport)> =
        Vec::with_capacity(ir.components.len());
    for node in &ir.components {
        if !realization_supported(node.realization_kind) {
            return Err(unsupported(
                "realization_kind",
                node.realization_kind.as_str(),
            ));
        }
        if !trigger_supported(node.trigger.kind) {
            return Err(unsupported("trigger.kind", node.trigger.kind.as_str()));
        }
        if !outcome_supported(node.effect.outcome.kind) {
            return Err(unsupported(
                "outcome.kind",
                node.effect.outcome.kind.as_str(),
            ));
        }
        check_conditional_shapes(node)?;
        let report = resolve_capabilities(node, target_str, &profile)?;
        resolved.push((node, report));
    }

    // Every component cleared the pre-pass — build the full bundle in memory.
    let agents: Vec<AgentBundle> = resolved
        .into_iter()
        .map(|(node, capabilities)| build_agent_bundle(node, capabilities, &tool_map))
        .collect();

    let bundle = VercelBundle {
        vercel_bundle_version: VERCEL_BUNDLE_VERSION.to_string(),
        compat: CompatibilityPolicy {
            min_ir_version: MIN_SUPPORTED_IR_VERSION.to_string(),
            max_ir_version: MAX_SUPPORTED_IR_VERSION.to_string(),
        },
        profile: ir.profile.clone(),
        target: target_str.to_string(),
        agents,
    };

    // Only now — after the entire bundle has been built successfully — does any filesystem write
    // happen, and it is a single write of a single file.
    fs::create_dir_all(out_dir).map_err(|e| {
        DispatchError::new(format!(
            "failed to create output directory {}: {e}",
            out_dir.display()
        ))
    })?;
    let json = serde_json::to_string_pretty(&bundle)
        .map_err(|e| DispatchError::new(format!("failed to serialize bundle: {e}")))?;
    fs::write(out_dir.join("bundle.json"), json)
        .map_err(|e| DispatchError::new(format!("failed to write bundle.json: {e}")))?;

    Ok(bundle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Hand-build a minimal `ComponentNode` carrying only the given `llm_calls` — same fixture
    /// shape as `classify.rs`'s own test helper, kept as an independent copy since each test module
    /// in this crate pins its fixtures locally rather than sharing a builder across modules.
    fn node_with_calls(calls: Vec<serde_json::Value>) -> ComponentNode {
        let value = json!({
            "id": "test_component",
            "verb": "test_component",
            "type": "analytical",
            "realization_kind": "skill",
            "context_binding": { "project": "x", "binding_mode": "runtime_selected" },
            "precondition_result": { "status": "pass" },
            "prompt_fragment": "",
            "llm_calls": calls,
            "guardrails": [],
            "trigger": { "kind": "one_shot" },
            "eval_ref": "test_component.eval",
            "effect": { "outcome": { "kind": "none" } }
        });
        serde_json::from_value(value).expect("valid ComponentNode fixture")
    }

    #[test]
    fn conditional_true_with_no_when_wall_hits() {
        let node = node_with_calls(vec![
            json!({"name": "step_a", "tier": "strong", "prompt": "p", "conditional": true}),
        ]);
        let err = check_conditional_shapes(&node).expect_err("bare conditional must wall-hit");
        assert!(
            err.0.contains("no 'when' guard"),
            "unexpected error message: {}",
            err.0
        );
    }

    #[test]
    fn conditional_false_with_when_present_wall_hits() {
        let node = node_with_calls(vec![json!({
            "name": "step_a", "tier": "strong", "prompt": "p", "conditional": false,
            "when": {"guard": "on_flag", "target": "some.flag"}
        })]);
        let err =
            check_conditional_shapes(&node).expect_err("when without conditional must wall-hit");
        assert!(
            err.0.contains("is not 'conditional: true'"),
            "unexpected error message: {}",
            err.0
        );
    }

    #[test]
    fn unrecognized_guard_string_wall_hits() {
        let node = node_with_calls(vec![json!({
            "name": "step_a", "tier": "strong", "prompt": "p", "conditional": true,
            "when": {"guard": "on_timeout", "target": "some.thing"}
        })]);
        let err = check_conditional_shapes(&node).expect_err("unrecognized guard must wall-hit");
        assert!(
            err.0.contains("unrecognized 'when' guard 'on_timeout'"),
            "unexpected error message: {}",
            err.0
        );
    }

    #[test]
    fn recognized_guard_shapes_pass_the_check() {
        // Adjacent on_failure (R1), non-adjacent on_flag (R2), and no-guard/non-conditional are
        // all shapes classify_step already handles; none of them should wall-hit here.
        let node = node_with_calls(vec![
            json!({"name": "step_a", "tier": "strong", "prompt": "p"}),
            json!({
                "name": "step_b", "tier": "strong", "prompt": "p", "conditional": true,
                "when": {"guard": "on_failure", "target": "step_a"}
            }),
            json!({
                "name": "step_c", "tier": "strong", "prompt": "p", "conditional": true,
                "when": {"guard": "on_flag", "target": "some.flag"}
            }),
            json!({
                "name": "step_d", "tier": "strong", "prompt": "p", "conditional": true,
                "when": {"guard": "on_missing", "target": "some_artifact"}
            }),
        ]);
        assert!(check_conditional_shapes(&node).is_ok());
    }
}
