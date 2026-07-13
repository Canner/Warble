//! Warble eval runner.
//!
//! Replays golden questions through a dispatched Warble agent under several tier→model bindings,
//! scores each result set with `warble-eval-compare`, and produces a Pareto report
//! (accuracy vs cost vs latency). The whole-model binding is runtime-injected via `claude --model`
//! — same IR/agent, different binding, which is exactly what [`run_eval`] varies. The queryable
//! project (connection + data) is injected via `project`; the agent files are installed into
//! `<project>/.claude` for the run and removed afterward.
//!
//! On top of that measurement, the **closed loop** (roadmap Phase 1.4) lives in sibling modules:
//! - [`ablation`] — per-step tier ablation: re-dispatch the IR binding one named step at a time.
//! - [`gate`] — CI gate: fail on accuracy regression vs a committed baseline.
//! - [`context`] — MDL-version reverify: flag goldens whose pinned `context_version` went stale.
//! - [`capture`] — capture-confirmed: mint a candidate golden from one confirmed run.
//!
//! Pure helpers (`extract_result`, `aggregate`, `format_pareto`, golden parsing) and the closed-loop
//! modules' logic are unit-tested; `run_eval` / `run_ablation` additionally spawn `claude` and are
//! exercised end-to-end against a live project.

use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;
use warble_eval_compare::{compare, CompareRequest, MatchMode, Table, Tolerance};

mod ablation;
mod cache;
mod capture;
mod context;
mod filter;
mod gate;

pub use ablation::{
    format_ablation, run_ablation, AblationConfig, AblationPoint, AblationReport,
    StepRecommendation,
};
pub use cache::{rescore, CaseKey, Trace, TraceStore};
pub use capture::{build_candidate_yaml, candidates_header, CaptureInput};
pub use context::{
    classify, compute_mdl_sha, parse_context_version, stamp_context_version, verify_context,
    Freshness, VerifyResult,
};
pub use filter::{select_cases, CaseFilter, Sample, Selection};
pub use gate::{format_gate, run_gate, GateResult, Regression};

