//! claude-code target — emits Claude Code agent runtime files from a resolved Warble IR.
//!
//! Dispatch is keyed on IR enum values (`realization_kind`, `trigger.kind`, `effect.outcome.kind`),
//! never on a component's id/verb. Enum values not yet supported by this target fail loudly
//! ("wall-hit") rather than silently emitting something wrong — see [`support::unsupported`].
//!
//! This module is split by responsibility: [`types`] (public flavor/realization enums), [`support`]
//! (constants + enum-support predicates + guardrail helpers), [`gate`] (render gate + tool grants),
//! [`sections`] (agent-body prompt sections), [`agent`] (single-agent markdown), [`settings`]
//! (per-component `settings.json` + wren config), [`scope`] (the scope-level session envelope and
//! system prompt), [`run_md`] (RUN.md), [`split`] (per-step-tier split realization), [`isolate`]
//! (context isolation), [`resolution`] (capability resolution + summary), [`fs_util`] (file
//! writers), and [`hybrid`] (hybrid local+cloud realization). The public `emit_claude_code*` entry
//! points live here.
//!
//! Everything this module writes is asserted byte-for-byte against a committed snapshot by
//! `tests/dispatch_snapshot_tests.rs`. That is deliberate: what dispatch emits *is* what an agent
//! reads, so a change here changes behavior, and the snapshot makes it impossible to land one
//! without a reviewer seeing exactly what changed.

mod agent;
mod fs_util;
mod gate;
mod hybrid;
mod isolate;
mod resolution;
mod run_md;
mod scope;
mod sections;
mod settings;
mod split;
mod support;
mod types;

pub use resolution::resolve_node_capabilities;
pub use types::{
    ContextInjection, ContextInjectionMode, ContextInjectionReport, HybridRealization,
    RenderFlavor, DEFAULT_CONTEXT_INJECTION, DEFAULT_RENDER_FLAVOR,
};

use crate::error::DispatchError;
use crate::interactive::{
    native_analysis_prompt_fragment, native_analysis_terminal_presentation_instructions,
    native_context_enrichment_prompt_fragment,
    native_context_enrichment_terminal_presentation_instructions,
    native_dashboard_save_instructions, prepare_interactive_output,
    setup_bootstrap_authority_instructions, setup_recovery_instructions, NativeMcpDescriptor,
    NativePurpose, NativeSessionScope,
};
use crate::ir::{validate_ir_version, WarbleIr};
use crate::models::{ModelConfig, ANTHROPIC_PROVIDER};
use crate::provider::{compose_target, ProviderFragment, ToolMap};
use crate::resolve::ResolutionReport;
use crate::targets::{CapabilityOutcome, TargetId};
use std::path::Path;

use agent::build_agent_markdown;
use fs_util::{mkdir_all, write_file, write_json};
use hybrid::{any_local_provider, emit_hybrid_file_target, emit_hybrid_file_target_mcp};
use isolate::{
    build_isolated_child_markdown, build_isolating_parent_markdown, isolated_agent_name,
    should_isolate,
};
use resolution::{print_resolution_summary, resolve_node_with_shared_binding};
use run_md::{build_interactive_run_md, build_profile_run_md};
use scope::{build_scope_prompt, merge_scope_settings, scope_denies_destructive_bash};
use settings::{build_settings, wren_config};
use split::{
    build_driver_markdown, build_split_settings, build_subagent_markdown,
    should_split_per_step_tier, subagent_name,
};
use support::{outcome_supported, realization_supported, trigger_supported, unsupported};

fn is_native_dashboard_component(node: &crate::ir::ComponentNode) -> bool {
    node.required_capabilities
        .iter()
        .any(|capability| capability == "genbi_build")
        && node
            .required_capabilities
            .iter()
            .any(|capability| capability == "artifact_write")
}

