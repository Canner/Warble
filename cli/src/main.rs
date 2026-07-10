//! `warble` — the Warble CLI.
//!
//! One native binary across the CLI-target path:
//! - `compile`  — a Warble project → IR JSON (front-end compiler; host reads files, injects into
//!   the sans-IO `warble` core).
//! - `dispatch` — IR → Claude Code agent files (the `claude-code-cli` back-end, in Rust).
//! - `render`   — a captured agent envelope → deterministic `dashboard.html` (reference renderer).
//! - `manifest` — IR → capability manifest (interop advertisement).
//! - `eval compare` — result-set comparison for the eval loop (reads stdin JSON).

use clap::{Parser, Subcommand};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::{fs, io};

use warble::{BindingFile, ComponentFile, ProfileFile};
use warble_claude_code::{
    build_manifest, emit_claude_code_with_models, ir::WarbleIr, parse_envelope,
    render_envelope_to_html, ModelConfig, RenderFlavor, RenderOptions,
};
use warble_eval_compare::{compare, CompareRequest, CompareResult};
use warble_eval_runner::{
    build_candidate_yaml, candidates_header, format_ablation, format_gate, format_pareto,
    run_ablation, run_eval, run_gate, stamp_context_version, verify_context, AblationConfig,
    CaptureInput, Freshness, Report, RunConfig,
};

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
    },
    /// Dispatch a compiled IR into Claude Code agent runtime files.
    Dispatch {
        ir: PathBuf,
        /// Target runtime (claude-code:headless | claude-code:interactive).
        #[arg(long, default_value = "claude-code:headless")]
        target: String,
        #[arg(long)]
        out: PathBuf,
        /// Render flavor for render-contract components (programmatic | prompt).
        #[arg(long = "render-flavor", default_value = "programmatic")]
        render_flavor: String,
        /// Tier→model config YAML (`tiers:` map + optional `driver:`). Takes precedence over the
        /// inline --strong/--cheap/--orchestrator flags when given.
        #[arg(long = "models-config")]
        models_config: Option<PathBuf>,
        /// Model for the `strong` tier (inline tier→model binding; ignored if --models-config given).
        #[arg(long, default_value = "opus")]
        strong: String,
        /// Model for the `cheap` tier.
        #[arg(long, default_value = "haiku")]
        cheap: String,
        /// Model for the per-step-tier driver's routing loop.
        #[arg(long, default_value = "sonnet")]
        orchestrator: String,
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
    /// Eval utilities.
    #[command(subcommand)]
    Eval(EvalCommand),
}

