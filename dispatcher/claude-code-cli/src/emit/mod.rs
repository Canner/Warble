//! claude-code target — emits Claude Code agent runtime files from a resolved Warble IR.
//!
//! Dispatch is keyed on IR enum values (`realization_kind`, `trigger.kind`, `effect.outcome.kind`),
//! never on a component's id/verb. Enum values not yet supported by this target fail loudly
//! ("wall-hit") rather than silently emitting something wrong — see [`support::unsupported`].
//!
//! This module is split by responsibility: [`types`] (public flavor/realization enums), [`support`]
//! (constants + enum-support predicates + guardrail helpers), [`gate`] (render gate + tool grants),
//! [`sections`] (agent-body prompt sections), [`agent`] (single-agent markdown), [`settings`]
//! (`settings.json` + wren config), [`run_md`] (RUN.md), [`split`] (per-step-tier split realization),
//! [`resolution`] (capability resolution + summary), [`fs_util`] (file writers), and [`hybrid`]
//! (hybrid local+cloud realization). The public `emit_claude_code*` entry points live here.

mod agent;
mod fs_util;
mod gate;
mod hybrid;
mod resolution;
mod run_md;
mod sections;
mod settings;
mod split;
mod support;
mod types;

pub use resolution::resolve_node_capabilities;
pub use types::{HybridRealization, RenderFlavor, DEFAULT_RENDER_FLAVOR};

use crate::error::DispatchError;
use crate::ir::{WarbleIr, SUPPORTED_IR_VERSION};
use crate::models::{ModelConfig, ANTHROPIC_PROVIDER};
use crate::resolve::ResolutionReport;
use crate::targets::{CapabilityOutcome, TargetId};
use std::path::Path;

use agent::build_agent_markdown;
use fs_util::{mkdir_all, write_file, write_json};
use hybrid::{any_local_provider, emit_hybrid_file_target, emit_hybrid_file_target_mcp};
use resolution::{print_resolution_summary, resolve_node_with_shared_binding};
use run_md::build_run_md;
use settings::{build_settings, wren_config};
use split::{
    build_driver_markdown, build_split_run_md, build_split_settings, build_subagent_markdown,
    should_split_per_step_tier, subagent_name,
};
use support::{outcome_supported, realization_supported, trigger_supported, unsupported};

pub fn emit_claude_code(
    ir: &WarbleIr,
    out_dir: &Path,
    target_id: &str,
    render_flavor: RenderFlavor,
) -> Result<(), DispatchError> {
    emit_claude_code_with_models(
        ir,
        out_dir,
        target_id,
        render_flavor,
        &ModelConfig::default(),
    )
}

/// Loud-fail if the binding routes any step to a non-Anthropic provider but the target's profile does
/// not realize `llm:per_step_provider` (hybrid). Anthropic-provider bindings (incl. the shorthand
/// string form, whose provider defaults to Anthropic) always pass — a local model name that reaches a
/// whole-session proxy is the caller's choice, not per-step provider routing.
fn require_per_step_provider_support(
    ir: &WarbleIr,
    target_id: &str,
    models: &ModelConfig,
) -> Result<(), DispatchError> {
    let supported = TargetId::parse(target_id)
        .map(|t| t.profile())
        .and_then(|p| p.get("llm:per_step_provider").map(|e| e.outcome))
        .is_some_and(|outcome| outcome != CapabilityOutcome::Fail);
    if supported {
        return Ok(());
    }
    for node in &ir.components {
        for call in &node.llm_calls {
            let binding = models.binding(&call.tier)?;
            if binding.provider != ANTHROPIC_PROVIDER {
                return Err(DispatchError(format!(
                    "llm:per_step_provider: fail on {target_id} — the binding routes step '{}.{}' \
(tier '{}') to provider '{}', but this target is whole-session single-provider and does not support \
per-step provider routing (hybrid). Use an all-cloud binding for this target, or dispatch to a target \
that realizes llm:per_step_provider.",
                    node.verb,
                    call.name,
                    call.tier,
                    binding.provider.as_str()
                )));
            }
        }
    }
    Ok(())
}

/// Emit Claude Code agent runtime files for a resolved IR into `out_dir`. Errors on any unsupported
/// enum value rather than emitting a silently-wrong file. Runs the capability resolution pass first;
/// on abort it errors and writes nothing. `models` resolves each step's tier to a concrete model.
/// A hybrid binding uses the default [`HybridRealization::BashScript`]; call
/// [`emit_claude_code_with_realization`] to choose.
pub fn emit_claude_code_with_models(
    ir: &WarbleIr,
    out_dir: &Path,
    target_id: &str,
    render_flavor: RenderFlavor,
    models: &ModelConfig,
) -> Result<(), DispatchError> {
    emit_claude_code_with_realization(
        ir,
        out_dir,
        target_id,
        render_flavor,
        models,
        HybridRealization::default(),
    )
}