fn native_setup_settings(
    mut settings: serde_json::Value,
    purpose: Option<NativePurpose>,
    native_scope: Option<&NativeSessionScope>,
) -> Result<serde_json::Value, DispatchError> {
    if purpose != Some(NativePurpose::Setup) {
        return Ok(settings);
    }
    let scope = native_scope.ok_or_else(|| {
        DispatchError("Setup permissions require a server-derived native scope".to_string())
    })?;
    let scoped_permissions = scope.claude_setup_write_permissions()?;
    let allow = settings
        .pointer_mut("/permissions/allow")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| DispatchError("native Setup permissions are incompatible".to_string()))?;
    allow.retain(|entry| !matches!(entry.as_str(), Some("Edit" | "Write")));
    for permission in scoped_permissions {
        allow.push(serde_json::Value::String(permission));
    }
    let note = "Setup write authority is server-sealed: only Edit/Write paths below the host-provided WARBLE_SETUP_BOOTSTRAP_ROOT are allowed; the native cwd is private and read-only.";
    match settings.get_mut("$comment") {
        Some(comment) => {
            let existing = comment.as_str().ok_or_else(|| {
                DispatchError("native Setup permissions are incompatible".to_string())
            })?;
            *comment = serde_json::Value::String(format!("{existing} {note}"));
        }
        None => {
            settings["$comment"] = serde_json::Value::String(note.to_string());
        }
    }
    Ok(settings)
}

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
    let context = ContextInjection::from_ir(ir, DEFAULT_CONTEXT_INJECTION, None);
    emit_claude_code_with_context(
        ir,
        out_dir,
        target_id,
        render_flavor,
        models,
        hybrid,
        &context,
    )
}

/// As [`emit_claude_code_with_realization`], with an explicit host-normalized context payload.
/// This is the CLI host seam for `--context-injection`; the dispatcher performs no project I/O.
#[allow(clippy::too_many_arguments)]
pub fn emit_claude_code_with_context(
    ir: &WarbleIr,
    out_dir: &Path,
    target_id: &str,
    render_flavor: RenderFlavor,
    models: &ModelConfig,
    hybrid: HybridRealization,
    context: &ContextInjection,
) -> Result<(), DispatchError> {
    emit_claude_code_with_providers(
        ir,
        out_dir,
        target_id,
        render_flavor,
        models,
        hybrid,
        context,
        &[],
    )
}

/// As [`emit_claude_code_with_context`], composing the base target with caller-supplied provider
/// fragments. This is how a domain capability — one naming an external service rather than the
/// runtime's own structure — reaches this back-end without being hardcoded in it.
#[allow(clippy::too_many_arguments)]
pub fn emit_claude_code_with_providers(
    ir: &WarbleIr,
    out_dir: &Path,
    target_id: &str,
    render_flavor: RenderFlavor,
    models: &ModelConfig,
    hybrid: HybridRealization,
    context: &ContextInjection,
    providers: &[ProviderFragment],
) -> Result<(), DispatchError> {
    emit_claude_code_with_native_purpose(
        ir,
        out_dir,
        target_id,
        render_flavor,
        models,
        hybrid,
        context,
        providers,
        None,
        None,
        None,
    )
}

