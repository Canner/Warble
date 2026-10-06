//! Author commands share compilation and the real native emitter. No runtime is launched.
use clap::Args;
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
use warble_cli::{provenance::AuthorSource, BuiltinContextResolver, ComponentSource};

#[derive(Args)]
pub(super) struct AuthorArgs {
    /// Project directory containing profile.yml.
    project_dir: PathBuf,
    /// Plain native file target: claude-code:headless or claude-code:interactive.
    #[arg(long, default_value = "claude-code:headless")]
    target: String,
    #[arg(long = "component-dir")]
    component_dir: Vec<PathBuf>,
    #[arg(long = "hub-dir", conflicts_with = "hub_version")]
    hub_dir: Option<PathBuf>,
    #[arg(long = "hub-version", conflicts_with = "hub_dir")]
    hub_version: Option<String>,
    #[arg(long, default_value = "opus")]
    strong: String,
    #[arg(long, default_value = "haiku")]
    cheap: String,
    #[arg(long, default_value = "sonnet")]
    orchestrator: String,
    #[arg(long = "render-flavor", default_value = "programmatic")]
    render_flavor: String,
    /// NAME=VARIANT selects a variant; NAME= explicitly omits a conditional slot.
    #[arg(long = "slot", value_name = "NAME=VARIANT")]
    slot: Vec<String>,
}

pub(super) enum Mode {
    Check,
    Preview { json: bool },
    Build { out: PathBuf },
}

#[derive(Serialize)]
struct Surface {
    path: String,
    content: String,
}
#[derive(Serialize)]
struct Preview {
    target: String,
    runtime_boundary: Vec<&'static str>,
    sources: Vec<AuthorSource>,
    surfaces: Vec<Surface>,
    permissions: serde_json::Value,
    capabilities: serde_json::Value,
}

fn dispatch(args: &AuthorArgs, ir: &Path, out: &Path) -> Result<(), String> {
    super::run_dispatch(
        ir,
        &args.target,
        out,
        &args.render_flavor,
        None,
        args.strong.clone(),
        args.cheap.clone(),
        args.orchestrator.clone(),
        "bash-script",
        None,
        None,
        None,
        None,
        &[],
        None,
        &args.slot,
    )
}

fn explain(args: &AuthorArgs, stage: &str, error: String) -> String {
    // serde YAML errors may include the entire invalid scalar. Keep the source/location and
    // field name, never quote that value in this author-facing path.
    let message = if error.contains("failed to parse") {
        let source = error.split(": ").next().unwrap_or("authoring file");
        let field = error
            .split("unknown field `")
            .nth(1)
            .and_then(|s| s.split('`').next());
        let entry = error
            .split("components[")
            .nth(1)
            .and_then(|s| s.split(']').next())
            .filter(|s| s.chars().all(|c| c.is_ascii_digit()));
        format!("{source}{}: invalid YAML or unsupported field{}. Check field names and value types; values omitted.",
            entry.map(|i| format!("#components[{i}]")).unwrap_or_default(),
            field.map(|s| format!(" '{s}'")).unwrap_or_default())
    } else {
        error
    };
    let remedy = match stage {
        "compile" => "Check components[].prompt / llm_steps, context and context_precondition in the named source. Supply an explicit context when required; use supported fields.",
        "output" => "Check the output path length, directory permissions and available disk space before retrying.",
        _ => "Check component required_capabilities, guardrails and realization_kind against this target. For slots, supply --slot NAME=VARIANT (or NAME= to omit); keep required safety constraints.",
    };
    format!(
        "{}: {stage} for {} failed: {message}\n{remedy}",
        args.project_dir.join("profile.yml").display(),
        args.target
    )
}

fn read_json(path: &Path) -> Result<serde_json::Value, String> {
    serde_json::from_str(&super::read_file(path)?).map_err(|e| e.to_string())
}

fn emit_new_output(out: &Path, emit: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    // Reserve before emitting: an existing directory or symlink is never ours to clean up.
    fs::create_dir(out).map_err(|e| format!("cannot reserve new output {}: {e}", out.display()))?;
    // Keep the directory open so its inode cannot be recycled while delivery runs.
    // All distributed CLI targets are Unix. Other platforms retain failed output.
    #[cfg(unix)]
    let reserved = fs::File::open(out).map_err(|e| {
        format!(
            "cannot retain output identity {}: {e}; output preserved",
            out.display()
        )
    })?;
    if let Err(error) = emit() {
        #[cfg(unix)]
        let cleanup = remove_owned_output(out, &reserved);
        #[cfg(not(unix))]
        let cleanup: std::io::Result<()> = Err(std::io::Error::other(
            "output identity verification unavailable on this platform; output preserved",
        ));
        return match cleanup {
            Ok(()) => Err(error),
            Err(cleanup) => Err(format!(
                "{error}\nCould not remove failed output {}: {cleanup}. Inspect the output before retrying; preserved paths may belong to another process.",
                out.display()
            )),
        };
    }
    Ok(())
}

