//! `warble` — the Warble CLI.
//!
//! One native binary across the CLI-target path:
//! - `compile`  — a Warble project → IR JSON (front-end compiler; host reads files, injects into
//!   the sans-IO `warble` core).
//! - `dispatch` — IR → a runtime target: Claude Code agent files (the `claude-code-cli` back-end)
//!   or a vercel bundle (the `vercel` back-end); both in Rust.
//! - `render`   — a captured agent envelope → deterministic `dashboard.html` (reference renderer).
//! - `manifest` — IR → capability manifest (interop advertisement).
//! - `eval compare` — result-set comparison for the eval loop (reads stdin JSON).

use clap::{Parser, Subcommand};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::{fs, io};

use warble_claude_code::{
    build_manifest, emit_claude_code_with_native_purpose, emit_codex_interactive,
    ir::{validate_ir_version, WarbleIr},
    parse_envelope, render_envelope_to_html, ContextInjection, ContextInjectionMode,
    HybridRealization, ModelConfig, NativeMcpDescriptor, NativePurpose, NativeSessionScope,
    RenderFlavor, RenderOptions,
};
use warble_cli::{
    blast_radius_for_project, check_compliance_ir_version, compile_project_to_ir_with_sources,
    default_component_sources, gate, ComponentSource, SourceKind,
};
use warble_eval_compare::{compare, CompareRequest, CompareResult};
use warble_eval_runner::{
    build_candidate_yaml, candidates_header, effective_record_answers, format_ablation,
    format_compliance, format_gate, format_monitor_report, format_pareto, run_ablation, run_eval,
    run_gate, score_compliance, score_monitor_pair, stamp_context_version, verify_context,
    AblationConfig, Backend, CaptureInput, CaseFilter, ComplianceIr, ComplianceTrace, Freshness,
    Report, RunConfig,
};
use warble_mdl_context::read_knowledge_rules;
use warble_vercel::{
    emit_vercel, known_target_names, parse_provider_fragments,
    validate_ir_version as validate_vercel_ir_version, ProviderFragment,
    TargetId as VercelTargetId, DEFAULT_TARGET,
};

mod mcp_serve;

#[derive(Parser)]
#[command(
    name = "warble",
    version,
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
        /// Target runtime (claude-code:headless | claude-code:interactive | codex:interactive |
        /// vercel | vercel:headless | vercel:interactive).
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
        /// (claude-code target only) Normalized context embedded in prompts (schema-only | schema+knowledge).
        #[arg(long = "context-injection", default_value = "schema-only")]
        context_injection: String,
        /// (claude-code target only) Bound project root used by the host adapter to load knowledge for schema+knowledge.
        /// Optional when the authored project path resolves relative to the IR file. This is a
        /// trusted override: the caller must ensure it is the project represented by the IR.
        #[arg(long = "context-project")]
        context_project: Option<PathBuf>,
        /// (native interactive targets only) Server-selected session purpose
        /// (analysis | setup | context_enrichment). Omitting this preserves the v1 enrichment
        /// launch contract for existing consumers.
        #[arg(long)]
        purpose: Option<String>,
        /// (native interactive targets with --purpose only) Immutable server-derived scope
        /// descriptor. Its canonical cwd must be exactly --out; Setup additionally carries its
        /// separate server-authorized bootstrap root, while bound projects carry the opaque
        /// binding identity, generation, and revision.
        #[arg(long = "native-scope")]
        native_scope: Option<PathBuf>,
        /// (native interactive targets with --purpose only) Exact server-derived MCP descriptor.
        /// Its opaque credential is materialized only into vendor-owned discovery configuration;
        /// it upgrades the native Sessions launch contract to v3.
        #[arg(long = "native-mcp")]
        native_mcp: Option<PathBuf>,
        /// (Claude Code file and vercel targets only) A provider fragment file (YAML) contributing
        /// domain capabilities + tool bindings on top of the base substrate profile — repeatable.
        /// The fragment's engine must match the selected target. A bare dispatch with no matching
        /// provider loud-fails any domain capability the base target does not realize, naming which
        /// one is unresolved. Rejected by codex:interactive, which realizes no fragment capability.
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
    /// Eval utilities.
    #[command(subcommand)]
    Eval(EvalCommand),
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

