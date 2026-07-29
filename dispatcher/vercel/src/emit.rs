//! The vercel bundle emitter — the only place in this crate that touches the filesystem.
//!
//! Dispatch is keyed on IR enums (`realization_kind`, `trigger.kind`, `effect.outcome.kind`),
//! never on a component's id/verb. Enum values this target does not yet realize fail loudly (a
//! "wall-hit"), and so does any capability that fails to resolve.
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
