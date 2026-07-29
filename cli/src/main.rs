//! `warble` — the Warble CLI.
//!
//! One native binary across the CLI-target path:
//! - `compile`  — a Warble project → IR JSON (front-end compiler; host reads files, injects into
//!   the sans-IO `warble` core).
//! - `dispatch` — IR → a runtime target: Claude Code agent files (the `claude-code-cli` back-end)
//!   or a vercel bundle (the `vercel` back-end); both in Rust.
//! - `render`   — a captured agent envelope → deterministic `dashboard.html` (reference renderer).
//! - `manifest` — IR → capability manifest (interop advertisement).

use clap::{Parser, Subcommand};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use warble_claude_code::{
    build_manifest, emit_claude_code_with_realization, ir::WarbleIr, parse_envelope,
    render_envelope_to_html, HybridRealization, ModelConfig, RenderFlavor, RenderOptions,
};
use warble_cli::{
    blast_radius_for_project, compile_project_to_ir_with_sources, default_component_sources, gate,
    ComponentSource, SourceKind,
};
use warble_vercel::{
    emit_vercel, known_target_names, parse_provider_fragments, ProviderFragment,
    TargetId as VercelTargetId, DEFAULT_TARGET,
};

mod mcp_serve;

#[derive(Parser)]
#[command(
    name = "warble",
    about = "Warble — declarative data-agent behavior framework"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Compile a Warble project (profile + components + context binding) into IR JSON.
    Compile {
        project_dir: PathBuf,
        #[arg(short, long)]
        out: PathBuf,
        /// An additional Local-precedence component source directory (immediate children are
        /// `<id>/component.yml`). Repeatable. This is how a host outside this checkout mounts its
        /// own component library alongside the Hub, e.g. a product-specific set of components.
        /// Local sources (this flag + the project's own `components/` dir) all outrank Hub, but
        /// two Local sources defining the same id is an ambiguous, loud-fail configuration — no
        /// rule says which wins.
        #[arg(long = "component-dir")]
        component_dir: Vec<PathBuf>,
        /// Override the Hub component library root (defaults to this checkout's own
        /// `hub/components`). Lets a host point at a Hub library that lives outside this checkout.
        #[arg(long = "hub-dir")]
        hub_dir: Option<PathBuf>,
    },
    /// Dispatch a compiled IR to a runtime target: Claude Code agent files, or a vercel bundle.
    Dispatch {
        ir: PathBuf,
        /// Target runtime (claude-code:headless | claude-code:interactive | vercel |
        /// vercel:headless | vercel:interactive).
        #[arg(long, default_value = "claude-code:headless")]
        target: String,
        #[arg(long)]
        out: PathBuf,
        /// (claude-code target only) Render flavor for render-contract components (programmatic | prompt).
        #[arg(long = "render-flavor", default_value = "programmatic")]
        render_flavor: String,
        /// (claude-code target only) Tier→model config YAML (a `tiers:` map). Takes
        /// precedence over the inline --strong/--cheap/--orchestrator flags when given.
        #[arg(long = "models-config")]
        models_config: Option<PathBuf>,
        /// (claude-code target only) Model for the `strong` tier (inline tier→model binding; ignored if --models-config given).
        #[arg(long, default_value = "opus")]
        strong: String,
        /// (claude-code target only) Model for the `cheap` tier.
        #[arg(long, default_value = "haiku")]
        cheap: String,
        /// (claude-code target only) Model for the per-step-tier driver's routing loop.
        #[arg(long, default_value = "sonnet")]
        orchestrator: String,
        /// (claude-code target only) How a HYBRID binding's local step is realized on the file target (bash-script | mcp-server).
        #[arg(long = "hybrid-realization", default_value = "bash-script")]
        hybrid_realization: String,
        /// (vercel target only) A provider fragment file (YAML) contributing domain capabilities +
        /// tool bindings on top of the base substrate profile — repeatable. The base vercel target
        /// resolves only substrate capabilities (llm tiers, render contract, approval, VCS, ...); a
        /// bare dispatch with no --provider loud-fails any component that requires a domain
        /// capability (sql_execution, genbi_build, scheduler, ...), naming which one is unresolved.
        #[arg(long = "provider")]
        provider: Vec<PathBuf>,
    },
    /// Render a captured agent envelope into a self-contained dashboard.html.
    Render {
        /// Envelope JSON file, or `-` for stdin.
        input: String,
        #[arg(short, long)]
        out: PathBuf,
        #[arg(long)]
        title: Option<String>,
    },
    /// Emit a profile's capability manifest from its IR.
    Manifest {
        ir: PathBuf,
        /// Write to this path instead of stdout.
        #[arg(short, long)]
        out: Option<PathBuf>,
    },
    /// Run the stdio MCP server for the file target's hybrid (mcp-server) realization: exposes a
    /// `local_infer` tool that runs a binding's local step on an OpenAI-compatible endpoint. Registered
    /// by the emitted `.mcp.json`; spawned by `claude` over stdio (not run by hand).
    McpServe {
        /// Path to the emitted `mcp-steps.json` (local step → endpoint/model/system).
        #[arg(long)]
        steps: PathBuf,
    },
    /// Compute a node's blast radius against a Warble project's bound wren project, and gate a
    /// pending mutating apply against it (Phase 4a).
    ///
    /// Exit codes: 0 = allow, 10 = escalate (route to human approval), 11 = block (protected
    /// asset — no escalation path). A resolution/parse error prints `error: ...` to stderr and
    /// exits 1.
    BlastRadius {
        /// The Warble project directory (contains profile.yml + context/binding.yml).
        project_dir: PathBuf,
        /// The lineage node id to compute the blast radius of (e.g. `model:orders`).
        #[arg(long)]
        node: String,
        /// Escalate when the radius severity is strictly above this (none|compatibility|structural|semantic).
        #[arg(long = "max-severity")]
        max_severity: Option<String>,
        /// Escalate when the downstream count is strictly above this.
        #[arg(long = "max-downstream")]
        max_downstream: Option<usize>,
        /// Comma-separated node ids that force a hard block if touched.
        #[arg(long, default_value = "")]
        protected: String,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Compile {
            project_dir,
            out,
            component_dir,
            hub_dir,
        } => run_compile(&project_dir, &out, &component_dir, hub_dir.as_deref()),
        Command::Dispatch {
            ir,
            target,
            out,
            render_flavor,
            models_config,
            strong,
            cheap,
            orchestrator,
            hybrid_realization,
            provider,
        } => run_dispatch(
            &ir,
            &target,
            &out,
            &render_flavor,
            models_config.as_deref(),
            strong,
            cheap,
            orchestrator,
            &hybrid_realization,
            &provider,
        ),
        Command::Render { input, out, title } => run_render(&input, &out, title.as_deref()),
        Command::Manifest { ir, out } => run_manifest(&ir, out.as_deref()),
        Command::McpServe { steps } => mcp_serve::run_mcp_serve(&steps),
        Command::BlastRadius {
            project_dir,
            node,
            max_severity,
            max_downstream,
            protected,
        } => {
            return run_blast_radius(
                &project_dir,
                &node,
                max_severity.as_deref(),
                max_downstream,
                &protected,
            )
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            ExitCode::FAILURE
        }
    }
}

