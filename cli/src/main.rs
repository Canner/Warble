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
    build_manifest, emit_claude_code, ir::WarbleIr, parse_envelope, render_envelope_to_html,
    RenderFlavor, RenderOptions,
};
use warble_eval_compare::{compare, CompareRequest, CompareResult};
use warble_eval_runner::{format_pareto, run_eval, RunConfig};

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
        } => run_dispatch(&ir, &target, &out, &render_flavor),
        Command::Render { input, out, title } => run_render(&input, &out, title.as_deref()),
        Command::Manifest { ir, out } => run_manifest(&ir, out.as_deref()),
        Command::Eval(EvalCommand::Compare) => return run_eval_compare(),
        Command::Eval(EvalCommand::Run {
            project,
            agent_dir,
            golden,
            models,
            out,
        }) => run_eval_run(&project, &agent_dir, &golden, &models, out.as_deref()),
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

fn run_dispatch(
    ir_path: &Path,
    target: &str,
    out: &Path,
    render_flavor: &str,
) -> Result<(), String> {
    let flavor = RenderFlavor::parse(render_flavor).ok_or_else(|| {
        format!("unknown --render-flavor '{render_flavor}' (expected: programmatic, prompt)")
    })?;
    let ir = load_ir(ir_path)?;
    emit_claude_code(&ir, out, target, flavor).map_err(|e| e.to_string())
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
