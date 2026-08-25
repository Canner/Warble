//! Native Codex TUI materialization. This emits discovery artifacts only; it never starts Codex.

use crate::error::DispatchError;
use crate::interactive::{
    native_analysis_prompt_fragment, native_analysis_terminal_presentation_instructions,
    native_answer_persistence_instructions, native_context_enrichment_prompt_fragment,
    native_context_enrichment_terminal_presentation_instructions,
    native_dashboard_save_instructions, prepare_interactive_output,
    setup_bootstrap_authority_instructions, setup_recovery_instructions, NativeMcpDescriptor,
    NativePurpose, NativeSessionScope,
};
use crate::ir::{validate_ir_version, OutcomeKind, RealizationKind, TriggerKind, WarbleIr};
use crate::resolve::resolve_capabilities;
use crate::targets::TargetId;
use std::fs;
use std::path::Path;

pub fn emit_codex_interactive(
    ir: &WarbleIr,
    out_dir: &Path,
    purpose: Option<NativePurpose>,
    native_scope: Option<NativeSessionScope>,
    native_mcp: Option<NativeMcpDescriptor>,
) -> Result<(), DispatchError> {
    validate_ir_version(ir)?;
    if let Some(purpose) = purpose {
        purpose.validate_profile(ir)?;
    }
    let materializable = ir
        .components
        .iter()
        .filter(|node| {
            !node
                .required_capabilities
                .iter()
                .any(|capability| capability == "enrichment_apply:deterministic")
        })
        .cloned()
        .collect::<Vec<_>>();
    if materializable.is_empty() {
        return Err(DispatchError("apply_enrichment cannot be dispatched on codex:interactive: native materialization has no enforceable human-approval apply channel (wall-hit)".to_string()));
    }
    let materialized = WarbleIr {
        components: materializable,
        ..ir.clone()
    };
    let ir = &materialized;
    let target = TargetId::CodexInteractive.as_str();
    let signature = ir
        .components
        .iter()
        .map(|node| node.id.as_str())
        .collect::<Vec<_>>()
        .join(",");
    let skill_name = purpose.map_or("genbi-enrich-context", NativePurpose::codex_skill);
    let skill_relative = Path::new(".agents/skills")
        .join(skill_name)
        .join("SKILL.md");
    let agents_relative = Path::new("AGENTS.md").to_path_buf();
    let run_relative = Path::new("RUN.md").to_path_buf();
    let mut owned_paths = vec![
        skill_relative.clone(),
        agents_relative.clone(),
        run_relative.clone(),
    ];
    if purpose.is_some() {
        owned_paths.push(Path::new(".codex/config.toml").to_path_buf());
        owned_paths.push(Path::new(".codex/hooks.json").to_path_buf());
        owned_paths.push(Path::new(".warble/capture-codex-thread.sh").to_path_buf());
    }
    let output = prepare_interactive_output(
        out_dir,
        target,
        "codex",
        &signature,
        &owned_paths,
        purpose,
        native_scope.clone(),
        native_mcp.clone(),
    )?;
    // `prepare_interactive_output` has now validated the purpose/scope pairing without writing
    // any artifact, so a direct library caller receives the regular dispatch error rather than a
    // panic when it omits the required native scope.
    let codex_permission_profile = if purpose.is_some() {
        native_scope
            .as_ref()
            .expect("validated native purpose carries a scope")
            .codex_permission_profile()?
    } else {
        String::new()
    };

    for node in &ir.components {
        if !matches!(node.trigger.kind, TriggerKind::OneShot)
            || !matches!(
                node.realization_kind,
                RealizationKind::Skill | RealizationKind::GatedTool
            )
            || !matches!(
                node.effect.outcome.kind,
                OutcomeKind::None | OutcomeKind::Mutation
            )
        {
            return Err(DispatchError(format!(
                "{} cannot materialize component '{}' shape on codex:interactive (wall-hit)",
                target, node.id
            )));
        }
        resolve_capabilities(node, target, &TargetId::CodexInteractive.profile())?;
    }

    let include_setup_recovery_instructions =
        purpose == Some(NativePurpose::Setup) && native_mcp.is_some();
    let include_persist_answer_instructions = purpose == Some(NativePurpose::Analysis)
        && native_mcp.is_some()
        && ir.components.iter().any(is_persisted_answer_component);
    let skill = build_skill(
        ir,
        output.marker(),
        purpose,
        include_setup_recovery_instructions,
        include_persist_answer_instructions,
        native_mcp.is_some(),
    );
    let agents = build_agents(output.marker(), purpose);
    let run = build_run(output.marker(), skill_name, purpose);
    let skill_path = output.root.join(skill_relative);
    fs::create_dir_all(skill_path.parent().expect("skill parent"))
        .map_err(|e| DispatchError(format!("create Codex skill dir: {e}")))?;
    fs::write(skill_path, skill).map_err(|e| DispatchError(format!("write Codex skill: {e}")))?;
    fs::write(output.root.join(agents_relative), agents)
        .map_err(|e| DispatchError(format!("write AGENTS.md: {e}")))?;
    fs::write(output.root.join(run_relative), run)
        .map_err(|e| DispatchError(format!("write RUN.md: {e}")))?;
    if purpose.is_some() {
        let codex_dir = output.root.join(".codex");
        fs::create_dir_all(&codex_dir)
            .map_err(|e| DispatchError(format!("create Codex discovery dir: {e}")))?;
        let mcp_discovery = native_mcp.map_or_else(String::new, |descriptor| {
            descriptor.codex_discovery_config(
                include_setup_recovery_instructions,
                purpose == Some(NativePurpose::Analysis)
                    && ir.components.iter().any(is_dashboard_component),
                include_persist_answer_instructions,
            )
        });
        fs::write(
            codex_dir.join("config.toml"),
            format!("{codex_permission_profile}\n{mcp_discovery}"),
        )
        .map_err(|e| DispatchError(format!("write Codex native session config: {e}")))?;
        fs::write(codex_dir.join("hooks.json"), codex_resume_capture_hooks())
            .map_err(|e| DispatchError(format!("write Codex native session hooks: {e}")))?;
        let capture = output.root.join(".warble/capture-codex-thread.sh");
        fs::create_dir_all(capture.parent().expect("capture parent"))
            .map_err(|e| DispatchError(format!("create Codex native resume capture dir: {e}")))?;
        fs::write(&capture, CODEX_RESUME_CAPTURE_SCRIPT)
            .map_err(|e| DispatchError(format!("write Codex native resume capture: {e}")))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&capture, fs::Permissions::from_mode(0o700))
                .map_err(|e| DispatchError(format!("secure Codex native resume capture: {e}")))?;
        }
    }
    output.write_ownership()?;
    output.write_launch_spec()
}