/// A golden eval file: dataset metadata + cases with expected result sets.
#[derive(Debug, serde::Deserialize)]
pub struct Golden {
    #[serde(default)]
    pub dataset: Option<String>,
    #[serde(default)]
    pub context_version: Option<String>,
    pub cases: Vec<GoldenCase>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct GoldenCase {
    pub id: String,
    pub question: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(rename = "match")]
    pub match_mode: MatchMode,
    #[serde(default)]
    pub tolerance: Tolerance,
    pub expected: Table,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct CaseResult {
    pub id: String,
    pub tags: Vec<String>,
    pub pass: bool,
    pub reason: String,
    pub cost: f64,
    pub latency_ms: u64,
    /// Conversation turns for this case (`num_turns`) — the round-trip diagnostic (eval-speed §1/§4).
    /// A cache hit carries the turns of the run that produced the cached result.
    #[serde(default)]
    pub turns: u64,
    /// True when this result was served from the trace cache (re-scored, not re-run — 0 LLM calls).
    /// Surfaced per-case and aggregated so a cached/re-scored run is never mistaken for a fresh one.
    #[serde(default)]
    pub cache_hit: bool,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct TagStat {
    pub pass: u32,
    pub n: u32,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct ConfigReport {
    pub model: String,
    pub n: usize,
    pub accuracy: f64,
    pub cost_total_usd: f64,
    pub latency_ms_avg: u64,
    /// Average conversation turns per case (`num_turns`) — a context-quality diagnostic (eval-speed
    /// §1: fewer turns ⇒ less exploration ⇒ cheaper). `0` in a pre-P4 report.
    #[serde(default)]
    pub turns_avg: u64,
    /// Cases served from the trace cache (re-scored, 0 LLM) vs freshly re-run this invocation.
    /// `cache_misses` is the count of actual LLM calls made; both `0` in a pre-P4 report.
    #[serde(default)]
    pub cache_hits: usize,
    #[serde(default)]
    pub cache_misses: usize,
    pub by_tag: BTreeMap<String, TagStat>,
    pub cases: Vec<CaseResult>,
}

/// A full eval report (one config per tier→model binding). Serialized by `warble eval run --out`
/// and consumed as the baseline / candidate by `warble eval gate`.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct Report {
    pub dataset: Option<String>,
    pub context_version: Option<String>,
    /// Concurrency the cases ran at (1 = serial). Recorded because parallelism can inflate
    /// per-case latency (queueing), so latency columns are only comparable at equal levels.
    #[serde(default = "default_parallel")]
    pub parallel: usize,
    /// Golden cases scored vs the golden file's total. `selected_cases < total_cases` means a
    /// `--tags`/`--sample` subset (a smoke run) — recorded so a partial run is never mistaken for
    /// a full one and `eval gate` can see the comparison was over fewer cases (no silent caps).
    /// Both 0 in a pre-P3 report (the field was absent).
    #[serde(default)]
    pub selected_cases: usize,
    #[serde(default)]
    pub total_cases: usize,
    pub configs: Vec<ConfigReport>,
}

fn default_parallel() -> usize {
    1
}

pub struct RunConfig {
    pub project: PathBuf,
    pub agent_dir: PathBuf,
    pub golden_path: PathBuf,
    pub models: Vec<String>,
    pub out: Option<PathBuf>,
    /// Concurrent cases per binding (1 = serial). Under contention the per-case latency
    /// column measures queueing too, so the report records the level it ran at.
    pub parallel: usize,
    /// Golden case selection (`--tags` / `--sample`). Default = full run (every case).
    pub filter: CaseFilter,
    /// Bypass the trace cache (`--no-cache`): re-run every case and refresh its cached result
    /// instead of reusing a content-addressed hit.
    pub no_cache: bool,
    /// Where per-case traces are read/written. `None` = `<project>/.warble/eval-cache`.
    pub cache_dir: Option<PathBuf>,
}

/// The per-run inputs that key the trace cache, threaded through [`run_cases`]/`run_case` so a case
/// can be re-scored from cache instead of re-run. `model` is the whole-run binding (run path) or
/// [`cache::FRONTMATTER_MODEL`] (ablation path); `agent_sha`/`context_sha` are content SHAs of the
/// dispatched agent dir and the bound MDL. A `disabled` store makes every case a miss (`--no-cache`
/// or when the SHAs can't be computed).
pub(crate) struct CaseCtx<'a> {
    pub model: &'a str,
    pub agent_sha: &'a str,
    pub context_sha: &'a str,
    pub context_version: Option<&'a str>,
    pub store: &'a TraceStore,
}

impl CaseCtx<'_> {
    /// The `--model` override to pass `claude`, or `None` on the ablation/frontmatter path (where
    /// the tier→model binding is baked into the emitted agent and must not be overridden).
    fn model_override(&self) -> Option<&str> {
        (self.model != cache::FRONTMATTER_MODEL).then_some(self.model)
    }
}

// --- pure helpers ---------------------------------------------------------------------------------

/// Extract the `{columns, rows}` object from an agent's free-form final text: prefer a fenced code
/// block, else the whole text; then take the first `{` … last `}` and parse it as a table.
pub fn extract_result(text: &str) -> Option<Table> {
    serde_json::from_value(extract_result_json(text)?).ok()
}