/// As [`emit_claude_code_with_providers`], opting into the v2 native Sessions contract.
/// `purpose` is a closed, server-selected allowlist; it selects neither a caller cwd nor prompt.
#[allow(clippy::too_many_arguments)]
pub fn emit_claude_code_with_native_purpose(
    ir: &WarbleIr,
    out_dir: &Path,
    target_id: &str,
    render_flavor: RenderFlavor,
    models: &ModelConfig,
    hybrid: HybridRealization,
    context: &ContextInjection,
    providers: &[ProviderFragment],
    purpose: Option<NativePurpose>,
    native_scope: Option<NativeSessionScope>,
    native_mcp: Option<NativeMcpDescriptor>,
) -> Result<(), DispatchError> {
    validate_ir_version(ir)?;
    if let Some(purpose) = purpose {
        if target_id != "claude-code:interactive" {
            return Err(DispatchError(
                "--purpose is supported only by native interactive targets".to_string(),
            ));
        }
        purpose.validate_profile(ir)?;
    }
    if native_mcp.is_some() && purpose.is_none() {
        return Err(DispatchError(
            "--native-mcp requires a native Sessions --purpose".to_string(),
        ));
    }
    let include_setup_recovery_instructions =
        purpose == Some(NativePurpose::Setup) && native_mcp.is_some();
    if target_id == "codex:interactive" {
        return Err(DispatchError("codex:interactive must use the native Codex materializer, never the Claude file emitter".to_string()));
    }
    // This target has no enforceable implementation of the enrichment contract's deterministic
    // apply capability. Keep generic interactive mutations intact, but exclude that capability;
    // an apply-only IR wall-hits before it can create a handoff.
    let filtered_ir;
    let ir = if target_id == "claude-code:interactive" {
        filtered_ir = WarbleIr {
            components: ir
                .components
                .iter()
                .filter(|node| {
                    !node
                        .required_capabilities
                        .iter()
                        .any(|capability| capability == "enrichment_apply:deterministic")
                })
                .cloned()
                .collect(),
            ..ir.clone()
        };
        if filtered_ir.components.is_empty() {
            return Err(DispatchError("apply_enrichment cannot be dispatched on claude-code:interactive: native materialization has no enforceable human-approval apply channel (wall-hit)".to_string()));
        }
        &filtered_ir
    } else {
        ir
    };
    // Every step tier must map to a model — abort before writing anything if one is undefined.
    models.validate(ir)?;
    // Both shapes that emit a delegating parent — the per-step split and context isolation — need
    // the reserved `orchestrator` tier for it. Required up front so emission cannot fail halfway
    // through writing files.
    if ir
        .components
        .iter()
        .any(|n| should_split_per_step_tier(n) || should_isolate(n))
    {
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
        if native_mcp.is_some() {
            return Err(DispatchError(
                "native MCP discovery requires an all-cloud native interactive materialization; hybrid MCP configuration is a separate producer contract"
                    .to_string(),
            ));
        }
        return match hybrid {
            HybridRealization::BashScript => {
                emit_hybrid_file_target(ir, out_dir, target_id, models, context)
            }
            HybridRealization::McpServer => {
                emit_hybrid_file_target_mcp(ir, out_dir, target_id, models, context)
            }
        };
    }

    // Validate the target's enum surface before any all-cloud output is written.
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
    }

    // Compose the base target with any provider fragments BEFORE resolving: a capability a
    // fragment supplies must be visible to the resolution pass, or every domain capability would
    // resolve as unknown and abort. Composition is also where a malformed or colliding fragment
    // loud-fails, which must happen before anything is written.
    let target = TargetId::parse(target_id).ok_or_else(|| {
        DispatchError(format!(
            "target '{target_id}' has no capability profile (known targets: {})",
            crate::targets::known_target_names().join(", ")
        ))
    })?;
    let composed = compose_target(target.profile(), ToolMap::new(), providers, target)?;
    let tool_map = &composed.tool_map;

    // Resolve every node first — abort before writing anything if any capability fails.
    let mut reports: Vec<(String, ResolutionReport)> = Vec::with_capacity(ir.components.len());
    for node in &ir.components {
        reports.push((
            node.id.clone(),
            resolve_node_with_shared_binding(
                node,
                &ir.context_binding,
                target_id,
                &composed.profile,
            )?,
        ));
    }
    let report_for = |id: &str| -> &ResolutionReport {
        &reports
            .iter()
            .find(|(nid, _)| nid == id)
            .expect("report exists")
            .1
    };

    // Interactive output is launched in the emitted directory. Preflight its user-visible
    // handoff/spec before any write so a hostile pre-existing file cannot be overwritten.
    let interactive = if target_id == "claude-code:interactive" {
        let signature = ir
            .components
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>()
            .join(",");
        let mut paths = vec![
            std::path::PathBuf::from("RUN.md"),
            std::path::PathBuf::from("context-report.json"),
            std::path::PathBuf::from("capability-report.json"),
            std::path::PathBuf::from(".claude/CLAUDE.md"),
            std::path::PathBuf::from(".claude/settings.json"),
            std::path::PathBuf::from(".wren/config.json"),
        ];
        if native_mcp.is_some() {
            paths.push(std::path::PathBuf::from(".mcp.json"));
        }
        for node in &ir.components {
            paths.push(std::path::PathBuf::from(format!(
                ".claude/agents/{}.md",
                node.verb
            )));
            if should_split_per_step_tier(node) {
                for call in &node.llm_calls {
                    paths.push(std::path::PathBuf::from(format!(
                        ".claude/agents/{}.md",
                        subagent_name(&node.verb, call)
                    )));
                }
            }
        }
        Some(prepare_interactive_output(
            out_dir,
            target_id,
            "claude",
            &signature,
            &paths,
            purpose,
            native_scope.clone(),
            native_mcp.clone(),
        )?)
    } else {
        None
    };
    let out_dir = interactive
        .as_ref()
        .map_or(out_dir, |output| output.root.as_path());

    // Write only after the all-cloud resolution pass succeeds, preserving the back-end's
    // abort-before-write contract. Hybrid emitters write the same report after their own gates.
    mkdir_all(out_dir)?;
    write_json(
        &out_dir.join("context-report.json"),
        &serde_json::to_value(context.report()).expect("context report serializes"),
    )?;
    // `.claude/settings.json` is session-scoped: one file the runtime loads once, whichever agent
    // the session selects. So the native MCP allowlist is decided for the profile rather than by
    // whichever component happens to hold the dashboard shape.
    let include_session_dashboard_save_tool = purpose == Some(NativePurpose::Analysis)
        && native_mcp.is_some()
        && ir.components.iter().any(is_native_dashboard_component);

    let claude_dir = out_dir.join(".claude");
    let agents_dir = claude_dir.join("agents");
    let wren_dir = out_dir.join(".wren");
    mkdir_all(&agents_dir)?;
    mkdir_all(&wren_dir)?;
    // Each component's own envelope, merged into the session's after the loop. Collected rather
    // than written: a component-scoped write to a session-scoped path is last-writer-wins, not a
    // stricter grant.
    let mut component_settings: Vec<(String, serde_json::Value)> =
        Vec::with_capacity(ir.components.len());

    for node in &ir.components {
        let include_dashboard_save_tool = purpose == Some(NativePurpose::Analysis)
            && native_mcp.is_some()
            && is_native_dashboard_component(node);
        let include_native_terminal_presentation = matches!(
            purpose,
            Some(NativePurpose::Analysis | NativePurpose::ContextEnrichment)
        );
        // Native analysis and context enrichment share source IR with programmatic dispatch, but
        // their final terminal response is Markdown rather than the IR's JSON transport. Rewrite
        // only this emitted native view; the IR and every non-native target retain the exact JSON
        // contract.
        let mut rendered_node;
        let node = if include_native_terminal_presentation {
            rendered_node = node.clone();
            rendered_node.prompt_fragment = match purpose {
                Some(NativePurpose::Analysis) => {
                    native_analysis_prompt_fragment(&node.prompt_fragment)
                }
                Some(NativePurpose::ContextEnrichment) => {
                    native_context_enrichment_prompt_fragment(&node.prompt_fragment)
                }
                _ => unreachable!("native terminal presentation requires a native purpose"),
            };
            &rendered_node
        } else {
            node
        };
        let report = report_for(&node.id);

        // Isolation is checked before the per-step split because the two want opposite things from
        // the same component: the split hands each STEP its own child and marshals artifacts through
        // the parent, which is precisely the leakage isolation exists to stop. When both apply the
        // component asked for the boundary, so it wins and the tiers collapse — visibly, in the
        // child's own tier comment and in capability-report.json.
        if should_isolate(node) {
            write_file(
                &agents_dir.join(format!("{}.md", node.verb)),
                &build_isolating_parent_markdown(node, report, render_flavor, models)?,
            )?;
            write_file(
                &agents_dir.join(format!("{}.md", isolated_agent_name(&node.verb))),
                &build_isolated_child_markdown(
                    node,
                    report,
                    render_flavor,
                    models,
                    context,
                    tool_map,
                    include_setup_recovery_instructions,
                    include_dashboard_save_tool,
                )?,
            )?;
            // The parent needs Task/Read and the child needs the component's own tools, which is
            // exactly the union the split path already computes.
            component_settings.push((
                node.verb.clone(),
                build_split_settings(
                    node,
                    report,
                    render_flavor,
                    tool_map,
                    include_session_dashboard_save_tool,
                ),
            ));
        } else if should_split_per_step_tier(node) {
            let mut driver = build_driver_markdown(
                node,
                report,
                render_flavor,
                models,
                context,
                include_dashboard_save_tool,
                include_native_terminal_presentation,
            );
            if include_dashboard_save_tool {
                driver.push('\n');
                driver.push_str(native_dashboard_save_instructions());
            }
            if include_native_terminal_presentation {
                driver.push('\n');
                driver.push_str(match purpose {
                    Some(NativePurpose::Analysis) => {
                        native_analysis_terminal_presentation_instructions()
                    }
                    Some(NativePurpose::ContextEnrichment) => {
                        native_context_enrichment_terminal_presentation_instructions()
                    }
                    _ => unreachable!("native terminal presentation requires a native purpose"),
                });
            }
            if purpose == Some(NativePurpose::Setup) {
                driver.push('\n');
                driver.push_str(&setup_bootstrap_authority_instructions());
            }
            write_file(&agents_dir.join(format!("{}.md", node.verb)), &driver)?;
            for call in &node.llm_calls {
                let mut subagent = build_subagent_markdown(node, call, models, context, tool_map);
                if purpose == Some(NativePurpose::Setup) {
                    subagent.push('\n');
                    subagent.push_str(&setup_bootstrap_authority_instructions());
                }
                write_file(
                    &agents_dir.join(format!("{}.md", subagent_name(&node.verb, call))),
                    &subagent,
                )?;
            }
            component_settings.push((
                node.verb.clone(),
                build_split_settings(
                    node,
                    report,
                    render_flavor,
                    tool_map,
                    include_session_dashboard_save_tool,
                ),
            ));
        } else {
            let mut agent_markdown = build_agent_markdown(
                node,
                report,
                render_flavor,
                models,
                context,
                tool_map,
                include_setup_recovery_instructions,
                include_dashboard_save_tool,
            )?;
            if include_dashboard_save_tool {
                agent_markdown.push('\n');
                agent_markdown.push_str(native_dashboard_save_instructions());
            }
            if include_native_terminal_presentation {
                agent_markdown.push('\n');
                agent_markdown.push_str(match purpose {
                    Some(NativePurpose::Analysis) => {
                        native_analysis_terminal_presentation_instructions()
                    }
                    Some(NativePurpose::ContextEnrichment) => {
                        native_context_enrichment_terminal_presentation_instructions()
                    }
                    _ => unreachable!("native terminal presentation requires a native purpose"),
                });
            }
            if include_setup_recovery_instructions {
                agent_markdown.push('\n');
                agent_markdown.push_str(setup_recovery_instructions());
            }
            if purpose == Some(NativePurpose::Setup) {
                agent_markdown.push('\n');
                agent_markdown.push_str(&setup_bootstrap_authority_instructions());
            }
            write_file(
                &agents_dir.join(format!("{}.md", node.verb)),
                &agent_markdown,
            )?;
            component_settings.push((
                node.verb.clone(),
                build_settings(
                    node,
                    report,
                    render_flavor,
                    tool_map,
                    include_setup_recovery_instructions,
                    include_session_dashboard_save_tool,
                ),
            ));
        }
    }

    // Scope-level artifacts, computed once for the profile. The runtime loads
    // one settings file, one data-layer config and one project memory per session — emitting them
    // per component writes N times to each path and lets whichever component the IR ends with
    // decide the session's envelope.
    let scope_components = ir
        .components
        .iter()
        .map(|node| (node, report_for(&node.id)))
        .collect::<Vec<_>>();
    write_json(
        &claude_dir.join("settings.json"),
        &native_setup_settings(
            merge_scope_settings(&component_settings),
            purpose,
            native_scope.as_ref(),
        )?,
    )?;
    write_json(&wren_dir.join("config.json"), &wren_config())?;
    let scope_prompt = build_scope_prompt(
        ir,
        &scope_components,
        render_flavor,
        scope_denies_destructive_bash(&component_settings),
    );
    write_file(
        &claude_dir.join("CLAUDE.md"),
        &match interactive.as_ref() {
            Some(output) => format!("{}\n{scope_prompt}", output.marker()),
            None => scope_prompt,
        },
    )?;

    // RUN.md is profile-level: one emitted directory, one document. Writing it inside the loop
    // above would write it once per component to the same path, leaving the last component the only
    // one documented and the rest of the profile invisible.
    let run = match interactive.as_ref() {
        Some(output) => format!(
            "{}\n{}",
            output.marker(),
            build_interactive_run_md(ir, purpose)
        ),
        None => build_profile_run_md(&ir.profile, &scope_components, render_flavor, models)?,
    };
    write_file(&out_dir.join("RUN.md"), &run)?;

    if let (Some(_), Some(descriptor)) = (&interactive, native_mcp.as_ref()) {
        write_file(
            &out_dir.join(".mcp.json"),
            &descriptor.claude_discovery_config()?,
        )?;
        // The interactive output remains the sole writer of the ownership manifest and launch
        // spec, after this exact vendor-owned discovery file is present and can be hashed.
    }

    let capability_report = serde_json::json!({
        "target": target_id,
        "components": ir.components.iter().map(|node| {
            let mut entry = serde_json::json!({
                "id": node.id,
                "capabilities": report_for(&node.id),
            });
            // Which provider-supplied tools this component was actually granted, and where each is
            // realized. Without it, a reader of the emitted agent sees tool names with no way to
            // tell which fragment put them there or what backs them.
            let granted: serde_json::Map<String, serde_json::Value> = node
                .required_capabilities
                .iter()
                .filter_map(|c| tool_map.get(c.as_str()).map(|b| (c, b)))
                .map(|(capability, binding)| {
                    (
                        capability.clone(),
                        serde_json::json!({ "names": binding.names, "source": binding.source }),
                    )
                })
                .collect();
            if !granted.is_empty() {
                entry["tool_bindings"] = serde_json::Value::Object(granted);
            }
            // Isolation swallows the per-step-tier split, and swallowing a realized capability is a
            // degrade — so it is recorded rather than left for a reader to infer from the absence of
            // subagent files ("no silent caps", capability-model §4).
            if should_isolate(node) {
                let collapsed = models.collapsed_model(&node.llm_calls).ok();
                entry["isolation"] = serde_json::json!({
                    "realized_via": "single-child-subagent",
                    "child_agent": isolated_agent_name(&node.verb),
                    "per_step_tier": if should_split_per_step_tier(node) {
                        serde_json::json!({
                            "outcome": "degrade",
                            "reason": "the whole component runs in one child, so its steps share one model",
                            "collapsed_to": collapsed,
                        })
                    } else {
                        serde_json::json!({ "outcome": "not-requested" })
                    },
                });
            }
            entry
        }).collect::<Vec<_>>(),
    });
    write_json(&out_dir.join("capability-report.json"), &capability_report)?;

    for node in &ir.components {
        print_resolution_summary(
            &format!("{target_id} (component '{}')", node.id),
            report_for(&node.id),
        );
    }

    if let Some(output) = interactive {
        output.write_ownership()?;
        output.write_launch_spec()?;
    }
    Ok(())
}
