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
mod capture;
mod context;
mod gate;

pub use ablation::{
    format_ablation, run_ablation, AblationConfig, AblationPoint, AblationReport,
    StepRecommendation,
};
pub use capture::{build_candidate_yaml, candidates_header, CaptureInput};
pub use context::{
    classify, compute_mdl_sha, parse_context_version, stamp_context_version, verify_context,
    Freshness, VerifyResult,
};
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

#[derive(Debug, serde::Deserialize)]
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
    pub by_tag: BTreeMap<String, TagStat>,
    pub cases: Vec<CaseResult>,
}

/// A full eval report (one config per tier→model binding). Serialized by `warble eval run --out`
/// and consumed as the baseline / candidate by `warble eval gate`.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct Report {
    pub dataset: Option<String>,
    pub context_version: Option<String>,
    pub configs: Vec<ConfigReport>,
}

pub struct RunConfig {
    pub project: PathBuf,
    pub agent_dir: PathBuf,
    pub golden_path: PathBuf,
    pub models: Vec<String>,
    pub out: Option<PathBuf>,
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
        by_tag,
        cases: rows,
    }
}

/// Render the Pareto table (accuracy vs cost vs latency, with per-tag accuracy).
pub fn format_pareto(report: &Report) -> String {
    let mut out = String::new();
    out.push_str("\n=== Warble eval — Pareto (accuracy vs cost vs latency) ===\n");
    out.push_str(&format!(
        "{:<16} {:<7} {:<10} {:<12} by_tag\n",
        "binding", "acc", "cost($)", "lat(ms)"
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
            "{:<16} {:<7} {:<10} {:<12} {tags}\n",
            format!("strong→{}", c.model),
            format!("{:.2}", c.accuracy),
            cost,
            c.latency_ms_avg
        ));
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

/// Run one golden case through the dispatched `agent`. `model` is the whole-run `--model` override
/// (whole-model ablation, [`run_eval`]); pass `None` for per-step ablation, where each (sub)agent's
/// tier→model binding is baked into its emitted frontmatter and must NOT be overridden.
fn run_case(
    project: &Path,
    agent: &str,
    path_env: &str,
    model: Option<&str>,
    case: &GoldenCase,
) -> CaseResult {
    let started = Instant::now();
    let fail = |reason: &str, cost: f64, latency_ms: u64| CaseResult {
        id: case.id.clone(),
        tags: case.tags.clone(),
        pass: false,
        reason: reason.to_string(),
        cost,
        latency_ms,
    };

    let mut args: Vec<&str> = vec!["-p", &case.question, "--agent", agent];
    if let Some(model) = model {
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

    let Some(actual) = extract_result(result_text) else {
        return fail("no parseable {columns,rows} in output", cost, latency_ms);
    };

    let verdict = compare(&CompareRequest {
        match_mode: case.match_mode,
        tolerance: case.tolerance,
        expected: case.expected.clone(),
        actual,
    });
    CaseResult {
        id: case.id.clone(),
        tags: case.tags.clone(),
        pass: verdict.pass,
        reason: verdict.reason,
        cost,
        latency_ms,
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

    let agent = agent_name(&cfg.agent_dir)?;
    let path_env = run_path(&cfg.project);
    let _installed = install_agents(&cfg.agent_dir, &cfg.project)?;

    let mut configs = Vec::new();
    for model in &cfg.models {
        eprintln!("\n### binding: strong→{model}  (n={})", golden.cases.len());
        let rows = run_cases(&cfg.project, &agent, &path_env, Some(model), &golden.cases);
        configs.push(aggregate(model, rows));
    }

    Ok(Report {
        dataset: golden.dataset,
        context_version: golden.context_version,
        configs,
    })
}

/// Run every golden case through the installed `agent`, streaming per-case progress to stderr.
/// `model` is the whole-run `--model` override (`None` = use each agent's frontmatter binding —
/// the per-step ablation path). The agent must already be installed into `project`.
pub(crate) fn run_cases(
    project: &Path,
    agent: &str,
    path_env: &str,
    model: Option<&str>,
    cases: &[GoldenCase],
) -> Vec<CaseResult> {
    let mut rows = Vec::new();
    for case in cases {
        let r = run_case(project, agent, path_env, model, case);
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
        eprintln!(
            "  {}  {}  ({:.1}s{cost}){extra}",
            if r.pass { "PASS" } else { "FAIL" },
            r.id,
            r.latency_ms as f64 / 1000.0
        );
        rows.push(r);
    }
    rows
}