/// Like [`extract_result`] but returns the raw `{columns, rows}` JSON object (kept serializable so
/// `warble eval capture` can embed it verbatim as a golden's `expected`).
pub fn extract_result_json(text: &str) -> Option<serde_json::Value> {
    let candidate = strip_fence(text);
    let start = candidate.find('{')?;
    let end = candidate.rfind('}')?;
    if end <= start {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(&candidate[start..=end]).ok()?;
    // Only accept objects that actually carry a `rows` array (matches the JS guard).
    if !value.get("rows").map(|r| r.is_array()).unwrap_or(false) {
        return None;
    }
    Some(value)
}

/// Return the content of the first ```/```json fenced block, or the whole text if none.
fn strip_fence(text: &str) -> &str {
    let Some(open) = text.find("```") else {
        return text;
    };
    let after = &text[open + 3..];
    // Skip an optional language tag up to the newline that ends the opening fence line.
    let content_start = match after.find('\n') {
        Some(i) => open + 3 + i + 1,
        None => return text,
    };
    match text[content_start..].find("```") {
        Some(close_rel) => &text[content_start..content_start + close_rel],
        None => text,
    }
}

/// Aggregate per-case results for one model binding into a config report.
pub fn aggregate(model: &str, rows: Vec<CaseResult>) -> ConfigReport {
    let n = rows.len();
    let passes = rows.iter().filter(|r| r.pass).count();
    let cost_total_usd = rows.iter().map(|r| r.cost).sum();
    let latency_sum: u64 = rows.iter().map(|r| r.latency_ms).sum();
    let latency_ms_avg = if n > 0 { latency_sum / n as u64 } else { 0 };
    let turns_sum: u64 = rows.iter().map(|r| r.turns).sum();
    let turns_avg = if n > 0 { turns_sum / n as u64 } else { 0 };
    let cache_hits = rows.iter().filter(|r| r.cache_hit).count();
    let cache_misses = n - cache_hits;

    let mut by_tag: BTreeMap<String, TagStat> = BTreeMap::new();
    for r in &rows {
        for t in &r.tags {
            let e = by_tag.entry(t.clone()).or_insert(TagStat { pass: 0, n: 0 });
            e.n += 1;
            if r.pass {
                e.pass += 1;
            }
        }
    }

    ConfigReport {
        model: model.to_string(),
        n,
        accuracy: if n > 0 { passes as f64 / n as f64 } else { 0.0 },
        cost_total_usd,
        latency_ms_avg,
        turns_avg,
        cache_hits,
        cache_misses,
        by_tag,
        cases: rows,
    }
}

/// Render the Pareto table (accuracy vs cost vs latency, with per-tag accuracy).
pub fn format_pareto(report: &Report) -> String {
    let mut out = String::new();
    out.push_str("\n=== Warble eval — Pareto (accuracy vs cost vs latency) ===\n");
    if report.selected_cases < report.total_cases {
        out.push_str(&format!(
            "  (subset: {}/{} golden cases — smoke run, not a full scoring)\n",
            report.selected_cases, report.total_cases
        ));
    }
    out.push_str(&format!(
        "{:<16} {:<7} {:<10} {:<12} {:<7} by_tag\n",
        "binding", "acc", "cost($)", "lat(ms)", "turns"
    ));
    for c in &report.configs {
        let tags = c
            .by_tag
            .iter()
            .map(|(t, v)| format!("{t}:{:.2}", v.pass as f64 / v.n.max(1) as f64))
            .collect::<Vec<_>>()
            .join(" ");
        let cost = if c.cost_total_usd > 0.0 {
            format!("{:.4}", c.cost_total_usd)
        } else {
            "n/a".to_string()
        };
        out.push_str(&format!(
            "{:<16} {:<7} {:<10} {:<12} {:<7} {tags}\n",
            format!("strong→{}", c.model),
            format!("{:.2}", c.accuracy),
            cost,
            c.latency_ms_avg,
            c.turns_avg
        ));
    }
    // Cache visibility (no silent caps): show what was re-scored from cache vs freshly re-run, so a
    // 0-LLM re-score is never mistaken for a fresh run. `cache_misses` == the LLM calls this run.
    if report.configs.iter().any(|c| c.cache_hits > 0) {
        out.push_str("cache (miss = LLM call this run):\n");
        for c in &report.configs {
            let note = if c.cache_misses == 0 {
                "re-score only, 0 LLM calls this run".to_string()
            } else {
                format!("{} LLM calls this run", c.cache_misses)
            };
            out.push_str(&format!(
                "  strong→{:<10} {} hit / {} miss — {note}\n",
                c.model, c.cache_hits, c.cache_misses
            ));
        }
    }
    out
}

// --- orchestration --------------------------------------------------------------------------------

/// Installs agent files into `<project>/.claude` and removes them on drop (the project may have had
/// no `.claude` at all, so cleanup is best-effort and non-recursive, matching the reference runner).
struct InstalledAgents {
    files: Vec<PathBuf>,
    agents_dir: PathBuf,
    claude_dir: PathBuf,
}

impl Drop for InstalledAgents {
    fn drop(&mut self) {
        for f in &self.files {
            let _ = fs::remove_file(f);
        }
        let _ = fs::remove_dir(&self.agents_dir);
        let _ = fs::remove_dir(&self.claude_dir);
    }
}

pub(crate) fn install_agents(agent_dir: &Path, project: &Path) -> Result<InstalledAgents, String> {
    let claude_dir = project.join(".claude");
    let agents_dir = claude_dir.join("agents");
    fs::create_dir_all(&agents_dir).map_err(|e| format!("mkdir {}: {e}", agents_dir.display()))?;

    let src_agents = agent_dir.join(".claude").join("agents");
    let mut files = Vec::new();
    for entry in
        fs::read_dir(&src_agents).map_err(|e| format!("read {}: {e}", src_agents.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let dst = agents_dir.join(entry.file_name());
        fs::copy(entry.path(), &dst).map_err(|e| format!("copy agent: {e}"))?;
        files.push(dst);
    }

    // settings.json lives at .claude/settings.json (split path) or <out>/settings.json (single path).
    let settings_src = {
        let split = agent_dir.join(".claude").join("settings.json");
        if split.is_file() {
            Some(split)
        } else {
            let flat = agent_dir.join("settings.json");
            flat.is_file().then_some(flat)
        }
    };
    if let Some(src) = settings_src {
        let dst = claude_dir.join("settings.json");
        fs::copy(&src, &dst).map_err(|e| format!("copy settings: {e}"))?;
        files.push(dst);
    }

    Ok(InstalledAgents {
        files,
        agents_dir,
        claude_dir,
    })
}

/// The agent name is the basename of the first agent file (the driver, for split components).
pub(crate) fn agent_name(agent_dir: &Path) -> Result<String, String> {
    let dir = agent_dir.join(".claude").join("agents");
    let mut names: Vec<String> = fs::read_dir(&dir)
        .map_err(|e| format!("read {}: {e}", dir.display()))?
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter_map(|f| f.strip_suffix(".md").map(str::to_string))
        .collect();
    names.sort();
    names
        .into_iter()
        .next()
        .ok_or_else(|| format!("no agent files in {}", dir.display()))
}

/// Build a PATH that prepends `<project>/.venv/bin` when present, so the agent's `wren` is found.
pub(crate) fn run_path(project: &Path) -> String {
    let base = std::env::var("PATH").unwrap_or_default();
    let venv = project.join(".venv").join("bin");
    if venv.is_dir() {
        format!("{}:{base}", venv.display())
    } else {
        base
    }
}

/// Run one golden case through the dispatched `agent`, consulting the trace cache in `ctx`.
///
/// **Cache hit** — identical `(case, agent_sha, model, context_sha)` — re-scores the cached result
/// against the case's *current* expectation with **no LLM call** (`cache_hit = true`). This is both
/// the content-addressed skip and the "only the golden's `expected` changed" 0-LLM re-score: the
/// expectation is deliberately outside the key, so such a change still hits and only the comparison
/// is redone. **Miss** invokes the agent (`ctx` supplies the `--model` override on the run path, or
/// the frontmatter binding on the ablation path) and writes a fresh trace back to the cache.
fn run_case(
    project: &Path,
    agent: &str,
    path_env: &str,
    case: &GoldenCase,
    ctx: &CaseCtx,
) -> CaseResult {
    let key = CaseKey {
        case_id: &case.id,
        question: &case.question,
        agent_sha: ctx.agent_sha,
        model: ctx.model,
        context_sha: ctx.context_sha,
    };

    // Cache hit → re-score the cached result against the current expectation (0 LLM). A corrupt
    // entry (result no longer reads back as a table) falls through and re-runs the case.
    if let Some(trace) = ctx.store.load(&key) {
        if let Some(verdict) = rescore(&trace, case) {
            return CaseResult {
                id: case.id.clone(),
                tags: case.tags.clone(),
                pass: verdict.pass,
                reason: verdict.reason,
                cost: trace.cost,
                latency_ms: trace.latency_ms,
                turns: trace.turns,
                cache_hit: true,
            };
        }
    }

    let started = Instant::now();
    let fail = |reason: &str, cost: f64, latency_ms: u64| CaseResult {
        id: case.id.clone(),
        tags: case.tags.clone(),
        pass: false,
        reason: reason.to_string(),
        cost,
        latency_ms,
        turns: 0,
        cache_hit: false,
    };

    let mut args: Vec<&str> = vec!["-p", &case.question, "--agent", agent];
    if let Some(model) = ctx.model_override() {
        args.extend_from_slice(&["--model", model]);
    }
    args.extend_from_slice(&[
        "--output-format",
        "json",
        "--allowedTools",
        "Read",
        "Bash(wren:*)",
    ]);
    let output = Command::new("claude")
        .args(&args)
        .current_dir(project)
        .env("PATH", path_env)
        .output();

    let raw = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        _ => {
            return fail(
                "claude invocation failed",
                0.0,
                started.elapsed().as_millis() as u64,
            )
        }
    };

    let meta: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
    let result_text = meta.get("result").and_then(|v| v.as_str()).unwrap_or(&raw);
    let latency_ms = meta
        .get("duration_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| started.elapsed().as_millis() as u64);
    let cost = meta
        .get("total_cost_usd")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    // `num_turns` is the round-trip count the whole codebase treats as the turn diagnostic.
    let turns = meta.get("num_turns").and_then(|v| v.as_u64()).unwrap_or(0);

    let Some(result_value) = extract_result_json(result_text) else {
        return fail("no parseable {columns,rows} in output", cost, latency_ms);
    };
    let Ok(actual) = serde_json::from_value::<Table>(result_value.clone()) else {
        return fail("no parseable {columns,rows} in output", cost, latency_ms);
    };

    let verdict = compare(&CompareRequest {
        match_mode: case.match_mode,
        tolerance: case.tolerance,
        expected: case.expected.clone(),
        actual,
    });

    // Cache the result (best-effort; a write failure degrades to "not cached", never fails the run).
    let trace = Trace {
        case_id: case.id.clone(),
        agent_sha: ctx.agent_sha.to_string(),
        model: ctx.model.to_string(),
        context_version: ctx.context_version.map(str::to_string),
        context_sha: ctx.context_sha.to_string(),
        question: case.question.clone(),
        sql_executed: None,
        result: result_value,
        cost,
        latency_ms,
        turns,
        tool_calls: None,
    };
    if let Err(e) = ctx.store.store(&key, &trace) {
        eprintln!("  note: could not cache trace for {}: {e}", case.id);
    }

    CaseResult {
        id: case.id.clone(),
        tags: case.tags.clone(),
        pass: verdict.pass,
        reason: verdict.reason,
        cost,
        latency_ms,
        turns,
        cache_hit: false,
    }
}

/// Load the golden file, install the agent, run every case under every model binding, and return
/// the aggregated report. Progress is streamed to stderr. The agent install is cleaned up on return
/// (including on error) via the `InstalledAgents` drop guard.
pub fn run_eval(cfg: &RunConfig) -> Result<Report, String> {
    let golden_text = fs::read_to_string(&cfg.golden_path)
        .map_err(|e| format!("read {}: {e}", cfg.golden_path.display()))?;
    let golden: Golden =
        serde_yaml::from_str(&golden_text).map_err(|e| format!("parse golden: {e}"))?;

    // Stratified selection (`--tags` / `--sample`): pick the smoke/full subset before any spend.
    let total_cases = golden.cases.len();
    let cases = select_and_subset(&golden, &cfg.filter)?;
    let selected_cases = cases.len();

    let agent = agent_name(&cfg.agent_dir)?;
    let path_env = run_path(&cfg.project);

    // Trace cache: the MDL SHA (context_sha) + the dispatched-agent SHA (agent_sha) are the run's
    // content-addressed key material. Computed before install (install copies agents into the
    // project's .claude, which compute_mdl_sha skips). Either failing disables the cache visibly.
    let (mut store, context_sha) =
        build_store(cfg.no_cache, cfg.cache_dir.as_deref(), &cfg.project);
    let agent_sha = if store.is_enabled() {
        match context::compute_dir_sha(&cfg.agent_dir) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("cache: disabled — cannot hash agent dir: {e}");
                store = TraceStore::disabled();
                String::new()
            }
        }
    } else {
        String::new()
    };

    let _installed = install_agents(&cfg.agent_dir, &cfg.project)?;

    let parallel = cfg.parallel.max(1);
    let mut configs = Vec::new();
    for model in &cfg.models {
        let par = if parallel > 1 {
            format!(", parallel={parallel}")
        } else {
            String::new()
        };
        eprintln!("\n### binding: strong→{model}  (n={selected_cases}{par})");
        let ctx = CaseCtx {
            model,
            agent_sha: &agent_sha,
            context_sha: &context_sha,
            context_version: golden.context_version.as_deref(),
            store: &store,
        };
        let rows = run_cases(&cfg.project, &agent, &path_env, &cases, parallel, &ctx);
        configs.push(aggregate(model, rows));
    }

    Ok(Report {
        dataset: golden.dataset,
        context_version: golden.context_version,
        parallel,
        selected_cases,
        total_cases,
        configs,
    })
}

