//! Native Codex TUI materialization. This emits discovery artifacts only; it never starts Codex.

use crate::error::DispatchError;
use crate::interactive::prepare_interactive_output;
use crate::ir::{validate_ir_version, OutcomeKind, RealizationKind, TriggerKind, WarbleIr};
use crate::resolve::resolve_capabilities;
use crate::targets::TargetId;
use std::fs;
use std::path::Path;

pub fn emit_codex_interactive(ir: &WarbleIr, out_dir: &Path) -> Result<(), DispatchError> {
    validate_ir_version(ir)?;
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
    let skill_relative = Path::new(".agents/skills/genbi-enrich-context/SKILL.md").to_path_buf();
    let agents_relative = Path::new("AGENTS.md").to_path_buf();
    let run_relative = Path::new("RUN.md").to_path_buf();
    let output = prepare_interactive_output(
        out_dir,
        target,
        "codex",
        &signature,
        &[
            skill_relative.clone(),
            agents_relative.clone(),
            run_relative.clone(),
        ],
    )?;

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

    let skill = build_skill(ir, output.marker());
    let agents = format!("{}\n# Warble native enrichment\n\nUse the `$genbi-enrich-context` skill for read-only inspection and proposal drafting. It never grants an apply path.\n", output.marker());
    let run = format!("{}\n# Native Codex enrichment\n\nStart the native `codex` TUI in this directory. Codex discovers `AGENTS.md` once for the launched session and discovers `.agents/skills/genbi-enrich-context/SKILL.md` from this repository scope. The caller owns the PTY, prompt injection, process, transcript, and session lifecycle.\n\n`apply_enrichment` is not a headless operation: it remains a separate native, explicit-human-approval action after dry-run, scoped authorization, validation/build, and rollback checks.\n", output.marker());
    let skill_path = output.root.join(skill_relative);
    fs::create_dir_all(skill_path.parent().expect("skill parent"))
        .map_err(|e| DispatchError(format!("create Codex skill dir: {e}")))?;
    fs::write(skill_path, skill).map_err(|e| DispatchError(format!("write Codex skill: {e}")))?;
    fs::write(output.root.join(agents_relative), agents)
        .map_err(|e| DispatchError(format!("write AGENTS.md: {e}")))?;
    fs::write(output.root.join(run_relative), run)
        .map_err(|e| DispatchError(format!("write RUN.md: {e}")))?;
    output.write_ownership()?;
    output.write_launch_spec()
}

fn build_skill(ir: &WarbleIr, marker: &str) -> String {
    let sections = ir
        .components
        .iter()
        .filter(|node| node.realization_kind == RealizationKind::Skill)
        .map(|node| node.prompt_fragment.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    format!("---\nname: genbi-enrich-context\ndescription: Inspect a pinned project and draft read-only enrichment proposals; never apply an enrichment.\n---\n\n{}\n\n# GenBI enrichment context\n\nRead only files within the launched repository scope. Do not read credentials or expose raw material. Do not write files, invoke a headless runner, start an app server, or use `codex exec`.\n\n{}\n\n## Apply boundary\n\nDo not invoke or simulate `apply_enrichment`. An apply remains a native interactive human-approval workflow with dry-run, scoped write authorization, validation/build, and rollback checks.\n", marker, sections)
}