#[cfg(unix)]
fn remove_owned_output(out: &Path, reserved: &fs::File) -> std::io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let original = reserved.metadata()?;
    let current = fs::symlink_metadata(out)?;
    if !current.is_dir() || current.dev() != original.dev() || current.ino() != original.ino() {
        return Err(std::io::Error::other(
            "output directory identity changed; replacement preserved",
        ));
    }
    fs::remove_dir_all(out)
}

pub(super) fn run(args: AuthorArgs, mode: Mode) -> Result<(), String> {
    if !matches!(
        args.target.as_str(),
        "claude-code:headless" | "claude-code:interactive"
    ) {
        return Err("author check/preview/build currently support claude-code:headless and claude-code:interactive; use compile/dispatch for other targets and their explicit host contracts".into());
    }
    if let Mode::Build { out } = &mode {
        if out.symlink_metadata().is_ok() {
            return Err(format!("{} already exists; choose a new --out directory (build never overwrites an existing path)",out.display()));
        }
    }
    let profile = args.project_dir.join("profile.yml");
    warble_cli::provenance::validate_profile_fields(&super::read_file(&profile)?, &profile)?;
    let mut local = vec![ComponentSource::local(args.project_dir.join("components"))];
    local.extend(args.component_dir.iter().map(ComponentSource::local));
    let sources = if let Some(hub) = &args.hub_dir {
        local.push(ComponentSource::hub(hub));
        local
    } else if args.hub_version.is_some()
        || warble_cli::project_needs_hub(&args.project_dir, &local, None).map_err(|e| {
            explain(
                &args,
                "compile",
                format!("failed to parse {}: {e}", profile.display()),
            )
        })?
    {
        let mut sources = warble_cli::default_component_sources_with_hub_version(
            &args.project_dir,
            args.hub_version.as_deref(),
        )?;
        sources.extend(args.component_dir.iter().map(ComponentSource::local));
        sources
    } else {
        local
    };
    let compiled = warble_cli::compile_project_for_authoring(
        &args.project_dir,
        &sources,
        &BuiltinContextResolver,
    )
    .map_err(|e| explain(&args, "compile", e))?;
    // Only this process's temporary directory holds IR/assets. TempDir removes it on every exit.
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let ir = temp.path().join("ir.json");
    fs::write(
        &ir,
        serde_json::to_vec_pretty(&compiled.ir).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    warble_cli::write_assets(&warble_cli::asset_dir_for_ir(&ir), &compiled.assets)?;
    let emitted = temp.path().join("native");
    dispatch(&args, &ir, &emitted).map_err(|e| {
        let sources = compiled
            .sources
            .iter()
            .filter(|s| s.role == "component declaration" || s.role == "slot variant")
            .map(|s| format!("  {}#{}", s.file, s.field))
            .collect::<Vec<_>>()
            .join("\n");
        explain(
            &args,
            "dispatch",
            format!(
                "{}\nAuthor sources:\n{sources}",
                e.replace(&ir.display().to_string(), "compiled profile")
            ),
        )
    })?;
    match mode {
        Mode::Check => println!(
            "Valid for {}. No model was started; temporary output removed on exit.",
            args.target
        ),
        Mode::Build { out } => {
            // Preflight used the identical compiled input and target; the real emitter still
            // performs its output ownership checks at the destination (interactive launch pins).
            if let Some(parent) = out.parent().filter(|p| !p.as_os_str().is_empty()) {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("cannot create output parent: {e}"))?;
            }
            // Keep final-path emission for interactive launch pins, rolling back this new
            // directory if delivery fails after the successful temporary preflight.
            emit_new_output(&out, || dispatch(&args, &ir, &out))
                .map_err(|e| explain(&args, "output", e))?;
            println!("Built {} at {}. Read RUN.md, then start the native CLI yourself. No model was started.",args.target,out.display());
        }
        Mode::Preview { json } => {
            let supply = super::parse_slot_flags(&args.slot)?;
            let mut sources = compiled.sources;
            for source in &mut sources {
                if let Some(name) = &source.slot {
                    let selection = supply
                        .get(name)
                        .cloned()
                        .unwrap_or_else(|| source.default_variant.clone());
                    source.status = if selection.is_none() {
                        "omitted by --slot; not emitted"
                    } else if selection == source.variant {
                        "selected variant; contributes only through effective references"
                    } else {
                        "unselected; not emitted"
                    }
                    .into();
                }
                if let Some(id) = &source.component {
                    if compiled.ir["components"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|n| n["id"] == *id && n["entrypoint"] == false)
                    {
                        source.status = "non-entrypoint; not emitted by this file target".into();
                    }
                }
            }
            let agent_dir = emitted.join(".claude/agents");
            let mut files = vec![emitted.join(".claude/CLAUDE.md")];
            let mut agents: Vec<_> = fs::read_dir(&agent_dir)
                .map_err(|e| e.to_string())?
                .map(|e| e.map(|entry| entry.path()))
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            agents.sort();
            files.extend(agents);
            let surfaces = files
                .iter()
                .map(|file| {
                    Ok(Surface {
                        path: file
                            .strip_prefix(&emitted)
                            .unwrap()
                            .to_string_lossy()
                            .into_owned(),
                        content: super::read_file(file)?,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            let preview = Preview {
                target: args.target,
                runtime_boundary: vec![
                    "Exact static native instruction files, including frontmatter; not a captured conversation or proof that every agent runs.",
                    "The native CLI/host adds its own system instructions, user request, conversation history, environment policies, tool definitions and results at runtime. These are not previewed.",
                    "Sources explain append/replace and slot selection. Replaced and unselected text is not printed; target-generated framing is visible in the native files.",
                    "Native permissions shown are generated configuration; prompt requests are not enforcement. Conditional/per-step behavior retains this target's existing limits.",
                    "No runtime credentials, provider bindings or ambient environment are loaded by this author path. Authored prompt text is printed verbatim: do not put secrets in it.",
                ],
                sources, surfaces,
                permissions: read_json(&emitted.join(".claude/settings.json"))?,
                capabilities: read_json(&emitted.join("capability-report.json"))?,
            };
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&preview).map_err(|e| e.to_string())?
                );
            } else {
                println!("Preview: {}\n", preview.target);
                for line in &preview.runtime_boundary {
                    println!("{line}");
                }
                println!("\nAuthor sources:");
                for source in &preview.sources {
                    println!(
                        "- {}#{} [{}]: {} — {}",
                        source.file,
                        source.field,
                        source.component.as_deref().unwrap_or("profile"),
                        source.role,
                        source.status
                    );
                }
                println!(
                    "\nNative permissions:\n{}\n\nCapability resolution:\n{}",
                    serde_json::to_string_pretty(&preview.permissions).unwrap(),
                    serde_json::to_string_pretty(&preview.capabilities).unwrap()
                );
                for surface in &preview.surfaces {
                    println!("\n--- {} ---\n{}", surface.path, surface.content);
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn delivery_error_removes_partial_files_and_allows_retry() {
        let temp = tempfile::tempdir().unwrap();
        let out = temp.path().join("output");
        let error = emit_new_output(&out, || {
            fs::create_dir(out.join(".claude")).unwrap();
            fs::write(out.join(".claude/CLAUDE.md"), "partial").unwrap();
            Err("delivery write failed".into())
        })
        .unwrap_err();
        assert_eq!(error, "delivery write failed");
        assert!(!out.exists());
        emit_new_output(&out, || {
            fs::write(out.join("complete"), "ready").map_err(|e| e.to_string())
        })
        .unwrap();
        assert_eq!(fs::read_to_string(out.join("complete")).unwrap(), "ready");
    }

    #[test]
    fn reservation_failure_preserves_existing_output_without_emitting() {
        let temp = tempfile::tempdir().unwrap();
        let out = temp.path().join("output");
        fs::create_dir(&out).unwrap();
        fs::write(out.join("canary"), "preserve").unwrap();
        let error =
            emit_new_output(&out, || panic!("existing output must not be emitted")).unwrap_err();
        assert!(error.contains("cannot reserve new output"));
        assert_eq!(fs::read_to_string(out.join("canary")).unwrap(), "preserve");
    }

    #[test]
    fn cleanup_failure_reports_both_errors_without_removing_a_replacement_file() {
        let temp = tempfile::tempdir().unwrap();
        let out = temp.path().join("output");
        let error = emit_new_output(&out, || {
            // A concurrent writer has replaced the reserved directory with a file.
            fs::remove_dir(&out).unwrap();
            fs::write(&out, "preserve replacement").unwrap();
            Err("delivery write failed".into())
        })
        .unwrap_err();
        assert!(error.contains("delivery write failed"));
        assert!(error.contains("Could not remove failed output"));
        assert!(error.contains(out.to_str().unwrap()));
        assert_eq!(fs::read_to_string(&out).unwrap(), "preserve replacement");
    }

    #[cfg(unix)]
    #[test]
    fn rollback_preserves_replacement_directory_and_symlink() {
        for symlink in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let out = temp.path().join("output");
            let moved = temp.path().join("moved");
            let foreign = temp.path().join("foreign");
            fs::create_dir(&foreign).unwrap();
            fs::write(foreign.join("canary"), "preserve").unwrap();
            let error = emit_new_output(&out, || {
                fs::write(out.join("partial"), "owned").unwrap();
                fs::rename(&out, &moved).unwrap();
                if symlink {
                    std::os::unix::fs::symlink(&foreign, &out).unwrap();
                } else {
                    fs::rename(&foreign, &out).unwrap();
                }
                Err("delivery write failed".into())
            })
            .unwrap_err();
            assert!(error.contains("output directory identity changed"));
            assert_eq!(fs::read_to_string(out.join("canary")).unwrap(), "preserve");
            assert_eq!(fs::read_to_string(moved.join("partial")).unwrap(), "owned");
        }
    }
}