/// Build the trace store and compute the `context_sha` (MDL SHA) key component shared by every case
/// of a run/ablation. Returns a **disabled** store (every case re-runs, nothing is cached) with an
/// empty `context_sha` when `--no-cache` is set or the MDL SHA can't be computed — the reason is
/// printed to stderr so a disabled cache is never a silent surprise. The default cache dir is
/// `<project>/.warble/eval-cache`.
pub(crate) fn build_store(
    no_cache: bool,
    cache_dir: Option<&Path>,
    project: &Path,
) -> (TraceStore, String) {
    if no_cache {
        eprintln!("cache: disabled (--no-cache) — every case re-runs and refreshes its trace");
        return (TraceStore::disabled(), String::new());
    }
    let context_sha = match compute_mdl_sha(project) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("cache: disabled — cannot compute MDL context SHA: {e}");
            return (TraceStore::disabled(), String::new());
        }
    };
    let dir = cache_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| project.join(".warble").join("eval-cache"));
    eprintln!(
        "cache: enabled at {} (context_sha {})",
        dir.display(),
        &context_sha[..context_sha.len().min(12)]
    );
    (TraceStore::new(dir, true), context_sha)
}

/// Apply `filter` to `golden.cases`, print the no-silent-caps selection note, and return the
/// selected cases. Errors if an active filter selects nothing (a typo'd tag shouldn't quietly run
/// zero cases). Shared by the run and ablation paths.
pub(crate) fn select_and_subset(
    golden: &Golden,
    filter: &CaseFilter,
) -> Result<Vec<GoldenCase>, String> {
    let selection = select_cases(&golden.cases, filter);
    if filter.is_active() {
        eprintln!("{}", selection.note);
    }
    if filter.is_active() && selection.indices.is_empty() {
        return Err(format!(
            "no golden cases match the filter — {} (nothing to run)",
            selection.note
        ));
    }
    Ok(selection
        .indices
        .iter()
        .map(|&i| golden.cases[i].clone())
        .collect())
}

