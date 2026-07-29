//! `warble-eval` — Warble's eval CLI.
//!
//! A companion binary to `warble`, not part of the published crate/release channel: result-set
//! comparison, Pareto runs across tier→model bindings, per-step ablation, context-staleness
//! checks, candidate capture, CI regression gating, and compliance scoring against a dispatched
//! agent's tool-call trace.

use clap::{Parser, Subcommand};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::{fs, io};

use warble_eval_compare::{compare, CompareRequest, CompareResult};
use warble_eval_runner::{
    build_candidate_yaml, candidates_header, format_ablation, format_compliance, format_gate,
    format_pareto, run_ablation, run_eval, run_gate, score_compliance, stamp_context_version,
    verify_context, AblationConfig, CaptureInput, CaseFilter, ComplianceIr, ComplianceTrace,
    Freshness, Report, RunConfig,
};

#[derive(Parser)]
#[command(
    name = "warble-eval",
    about = "Warble eval utilities — result comparison, Pareto runs, ablation, compliance, gating."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
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
        /// Concurrent cases per binding (1 = serial). 4-8 is a good speedup; note that under
        /// contention the per-case latency column also measures queueing.
        #[arg(long, default_value_t = 1)]
        parallel: usize,
        /// Only run goldens carrying at least one of these tags (comma-separated). Empty = all.
        #[arg(long, default_value = "")]
        tags: String,
        /// Sub-sample the (tag-filtered) goldens for a smoke run: `N` (count), a fraction `0.2` /
        /// `20%`, or `per-tag[:K]` (K per tag; the smoke default). Omit for a full run.
        #[arg(long)]
        sample: Option<String>,
        /// Bypass the trace cache: re-run every case (new LLM calls) and refresh its cached result.
        /// Without this, cases whose `(case, agent, model, context)` is unchanged are re-scored from
        /// cache with 0 LLM calls, so changing only a golden's `expected` re-scores in seconds.
        #[arg(long = "no-cache")]
        no_cache: bool,
        /// Trace cache directory. Default: `<project>/.warble/eval-cache`.
        #[arg(long = "cache-dir")]
        cache_dir: Option<PathBuf>,
        /// Repeated samples per case (pass-rate methodology). `1` (the default) is today's
        /// single-run behavior; `>1` distinguishes a genuinely flaky case from run-to-run noise.
        #[arg(long, default_value_t = 1)]
        samples: usize,
        /// Also record each sample's actual result-set value (not just pass/fail), so a flaky
        /// case's report shows a distinct-answer distribution. Off by default — heavier to store.
        #[arg(long = "record-answers")]
        record_answers: bool,
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
        /// Concurrent cases per dispatched point (1 = serial); see `run --parallel`.
        #[arg(long, default_value_t = 1)]
        parallel: usize,
        /// Only ablate against goldens carrying one of these tags (comma-separated). Empty = all.
        #[arg(long, default_value = "")]
        tags: String,
        /// Sub-sample the (tag-filtered) goldens; see `run --sample`. Omit for a full run.
        #[arg(long)]
        sample: Option<String>,
        /// Bypass the trace cache: re-run every case at every point (see `run --no-cache`).
        #[arg(long = "no-cache")]
        no_cache: bool,
        /// Trace cache directory. Default: `<project>/.warble/eval-cache`.
        #[arg(long = "cache-dir")]
        cache_dir: Option<PathBuf>,
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
        /// Baseline report JSON (a committed `warble-eval run --out`).
        #[arg(long)]
        baseline: PathBuf,
        /// Candidate report JSON (the PR's `warble-eval run --out`).
        #[arg(long)]
        report: PathBuf,
        /// A metric regresses only when it drops more than this below baseline.
        #[arg(long, default_value = "0.0")]
        tolerance: f64,
    },
    /// Score a dispatched agent's tool-call trace against the IR's declared guardrails — a
    /// pure, deterministic, zero-LLM compliance check (exit 1 on any violation).
    Compliance {
        /// A trace JSON (`ComplianceTrace`): the component dispatched + its ordered tool-call events.
        #[arg(long)]
        trace: PathBuf,
        /// The compiled IR JSON the trace's component was dispatched from.
        #[arg(long)]
        ir: PathBuf,
        /// Write the compliance report JSON here as well as printing it. Omit for print-only.
        #[arg(long)]
        out: Option<PathBuf>,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Compare => return run_eval_compare(),
        Command::Capture {
            question,
            id,
            result,
            match_mode,
            tolerance,
            tags,
            context_version,
            dataset,
            out,
        } => run_eval_capture(
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
        Command::Gate {
            baseline,
            report,
            tolerance,
        } => return run_eval_gate(&baseline, &report, tolerance),
        Command::Compliance { trace, ir, out } => {
            return run_eval_compliance(&trace, &ir, out.as_deref())
        }
        Command::VerifyContext {
            golden,
            project,
            stamp,
            strict,
            agent_dir,
            models,
            reverify,
        } => {
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
        Command::Run {
            project,
            agent_dir,
            golden,
            models,
            out,
            parallel,
            tags,
            sample,
            no_cache,
            cache_dir,
            samples,
            record_answers,
        } => run_eval_run(
            &project,
            &agent_dir,
            &golden,
            &models,
            out.as_deref(),
            parallel,
            &tags,
            sample.as_deref(),
            no_cache,
            cache_dir,
            samples,
            record_answers,
        ),
        Command::Ablate {
            project,
            ir,
            golden,
            target,
            models_config,
            sweep,
            base_tier,
            accuracy_drop_tolerance,
            out,
            parallel,
            tags,
            sample,
            no_cache,
            cache_dir,
        } => run_eval_ablate(
            &project,
            &ir,
            &golden,
            &target,
            models_config.as_deref(),
            &sweep,
            &base_tier,
            accuracy_drop_tolerance,
            out.as_deref(),
            parallel,
            &tags,
            sample.as_deref(),
            no_cache,
            cache_dir,
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

// --- compare ----------------------------------------------------------------------------------

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

// --- capture ----------------------------------------------------------------------------------

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
                "warble-eval capture: candidate '{id}' → {} (review, then move into the golden set)",
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

// --- gate -------------------------------------------------------------------------------------

/// Gate a candidate report against a baseline; non-zero exit on regression (the G4 hard line).
fn run_eval_gate(baseline: &Path, report: &Path, tolerance: f64) -> ExitCode {
    let load = |path: &Path| -> Result<Report, String> {
        let raw = read_file(path)?;
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))
    };
    let (mut base, mut cur) = match (load(baseline), load(report)) {
        (Ok(b), Ok(c)) => (b, c),
        (Err(e), _) | (_, Err(e)) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };
    // Either report may predate repeated sampling (a `samples == 0` sentinel per case); migrate
    // both forward so the pass-rate-based gate logic always has real samples/pass_rate to compare.
    base.backfill_legacy();
    cur.backfill_legacy();
    let result = run_gate(&base, &cur, tolerance);
    print!("{}", format_gate(&result));
    if result.passed {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

// --- compliance ---------------------------------------------------------------------------------

/// Score a dispatched agent's tool-call trace against the IR's declared guardrails. Pure and
/// zero-LLM: this function does the I/O (read + parse), `score_compliance` does the (equally
/// zero-LLM) reasoning. Non-zero exit on any guardrail violation — usable as a CI gate.
fn run_eval_compliance(trace_path: &Path, ir_path: &Path, out: Option<&Path>) -> ExitCode {
    let trace: ComplianceTrace = match read_file(trace_path)
        .and_then(|raw| serde_json::from_str(&raw).map_err(|e| format!("parse trace: {e}")))
    {
        Ok(t) => t,
        Err(e) => {
            eprintln!("error: failed to read trace {}: {e}", trace_path.display());
            return ExitCode::FAILURE;
        }
    };
    let ir: ComplianceIr = match read_file(ir_path)
        .and_then(|raw| serde_json::from_str(&raw).map_err(|e| format!("parse IR: {e}")))
    {
        Ok(i) => i,
        Err(e) => {
            eprintln!("error: failed to read IR {}: {e}", ir_path.display());
            return ExitCode::FAILURE;
        }
    };

    let report = score_compliance(&trace, &ir);
    print!("{}", format_compliance(&report));

    if let Some(out_path) = out {
        match serde_json::to_string_pretty(&report) {
            Ok(json) => {
                if let Err(e) = fs::write(out_path, json) {
                    eprintln!("error: failed to write {}: {e}", out_path.display());
                    return ExitCode::FAILURE;
                }
                println!("report → {}", out_path.display());
            }
            Err(e) => {
                eprintln!("error: failed to serialize report: {e}");
                return ExitCode::FAILURE;
            }
        }
    }

    if report.compliant {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

// --- verify-context -----------------------------------------------------------------------------

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
                    // Diagnostic re-run; serial keeps its latency column comparable to the
                    // original (parallel runs measure queueing too).
                    parallel: 1,
                    // Reverify surfaces which cases the MDL change moved — always the full set.
                    filter: CaseFilter::default(),
                    // Must actually re-run the agent against the changed MDL to see the diff, so
                    // bypass the cache (the new context_sha would miss anyway; this is explicit).
                    no_cache: true,
                    cache_dir: None,
                    // A diagnostic re-run — single-sample is all this needs.
                    samples: 1,
                    record_answers: false,
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

// --- run --------------------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn run_eval_run(
    project: &Path,
    agent_dir: &Path,
    golden: &Path,
    models: &str,
    out: Option<&Path>,
    parallel: usize,
    tags: &str,
    sample: Option<&str>,
    no_cache: bool,
    cache_dir: Option<PathBuf>,
    samples: usize,
    record_answers: bool,
) -> Result<(), String> {
    let cfg = RunConfig {
        project: project.to_path_buf(),
        agent_dir: agent_dir.to_path_buf(),
        golden_path: golden.to_path_buf(),
        models: models.split(',').map(|s| s.trim().to_string()).collect(),
        out: out.map(Path::to_path_buf),
        parallel,
        filter: CaseFilter::from_flags(tags, sample)?,
        no_cache,
        cache_dir,
        samples,
        record_answers,
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

// --- ablate -----------------------------------------------------------------------------------

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
    parallel: usize,
    tags: &str,
    sample: Option<&str>,
    no_cache: bool,
    cache_dir: Option<PathBuf>,
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
        parallel,
        filter: CaseFilter::from_flags(tags, sample)?,
        no_cache,
        cache_dir,
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

// --- helpers ------------------------------------------------------------------------------------

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

/// Unwrap `claude -p --output-format json`, whose top-level object carries the agent's final text
/// under `.result`. Otherwise pass the input through unchanged.
fn unwrap_cli_result(raw: &str) -> String {
    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(serde_json::Value::String(result)) = map.get("result") {
            return result.clone();
        }
    }
    raw.to_string()
}