#[derive(Subcommand)]
enum EvalCommand {
    /// Compare an expected vs actual result set (reads a CompareRequest JSON from stdin).
    Compare,
    /// Replay golden questions through a dispatched agent under each tier→model binding and print a Pareto.
    Run {
        /// A queryable wren project (connection + data); agent files are installed here for the run.
        #[arg(long)]
        project: PathBuf,
        /// A dispatched agent output dir (contains `.claude/agents/…`). Required for
        /// `--backend claude-code-cli` (the default); mutually exclusive with `--ir`, which the
        /// other backends need instead.
        #[arg(long = "agent-dir")]
        agent_dir: Option<PathBuf>,
        /// Required for `--backend claude-agent-sdk` and `--backend codex-local`; unused by
        /// `claude-code-cli`. What it must point at differs per back-end:
        ///   - `claude-agent-sdk` dispatches directly from the IR (no pre-installed agent dir), so
        ///     pass the compiled IR JSON itself (from `warble compile`) here — it must compile to
        ///     a single-component IR, since the SDK's `dispatch` subcommand runs the question
        ///     against every component in the file, with no per-component filter.
        ///   - `codex-local` needs an external MCP server binding and a `--component` its own
        ///     `dispatch` CLI requires, neither of which fits the IR file itself — pass a small
        ///     JSON dispatch spec that names the IR, the component, and the MCP server instead
        ///     (`{ir_path, component, mcp: {command, ...}}`). Passing the compiled IR directly
        ///     here (as you would for `claude-agent-sdk`) fails loudly and names the shape it
        ///     wants instead. See the "codex-local" section of
        ///     `docs/site/docs/guides/evaluating.md` for the full shape and a worked example.
        #[arg(long)]
        ir: Option<PathBuf>,
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
        /// Also record each sample's actual result value, or its raw final output when parsing
        /// fails, so a flaky or malformed case remains diagnosable. Off by default — heavier to
        /// store.
        #[arg(long = "record-answers")]
        record_answers: bool,
        /// Which back-end/runtime to replay the goldens through — a different axis from the
        /// per-back-end capability `--target` some subcommands take (e.g. `eval ablate`'s
        /// `claude-code:headless`): this picks *which dispatcher ran at all*, not a capability
        /// posture within one. Only back-ends with a real eval-runner adapter are accepted; an
        /// unrecognized spelling is rejected by clap, and a recognized-but-unsupported one (every
        /// back-end but the default, today) fails loudly at run time naming the supported set.
        /// Defaults to `claude-code-cli` so an invocation that never mentions this flag keeps
        /// measuring exactly what it always measured.
        #[arg(long, value_enum, default_value_t = Backend::ClaudeCodeCli)]
        backend: Backend,
        /// Cap the back-end's own dispatch on a turn budget instead of its default. Only
        /// `--backend claude-agent-sdk` has a `--max-turns` knob to honor this with (its dispatch
        /// CLI already parses and forwards one); passing this with any other `--backend` fails
        /// loudly naming the mismatch, rather than being silently ignored. Also part of the trace
        /// cache key, so a capped run never hits an uncapped (or differently-capped) run's cache.
        #[arg(long = "max-turns")]
        max_turns: Option<u32>,
        /// A differentiated tier→model binding for this run, matching `warble dispatch
        /// --models-config` (a `tiers:` map YAML). Takes precedence over the inline
        /// --strong/--cheap/--orchestrator flags when given. Only `--backend claude-agent-sdk` can
        /// honor a differentiated binding (its dispatch CLI has tier flags); any other `--backend`
        /// fails loudly naming the mismatch. Passing this bypasses the `--models` sweep entirely
        /// and runs one pass with the resolved binding instead; omit it (and the three inline
        /// flags below) to keep the pre-existing `--models` sweep unchanged.
        #[arg(long = "models-config")]
        models_config: Option<PathBuf>,
        /// Model for the `strong` tier (inline differentiated binding; ignored if
        /// --models-config is given). A differentiated binding needs all three of
        /// --strong/--cheap/--orchestrator — passing only some of them fails loudly rather than
        /// silently defaulting the rest.
        #[arg(long)]
        strong: Option<String>,
        /// Model for the `cheap` tier. See --strong.
        #[arg(long)]
        cheap: Option<String>,
        /// Model for the per-step-tier driver's routing loop. See --strong.
        #[arg(long)]
        orchestrator: Option<String>,
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
        /// Concurrent cases per dispatched point (1 = serial); see `eval run --parallel`.
        #[arg(long, default_value_t = 1)]
        parallel: usize,
        /// Only ablate against goldens carrying one of these tags (comma-separated). Empty = all.
        #[arg(long, default_value = "")]
        tags: String,
        /// Sub-sample the (tag-filtered) goldens; see `eval run --sample`. Omit for a full run.
        #[arg(long)]
        sample: Option<String>,
        /// Bypass the trace cache: re-run every case at every point (see `eval run --no-cache`).
        #[arg(long = "no-cache")]
        no_cache: bool,
        /// Trace cache directory. Default: `<project>/.warble/eval-cache`.
        #[arg(long = "cache-dir")]
        cache_dir: Option<PathBuf>,
        /// Which back-end/runtime to run the ablation through — see `eval run --backend` for what
        /// this axis means and how it differs from `--target` above. The ablation loop re-dispatches
        /// IR via `claude-code-cli`'s own Rust emitter directly, so only that one back-end is
        /// supported here today; naming any other fails loudly at run time.
        #[arg(long, value_enum, default_value_t = Backend::ClaudeCodeCli)]
        backend: Backend,
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
        /// Assert both reports were recorded against this back-end before gating (a belt-and-braces
        /// check distinct from the unconditional baseline-vs-candidate backend check `run_gate`
        /// itself always performs — that one catches "baseline and candidate disagree with each
        /// other"; this one catches "both agree, but not on the back-end this CI job intended to
        /// gate"). Omit to skip this extra assertion and rely on the built-in cross-check alone.
        #[arg(long, value_enum)]
        backend: Option<Backend>,
    },
    /// Join clean + injected verdict runs with a fault-injection manifest and gate the live
    /// precision / recall / false-alarm report.
    MonitorReport {
        /// Fault-injection manifest YAML produced by the driftwood generator.
        #[arg(long)]
        manifest: PathBuf,
        /// Clean-baseline `eval run --record-answers --out` report JSON.
        #[arg(long = "clean-report")]
        clean_report: PathBuf,
        /// Injected `eval run --record-answers --out` report JSON.
        #[arg(long = "injected-report")]
        injected_report: PathBuf,
        /// Write the joined monitor report JSON here as well as printing it.
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Score a dispatched agent's tool-call trace against the IR's declared guardrails — a
    /// pure, deterministic, zero-LLM compliance check (exit 1 on any violation).
    Compliance {
        /// A trace JSON (`ComplianceTrace`): the component dispatched + its ordered tool-call events.
        #[arg(long)]
        trace: PathBuf,
        /// The compiled IR JSON the trace's component was dispatched from. Must carry a
        /// `warble_ir_version` this build understands — checked before scoring, same gate as
        /// `dispatch`/`manifest`.
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
            context_injection,
            context_project,
            purpose,
            native_scope,
            native_mcp,
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
            &context_injection,
            context_project.as_deref(),
            purpose.as_deref(),
            native_scope.as_deref(),
            native_mcp.as_deref(),
            &provider,
        ),
        Command::Render { input, out, title } => run_render(&input, &out, title.as_deref()),
        Command::Manifest { ir, out } => run_manifest(&ir, out.as_deref()),
        Command::McpServe { steps } => mcp_serve::run_mcp_serve(&steps),
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
            backend,
        }) => return run_eval_gate(&baseline, &report, tolerance, backend),
        Command::Eval(EvalCommand::MonitorReport {
            manifest,
            clean_report,
            injected_report,
            out,
        }) => {
            return run_eval_monitor_report(
                &manifest,
                &clean_report,
                &injected_report,
                out.as_deref(),
            )
        }
        Command::Eval(EvalCommand::Compliance { trace, ir, out }) => {
            return run_eval_compliance(&trace, &ir, out.as_deref())
        }
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
            ir,
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
            backend,
            max_turns,
            models_config,
            strong,
            cheap,
            orchestrator,
        }) => run_eval_run(
            &project,
            agent_dir.as_deref(),
            ir.as_deref(),
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
            backend,
            max_turns,
            models_config.as_deref(),
            strong,
            cheap,
            orchestrator,
        ),
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
            parallel,
            tags,
            sample,
            no_cache,
            cache_dir,
            backend,
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
            parallel,
            &tags,
            sample.as_deref(),
            no_cache,
            cache_dir,
            backend,
        ),
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
    context_injection: &str,
    context_project: Option<&Path>,
    purpose: Option<&str>,
    native_scope_path: Option<&Path>,
    native_mcp_path: Option<&Path>,
    provider_paths: &[PathBuf],
) -> Result<(), String> {
    let purpose = purpose
        .map(|value| {
            NativePurpose::parse(value).ok_or_else(|| {
                format!(
                    "unknown --purpose '{value}' (expected: analysis, setup, context_enrichment)"
                )
            })
        })
        .transpose()?;
    if purpose.is_some() && target != "claude-code:interactive" && target != "codex:interactive" {
        return Err("--purpose is supported only by native interactive targets".to_string());
    }
    let native_scope = match (purpose, native_scope_path) {
        (Some(_), Some(path)) => {
            Some(NativeSessionScope::from_file(path).map_err(|e| e.to_string())?)
        }
        (Some(_), None) => {
            return Err(
                "native Sessions purpose requires a server-derived --native-scope descriptor"
                    .to_string(),
            )
        }
        (None, Some(_)) => {
            return Err("--native-scope requires a native Sessions --purpose".to_string())
        }
        (None, None) => None,
    };
    let native_mcp = match (purpose, native_mcp_path) {
        (Some(_), Some(path)) => {
            Some(NativeMcpDescriptor::from_file(path).map_err(|e| e.to_string())?)
        }
        (Some(_), None) | (None, None) => None,
        (None, Some(_)) => {
            return Err("--native-mcp requires a native Sessions --purpose".to_string())
        }
    };
    if purpose.is_some() && context_project.is_some() {
        return Err(
            "--context-project is not supported for native Sessions purposes; the server-owned scope selects the project"
                .to_string(),
        );
    }
    // Validate shared enum-shaped knobs before target routing so no target silently accepts a typo.
    let context_mode = ContextInjectionMode::parse(context_injection).ok_or_else(|| {
        format!(
            "unknown --context-injection '{context_injection}' (expected: schema-only, schema+knowledge)"
        )
    })?;
    // The vercel target is a wholly separate back-end (its own IR type, no render-flavor/model-tier/
    // hybrid-realization knobs), so it branches off before any claude-code-specific flag parsing.
    if is_vercel_target(target) {
        return run_vercel_dispatch(ir_path, target, out, provider_paths);
    }
    if target == "codex:interactive" {
        // The claude-code target composes its domain capabilities from provider fragments, but
        // this one hands the session to Codex's own CLI and realizes no capability itself, so a
        // fragment here would silently do nothing. Say so rather than accept and ignore it.
        if !provider_paths.is_empty() {
            return Err("--provider is not supported for the codex:interactive target".to_string());
        }
        let ir = load_ir(ir_path)?;
        return emit_codex_interactive(&ir, out, purpose, native_scope, native_mcp)
            .map_err(|e| e.to_string());
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
    // Provider-specific project I/O stays in the CLI host adapter. The dispatcher receives only
    // normalized context and never probes an arbitrary path from IR. `schema-only` deliberately
    // performs no knowledge read. The current adapter reads Wren project knowledge; future OSI or
    // dbt adapters must preserve this same source-neutral dispatcher contract.
    let knowledge = if context_mode == ContextInjectionMode::SchemaWithKnowledge {
        let ir_dir = ir_path.parent().unwrap_or_else(|| Path::new("."));
        let project_dir = context_project
            .map(Path::to_path_buf)
            .unwrap_or_else(|| ir_dir.join(&ir.context_binding.project));
        if !project_dir.is_dir() {
            return Err(format!(
                "--context-injection schema+knowledge cannot resolve bound project {} from the IR location; pass --context-project <project-root>",
                project_dir.display()
            ));
        }
        let loaded = read_knowledge_rules(&project_dir).map_err(|e| {
            format!(
                "failed to read knowledge rules from bound project {}: {e}",
                project_dir.display()
            )
        })?;
        if loaded.used_legacy {
            eprintln!(
                "warning: bound project uses deprecated instructions.md; move it to knowledge/rules/*.md"
            );
        }
        Some(loaded.content)
    } else {
        None
    };
    let context = ContextInjection::from_ir(&ir, context_mode, knowledge);
    // Domain capabilities reach this back-end the same way they reach the vercel one: through
    // provider fragments supplied at dispatch, never hardcoded in the target.
    let providers = load_claude_code_provider_fragments(provider_paths)?;
    emit_claude_code_with_native_purpose(
        &ir,
        out,
        target,
        flavor,
        &models,
        hybrid,
        &context,
        &providers,
        purpose,
        native_scope,
        native_mcp,
    )
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
/// The claude-code back-end's fragment loader. Deliberately separate from the vercel one: the two
/// back-ends parse the same fragment format into their own types, the arrangement `binding-spec.md`
/// describes for the tier→model binding. Sharing a parser would mean sharing their capability types,
/// which are per-target by design.
fn load_claude_code_provider_fragments(
    paths: &[PathBuf],
) -> Result<Vec<warble_claude_code::ProviderFragment>, String> {
    let mut fragments = Vec::new();
    for path in paths {
        let raw = read_file(path)?;
        let parsed = warble_claude_code::parse_provider_fragments(&raw)
            .map_err(|e| format!("failed to parse provider fragment {}: {e}", path.display()))?;
        fragments.extend(parsed);
    }
    Ok(fragments)
}

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
fn run_eval_gate(
    baseline: &Path,
    report: &Path,
    tolerance: f64,
    backend: Option<Backend>,
) -> ExitCode {
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
    // Belt-and-braces: `run_gate` itself unconditionally fails when baseline/candidate disagree on
    // backend, but that says nothing about whether they're BOTH the backend this CI job actually
    // intended to gate. `--backend`, when given, asserts that explicitly before the diff even runs.
    if let Some(want) = backend {
        if base.backend != want || cur.backend != want {
            eprintln!(
                "error: --backend {want} requested, but baseline is '{}' and candidate is '{}'",
                base.backend, cur.backend
            );
            return ExitCode::FAILURE;
        }
    }
    let result = run_gate(&base, &cur, tolerance);
    print!("{}", format_gate(&result));
    if result.passed {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

// --- eval monitor-report -------------------------------------------------------------------------

fn run_eval_monitor_report(
    manifest_path: &Path,
    clean_path: &Path,
    injected_path: &Path,
    out: Option<&Path>,
) -> ExitCode {
    let load_report = |path: &Path| -> Result<Report, String> {
        let raw = read_file(path)?;
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))
    };
    let manifest = match read_file(manifest_path) {
        Ok(raw) => raw,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };
    let (clean, injected) = match (load_report(clean_path), load_report(injected_path)) {
        (Ok(clean), Ok(injected)) => (clean, injected),
        (Err(e), _) | (_, Err(e)) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };
    let report = match score_monitor_pair(&manifest, &clean, &injected) {
        Ok(report) => report,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };
    print!("{}", format_monitor_report(&report));
    if let Some(path) = out {
        let json = match serde_json::to_string_pretty(&report) {
            Ok(json) => format!("{json}\n"),
            Err(e) => {
                eprintln!("error: failed to serialize monitor report: {e}");
                return ExitCode::FAILURE;
            }
        };
        if let Err(e) = fs::write(path, json) {
            eprintln!("error: failed to write {}: {e}", path.display());
            return ExitCode::FAILURE;
        }
        println!("report → {}", path.display());
    }
    if report.passed {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

// --- eval compliance --------------------------------------------------------------------------------

/// Score a dispatched agent's tool-call trace against the IR's declared guardrails. Pure and
/// zero-LLM: this function does the I/O (read + parse), `score_compliance` does the (equally
/// zero-LLM) reasoning. Non-zero exit on any guardrail violation — usable as a CI gate.
///
/// Validates `warble_ir_version` on the raw JSON before ever deserializing into `ComplianceIr` —
/// see [`check_compliance_ir_version`] for why the check lives here rather than on that type.
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
    let ir_raw = match read_file(ir_path) {
        Ok(raw) => raw,
        Err(e) => {
            eprintln!("error: failed to read IR {}: {e}", ir_path.display());
            return ExitCode::FAILURE;
        }
    };
    if let Err(e) = check_compliance_ir_version(&ir_raw, ir_path) {
        eprintln!("error: {e}");
        return ExitCode::FAILURE;
    }
    let ir: ComplianceIr = match serde_json::from_str(&ir_raw).map_err(|e| format!("parse IR: {e}"))
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
                    agent_dir: Some(dir.to_path_buf()),
                    ir_path: None,
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
                    // `verify-context --reverify` has no `--backend` flag of its own (it's a
                    // diagnostic re-run of `eval run`, not a first-class eval invocation) — default
                    // to the reference back-end, matching this command's pre-existing behavior.
                    backend: Backend::default(),
                    // Same rationale as `backend` above: no `--max-turns` flag on this subcommand,
                    // so leave the back-end's own default turn budget in place.
                    max_turns: None,
                    // `verify-context --reverify` has no differentiated-binding flags of its own
                    // either — same rationale as `backend`/`max_turns` above.
                    tier_models: None,
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

/// Resolve `eval run`'s differentiated `--strong`/`--cheap`/`--orchestrator` (or
/// `--models-config`) binding, mirroring `warble dispatch`'s own precedence (`--models-config`
/// wins over the inline flags — see `run_dispatch`). Returns `None` when none of the four flags
/// were given, which keeps the pre-existing `--models` sweep behaving exactly as before (see
/// `RunConfig::tier_models`); a partial inline combination (e.g. only `--strong`) is an ambiguous
/// binding and fails loudly here, before `run_eval` ever validates it against the backend, rather
/// than silently filling in a default for the missing tier(s).
fn resolve_tier_models(
    models_config: Option<&Path>,
    strong: Option<String>,
    cheap: Option<String>,
    orchestrator: Option<String>,
) -> Result<Option<ModelConfig>, String> {
    if let Some(path) = models_config {
        return Ok(Some(
            ModelConfig::from_yaml(&read_file(path)?).map_err(|e| e.to_string())?,
        ));
    }
    match (strong, cheap, orchestrator) {
        (None, None, None) => Ok(None),
        (Some(strong), Some(cheap), Some(orchestrator)) => {
            Ok(Some(ModelConfig::from_flags(strong, cheap, orchestrator)))
        }
        (strong, cheap, orchestrator) => Err(format!(
            "a differentiated tier binding needs all three of --strong/--cheap/--orchestrator \
(or --models-config); got strong={strong:?}, cheap={cheap:?}, orchestrator={orchestrator:?} — \
pass all three, or omit all of them to keep the --models sweep"
        )),
    }
}

#[allow(clippy::too_many_arguments)]
fn run_eval_run(
    project: &Path,
    agent_dir: Option<&Path>,
    ir: Option<&Path>,
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
    backend: Backend,
    max_turns: Option<u32>,
    models_config: Option<&Path>,
    strong: Option<String>,
    cheap: Option<String>,
    orchestrator: Option<String>,
) -> Result<(), String> {
    // Repeated sampling exists to check reproducibility, so recording each sample's answer
    // (`--record-answers`) defaults on once `--samples` > 1 even without the explicit flag — an
    // explicit flag still works and `samples == 1` behavior is untouched. See
    // `effective_record_answers`'s doc comment for the full rationale.
    let record_answers = effective_record_answers(record_answers, samples);
    let tier_models = resolve_tier_models(models_config, strong, cheap, orchestrator)?;
    let cfg = RunConfig {
        project: project.to_path_buf(),
        agent_dir: agent_dir.map(Path::to_path_buf),
        ir_path: ir.map(Path::to_path_buf),
        golden_path: golden.to_path_buf(),
        models: models.split(',').map(|s| s.trim().to_string()).collect(),
        out: out.map(Path::to_path_buf),
        parallel,
        filter: CaseFilter::from_flags(tags, sample)?,
        no_cache,
        cache_dir,
        samples,
        record_answers,
        backend,
        max_turns,
        tier_models,
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
    parallel: usize,
    tags: &str,
    sample: Option<&str>,
    no_cache: bool,
    cache_dir: Option<PathBuf>,
    backend: Backend,
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
        backend,
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

/// Reads and parses an `ir.json` for the claude-code target, validating `warble_ir_version` right
/// here at parse time (via the dispatcher's own `validate_ir_version`, not a `cli`-local copy of
/// the constant) — so every subcommand that goes through this function, not just `dispatch`, is
/// gated. `emit_claude_code_with_realization` also validates on its own path (belt-and-braces for
/// direct callers of the dispatcher crate), so the check here is intentionally redundant for
/// `dispatch` but is what closes the gap for `manifest` and any future subcommand that reads an IR.
fn load_ir(path: &Path) -> Result<WarbleIr, String> {
    let raw = read_file(path)?;
    let ir: WarbleIr = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse IR {}: {e}", path.display()))?;
    validate_ir_version(&ir).map_err(|e| e.to_string())?;
    Ok(ir)
}

/// `emit_vercel` takes `warble_vercel`'s own `WarbleIr` type (distinct from
/// `warble_claude_code::ir::WarbleIr`, even though both deserialize the same IR JSON), so the
/// vercel dispatch path needs its own load function — validated the same way, via
/// `warble_vercel::validate_ir_version`, right at parse time.
fn load_vercel_ir(path: &Path) -> Result<warble_vercel::ir::WarbleIr, String> {
    let raw = read_file(path)?;
    let ir: warble_vercel::ir::WarbleIr = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse IR {}: {e}", path.display()))?;
    validate_vercel_ir_version(&ir).map_err(|e| e.to_string())?;
    Ok(ir)
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

#[cfg(test)]
mod resolve_tier_models_tests {
    use super::resolve_tier_models;

    /// No `--models-config` and none of the three inline flags: `eval run`'s pre-existing
    /// `--models` sweep must be untouched (AC2) — this is the signal `run_eval_run` reads to skip
    /// setting `RunConfig::tier_models` at all.
    #[test]
    fn no_flags_at_all_resolves_to_none() {
        let resolved = resolve_tier_models(None, None, None, None).expect("not an error");
        assert!(
            resolved.is_none(),
            "absent flags must preserve the --models sweep path"
        );
    }

    /// All three inline flags given (and no `--models-config`): the three distinct values must
    /// reach `ModelConfig` unchanged (AC1's CLI-reaching aspect).
    #[test]
    fn three_inline_flags_produce_a_config_with_the_three_distinct_values() {
        let resolved = resolve_tier_models(
            None,
            Some("sonnet".to_string()),
            Some("haiku".to_string()),
            Some("sonnet".to_string()),
        )
        .expect("three flags is a valid binding")
        .expect("three flags must resolve to Some");
        assert_eq!(resolved.require("strong").unwrap(), "sonnet");
        assert_eq!(resolved.require("cheap").unwrap(), "haiku");
        assert_eq!(resolved.require("orchestrator").unwrap(), "sonnet");
    }

    /// A partial inline combination (only `--strong`) is an ambiguous binding and must fail
    /// loudly, with an actionable message, before `run_eval` is ever reached (AC3's CLI-level
    /// aspect) — never silently default the missing tiers.
    #[test]
    fn partial_inline_flags_fail_loudly_with_an_actionable_message() {
        let err = resolve_tier_models(None, Some("sonnet".to_string()), None, None)
            .expect_err("a partial binding must be rejected");
        assert!(
            err.contains("--strong") && err.contains("--cheap") && err.contains("--orchestrator"),
            "error should name all three flags so the user knows what to add: {err}"
        );
    }

    /// `--models-config` wins over inline flags even when both are given (AC1's precedence
    /// aspect), mirroring `warble dispatch`'s own `run_dispatch` precedence.
    #[test]
    fn models_config_wins_over_inline_flags_even_when_both_given() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("models.yaml");
        std::fs::write(
            &path,
            "tiers:\n  strong: opus\n  cheap: haiku\n  orchestrator: sonnet\n",
        )
        .expect("write models.yaml");

        // Inline flags are also present, but must be ignored once --models-config is given.
        let resolved = resolve_tier_models(
            Some(path.as_path()),
            Some("ignored-strong".to_string()),
            Some("ignored-cheap".to_string()),
            Some("ignored-orchestrator".to_string()),
        )
        .expect("models-config is a valid binding")
        .expect("models-config must resolve to Some");
        assert_eq!(resolved.require("strong").unwrap(), "opus");
        assert_eq!(resolved.require("cheap").unwrap(), "haiku");
        assert_eq!(resolved.require("orchestrator").unwrap(), "sonnet");
    }
}