/// Run every golden case through the installed `agent`, streaming per-case progress to stderr.
/// `ctx` carries the model binding and trace-cache key material (see [`CaseCtx`]); a cache hit
/// re-scores without invoking the agent. The agent must already be installed into `project`.
/// `parallel` cases run concurrently (1 = the original serial behavior); cases are independent
/// and the installed agent files are only read, so the shared state is safe. Progress lines
/// print as cases finish (out of submission order under parallelism, each tagged `[cache]` when
/// re-scored); the returned rows are always in golden-file order.
pub(crate) fn run_cases(
    project: &Path,
    agent: &str,
    path_env: &str,
    cases: &[GoldenCase],
    parallel: usize,
    ctx: &CaseCtx,
) -> Vec<CaseResult> {
    run_indexed(cases.len(), parallel, |i| {
        let r = run_case(project, agent, path_env, &cases[i], ctx);
        let extra = if r.pass {
            String::new()
        } else {
            format!("  — {}", r.reason)
        };
        let cost = if r.cost > 0.0 {
            format!(", ${:.4}", r.cost)
        } else {
            String::new()
        };
        // Mark re-scored (cached) cases so a 0-LLM run is never read as a fresh one.
        let cache = if r.cache_hit { " [cache]" } else { "" };
        eprintln!(
            "  {}  {}{cache}  ({:.1}s{cost}, {}t){extra}",
            if r.pass { "PASS" } else { "FAIL" },
            r.id,
            r.latency_ms as f64 / 1000.0,
            r.turns
        );
        r
    })
}