// --- compile --------------------------------------------------------------------------------------

fn run_compile(
    project_dir: &Path,
    out: &Path,
    extra_component_dirs: &[PathBuf],
    hub_dir: Option<&Path>,
) -> Result<(), String> {
    let mut sources = default_component_sources(project_dir);
    if let Some(hub_dir) = hub_dir {
        // Replace the default Hub source by kind (not by position), so this stays correct if
        // `default_component_sources` ever grows or reorders its entries. There must still be
        // exactly one Hub source afterwards.
        sources.retain(|source| source.kind != SourceKind::Hub);
        sources.push(ComponentSource::hub(hub_dir));
    }
    sources.extend(
        extra_component_dirs
            .iter()
            .map(|dir| ComponentSource::local(dir.clone())),
    );

    let ir = compile_project_to_ir_with_sources(project_dir, &sources)?;
    let rendered = serde_json::to_string_pretty(&ir).map_err(|e| e.to_string())?;
    fs::write(out, rendered).map_err(|e| format!("failed to write {}: {e}", out.display()))
}

// --- dispatch -------------------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn run_dispatch(
    ir_path: &Path,
    target: &str,
    out: &Path,
    render_flavor: &str,
    models_config: Option<&Path>,
    strong: String,
    cheap: String,
    orchestrator: String,
    hybrid_realization: &str,
    provider_paths: &[PathBuf],
) -> Result<(), String> {
    // The vercel target is a wholly separate back-end (its own IR type, no render-flavor/model-tier/
    // hybrid-realization knobs), so it branches off before any claude-code-specific flag parsing.
    if is_vercel_target(target) {
        return run_vercel_dispatch(ir_path, target, out, provider_paths);
    }
    if !provider_paths.is_empty() {
        return Err("--provider is only supported for the vercel target".to_string());
    }
    let flavor = RenderFlavor::parse(render_flavor).ok_or_else(|| {
        format!("unknown --render-flavor '{render_flavor}' (expected: programmatic, prompt)")
    })?;
    let hybrid = HybridRealization::parse(hybrid_realization).ok_or_else(|| {
        format!(
            "unknown --hybrid-realization '{hybrid_realization}' (expected: bash-script, mcp-server)"
        )
    })?;
    // A --models-config YAML wins; otherwise build a two-tier config from the inline flags.
    let models = match models_config {
        Some(path) => ModelConfig::from_yaml(&read_file(path)?).map_err(|e| e.to_string())?,
        None => ModelConfig::from_flags(strong, cheap, orchestrator),
    };
    let ir = load_ir(ir_path)?;
    emit_claude_code_with_realization(&ir, out, target, flavor, &models, hybrid)
        .map_err(|e| e.to_string())
}