#[derive(Subcommand)]
enum EvalCommand {
    /// Compare an expected vs actual result set (reads a CompareRequest JSON from stdin).
    Compare,
    /// Replay golden questions through a dispatched agent under each tier→model binding and print a Pareto.
    Run {
        /// A queryable wren project (connection + data); agent files are installed here for the run.
        #[arg(long)]
        project: PathBuf,
        /// A dispatched agent output dir (contains `.claude/agents/…`).
        #[arg(long = "agent-dir")]
        agent_dir: PathBuf,
        /// Golden cases YAML.
        #[arg(long)]
        golden: PathBuf,
        /// Comma-separated model bindings to ablate.
        #[arg(long, default_value = "opus,haiku")]
        models: String,
        /// Write the full JSON report here.
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Per-step tier ablation (closed loop): re-dispatch the IR binding one named step at a time to
    /// each swept tier (others held at --base-tier), re-run the goldens, and print a per-step Pareto.
    Ablate {
        /// A queryable wren project (connection + data); agent files are installed here per dispatch.
        #[arg(long)]
        project: PathBuf,
        /// Compiled IR JSON (from `warble compile`). Re-dispatched per ablation point.
        #[arg(long)]
        ir: PathBuf,
        /// Golden cases YAML.
        #[arg(long)]
        golden: PathBuf,
        /// Dispatch target.
        #[arg(long, default_value = "claude-code:headless")]
        target: String,
        /// Optional tier→model config YAML (`tiers:` map). Defaults to strong/cheap/orchestrator.
        #[arg(long = "models-config")]
        models_config: Option<PathBuf>,
        /// Comma-separated tiers to try per step.
        #[arg(long, default_value = "cheap,strong")]
        sweep: String,
        /// Tier every non-ablated step is pinned to (the reference point).
        #[arg(long = "base-tier", default_value = "strong")]
        base_tier: String,
        /// A tier qualifies for the recommendation if within this accuracy of the baseline.
        #[arg(long = "accuracy-drop-tolerance", default_value = "0.0")]
        accuracy_drop_tolerance: f64,
        /// Write the full JSON report here.
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Check a golden's `context_version` against the bound project's current MDL SHA (stale
    /// detection). `--stamp` re-pins to the current SHA; `--reverify` re-runs the goldens on a stale
    /// MDL to surface which cases the change actually moved. Non-zero exit when stale.
    VerifyContext {
        /// Golden cases YAML (its `context_version` is the pin being checked).
        #[arg(long)]
        golden: PathBuf,
        /// The bound wren project whose MDL SHA is computed.
        #[arg(long)]
        project: PathBuf,
        /// Re-pin the golden's `context_version` to the current MDL SHA (accept the new MDL).
        #[arg(long)]
        stamp: bool,
        /// Treat a symbolic (unpinned) `context_version` as a failure too.
        #[arg(long)]
        strict: bool,
        /// On stale, re-run the goldens through this dispatched agent dir to surface the diff.
        #[arg(long = "agent-dir")]
        agent_dir: Option<PathBuf>,
        /// Model bindings for `--reverify` (comma-separated).
        #[arg(long, default_value = "haiku")]
        models: String,
        /// Re-run the goldens when stale (requires --agent-dir).
        #[arg(long)]
        reverify: bool,
    },
    /// Capture one confirmed run into a candidate golden case (local hook; NOT auto-accepted).
    Capture {
        /// The question that was answered.
        #[arg(long)]
        question: String,
        /// A stable case id for the golden.
        #[arg(long)]
        id: String,
        /// The captured result: a file with the agent's final text / `claude … --output-format json`
        /// envelope / a bare `{columns,rows}` object, or `-` for stdin.
        #[arg(long, default_value = "-")]
        result: String,
        /// Result comparison mode: scalar | set | ordered.
        #[arg(long = "match", default_value = "set")]
        match_mode: String,
        /// Numeric tolerance for the expected result.
        #[arg(long, default_value = "0.01")]
        tolerance: f64,
        /// Comma-separated tags.
        #[arg(long, default_value = "")]
        tags: String,
        /// The context version the result was confirmed against (used in a new candidates file header).
        #[arg(long = "context-version")]
        context_version: Option<String>,
        /// Dataset label (used in a new candidates file header).
        #[arg(long)]
        dataset: Option<String>,
        /// Append the candidate to this candidates file (created golden-shaped if absent). Omit for stdout.
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// CI gate (G4): fail (non-zero exit) if a candidate report regresses vs a baseline report.
    Gate {
        /// Baseline report JSON (a committed `warble eval run --out`).
        #[arg(long)]
        baseline: PathBuf,
        /// Candidate report JSON (the PR's `warble eval run --out`).
        #[arg(long)]
        report: PathBuf,
        /// A metric regresses only when it drops more than this below baseline.
        #[arg(long, default_value = "0.0")]
        tolerance: f64,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Compile { project_dir, out } => run_compile(&project_dir, &out),
        Command::Dispatch {
            ir,
            target,
            out,
            render_flavor,
            models_config,
            strong,
            cheap,
            orchestrator,
        } => run_dispatch(
            &ir,
            &target,
            &out,
            &render_flavor,
            models_config.as_deref(),
            strong,
            cheap,
            orchestrator,
        ),
        Command::Render { input, out, title } => run_render(&input, &out, title.as_deref()),
        Command::Manifest { ir, out } => run_manifest(&ir, out.as_deref()),
        Command::Eval(EvalCommand::Compare) => return run_eval_compare(),
        Command::Eval(EvalCommand::Capture {
            question,
            id,
            result,
            match_mode,
            tolerance,
            tags,
            context_version,
            dataset,
            out,
        }) => run_eval_capture(
            &question,
            &id,
            &result,
            &match_mode,
            tolerance,
            &tags,
            context_version.as_deref(),
            dataset.as_deref(),
            out.as_deref(),
        ),
        Command::Eval(EvalCommand::Gate {
            baseline,
            report,
            tolerance,
        }) => return run_eval_gate(&baseline, &report, tolerance),
        Command::Eval(EvalCommand::VerifyContext {
            golden,
            project,
            stamp,
            strict,
            agent_dir,
            models,
            reverify,
        }) => {
            return run_eval_verify_context(
                &golden,
                &project,
                stamp,
                strict,
                agent_dir.as_deref(),
                &models,
                reverify,
            )
        }
        Command::Eval(EvalCommand::Run {
            project,
            agent_dir,
            golden,
            models,
            out,
        }) => run_eval_run(&project, &agent_dir, &golden, &models, out.as_deref()),
        Command::Eval(EvalCommand::Ablate {
            project,
            ir,
            golden,
            target,
            models_config,
            sweep,
            base_tier,
            accuracy_drop_tolerance,
            out,
        }) => run_eval_ablate(
            &project,
            &ir,
            &golden,
            &target,
            models_config.as_deref(),
            &sweep,
            &base_tier,
            accuracy_drop_tolerance,
            out.as_deref(),
        ),
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

fn run_compile(project_dir: &Path, out: &Path) -> Result<(), String> {
    let profile_path = project_dir.join("profile.yml");
    let profile_yaml = read_file(&profile_path)?;
    let profile: ProfileFile = serde_yaml::from_str(&profile_yaml)
        .map_err(|e| format!("failed to parse {}: {e}", profile_path.display()))?;

    let binding_path = project_dir.join(&profile.context.project);
    let binding_yaml = read_file(&binding_path)?;
    let binding: BindingFile = serde_yaml::from_str(&binding_yaml)
        .map_err(|e| format!("failed to parse {}: {e}", binding_path.display()))?;

    let resolved_project_path = project_dir.join(&binding.project);
    let project_precondition_ok =
        resolved_project_path.is_dir() && resolved_project_path.join("wren_project.yml").is_file();

    let mut components: HashMap<String, ComponentFile> = HashMap::new();
    let mut step_contents: HashMap<String, HashMap<String, String>> = HashMap::new();

    for mount in &profile.components {
        let component_dir = project_dir.join("components").join(&mount.use_id);
        let component_path = component_dir.join("component.yml");
        let component_yaml = read_file(&component_path)?;
        let component: ComponentFile = serde_yaml::from_str(&component_yaml)
            .map_err(|e| format!("failed to parse {}: {e}", component_path.display()))?;

        let mut steps: HashMap<String, String> = HashMap::new();
        for step in &component.llm_steps {
            let step_path = component_dir.join(&step.prompt_ref);
            let content = read_file(&step_path)?;
            steps.insert(step.name.clone(), content);
        }
        step_contents.insert(component.id.clone(), steps);
        components.insert(component.id.clone(), component);
    }

    let ir = warble::compile(
        &profile,
        &components,
        &binding.project,
        project_precondition_ok,
        &step_contents,
    )
    .map_err(|e| e.to_string())?;

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
) -> Result<(), String> {
    let flavor = RenderFlavor::parse(render_flavor).ok_or_else(|| {
        format!("unknown --render-flavor '{render_flavor}' (expected: programmatic, prompt)")
    })?;
    // A --models-config YAML wins; otherwise build a two-tier config from the inline flags.
    let models = match models_config {
        Some(path) => ModelConfig::from_yaml(&read_file(path)?).map_err(|e| e.to_string())?,
        None => ModelConfig::from_flags(strong, cheap, orchestrator),
    };
    let ir = load_ir(ir_path)?;
    emit_claude_code_with_models(&ir, out, target, flavor, &models).map_err(|e| e.to_string())
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

// --- eval compare ---------------------------------------------------------------------------------

fn run_eval_compare() -> ExitCode {
    let mut input = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut input) {
        eprintln!("{}", compare_error(format!("failed to read stdin: {e}")));
        return ExitCode::FAILURE;
    }
    match serde_json::from_str::<CompareRequest>(&input) {
        Ok(request) => {
            let result = compare(&request);
            println!(
                "{}",
                serde_json::to_string(&result).expect("result serializes")
            );
            if result.pass {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(e) => {
            eprintln!("{}", compare_error(format!("invalid input JSON: {e}")));
            ExitCode::FAILURE
        }
    }
}

fn compare_error(reason: String) -> String {
    serde_json::to_string(&CompareResult {
        pass: false,
        reason,
    })
    .expect("result serializes")
}

// --- eval capture ---------------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn run_eval_capture(
    question: &str,
    id: &str,
    result: &str,
    match_mode: &str,
    tolerance: f64,
    tags: &str,
    context_version: Option<&str>,
    dataset: Option<&str>,
    out: Option<&Path>,
) -> Result<(), String> {
    let raw = read_input(result)?;
    let result_text = unwrap_cli_result(&raw);
    let tags: Vec<String> = tags
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let input = CaptureInput {
        id,
        question,
        match_mode,
        numeric_tolerance: tolerance,
        tags,
        result_text: &result_text,
    };
    let block = build_candidate_yaml(&input)?;

    match out {
        Some(path) => {
            // Golden-shaped candidates file: write the header on first creation, else append the case.
            let body = if path.exists() {
                let existing = read_file(path)?;
                format!("{existing}{block}")
            } else {
                format!("{}{block}", candidates_header(dataset, context_version))
            };
            fs::write(path, body)
                .map_err(|e| format!("failed to write {}: {e}", path.display()))?;
            eprintln!(
                "warble eval capture: candidate '{id}' → {} (review, then move into the golden set)",
                path.display()
            );
            Ok(())
        }
        None => {
            print!("{}{block}", candidates_header(dataset, context_version));
            Ok(())
        }
    }
}

// --- eval gate ------------------------------------------------------------------------------------

/// Gate a candidate report against a baseline; non-zero exit on regression (the G4 hard line).
fn run_eval_gate(baseline: &Path, report: &Path, tolerance: f64) -> ExitCode {
    let load = |path: &Path| -> Result<Report, String> {
        let raw = read_file(path)?;
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))
    };
    let (base, cur) = match (load(baseline), load(report)) {
        (Ok(b), Ok(c)) => (b, c),
        (Err(e), _) | (_, Err(e)) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };
    let result = run_gate(&base, &cur, tolerance);
    print!("{}", format_gate(&result));
    if result.passed {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

// --- eval verify-context --------------------------------------------------------------------------

/// Check the golden's pin against the current MDL SHA; optionally stamp or reverify. Non-zero exit
/// when stale (or unpinned under --strict).
#[allow(clippy::too_many_arguments)]
fn run_eval_verify_context(
    golden: &Path,
    project: &Path,
    stamp: bool,
    strict: bool,
    agent_dir: Option<&Path>,
    models: &str,
    reverify: bool,
) -> ExitCode {
    let golden_text = match read_file(golden) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };
    let meta: serde_yaml::Value = match serde_yaml::from_str(&golden_text) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("error: parse golden: {e}");
            return ExitCode::FAILURE;
        }
    };
    let context_version = meta
        .get("context_version")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let dataset = meta
        .get("dataset")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let result = match verify_context(context_version.as_deref(), project) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!("\n=== Warble eval — context version check ===");
    println!("golden:      {}", golden.display());
    println!("current MDL: {}", result.current_sha);
    println!("freshness:   {:?} — {}", result.freshness, result.detail);

    // --stamp: re-pin to the current MDL SHA and exit clean (an explicit "accept this MDL").
    if stamp {
        match stamp_context_version(&golden_text, &result.current_sha, dataset.as_deref()) {
            Ok(updated) => {
                if let Err(e) = fs::write(golden, updated) {
                    eprintln!("error: write {}: {e}", golden.display());
                    return ExitCode::FAILURE;
                }
                println!("stamped: context_version re-pinned to current MDL SHA.");
                return ExitCode::SUCCESS;
            }
            Err(e) => {
                eprintln!("error: {e}");
                return ExitCode::FAILURE;
            }
        }
    }

    let is_failure = matches!(result.freshness, Freshness::Stale)
        || (strict && matches!(result.freshness, Freshness::Unpinned));

    // --reverify: on a stale MDL, re-run the goldens to show which cases the change actually moved
    // (a case that now fails against its pinned expected is a candidate for re-confirmation/retirement).
    if is_failure && reverify {
        match agent_dir {
            Some(dir) => {
                println!("\nreverify: re-running goldens against the changed MDL …");
                let cfg = RunConfig {
                    project: project.to_path_buf(),
                    agent_dir: dir.to_path_buf(),
                    golden_path: golden.to_path_buf(),
                    models: models.split(',').map(|s| s.trim().to_string()).collect(),
                    out: None,
                };
                match run_eval(&cfg) {
                    Ok(report) => {
                        print!("{}", format_pareto(&report));
                        println!(
                            "\nreverify: cases that now FAIL against their pinned expected are the \
diff — re-confirm the new result or retire the golden."
                        );
                    }
                    Err(e) => {
                        eprintln!("error: reverify run failed: {e}");
                        return ExitCode::FAILURE;
                    }
                }
            }
            None => eprintln!("note: --reverify needs --agent-dir; skipping the re-run."),
        }
    }

    if is_failure {
        println!("\nCONTEXT STALE — re-verify the goldens, then --stamp to re-pin (or retire).");
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

// --- eval run -------------------------------------------------------------------------------------

fn run_eval_run(
    project: &Path,
    agent_dir: &Path,
    golden: &Path,
    models: &str,
    out: Option<&Path>,
) -> Result<(), String> {
    let cfg = RunConfig {
        project: project.to_path_buf(),
        agent_dir: agent_dir.to_path_buf(),
        golden_path: golden.to_path_buf(),
        models: models.split(',').map(|s| s.trim().to_string()).collect(),
        out: out.map(Path::to_path_buf),
    };
    let report = run_eval(&cfg)?;
    print!("{}", format_pareto(&report));
    if let Some(path) = out {
        let json = format!(
            "{}\n",
            serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
        );
        fs::write(path, json).map_err(|e| format!("failed to write {}: {e}", path.display()))?;
        println!("\nreport → {}", path.display());
    }
    Ok(())
}

// --- eval ablate ----------------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn run_eval_ablate(
    project: &Path,
    ir: &Path,
    golden: &Path,
    target: &str,
    models_config: Option<&Path>,
    sweep: &str,
    base_tier: &str,
    accuracy_drop_tolerance: f64,
    out: Option<&Path>,
) -> Result<(), String> {
    let cfg = AblationConfig {
        project: project.to_path_buf(),
        ir_path: ir.to_path_buf(),
        golden_path: golden.to_path_buf(),
        target: target.to_string(),
        models_config_path: models_config.map(Path::to_path_buf),
        sweep_tiers: sweep.split(',').map(|s| s.trim().to_string()).collect(),
        base_tier: base_tier.to_string(),
        accuracy_drop_tolerance,
        out: out.map(Path::to_path_buf),
    };
    let report = run_ablation(&cfg)?;
    print!("{}", format_ablation(&report));
    if let Some(path) = out {
        let json = format!(
            "{}\n",
            serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
        );
        fs::write(path, json).map_err(|e| format!("failed to write {}: {e}", path.display()))?;
        println!("\nreport → {}", path.display());
    }
    Ok(())
}

// --- helpers --------------------------------------------------------------------------------------

fn load_ir(path: &Path) -> Result<WarbleIr, String> {
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