/// Run jobs `0..n` through `job`, at most `parallel` concurrently, and return the results in
/// index order regardless of completion order. `parallel <= 1` degenerates to a plain serial
/// loop. Workers pull the next index from a shared counter, so long jobs don't starve the
/// queue behind a fixed pre-partition.
pub(crate) fn run_indexed<T, F>(n: usize, parallel: usize, job: F) -> Vec<T>
where
    T: Send,
    F: Fn(usize) -> T + Sync,
{
    if parallel <= 1 || n <= 1 {
        return (0..n).map(job).collect();
    }

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    let next = AtomicUsize::new(0);
    let slots: Vec<Mutex<Option<T>>> = (0..n).map(|_| Mutex::new(None)).collect();

    std::thread::scope(|scope| {
        for _ in 0..parallel.min(n) {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= n {
                    break;
                }
                let r = job(i);
                *slots[i].lock().expect("result slot poisoned") = Some(r);
            });
        }
    });

    slots
        .into_iter()
        .map(|slot| {
            slot.into_inner()
                .expect("result slot poisoned")
                .expect("every index 0..n is claimed exactly once by the shared counter")
        })
        .collect()
}

#[cfg(test)]
mod run_indexed_tests {
    use super::run_indexed;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[test]
    fn serial_path_preserves_order_and_runs_each_once() {
        let calls = AtomicUsize::new(0);
        let out = run_indexed(5, 1, |i| {
            calls.fetch_add(1, Ordering::Relaxed);
            i * 10
        });
        assert_eq!(out, vec![0, 10, 20, 30, 40]);
        assert_eq!(calls.load(Ordering::Relaxed), 5);
    }