const CODEX_RESUME_CAPTURE_SCRIPT: &str = r#"#!/bin/sh
set -eu
payload=$(cat)
thread_id=$(printf '%s\n' "$payload" | sed -n 's/^[[:space:]]*{[[:space:]]*"session_id"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F-]*\)".*/\1/p')
case "$thread_id" in
  ????????-????-[12345678]???-[89abAB]???-????????????)
    umask 077
    printf '%s\n' "$thread_id" > .warble/codex-thread-id
    ;;
  *) exit 1 ;;
esac
"#;

fn codex_resume_capture_hooks() -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "description": "Capture only this isolated native Codex thread identifier for host-owned resume.",
        "hooks": {
            "UserPromptSubmit": [{
                "hooks": [{
                    "type": "command",
                    "command": "/bin/sh .warble/capture-codex-thread.sh",
                    "timeout": 3,
                    "statusMessage": "Securing native session resume"
                }]
            }]
        }
    })).expect("Codex native hooks serialize")
}

fn build_skill(
    ir: &WarbleIr,
    marker: &str,
    purpose: Option<NativePurpose>,
    include_setup_recovery_instructions: bool,
    include_persist_answer_instructions: bool,
    has_native_mcp: bool,
) -> String {
    let purpose = purpose.unwrap_or(NativePurpose::ContextEnrichment);
    let sections = ir
        .components
        .iter()
        .filter(|node| node.realization_kind == RealizationKind::Skill)
        .map(|node| {
            let fragment = match purpose {
                NativePurpose::Analysis => native_analysis_prompt_fragment(&node.prompt_fragment),
                NativePurpose::ContextEnrichment => {
                    native_context_enrichment_prompt_fragment(&node.prompt_fragment)
                }
                NativePurpose::Setup => node.prompt_fragment.clone(),
            };
            match &node.brief {
                Some(brief) => format!("{brief}\n\n{fragment}"),
                None => fragment,
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let scope = match purpose {
        NativePurpose::Setup => "Operate only within the server-created bootstrap scope. Do not adopt, discover, or switch to an existing project.",
        NativePurpose::Analysis | NativePurpose::ContextEnrichment => "Operate only within the server-bound project scope. Do not change cwd or follow a caller-supplied project path.",
    };
    let safety = match purpose {
        NativePurpose::ContextEnrichment => "Do not write files, invoke a headless runner, start an app server, or use `codex exec`. Do not invoke or simulate `apply_enrichment`. An apply remains a native interactive human-approval workflow with dry-run, scoped authorization, validation/build, and rollback checks.",
        NativePurpose::Analysis => "Do not read credentials or expose raw material. Do not invoke a headless runner, start an app server, or use `codex exec`.",
        NativePurpose::Setup => "Do not read credentials into output, start an app server, or use `codex exec`. The host owns all session lifecycle and any subsequent project binding.",
    };
    let mut skill = format!(
        "---\nname: {}\ndescription: {}\n---\n\n{}\n\n# GenBI {}\n\n{}\n\n{}\n\n{}\n",
        purpose.codex_skill(),
        purpose.codex_description(),
        marker,
        purpose.as_str(),
        scope,
        sections,
        safety
    );
    if include_setup_recovery_instructions {
        skill.push('\n');
        skill.push_str(setup_recovery_instructions());
    }
    if purpose == NativePurpose::Setup {
        skill.push('\n');
        skill.push_str(&setup_bootstrap_authority_instructions());
    }
    if include_persist_answer_instructions {
        skill.push('\n');
        skill.push_str(native_answer_persistence_instructions());
    }
    if purpose == NativePurpose::Analysis {
        skill.push('\n');
        skill.push_str(native_analysis_terminal_presentation_instructions());
    }
    if purpose == NativePurpose::ContextEnrichment {
        skill.push('\n');
        skill.push_str(native_context_enrichment_terminal_presentation_instructions());
    }
    if purpose == NativePurpose::Analysis
        && has_native_mcp
        && ir.components.iter().any(is_dashboard_component)
    {
        skill.push('\n');
        skill.push_str(native_dashboard_save_instructions());
    }
    skill
}

fn is_dashboard_component(node: &crate::ir::ComponentNode) -> bool {
    node.required_capabilities
        .iter()
        .any(|capability| capability == "genbi_build")
        && node
            .required_capabilities
            .iter()
            .any(|capability| capability == "artifact_write")
}

/// The host persistence contract is derived from the component's declared
/// render blocks, so this target cannot introduce a Codex-only answer shape.
fn is_persisted_answer_component(node: &crate::ir::ComponentNode) -> bool {
    let blocks = &node.effect.render_blocks;
    let table = blocks
        .iter()
        .filter(|block| block.block_type == "table")
        .count();
    let definition = blocks
        .iter()
        .filter(|block| block.block_type == "definition")
        .count();
    table == 1
        && definition <= 1
        && blocks.len() == table + definition
        && blocks
            .iter()
            .find(|block| block.block_type == "table")
            .is_some_and(|block| {
                block
                    .fields
                    .get("columns")
                    .is_some_and(|field| field == "string[]")
                    && block
                        .fields
                        .get("rows")
                        .is_some_and(|field| field == "row[]")
            })
        && blocks
            .iter()
            .filter(|block| block.block_type == "definition")
            .all(|block| {
                block
                    .fields
                    .get("sql")
                    .is_some_and(|field| field == "string")
                    && block
                        .fields
                        .get("source_tables")
                        .is_some_and(|field| field == "string[]")
                    && block
                        .fields
                        .get("filters")
                        .is_some_and(|field| field == "string[]")
            })
}

fn build_agents(marker: &str, purpose: Option<NativePurpose>) -> String {
    let purpose = purpose.unwrap_or(NativePurpose::ContextEnrichment);
    format!("{}\n# Warble native {}\n\nUse the `${}` skill for this server-selected purpose. The caller owns the PTY, process, prompt injection, transcript, and session lifecycle.\n", marker, purpose.as_str(), purpose.codex_skill())
}

fn build_run(marker: &str, skill_name: &str, purpose: Option<NativePurpose>) -> String {
    let purpose = purpose.unwrap_or(NativePurpose::ContextEnrichment);
    format!("{}\n# Native Codex {} session\n\nRead `.warble/interactive-launch.json`, then start the native `codex` TUI in its canonical cwd. Codex discovers `AGENTS.md` and `.agents/skills/{}/SKILL.md` from that repository scope. The caller owns the PTY, prompt injection, process, transcript, and session lifecycle.\n", marker, purpose.as_str(), skill_name)
}