/// As [`emit_claude_code_with_models`], choosing how a hybrid binding's LOCAL step is realized on the
/// file target (bash-script script vs an MCP server). Only affects the hybrid path.
pub fn emit_claude_code_with_realization(
    ir: &WarbleIr,
    out_dir: &Path,
    target_id: &str,
    render_flavor: RenderFlavor,
    models: &ModelConfig,
    hybrid: HybridRealization,
) -> Result<(), DispatchError> {
    if ir.warble_ir_version != SUPPORTED_IR_VERSION {
        return Err(DispatchError::new(format!(
            "unsupported warble_ir_version '{}' (this back-end understands: {SUPPORTED_IR_VERSION})",
            ir.warble_ir_version
        )));
    }
    // Every step tier must map to a model — abort before writing anything if one is undefined.
    models.validate(ir)?;
    // A per-step-tier split needs the reserved `orchestrator` tier; require it up front so the
    // split builders can resolve it infallibly.
    if ir.components.iter().any(should_split_per_step_tier) {
        models.orchestrator()?;
    }
    // Binding-time hybrid gate (llm:per_step_provider). Whether hybrid is needed is a property of the
    // runtime BINDING (a step bound to a non-Anthropic provider), not the IR — so it is checked here,
    // once the models config is known, rather than as an IR-static required capability. If the target's
    // profile does not realize `llm:per_step_provider`, a non-Anthropic binding is a loud-fail (never a
    // silent emit of a model name that would depend on a whole-session proxy).
    require_per_step_provider_support(ir, target_id, models)?;

    // Hybrid binding (a step routed to a local provider): the gate above confirmed the target realizes
    // `llm:per_step_provider`, so take the chosen realization instead of the all-cloud emit below.
    if any_local_provider(ir, models)? {
        return match hybrid {
            HybridRealization::BashScript => {
                emit_hybrid_file_target(ir, out_dir, target_id, models)
            }
            HybridRealization::McpServer => {
                emit_hybrid_file_target_mcp(ir, out_dir, target_id, models)
            }
        };
    }

    // Resolve every node first — abort before writing anything if any capability fails.
    let mut reports: Vec<(String, ResolutionReport)> = Vec::with_capacity(ir.components.len());
    for node in &ir.components {
        reports.push((
            node.id.clone(),
            resolve_node_with_shared_binding(node, &ir.context_binding, target_id)?,
        ));
    }
    let report_for = |id: &str| -> &ResolutionReport {
        &reports
            .iter()
            .find(|(nid, _)| nid == id)
            .expect("report exists")
            .1
    };

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

        let claude_dir = out_dir.join(".claude");
        let agents_dir = claude_dir.join("agents");
        let wren_dir = out_dir.join(".wren");
        mkdir_all(&agents_dir)?;
        mkdir_all(&wren_dir)?;

        let report = report_for(&node.id);

        if should_split_per_step_tier(node) {
            write_file(
                &agents_dir.join(format!("{}.md", node.verb)),
                &build_driver_markdown(node, report, render_flavor, models),
            )?;
            for call in &node.llm_calls {
                write_file(
                    &agents_dir.join(format!("{}.md", subagent_name(&node.verb, call))),
                    &build_subagent_markdown(node, call, models),
                )?;
            }
            write_json(
                &claude_dir.join("settings.json"),
                &build_split_settings(node, report, render_flavor),
            )?;
            write_json(&wren_dir.join("config.json"), &wren_config())?;
            write_file(
                &out_dir.join("RUN.md"),
                &build_split_run_md(node, report, render_flavor, models),
            )?;
        } else {
            write_file(
                &agents_dir.join(format!("{}.md", node.verb)),
                &build_agent_markdown(node, report, render_flavor, models)?,
            )?;
            // P1: the single-agent path now also writes
            // `.claude/settings.json` — same location as the split path — so Claude Code
            // auto-loads the allowlist without a manual `--settings` flag or a copy step.
            write_json(
                &claude_dir.join("settings.json"),
                &build_settings(node, report, render_flavor),
            )?;
            write_json(&wren_dir.join("config.json"), &wren_config())?;
            write_file(
                &out_dir.join("RUN.md"),
                &build_run_md(node, report, render_flavor, models)?,
            )?;
        }
    }

    let capability_report = serde_json::json!({
        "target": target_id,
        "components": ir.components.iter().map(|node| serde_json::json!({
            "id": node.id,
            "capabilities": report_for(&node.id),
        })).collect::<Vec<_>>(),
    });
    write_json(&out_dir.join("capability-report.json"), &capability_report)?;

    for node in &ir.components {
        print_resolution_summary(
            &format!("{target_id} (component '{}')", node.id),
            report_for(&node.id),
        );
    }

    Ok(())
}