    #[test]
    fn parallel_results_are_in_index_order_despite_completion_order() {
        // Earlier indices sleep longer, so completion order is roughly reversed —
        // the returned Vec must still be in index order.
        let out = run_indexed(8, 4, |i| {
            std::thread::sleep(Duration::from_millis((8 - i as u64) * 3));
            i
        });
        assert_eq!(out, (0..8).collect::<Vec<_>>());
    }

    #[test]
    fn parallel_runs_each_index_exactly_once() {
        let per_index: Vec<AtomicUsize> = (0..32).map(|_| AtomicUsize::new(0)).collect();
        let out = run_indexed(32, 6, |i| {
            per_index[i].fetch_add(1, Ordering::Relaxed);
            i
        });
        assert_eq!(out.len(), 32);
        for (i, c) in per_index.iter().enumerate() {
            assert_eq!(c.load(Ordering::Relaxed), 1, "index {i} ran once");
        }
    }

    #[test]
    fn parallelism_wider_than_n_and_empty_input_are_fine() {
        assert_eq!(run_indexed(2, 16, |i| i), vec![0, 1]);
        assert_eq!(run_indexed(0, 4, |i| i), Vec::<usize>::new());
    }

    #[test]
    fn parallel_actually_overlaps_work() {
        // 4 jobs of ~40ms at parallel=4 should take far less than the ~160ms serial sum.
        let started = std::time::Instant::now();
        run_indexed(4, 4, |_| std::thread::sleep(Duration::from_millis(40)));
        assert!(
            started.elapsed() < Duration::from_millis(120),
            "4x40ms at parallel=4 took {:?} — jobs did not overlap",
            started.elapsed()
        );
    }
}