/// Whether `--target` names the vercel back-end (`vercel` or `vercel:<mode>`), as opposed to the
/// default claude-code back-end.
fn is_vercel_target(target: &str) -> bool {
    target == "vercel" || target.starts_with("vercel:")
}

fn run_vercel_dispatch(
    ir_path: &Path,
    target: &str,
    out: &Path,
    provider_paths: &[PathBuf],
) -> Result<(), String> {
    let target_id = if target == "vercel" {
        DEFAULT_TARGET
    } else {
        VercelTargetId::parse(target).ok_or_else(|| {
            format!(
                "unknown --target '{target}' (expected: vercel, {})",
                known_target_names().join(", ")
            )
        })?
    };
    let ir = load_vercel_ir(ir_path)?;
    let providers = load_provider_fragments(provider_paths)?;
    emit_vercel(&ir, target_id, out, &providers)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Read and parse every `--provider` file into a flat list of fragments (a file may itself declare
/// one fragment or a `providers:` list of several). File I/O lives here, in the CLI — `emit_vercel`
/// and `compose_target` only ever see already-parsed `ProviderFragment` values.
fn load_provider_fragments(paths: &[PathBuf]) -> Result<Vec<ProviderFragment>, String> {
    let mut fragments = Vec::new();
    for path in paths {
        let raw = read_file(path)?;
        let parsed = parse_provider_fragments(&raw)
            .map_err(|e| format!("failed to parse provider fragment {}: {e}", path.display()))?;
        fragments.extend(parsed);
    }
    Ok(fragments)
}

// --- render ---------------------------------------------------------------------------------------

fn run_render(input: &str, out: &Path, title: Option<&str>) -> Result<(), String> {
    let raw = read_input(input)?;
    let envelope = parse_envelope(&unwrap_cli_result(&raw)).map_err(|e| e.to_string())?;
    let options = RenderOptions {
        title: title.map(|t| t.to_string()),
    };
    let html = render_envelope_to_html(&envelope, &options);
    fs::write(out, html).map_err(|e| format!("failed to write {}: {e}", out.display()))?;
    eprintln!(
        "warble render: wrote {} ({} block(s))",
        out.display(),
        envelope.blocks.len()
    );
    Ok(())
}

/// Unwrap `claude -p --output-format json`, whose top-level object carries the agent's final text
/// under `.result`. Otherwise pass the input through to the envelope extractor.
fn unwrap_cli_result(raw: &str) -> String {
    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(serde_json::Value::String(result)) = map.get("result") {
            return result.clone();
        }
    }
    raw.to_string()
}

// --- manifest -------------------------------------------------------------------------------------

fn run_manifest(ir_path: &Path, out: Option<&Path>) -> Result<(), String> {
    let ir = load_ir(ir_path)?;
    let manifest = build_manifest(&ir);
    let json = format!(
        "{}\n",
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?
    );
    match out {
        Some(path) => {
            fs::write(path, json)
                .map_err(|e| format!("failed to write {}: {e}", path.display()))?;
            eprintln!("warble manifest: wrote {}", path.display());
            Ok(())
        }
        None => {
            print!("{json}");
            Ok(())
        }
    }
}

// --- blast-radius -----------------------------------------------------------------------------------

/// Compute `node`'s blast radius in the project bound at `project_dir`, gate it against the given
/// thresholds, and print a single pretty JSON object to stdout. Exit code carries the decision
/// (0 = allow, 10 = escalate, 11 = block) so a caller can branch on it without parsing output.
fn run_blast_radius(
    project_dir: &Path,
    node: &str,
    max_severity: Option<&str>,
    max_downstream: Option<usize>,
    protected: &str,
) -> ExitCode {
    let max_severity = match max_severity {
        Some(s) => match gate::parse_severity(s) {
            Some(sev) => Some(sev),
            None => {
                eprintln!(
                    "error: unknown --max-severity '{s}' (expected: none, compatibility, structural, semantic)"
                );
                return ExitCode::FAILURE;
            }
        },
        None => None,
    };
    let protected: Vec<String> = protected
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let threshold = gate::GateThreshold {
        max_severity,
        max_downstream,
        protected,
    };

    let radius = match blast_radius_for_project(project_dir, node) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };
    let (decision, reason) = gate::decide(&radius, &threshold);

    let output = serde_json::json!({
        "seed": radius.seed,
        "downstream": radius.downstream,
        "severity": gate::severity_str(radius.severity),
        "decision": decision.as_str(),
        "reason": reason,
    });
    match serde_json::to_string_pretty(&output) {
        Ok(json) => println!("{json}"),
        Err(e) => {
            eprintln!("error: failed to serialize blast-radius result: {e}");
            return ExitCode::FAILURE;
        }
    }

    match decision {
        gate::GateDecision::Allow => ExitCode::SUCCESS,
        gate::GateDecision::Escalate => ExitCode::from(10),
        gate::GateDecision::Block => ExitCode::from(11),
    }
}

// --- helpers --------------------------------------------------------------------------------------

fn load_ir(path: &Path) -> Result<WarbleIr, String> {
    let raw = read_file(path)?;
    serde_json::from_str(&raw).map_err(|e| format!("failed to parse IR {}: {e}", path.display()))
}

/// `emit_vercel` takes `warble_vercel`'s own `WarbleIr` type (distinct from
/// `warble_claude_code::ir::WarbleIr`, even though both deserialize the same IR JSON), so the
/// vercel dispatch path needs its own load function.
fn load_vercel_ir(path: &Path) -> Result<warble_vercel::ir::WarbleIr, String> {
    let raw = read_file(path)?;
    serde_json::from_str(&raw).map_err(|e| format!("failed to parse IR {}: {e}", path.display()))
}

fn read_file(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("failed to read {}: {e}", path.display()))
}

fn read_input(input: &str) -> Result<String, String> {
    if input == "-" {
        let mut buf = String::new();
        io::stdin()
            .read_to_string(&mut buf)
            .map_err(|e| format!("failed to read stdin: {e}"))?;
        Ok(buf)
    } else {
        read_file(Path::new(input))
    }
}
