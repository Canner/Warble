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
//! - `ablation` — per-step tier ablation: re-dispatch the IR binding one named step at a time.
//! - `gate` — CI gate: fail on accuracy regression vs a committed baseline.
//! - `context` — MDL-version reverify: flag goldens whose pinned `context_version` went stale.
//! - `capture` — capture-confirmed: mint a candidate golden from one confirmed run.
//!
//! Pure helpers (`extract_result`, `aggregate`, `format_pareto`, golden parsing) and the closed-loop
//! modules' logic are unit-tested; `run_eval` / `run_ablation` additionally spawn `claude` and are
//! exercised end-to-end against a live project.

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;
use warble_eval_compare::{compare, CompareRequest, CompareResult, MatchMode, Table, Tolerance};

mod ablation;
mod backend;
mod cache;
mod capture;
mod compliance;
mod context;
mod filter;
mod gate;
mod monitor;

pub use ablation::{
    format_ablation, run_ablation, AblationConfig, AblationPoint, AblationReport,
    StepRecommendation,
};
pub use backend::Backend;
use backend::{resolve_adapter, BackendAdapter};
pub use cache::{rescore, CaseKey, Trace, TraceStore};
pub use capture::{build_candidate_yaml, candidates_header, CaptureInput};
pub use compliance::{
    format_compliance, score_compliance, Check, CheckStatus, ComplianceIr, ComplianceReport,
    ComplianceTrace, TraceEvent,
};
pub use context::{
    classify, compute_mdl_sha, parse_context_version, stamp_context_version, verify_context,
    Freshness, VerifyResult,
};
pub use filter::{select_cases, CaseFilter, Sample, Selection};
pub use gate::{format_gate, run_gate, FlakyCase, GateResult, Regression};
pub use monitor::{
    format_monitor_report, score_monitor_pair, MonitorMetric, MonitorObservation, MonitorReport,
};

/// A golden eval file: dataset metadata + cases with expected result sets.
#[derive(Debug, serde::Deserialize)]
pub struct Golden {
    #[serde(default)]
    pub dataset: Option<String>,
    #[serde(default)]
    pub context_version: Option<String>,
    pub cases: Vec<GoldenCase>,
}

/// Which shape a case's `expected` compares against — additive so every existing (all-`Table`)
/// golden stays byte-compatible: an omitted `result_kind` defaults to `Table`, the pre-existing
/// behavior. `Verdict` is the +Assertive twin: the agent's final message is a `{blocks, verdict,
/// emitted, verified}` envelope (see `dispatcher/claude-code-cli`'s assertion output contract), not
/// a `{columns, rows}` table, and one of its fields is projected down to `expected`'s scalar shape
/// before the usual comparator runs — see [`project_verdict_field`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResultKind {
    #[default]
    Table,
    Verdict,
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
    /// See [`ResultKind`]. Defaulted to `Table` so every pre-existing golden is unaffected.
    #[serde(default)]
    pub result_kind: ResultKind,
    /// For `ResultKind::Verdict` cases, which envelope field [`project_verdict_field`] projects onto
    /// `expected`'s single cell: `"fresh"` (`verdict.fresh`) or `"severity"` (the breach severity).
    /// Ignored for `ResultKind::Table` cases; `None` on a verdict case defaults to `"fresh"`.
    #[serde(default)]
    pub verdict_field: Option<String>,
}

/// One repeated-sample invocation of a case — the direct product of one [`run_case`] call, folded
/// by [`fold_samples`] into the case's aggregate [`CaseResult`]. Not serialized itself; only the
/// fold's output (`CaseResult`/`SampleVerdict`) is.
struct SampleOutcome {
    pass: bool,
    reason: String,
    /// `None` when this back-end genuinely cannot report cost (missing is not free — never
    /// defaulted to `0.0`).
    cost: Option<f64>,
    latency_ms: u64,
    /// `None` when this back-end genuinely cannot report a turn count.
    turns: Option<u64>,
    cache_hit: bool,
    /// The sample's rendered result value, or its raw final output when extraction fails. `Some`
    /// only when the run records answers (`--record-answers`) — the distinct-answer distribution
    /// is opt-in, since it means keeping one more string around per sample.
    answer: Option<String>,
}

/// One sample's verdict, kept in [`CaseResult::samples_detail`] so a flaky case's individual
/// sample-by-sample results (which ones failed, and why) survive past the aggregate.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct SampleVerdict {
    pub pass: bool,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
}

/// A case's aggregate result over `samples` repeated runs (pass-rate methodology). At `samples ==
/// 1` every field is bit-identical to the pre-repeated-sampling report shape — that identity is
/// the whole back-compat story, both for the gate's case-level comparison and for the Pareto table.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct CaseResult {
    pub id: String,
    pub tags: Vec<String>,
    /// How many times this case was sampled. `0` only on a report predating repeated sampling —
    /// the sentinel [`crate::Report::backfill_legacy`] detects and migrates forward. Every
    /// freshly-produced result sets this to `samples.max(1)`.
    #[serde(default)]
    pub samples: u32,
    /// How many of `samples` passed.
    #[serde(default)]
    pub passes: u32,
    /// `passes as f64 / samples as f64`. Kept as a stored field (not recomputed on read) so a
    /// legacy report's backfilled value round-trips identically to a freshly-computed one.
    #[serde(default)]
    pub pass_rate: f64,
    /// Fully passing: every sample passed. At `samples == 1` this is exactly today's single-run
    /// `pass` flag.
    pub pass: bool,
    /// Some samples passed, some failed (`0 < passes < samples`). Always `false` at `samples <= 1`.
    #[serde(default)]
    pub flaky: bool,
    /// A representative reason: the modal failure reason among failing samples, or `"match"` when
    /// every sample passed.
    pub reason: String,
    /// Summed over samples — repeated sampling multiplies spend by `samples`, so the total is what
    /// a run's cost column should reflect, not a per-sample average. `None` when any sample's
    /// backend couldn't report cost — absent is not zero, so the sum doesn't quietly understate.
    #[serde(default)]
    pub cost: Option<f64>,
    /// Averaged over samples.
    pub latency_ms: u64,
    /// Averaged over samples (`num_turns`) — the round-trip diagnostic. `None` when any sample's
    /// backend couldn't report a turn count.
    #[serde(default)]
    pub turns: Option<u64>,
    /// Samples served from the trace cache (re-scored, 0 LLM) vs freshly re-run this invocation.
    #[serde(default)]
    pub cache_hits: u32,
    #[serde(default)]
    pub cache_misses: u32,
    /// Per-sample verdicts. Empty on a legacy report (there is nothing to backfill this from).
    #[serde(default)]
    pub samples_detail: Vec<SampleVerdict>,
    /// Distinct-answer distribution across samples. `Some` only when the run recorded answers
    /// (`--record-answers`) — absence is unambiguous (not just an empty map).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer_dist: Option<BTreeMap<String, u32>>,
}

/// Fold one case's repeated-sample outcomes into its aggregate [`CaseResult`]. Pure and
/// unit-tested directly: no I/O, no cache, no process spawn. `samples.len() == 1` degenerates
/// bit-identically to the pre-repeated-sampling shape.
fn fold_samples(
    id: String,
    tags: Vec<String>,
    outcomes: Vec<SampleOutcome>,
    record_answers: bool,
) -> CaseResult {
    let samples = outcomes.len() as u32;
    let passes = outcomes.iter().filter(|o| o.pass).count() as u32;
    let pass_rate = if samples > 0 {
        passes as f64 / samples as f64
    } else {
        0.0
    };
    let pass = samples > 0 && passes == samples;
    let flaky = passes > 0 && passes < samples;
    let reason = if passes == samples {
        "match".to_string()
    } else {
        modal_reason(
            outcomes
                .iter()
                .filter(|o| !o.pass)
                .map(|o| o.reason.as_str()),
        )
    };
    // `try_fold` short-circuits to `None` the moment any one sample's backend didn't report the
    // metric — a partial sum would misrepresent "absent" as "zero" (see `SampleOutcome::cost`).
    let cost: Option<f64> = outcomes
        .iter()
        .try_fold(0.0_f64, |acc, o| o.cost.map(|c| acc + c));
    let latency_ms = if samples > 0 {
        outcomes.iter().map(|o| o.latency_ms).sum::<u64>() / samples as u64
    } else {
        0
    };
    let turns: Option<u64> = if samples > 0 {
        outcomes
            .iter()
            .try_fold(0_u64, |acc, o| o.turns.map(|t| acc + t))
            .map(|sum| sum / samples as u64)
    } else {
        Some(0)
    };
    let cache_hits = outcomes.iter().filter(|o| o.cache_hit).count() as u32;
    let cache_misses = samples - cache_hits;

    let answer_dist = record_answers.then(|| {
        let mut dist: BTreeMap<String, u32> = BTreeMap::new();
        for o in &outcomes {
            if let Some(answer) = &o.answer {
                *dist.entry(answer.clone()).or_insert(0) += 1;
            }
        }
        dist
    });
    let samples_detail = outcomes
        .into_iter()
        .map(|o| SampleVerdict {
            pass: o.pass,
            reason: o.reason,
            answer: if record_answers { o.answer } else { None },
        })
        .collect();

    CaseResult {
        id,
        tags,
        samples,
        passes,
        pass_rate,
        pass,
        flaky,
        reason,
        cost,
        latency_ms,
        turns,
        cache_hits,
        cache_misses,
        samples_detail,
        answer_dist,
    }
}

/// The most common reason among `reasons`, breaking ties by first occurrence — a stable
/// "representative reason" rather than whatever order a hash-based tally would land on for a tie.
fn modal_reason<'a>(reasons: impl Iterator<Item = &'a str>) -> String {
    let mut counts: Vec<(&str, u32)> = Vec::new();
    for r in reasons {
        match counts.iter_mut().find(|(seen, _)| *seen == r) {
            Some(entry) => entry.1 += 1,
            None => counts.push((r, 1)),
        }
    }
    let mut best: Option<(&str, u32)> = None;
    for (r, c) in counts {
        if best.is_none_or(|(_, bc)| c > bc) {
            best = Some((r, c));
        }
    }
    best.map(|(r, _)| r.to_string()).unwrap_or_default()
}

/// Render a case's raw `{columns, rows}` result as a comparable string for the answer-distribution
/// feature (`--record-answers`). `Table` derives `Deserialize` only, not `Serialize`, so this
/// renders the raw JSON value's canonical text form rather than serializing a `Table` instance.
///
/// This is a *textual* signature, not the comparator's semantic one: it fixes object-key order and
/// whitespace but not row order or number scale (`42` vs `42.0`). So for set/unordered match modes
/// two results the comparator deems equal can land in different `answer_dist` buckets — the
/// distribution can over-split. That only affects this diagnostic view; pass/fail and the gate run
/// through the comparator, never through this string. Invocation failures have no final output and
/// therefore contribute no answer, so a case's bucket counts can still sum to fewer than its
/// samples.
fn render_answer(result: &serde_json::Value) -> String {
    result.to_string()
}

/// Preserve the best diagnostic representation of a completed model response when answer
/// recording is enabled: canonical JSON after extraction, otherwise the raw final output that
/// explains why extraction failed.
fn recorded_failure_answer(
    record_answers: bool,
    extracted: Option<&serde_json::Value>,
    raw: &str,
) -> Option<String> {
    record_answers.then(|| {
        extracted
            .map(render_answer)
            .unwrap_or_else(|| raw.to_string())
    })
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct TagStat {
    pub pass: u32,
    pub n: u32,
    /// Sum of each case's `pass_rate` for this tag — `pass_rate_sum / n` is the tag's mean
    /// pass-rate accuracy, consistent with the gate's per-tag comparison. `0.0` in a pre-repeated-
    /// sampling report; [`crate::Report::backfill_legacy`] backfills it from the legacy `pass` count.
    #[serde(default)]
    pub pass_rate_sum: f64,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct ConfigReport {
    pub model: String,
    pub n: usize,
    /// Mean of each case's `pass_rate`. At `samples == 1` this is exactly the old passes/n
    /// accuracy — the field name is kept for gate continuity.
    pub accuracy: f64,
    /// `None` when any case's backend couldn't report cost — absent is not zero, so a back-end
    /// that genuinely can't supply cost never shows up as "free".
    #[serde(default)]
    pub cost_total_usd: Option<f64>,
    pub latency_ms_avg: u64,
    /// Average conversation turns per case (`num_turns`) — a context-quality diagnostic
    /// (fewer turns ⇒ less exploration ⇒ cheaper). `0` in a pre-P4 report. `None` when any
    /// case's backend couldn't report a turn count.
    #[serde(default)]
    pub turns_avg: Option<u64>,
    /// Samples (not cases) served from the trace cache (re-scored, 0 LLM) vs freshly re-run this
    /// invocation. `cache_misses` is the count of actual LLM calls made; both `0` in a pre-P4 report.
    #[serde(default)]
    pub cache_hits: usize,
    #[serde(default)]
    pub cache_misses: usize,
    /// Cases with `0 < passes < samples` — inconsistent across samples, not a hard regression.
    /// `0` in a pre-repeated-sampling report (no case could be flaky at samples == 1).
    #[serde(default)]
    pub flaky_cases: u32,
    pub by_tag: BTreeMap<String, TagStat>,
    pub cases: Vec<CaseResult>,
}

/// A full eval report (one config per tier→model binding). Serialized by `warble eval run --out`
/// and consumed as the baseline / candidate by `warble eval gate`.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct Report {
    pub dataset: Option<String>,
    pub context_version: Option<String>,
    /// Dispatch-time context identity copied from `context-report.json`. Fingerprints/counts only: the
    /// report never embeds private business-rule text. `None` for legacy agents.
    #[serde(default)]
    pub context_injection: Option<ContextInjectionReport>,
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
    /// Which back-end/runtime produced this report. `#[serde(default)]` so a legacy report (no
    /// field at all) deserializes to [`Backend::default`] — the back-end that behavior always
    /// meant before this dimension existed — never a hard parse failure.
    #[serde(default)]
    pub backend: Backend,
}

/// Strict, non-sensitive projection of a dispatched agent's context identity.
///
/// `deny_unknown_fields` is a privacy boundary: an arbitrary agent directory cannot smuggle rule
/// text or local paths into an exported eval report through `context-report.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextInjectionReport {
    pub mode: String,
    pub schema_digest_fingerprint: String,
    pub knowledge_fingerprint: Option<String>,
    pub knowledge_chars: usize,
}

impl ContextInjectionReport {
    fn validate(self) -> Result<Self, &'static str> {
        if !valid_context_fingerprint(&self.schema_digest_fingerprint) {
            return Err("invalid schema digest fingerprint");
        }
        match self.mode.as_str() {
            "schema-only" if self.knowledge_fingerprint.is_none() && self.knowledge_chars == 0 => {}
            "schema+knowledge"
                if self
                    .knowledge_fingerprint
                    .as_deref()
                    .is_some_and(valid_context_fingerprint) => {}
            "schema-only" | "schema+knowledge" => return Err("inconsistent knowledge identity"),
            _ => return Err("invalid context injection mode"),
        }
        Ok(self)
    }
}

fn valid_context_fingerprint(value: &str) -> bool {
    value
        .strip_prefix("fnv1a64:")
        .is_some_and(|hex| hex.len() == 16 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn default_parallel() -> usize {
    1
}

pub struct RunConfig {
    pub project: PathBuf,
    /// A dispatched agent output dir (contains `.claude/agents/…`) — the artifact `Backend::ClaudeCodeCli`
    /// installs and runs against. Required when `backend` is `ClaudeCodeCli` (the default); `run_eval`
    /// fails loudly if it's missing then. Mutually exclusive with `ir_path` in practice — exactly one
    /// artifact shape applies per backend.
    pub agent_dir: Option<PathBuf>,
    /// Compiled IR JSON (the same artifact `warble dispatch` consumes) — the artifact
    /// `Backend::ClaudeAgentSdk` dispatches directly at invocation time, since that back-end has no
    /// pre-installed agent dir to point at. Required when `backend` needs it; `run_eval` fails loudly
    /// if it's missing then.
    pub ir_path: Option<PathBuf>,
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
    /// Repeated runs per case (pass-rate methodology). `1` is today's single-run behavior;
    /// use more to distinguish model capability from run-to-run noise (flaky vs consistently
    /// passing/failing).
    pub samples: usize,
    /// Record each sample's rendered result value into `CaseResult::answer_dist` (a distinct-
    /// answer distribution). Off by default — it means keeping the actual answer strings around,
    /// not just pass/fail.
    pub record_answers: bool,
    /// Which back-end/runtime to dispatch the run through. Defaults to [`Backend::default`]
    /// (`claude-code-cli`) so an invocation that never mentions `--backend` measures exactly
    /// what it always measured.
    pub backend: Backend,
    /// The `--max-turns` cap to invoke the back-end's own dispatch CLI with, or `None` to leave its
    /// default turn budget in place. Only [`Backend::ClaudeAgentSdk`] has a `--max-turns` knob at
    /// all (see `ClaudeAgentSdkAdapter::invoke`); `run_eval` fails loudly, before any spend, if this
    /// is `Some` for any other backend rather than silently ignoring it — see
    /// `validate_max_turns_backend`. Also part of the trace cache key (`CaseKey::max_turns`) so a
    /// capped run can never hit a differently-capped (or uncapped) run's cached trace.
    pub max_turns: Option<u32>,
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
    /// Populate `SampleOutcome::answer` from this run's result — the answer-distribution feature
    /// (`--record-answers`) is opt-in per run, not always-on.
    pub record_answers: bool,
    /// Which back-end/runtime this run is measuring — part of the trace cache key so runs on
    /// different backends can never hit each other's cache, and copied onto the report/trace.
    pub backend: Backend,
    /// The resolved runner adapter for `backend` — owns launch mechanism, question-passing, and
    /// trace/metadata extraction (and, implicitly, the capability envelope: the adapter no longer
    /// receives a hard-coded tool allowlist from the eval loop).
    pub adapter: &'a dyn BackendAdapter,
    /// The `--max-turns` cap for this run, or `None` for the back-end's own default. Copied onto
    /// every [`CaseKey`] and forwarded to [`BackendAdapter::invoke`] — see [`RunConfig::max_turns`]
    /// for why only `claude-agent-sdk` ever sees a non-`None` value here.
    pub max_turns: Option<u32>,
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

/// Extract a `{blocks, verdict, emitted, verified}` verdict envelope from an agent's free-form final
/// text — the +Assertive twin of [`extract_result_json`]. Same fence-stripping and outermost-brace
/// slicing, but the acceptance guard checks for `verdict` or `blocks` instead of `rows`, since a
/// verdict envelope carries neither of the table's fields. Rejects anything else (including a plain
/// `{columns,rows}` table) so a verdict case never accidentally scores a table-shaped answer.
pub fn extract_verdict_json(text: &str) -> Option<serde_json::Value> {
    let candidate = strip_fence(text);
    let start = candidate.find('{')?;
    let end = candidate.rfind('}')?;
    if end <= start {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(&candidate[start..=end]).ok()?;
    let has_verdict = value.get("verdict").is_some();
    let has_blocks = value.get("blocks").map(Value::is_array).unwrap_or(false);
    if !has_verdict && !has_blocks {
        return None;
    }
    Some(value)
}

/// Project one field of a verdict envelope down to the 1x1 scalar [`Table`] a case's `expected`
/// compares against. `"fresh"` reads `verdict.fresh`; `"severity"` reads the breach severity off the
/// envelope's `status` block (falling back to `verdict.severity`, in case a future envelope carries
/// it there instead). Fails closed: an absent, wrong-typed, or unrecognized field returns `None` —
/// the case then fails outright rather than silently comparing something else.
pub fn project_verdict_field(envelope: &serde_json::Value, field: &str) -> Option<Table> {
    match field {
        "fresh" => {
            let fresh = envelope.get("verdict")?.get("fresh")?.as_bool()?;
            Some(Table {
                columns: vec!["fresh".to_string()],
                rows: vec![vec![Value::Bool(fresh)]],
            })
        }
        "severity" => {
            let status_severity =
                envelope
                    .get("blocks")
                    .and_then(Value::as_array)
                    .and_then(|blocks| {
                        blocks
                            .iter()
                            .find(|b| b.get("type").and_then(Value::as_str) == Some("status"))
                            .and_then(|b| b.get("severity"))
                            .and_then(Value::as_str)
                    });
            let severity = status_severity.or_else(|| {
                envelope
                    .get("verdict")
                    .and_then(|v| v.get("severity"))
                    .and_then(Value::as_str)
            })?;
            Some(Table {
                columns: vec!["severity".to_string()],
                rows: vec![vec![Value::String(severity.to_string())]],
            })
        }
        _ => None,
    }
}

/// Score a raw result value against a case's expectation, dispatching on [`ResultKind`] so the
/// fresh-run path (`run_case`) and the cache re-score path ([`cache::rescore`]) project the same
/// way from the same stored shape: a `Table` value for `ResultKind::Table`, a verdict envelope for
/// `ResultKind::Verdict`. Returns `None` when `result_value` doesn't have the shape the case's kind
/// expects — the caller treats that as a hard fail, never a false pass.
pub fn score_value(result_value: &Value, case: &GoldenCase) -> Option<CompareResult> {
    let actual = match case.result_kind {
        ResultKind::Table => serde_json::from_value(result_value.clone()).ok()?,
        ResultKind::Verdict => {
            let field = case.verdict_field.as_deref().unwrap_or("fresh");
            project_verdict_field(result_value, field)?
        }
    };
    Some(compare(&CompareRequest {
        match_mode: case.match_mode,
        tolerance: case.tolerance,
        expected: case.expected.clone(),
        actual,
    }))
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
    // Accuracy is the mean of each case's pass_rate — at samples == 1 this is numerically
    // identical to the old passes/n (pass_rate is exactly 0.0 or 1.0 there).
    let pass_rate_sum_total: f64 = rows.iter().map(|r| r.pass_rate).sum();
    let accuracy = if n > 0 {
        pass_rate_sum_total / n as f64
    } else {
        0.0
    };
    let flaky_cases = rows.iter().filter(|r| r.flaky).count() as u32;
    // `try_fold` short-circuits to `None` the moment any one case's backend didn't report the
    // metric — absent is not zero (binding decision: never let a defaulted 0 look like "free").
    let cost_total_usd: Option<f64> = rows
        .iter()
        .try_fold(0.0_f64, |acc, r| r.cost.map(|c| acc + c));
    let latency_sum: u64 = rows.iter().map(|r| r.latency_ms).sum();
    let latency_ms_avg = if n > 0 { latency_sum / n as u64 } else { 0 };
    let turns_avg: Option<u64> = if n > 0 {
        rows.iter()
            .try_fold(0_u64, |acc, r| r.turns.map(|t| acc + t))
            .map(|sum| sum / n as u64)
    } else {
        Some(0)
    };
    let cache_hits = rows.iter().map(|r| r.cache_hits as usize).sum();
    let cache_misses = rows.iter().map(|r| r.cache_misses as usize).sum();

    let mut by_tag: BTreeMap<String, TagStat> = BTreeMap::new();
    for r in &rows {
        for t in &r.tags {
            let e = by_tag.entry(t.clone()).or_insert(TagStat {
                pass: 0,
                n: 0,
                pass_rate_sum: 0.0,
            });
            e.n += 1;
            if r.pass {
                e.pass += 1;
            }
            e.pass_rate_sum += r.pass_rate;
        }
    }

    ConfigReport {
        model: model.to_string(),
        n,
        accuracy,
        cost_total_usd,
        latency_ms_avg,
        turns_avg,
        cache_hits,
        cache_misses,
        flaky_cases,
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
            .map(|(t, v)| format!("{t}:{:.2}", v.pass_rate_sum / v.n.max(1) as f64))
            .collect::<Vec<_>>()
            .join(" ");
        // Absent is not zero: a backend that reported no cost renders as `n/a`, never conflated
        // with a genuine `$0.00` — mirrors `ablation.rs::fmt_cost`.
        let cost = match c.cost_total_usd {
            Some(cost) => format!("{cost:.4}"),
            None => "n/a".to_string(),
        };
        let turns = c
            .turns_avg
            .map(|t| t.to_string())
            .unwrap_or_else(|| "n/a".to_string());
        out.push_str(&format!(
            "{:<16} {:<7} {:<10} {:<12} {:<7} {tags}\n",
            format!("strong→{}", c.model),
            format!("{:.2}", c.accuracy),
            cost,
            c.latency_ms_avg,
            turns
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
    // Flaky cases (inconsistent across samples) are surfaced, never silently folded into a hard
    // failure — the gate treats them separately too (see gate::run_gate).
    if report.configs.iter().any(|c| c.flaky_cases > 0) {
        out.push_str("flaky cases (inconsistent across samples):\n");
        for c in &report.configs {
            for case in c.cases.iter().filter(|case| case.flaky) {
                out.push_str(&format!(
                    "  strong→{:<10} {}  pass_rate={:.2} ({}/{})",
                    c.model, case.id, case.pass_rate, case.passes, case.samples
                ));
                if let Some(dist) = &case.answer_dist {
                    let mut answers: Vec<(&String, &u32)> = dist.iter().collect();
                    answers.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
                    let top = answers
                        .into_iter()
                        .take(3)
                        .map(|(a, n)| format!("{a}×{n}"))
                        .collect::<Vec<_>>()
                        .join(", ");
                    out.push_str(&format!("  — {top}"));
                }
                out.push('\n');
            }
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

/// Run one repeated sample of one golden case through the dispatched `agent`, consulting the trace
/// cache in `ctx`.
///
/// **Cache hit** — identical `(case, agent_sha, model, context_sha, sample)` — re-scores the cached
/// result against the case's *current* expectation with **no LLM call** (`cache_hit = true`). This is
/// both the content-addressed skip and the "only the golden's `expected` changed" 0-LLM re-score: the
/// expectation is deliberately outside the key, so such a change still hits and only the comparison
/// is redone. **Miss** invokes the agent (`ctx` supplies the `--model` override on the run path, or
/// the frontmatter binding on the ablation path) and writes a fresh trace back to the cache. Each
/// `sample` is its own cache entry — the pass-rate methodology depends on every sample actually
/// invoking the agent (or replaying its own prior trace), never silently collapsing onto sample 0.
fn run_case(
    project: &Path,
    agent: &str,
    path_env: &str,
    case: &GoldenCase,
    sample: u32,
    ctx: &CaseCtx,
) -> SampleOutcome {
    let key = CaseKey {
        case_id: &case.id,
        question: &case.question,
        agent_sha: ctx.agent_sha,
        model: ctx.model,
        context_sha: ctx.context_sha,
        sample,
        backend: ctx.backend,
        max_turns: ctx.max_turns,
    };

    // Cache hit → re-score the cached result against the current expectation (0 LLM). A corrupt
    // entry (result no longer reads back as a table) falls through and re-runs the case.
    if let Some(trace) = ctx.store.load(&key) {
        if let Some(verdict) = rescore(&trace, case) {
            return SampleOutcome {
                pass: verdict.pass,
                reason: verdict.reason,
                cost: trace.cost,
                latency_ms: trace.latency_ms,
                turns: trace.turns,
                cache_hit: true,
                answer: ctx.record_answers.then(|| render_answer(&trace.result)),
            };
        }
    }

    let started = Instant::now();
    let fail = |reason: &str, cost: Option<f64>, latency_ms: u64| SampleOutcome {
        pass: false,
        reason: reason.to_string(),
        cost,
        latency_ms,
        turns: None,
        cache_hit: false,
        answer: None,
    };

    // The target decides how the run is launched, how the question is passed, and how the
    // trace/metadata come back — including the capability envelope (which tools the agent may
    // use). That is no longer decided here: `claude-code-cli`'s own dispatch already wrote a
    // per-component `.claude/settings.json` with the computed tool allowlist, and `install_agents`
    // copied it into `project` before this call — so the envelope is the adapter's to apply from
    // that file, never a literal chosen here.
    let invocation = ctx.adapter.invoke(
        project,
        agent,
        path_env,
        &case.question,
        ctx.model_override(),
        ctx.max_turns,
    );

    if !invocation.ok {
        // Carry the adapter's own first line of explanation instead of a fixed string: a failure
        // whose cause is a misconfiguration (e.g. an unreadable capability envelope) is otherwise
        // indistinguishable in the report from the agent simply erroring out.
        //
        // Bounded on purpose: adapters are expected to put a short diagnostic here, but `raw` is a
        // free-form field and a future back-end could populate it with captured stdout. The report
        // is a committed artifact, so take one line and cap its length rather than letting whatever
        // a process printed flow into it verbatim.
        const MAX_REASON_CHARS: usize = 200;
        let detail = invocation
            .raw
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty());
        let reason = match detail {
            Some(line) if line.chars().count() > MAX_REASON_CHARS => {
                let clipped: String = line.chars().take(MAX_REASON_CHARS).collect();
                format!("backend invocation failed: {clipped}…")
            }
            Some(line) => format!("backend invocation failed: {line}"),
            None => "backend invocation failed".to_string(),
        };
        return fail(&reason, None, started.elapsed().as_millis() as u64);
    }
    let raw = invocation.raw;
    let result_text = raw.as_str();
    // `latency_ms` is the one metric every backend can be given for free (we always know when we
    // started), so it stays non-Option throughout: fall back to wall-clock elapsed time only when
    // the adapter itself couldn't report a more precise duration.
    let latency_ms = invocation
        .latency_ms
        .unwrap_or_else(|| started.elapsed().as_millis() as u64);
    let cost = invocation.cost;
    // `num_turns` is the round-trip count the whole codebase treats as the turn diagnostic. `None`
    // when this backend genuinely can't report it — absent is not zero.
    let turns = invocation.turns;

    // Extraction dispatches on the case's kind: a Table case still reads `{columns,rows}`; a
    // Verdict case reads the +Assertive `{blocks,verdict,emitted,verified}` envelope instead. Either
    // way the raw value (not the projected scalar) is what gets cached in `Trace.result`, so a later
    // re-score ([`cache::rescore`]) can re-project it against a possibly-changed expectation/field.
    let extracted = match case.result_kind {
        ResultKind::Table => extract_result_json(result_text),
        ResultKind::Verdict => extract_verdict_json(result_text),
    };
    let Some(result_value) = extracted else {
        let reason = match case.result_kind {
            ResultKind::Table => "no parseable {columns,rows} in output",
            ResultKind::Verdict => "no parseable verdict envelope in output",
        };
        return SampleOutcome {
            pass: false,
            reason: reason.to_string(),
            cost,
            latency_ms,
            turns,
            cache_hit: false,
            // A failed extraction is exactly when the raw final message is most useful. Keep it
            // when answer recording was explicitly requested so a live eval artifact explains
            // the model-contract failure instead of exposing only an empty distribution.
            answer: recorded_failure_answer(ctx.record_answers, None, result_text),
        };
    };
    let Some(verdict) = score_value(&result_value, case) else {
        let reason = match case.result_kind {
            ResultKind::Table => "no parseable {columns,rows} in output",
            ResultKind::Verdict => "verdict envelope missing the expected field",
        };
        return SampleOutcome {
            pass: false,
            reason: reason.to_string(),
            cost,
            latency_ms,
            turns,
            cache_hit: false,
            // Extraction succeeded, so retain the structured value even though projection did
            // not. This makes --record-answers cover failed samples as its CLI contract promises.
            answer: recorded_failure_answer(ctx.record_answers, Some(&result_value), result_text),
        };
    };

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
        backend: ctx.backend,
    };
    if let Err(e) = ctx.store.store(&key, &trace) {
        eprintln!(
            "  note: could not cache trace for {} (sample {sample}): {e}",
            case.id
        );
    }

    SampleOutcome {
        pass: verdict.pass,
        reason: verdict.reason,
        cost,
        latency_ms,
        turns,
        cache_hit: false,
        answer: ctx.record_answers.then(|| render_answer(&trace.result)),
    }
}

/// Load the golden file, install the agent, run every case under every model binding, and return
/// the aggregated report. Progress is streamed to stderr. The agent install is cleaned up on return
/// (including on error) via the `InstalledAgents` drop guard.
/// Which artifact shape `run_eval` resolved for this invocation's backend — see the "Two distinct
/// artifact shapes" comment at the top of `run_eval` for what each variant means and skips.
#[derive(Clone, Copy)]
enum ArtifactPath<'a> {
    AgentDir(&'a Path),
    Ir(&'a Path),
}

/// `--max-turns` only has somewhere to go for [`Backend::ClaudeAgentSdk`] — its own dispatch CLI is
/// the only one with a `--max-turns` knob (see `ClaudeAgentSdkAdapter::invoke`). `claude-code-cli`
/// (`claude -p`) has no such flag at all, and `codex-local`'s sandboxed `codex exec` call is already
/// single-turn with no turn-budget knob either. Rather than silently dropping a `--max-turns` the
/// chosen backend cannot honor — which would make a capped experiment quietly run uncapped — a
/// mismatch fails loudly here, naming both the offending backend and the one that does support it.
fn validate_max_turns_backend(backend: Backend, max_turns: Option<u32>) -> Result<(), String> {
    if max_turns.is_some() && backend != Backend::ClaudeAgentSdk {
        return Err(format!(
            "--max-turns is only supported by backend '{}' (the only one whose dispatch CLI has a \
--max-turns knob); backend '{backend}' has none — omit --max-turns or pass --backend {}",
            Backend::ClaudeAgentSdk,
            Backend::ClaudeAgentSdk
        ));
    }
    Ok(())
}

#[cfg(test)]
mod max_turns_backend_validation_tests {
    use super::*;

    /// The back-end-mismatch guard: `--max-turns` on any backend other than `claude-agent-sdk`
    /// fails loudly, before any dispatch/claude spend, naming both the offending backend and the
    /// one that does support the flag — so the caller knows exactly what to change.
    #[test]
    fn max_turns_is_rejected_for_a_backend_with_no_turn_budget_knob() {
        for backend in [Backend::ClaudeCodeCli, Backend::CodexLocal, Backend::Vercel] {
            let err = validate_max_turns_backend(backend, Some(1))
                .expect_err("max-turns must be rejected for a backend with no such knob");
            assert!(
                err.contains(backend.as_str()),
                "error must name the offending backend '{backend}': {err}"
            );
            assert!(
                err.contains(Backend::ClaudeAgentSdk.as_str()),
                "error must name the backend that does support --max-turns: {err}"
            );
        }
    }

    /// The two paths that must never error: the one backend that does have a `--max-turns` knob,
    /// and `max_turns: None` (no flag passed) on every backend regardless of knob support.
    #[test]
    fn max_turns_is_accepted_for_the_sdk_backend_and_whenever_absent() {
        assert!(validate_max_turns_backend(Backend::ClaudeAgentSdk, Some(1)).is_ok());
        for backend in [
            Backend::ClaudeCodeCli,
            Backend::ClaudeAgentSdk,
            Backend::CodexLocal,
            Backend::Vercel,
        ] {
            assert!(validate_max_turns_backend(backend, None).is_ok());
        }
    }
}

pub fn run_eval(cfg: &RunConfig) -> Result<Report, String> {
    let golden_text = fs::read_to_string(&cfg.golden_path)
        .map_err(|e| format!("read {}: {e}", cfg.golden_path.display()))?;
    let golden: Golden =
        serde_yaml::from_str(&golden_text).map_err(|e| format!("parse golden: {e}"))?;

    // Stratified selection (`--tags` / `--sample`): pick the smoke/full subset before any spend.
    let total_cases = golden.cases.len();
    let cases = select_and_subset(&golden, &cfg.filter)?;
    let selected_cases = cases.len();

    // Resolved once for the whole run (not per model/case), and before either artifact path below is
    // even validated — every binding under this invocation measures the same backend, and a backend
    // with no adapter fails loudly here, before ever reaching a `Report`/`CaseKey`/`Trace`.
    let adapter = resolve_adapter(cfg.backend)?;

    // `--max-turns` only means something to `claude-agent-sdk` — validated once, up front, for the
    // same reason the artifact-shape check below is: a mismatched `--max-turns`/`--backend`
    // combination fails loudly before any dispatch/claude spend, rather than being silently ignored
    // per case.
    validate_max_turns_backend(cfg.backend, cfg.max_turns)?;

    // Two distinct artifact shapes, keyed on backend: `claude-code-cli` points at a pre-installed
    // dispatched agent dir (`agent_name`/`context-report.json`/`install_agents` all assume this
    // shape); `claude-agent-sdk` has no such dir — it dispatches straight from the compiled IR at
    // invocation time (see `ClaudeAgentSdkAdapter`), so `agent` becomes the IR path itself and there
    // is no context-injection report or install step. Validated once, up front, so a mismatched
    // `--agent-dir`/`--ir` vs `--backend` combination fails loudly before any dispatch/claude spend.
    let artifact = match cfg.backend {
        Backend::ClaudeCodeCli => ArtifactPath::AgentDir(
            cfg.agent_dir
                .as_deref()
                .ok_or_else(|| "backend 'claude-code-cli' requires --agent-dir".to_string())?,
        ),
        _ => ArtifactPath::Ir(
            cfg.ir_path
                .as_deref()
                .ok_or_else(|| format!("backend '{}' requires --ir", cfg.backend))?,
        ),
    };

    let (agent, context_injection): (String, Option<ContextInjectionReport>) = match artifact {
        ArtifactPath::AgentDir(dir) => (agent_name(dir)?, read_context_injection_report(dir)?),
        ArtifactPath::Ir(path) => (path.display().to_string(), None),
    };
    let path_env = run_path(&cfg.project);

    // Trace cache: the MDL SHA (context_sha) + the agent-artifact SHA (agent_sha) are the run's
    // content-addressed key material. Computed before install (install copies agents into the
    // project's .claude, which compute_mdl_sha skips). Either failing disables the cache visibly.
    let (mut store, context_sha) =
        build_store(cfg.no_cache, cfg.cache_dir.as_deref(), &cfg.project);
    let agent_sha = if store.is_enabled() {
        let sha = match artifact {
            ArtifactPath::AgentDir(dir) => context::compute_dir_sha(dir),
            ArtifactPath::Ir(path) => context::compute_file_sha(path),
        };
        match sha {
            Ok(s) => s,
            Err(e) => {
                eprintln!("cache: disabled — cannot hash agent artifact: {e}");
                store = TraceStore::disabled();
                String::new()
            }
        }
    } else {
        String::new()
    };

    // Only `claude-code-cli` installs agent files into the project; `claude-agent-sdk`'s CLI reads
    // the IR directly (via its own `--project`) and needs no installation step.
    let _installed = match artifact {
        ArtifactPath::AgentDir(dir) => Some(install_agents(dir, &cfg.project)?),
        ArtifactPath::Ir(_) => None,
    };

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
            record_answers: cfg.record_answers,
            backend: cfg.backend,
            adapter: adapter.as_ref(),
            max_turns: cfg.max_turns,
        };
        let rows = run_cases(
            &cfg.project,
            &agent,
            &path_env,
            &cases,
            cfg.samples,
            parallel,
            &ctx,
        );
        configs.push(aggregate(model, rows));
    }

    Ok(Report {
        dataset: golden.dataset,
        context_version: golden.context_version,
        context_injection,
        parallel,
        selected_cases,
        total_cases,
        configs,
        backend: cfg.backend,
    })
}

fn read_context_injection_report(
    agent_dir: &Path,
) -> Result<Option<ContextInjectionReport>, String> {
    let path = agent_dir.join("context-report.json");
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let report: ContextInjectionReport = serde_json::from_str(&raw).map_err(|_| {
        format!(
            "invalid {}: expected context identity fields only",
            path.display()
        )
    })?;
    report
        .validate()
        .map(Some)
        .map_err(|reason| format!("invalid {}: {reason}", path.display()))
}

#[cfg(test)]
mod context_injection_report_tests {
    use super::*;

    fn write_report(body: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("context-report.json"), body).unwrap();
        dir
    }

    #[test]
    fn accepts_only_the_non_sensitive_context_identity_shape() {
        let dir = write_report(
            r#"{
                "mode":"schema+knowledge",
                "schema_digest_fingerprint":"fnv1a64:0123456789abcdef",
                "knowledge_fingerprint":"fnv1a64:fedcba9876543210",
                "knowledge_chars":42
            }"#,
        );
        let report = read_context_injection_report(dir.path())
            .unwrap()
            .expect("report present");
        assert_eq!(report.mode, "schema+knowledge");
        assert_eq!(report.knowledge_chars, 42);
    }

    #[test]
    fn rejects_rule_text_paths_and_inconsistent_identity_without_echoing_values() {
        let secret = "PRIVATE_RULE_MARKER /Users/example/private-project";
        let unknown = write_report(&format!(
            r#"{{
                "mode":"schema-only",
                "schema_digest_fingerprint":"fnv1a64:0123456789abcdef",
                "knowledge_fingerprint":null,
                "knowledge_chars":0,
                "rule_text":{secret:?}
            }}"#
        ));
        let error = read_context_injection_report(unknown.path()).unwrap_err();
        assert!(!error.contains(secret));

        let path_as_fingerprint = write_report(
            r#"{
                "mode":"schema+knowledge",
                "schema_digest_fingerprint":"fnv1a64:0123456789abcdef",
                "knowledge_fingerprint":"/Users/example/private-project",
                "knowledge_chars":42
            }"#,
        );
        let error = read_context_injection_report(path_as_fingerprint.path()).unwrap_err();
        assert!(!error.contains("/Users/example/private-project"));

        let inconsistent = write_report(
            r#"{
                "mode":"schema-only",
                "schema_digest_fingerprint":"fnv1a64:0123456789abcdef",
                "knowledge_fingerprint":"fnv1a64:fedcba9876543210",
                "knowledge_chars":42
            }"#,
        );
        assert!(read_context_injection_report(inconsistent.path()).is_err());
    }
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
        if cache_dir.is_some() {
            eprintln!("cache: --cache-dir ignored — --no-cache disables the cache entirely");
        }
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

/// Run every golden case, `samples` times each, through the installed `agent`, streaming progress
/// to stderr. `ctx` carries the model binding and trace-cache key material (see [`CaseCtx`]); a
/// cache hit re-scores without invoking the agent. The agent must already be installed into
/// `project`. `parallel` jobs (case × sample) run concurrently (1 = serial); jobs are independent
/// and the installed agent files are only read, so the shared state is safe.
///
/// At `samples == 1` the per-case progress line is byte-for-byte what it was before repeated
/// sampling existed. At `samples > 1` each sample additionally prints its own compact line, and
/// once every sample of a case is in, a pass-rate summary line follows (marked `FLAKY` when the
/// case's samples disagree). The returned rows are always in golden-file order.
pub(crate) fn run_cases(
    project: &Path,
    agent: &str,
    path_env: &str,
    cases: &[GoldenCase],
    samples: usize,
    parallel: usize,
    ctx: &CaseCtx,
) -> Vec<CaseResult> {
    let samples = samples.max(1);
    let outcomes = run_indexed(cases.len() * samples, parallel, |j| {
        let case = &cases[j / samples];
        let sample = (j % samples) as u32;
        let r = run_case(project, agent, path_env, case, sample, ctx);
        let extra = if r.pass {
            String::new()
        } else {
            format!("  — {}", r.reason)
        };
        // Absent is not zero: a backend that reported no cost renders as no cost segment at all,
        // never conflated with a genuine `$0.00` — mirrors `ablation.rs::fmt_cost`.
        let cost = match r.cost {
            Some(cost) => format!(", ${cost:.4}"),
            None => String::new(),
        };
        let turns = r
            .turns
            .map(|t| t.to_string())
            .unwrap_or_else(|| "n/a".to_string());
        // Mark re-scored (cached) samples so a 0-LLM run is never read as a fresh one.
        let cache = if r.cache_hit { " [cache]" } else { "" };
        if samples == 1 {
            eprintln!(
                "  {}  {}{cache}  ({:.1}s{cost}, {turns}t){extra}",
                if r.pass { "PASS" } else { "FAIL" },
                case.id,
                r.latency_ms as f64 / 1000.0,
            );
        } else {
            eprintln!(
                "    {}  {} sample {sample}{cache}  ({:.1}s{cost}, {turns}t){extra}",
                if r.pass { "PASS" } else { "FAIL" },
                case.id,
                r.latency_ms as f64 / 1000.0,
            );
        }
        r
    });

    // Group the flat (case*samples + sample) outcomes back into per-case chunks, in golden order,
    // and fold each into its aggregate. `SampleOutcome` isn't `Clone`, so a shared mutable iterator
    // — not indexing/slicing — is what lets each case take exactly its `samples` items.
    let mut it = outcomes.into_iter();
    cases
        .iter()
        .map(|case| {
            let chunk: Vec<SampleOutcome> = (&mut it).take(samples).collect();
            let result = fold_samples(
                case.id.clone(),
                case.tags.clone(),
                chunk,
                ctx.record_answers,
            );
            if samples > 1 {
                let marker = if result.flaky {
                    "FLAKY"
                } else if result.pass {
                    "PASS"
                } else {
                    "FAIL"
                };
                eprintln!(
                    "  {marker}  {}  pass_rate={:.2} ({}/{})",
                    result.id, result.pass_rate, result.passes, result.samples
                );
            }
            result
        })
        .collect()
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
        // Track concurrency directly instead of asserting on wall-clock duration: a shared/
        // contended CI runner can make even a generous timing threshold flaky, since the claim
        // under test ("did the pool hand out overlapping work") isn't really about elapsed time.
        // Two sleeping threads are both genuinely inside the closure at once, so overlap is
        // observable this way even when the runner has fewer cores than the requested
        // parallelism — which is also why we assert `> 1`, not `== 4`.
        let in_flight = AtomicUsize::new(0);
        let max_in_flight = AtomicUsize::new(0);
        run_indexed(4, 4, |_| {
            let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            max_in_flight.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(40));
            in_flight.fetch_sub(1, Ordering::SeqCst);
        });
        let max = max_in_flight.load(Ordering::SeqCst);
        assert!(
            max > 1,
            "expected overlapping execution, but max concurrent was {max}"
        );
    }
}

#[cfg(test)]
mod fold_samples_tests {
    use super::*;

    fn outcome(pass: bool, reason: &str, cost: f64, latency_ms: u64, turns: u64) -> SampleOutcome {
        SampleOutcome {
            pass,
            reason: reason.to_string(),
            cost: Some(cost),
            latency_ms,
            turns: Some(turns),
            cache_hit: false,
            answer: None,
        }
    }

    #[test]
    fn fully_passing_is_not_flaky_and_reason_is_match() {
        let outcomes = vec![
            outcome(true, "match", 0.1, 1_000, 2),
            outcome(true, "match", 0.1, 1_000, 2),
        ];
        let r = fold_samples("a".into(), vec![], outcomes, false);
        assert_eq!(r.samples, 2);
        assert_eq!(r.passes, 2);
        assert!((r.pass_rate - 1.0).abs() < 1e-9);
        assert!(r.pass);
        assert!(!r.flaky);
        assert_eq!(r.reason, "match");
    }

    #[test]
    fn fully_failing_is_not_flaky() {
        let outcomes = vec![
            outcome(false, "mismatch", 0.0, 500, 1),
            outcome(false, "mismatch", 0.0, 500, 1),
        ];
        let r = fold_samples("a".into(), vec![], outcomes, false);
        assert_eq!(r.passes, 0);
        assert_eq!(r.pass_rate, 0.0);
        assert!(!r.pass);
        assert!(!r.flaky, "0 passes out of N is a hard fail, not flaky");
    }

    #[test]
    fn partial_pass_is_flaky_and_reason_is_the_modal_failure() {
        let outcomes = vec![
            outcome(true, "match", 0.0, 0, 0),
            outcome(false, "wrong total", 0.0, 0, 0),
            outcome(false, "wrong total", 0.0, 0, 0),
            outcome(false, "timeout", 0.0, 0, 0),
        ];
        let r = fold_samples("a".into(), vec![], outcomes, false);
        assert_eq!(r.passes, 1);
        assert_eq!(r.samples, 4);
        assert!((r.pass_rate - 0.25).abs() < 1e-9);
        assert!(!r.pass);
        assert!(r.flaky);
        assert_eq!(r.reason, "wrong total", "modal failure reason wins");
    }

    #[test]
    fn modal_reason_tie_break_is_first_occurrence() {
        // "b" and "a" both fail twice — "a" was seen first among the failures, so it wins the tie.
        let outcomes = vec![
            outcome(false, "a", 0.0, 0, 0),
            outcome(false, "b", 0.0, 0, 0),
            outcome(false, "b", 0.0, 0, 0),
            outcome(false, "a", 0.0, 0, 0),
        ];
        let r = fold_samples("a".into(), vec![], outcomes, false);
        assert_eq!(r.reason, "a");
    }

    #[test]
    fn cost_sums_latency_and_turns_average() {
        let outcomes = vec![
            outcome(true, "match", 0.10, 1_000, 4),
            outcome(true, "match", 0.20, 3_000, 6),
        ];
        let r = fold_samples("a".into(), vec![], outcomes, false);
        assert!(
            (r.cost.expect("cost present") - 0.30).abs() < 1e-9,
            "cost sums across samples"
        );
        assert_eq!(r.latency_ms, 2_000, "latency averages across samples");
        assert_eq!(r.turns, Some(5), "turns averages across samples");
    }

    #[test]
    fn cost_and_turns_are_none_when_any_sample_lacks_them() {
        let outcomes = vec![
            outcome(true, "match", 0.10, 1_000, 4),
            SampleOutcome {
                cost: None,
                turns: None,
                ..outcome(true, "match", 0.0, 1_000, 0)
            },
        ];
        let r = fold_samples("a".into(), vec![], outcomes, false);
        assert!(
            r.cost.is_none(),
            "one sample's missing cost makes the case's cost absent, not a partial sum"
        );
        assert!(
            r.turns.is_none(),
            "one sample's missing turns makes the case's turns absent, not a partial average"
        );
    }

    #[test]
    fn cache_hits_and_misses_are_counted_per_sample() {
        let outcomes = vec![
            SampleOutcome {
                cache_hit: true,
                ..outcome(true, "match", 0.0, 0, 0)
            },
            SampleOutcome {
                cache_hit: false,
                ..outcome(true, "match", 0.0, 0, 0)
            },
            SampleOutcome {
                cache_hit: true,
                ..outcome(true, "match", 0.0, 0, 0)
            },
        ];
        let r = fold_samples("a".into(), vec![], outcomes, false);
        assert_eq!(r.cache_hits, 2);
        assert_eq!(r.cache_misses, 1);
    }

    #[test]
    fn answer_dist_is_only_populated_when_record_answers_is_set() {
        let build = || {
            vec![
                SampleOutcome {
                    answer: Some("42".to_string()),
                    ..outcome(true, "match", 0.0, 0, 0)
                },
                SampleOutcome {
                    answer: Some("42".to_string()),
                    ..outcome(true, "match", 0.0, 0, 0)
                },
                SampleOutcome {
                    answer: Some("7".to_string()),
                    ..outcome(false, "wrong total", 0.0, 0, 0)
                },
            ]
        };

        let without = fold_samples("a".into(), vec![], build(), false);
        assert!(without.answer_dist.is_none());
        assert!(
            without.samples_detail.iter().all(|s| s.answer.is_none()),
            "no answer strings recorded unless --record-answers"
        );

        let with = fold_samples("a".into(), vec![], build(), true);
        let dist = with.answer_dist.expect("populated when record_answers");
        assert_eq!(dist.get("42"), Some(&2));
        assert_eq!(dist.get("7"), Some(&1));
        assert_eq!(
            with.samples_detail
                .iter()
                .filter(|s| s.answer.is_some())
                .count(),
            3
        );
    }

    #[test]
    fn failed_output_is_recorded_only_when_requested() {
        let extracted = serde_json::json!({
            "blocks": [{"type": "status", "state": "unknown"}],
            "verified": false,
        });

        assert_eq!(recorded_failure_answer(false, None, "raw refusal"), None);
        assert_eq!(
            recorded_failure_answer(false, Some(&extracted), "ignored"),
            None
        );
        assert_eq!(
            recorded_failure_answer(true, None, "raw refusal").as_deref(),
            Some("raw refusal")
        );
        assert_eq!(
            recorded_failure_answer(true, Some(&extracted), "ignored"),
            Some(extracted.to_string())
        );
    }

    #[test]
    fn modal_reason_of_empty_iterator_is_empty_string() {
        assert_eq!(modal_reason(std::iter::empty()), "");
    }
}

#[cfg(test)]
mod verdict_tests {
    use super::*;

    /// A representative +Assertive envelope, shaped exactly like
    /// `dispatcher/claude-code-cli`'s `VERDICT_ENVELOPE_EXAMPLE`.
    fn envelope(fresh: bool, severity: &str) -> serde_json::Value {
        serde_json::json!({
            "blocks": [
                { "type": "status", "state": if fresh { "fresh" } else { "stale" },
                  "label": "orders freshness", "detail": "…", "severity": severity }
            ],
            "verdict": { "type": "freshness_verdict", "fresh": fresh, "observed_lag_hours": 51,
                         "expected_cadence": "24h" },
            "emitted": ["freshness_breach"],
            "verified": true,
        })
    }

    fn fenced(value: &serde_json::Value) -> String {
        format!("Some prose.\n\n```json\n{value}\n```\n")
    }

    #[test]
    fn extract_verdict_json_accepts_a_real_envelope() {
        let text = fenced(&envelope(false, "critical"));
        let got = extract_verdict_json(&text).expect("envelope parses");
        assert_eq!(got["verdict"]["fresh"], false);
    }

    #[test]
    fn extract_verdict_json_rejects_a_columns_rows_table() {
        let text = fenced(&serde_json::json!({"columns": ["n"], "rows": [[42]]}));
        assert!(
            extract_verdict_json(&text).is_none(),
            "a table has neither `verdict` nor `blocks`"
        );
    }

    #[test]
    fn extract_verdict_json_rejects_malformed_json() {
        assert!(extract_verdict_json("not json at all").is_none());
        assert!(extract_verdict_json("```json\n{ not valid\n```").is_none());
    }

    #[test]
    fn extract_result_json_rejects_a_verdict_envelope() {
        // The inverse guard: a verdict envelope has no `rows` array, so the Table extractor must
        // not accidentally accept it either.
        let text = fenced(&envelope(true, "critical"));
        assert!(extract_result_json(&text).is_none());
    }

    #[test]
    fn project_verdict_field_reads_fresh_true_and_false() {
        let fresh_table = project_verdict_field(&envelope(true, "critical"), "fresh").unwrap();
        assert_eq!(fresh_table.rows, vec![vec![Value::Bool(true)]]);

        let stale_table = project_verdict_field(&envelope(false, "critical"), "fresh").unwrap();
        assert_eq!(stale_table.rows, vec![vec![Value::Bool(false)]]);
    }

    #[test]
    fn project_verdict_field_reads_severity_warn_and_critical() {
        let warn = project_verdict_field(&envelope(false, "warn"), "severity").unwrap();
        assert_eq!(warn.rows, vec![vec![Value::String("warn".to_string())]]);

        let critical = project_verdict_field(&envelope(false, "critical"), "severity").unwrap();
        assert_eq!(
            critical.rows,
            vec![vec![Value::String("critical".to_string())]]
        );
    }

    #[test]
    fn project_verdict_field_falls_back_to_verdict_severity() {
        // A `status` block without a `severity` key: fall back to `verdict.severity`.
        let envelope = serde_json::json!({
            "blocks": [{ "type": "status", "state": "stale" }],
            "verdict": { "type": "freshness_verdict", "fresh": false, "severity": "warn" },
        });
        let got = project_verdict_field(&envelope, "severity").unwrap();
        assert_eq!(got.rows, vec![vec![Value::String("warn".to_string())]]);
    }

    #[test]
    fn project_verdict_field_is_none_on_missing_or_unknown_field() {
        let e = envelope(true, "critical");
        assert!(
            project_verdict_field(&e, "observed_lag_hours").is_none(),
            "unrecognized field fails closed, never silently passes"
        );
        let no_verdict = serde_json::json!({"blocks": []});
        assert!(project_verdict_field(&no_verdict, "fresh").is_none());
        let no_severity_anywhere = serde_json::json!({
            "blocks": [{"type": "status", "state": "stale"}],
            "verdict": {"type": "freshness_verdict", "fresh": false},
        });
        assert!(project_verdict_field(&no_severity_anywhere, "severity").is_none());
    }

    fn verdict_case(tag: &str, field: &str, expected_rows: &str) -> GoldenCase {
        let yaml = format!(
            "id: v1\nquestion: \"is it fresh?\"\ntags: [{tag}]\nmatch: scalar\n\
             result_kind: verdict\nverdict_field: {field}\n\
             expected: {{ columns: [{field}], rows: {expected_rows} }}\n"
        );
        serde_yaml::from_str(&yaml).expect("verdict golden case parses")
    }

    #[test]
    fn golden_case_result_kind_defaults_to_table_when_omitted() {
        let yaml = "id: t1\nquestion: \"how many?\"\nmatch: scalar\nexpected: { columns: [n], rows: [[1]] }\n";
        let case: GoldenCase = serde_yaml::from_str(yaml).expect("legacy case parses");
        assert_eq!(case.result_kind, ResultKind::Table);
        assert!(case.verdict_field.is_none());
    }

    #[test]
    fn score_value_passes_a_matching_verdict_envelope() {
        let case = verdict_case("detection", "fresh", "[[false]]");
        let verdict = score_value(&envelope(false, "critical"), &case).expect("scores");
        assert!(
            verdict.pass,
            "envelope fresh=false matches expected fresh=false"
        );
    }

    #[test]
    fn score_value_fails_a_mismatching_verdict_envelope() {
        let case = verdict_case("detection", "fresh", "[[true]]");
        let verdict = score_value(&envelope(false, "critical"), &case).expect("scores");
        assert!(
            !verdict.pass,
            "envelope fresh=false does not match expected fresh=true"
        );
    }

    #[test]
    fn score_value_projects_severity_for_the_severity_field() {
        let case = verdict_case("severity", "severity", "[[critical]]");
        let verdict = score_value(&envelope(false, "critical"), &case).expect("scores");
        assert!(verdict.pass);
    }

    #[test]
    fn score_value_on_a_table_case_is_unaffected_by_verdict_support() {
        let yaml = "id: t1\nquestion: \"how many?\"\nmatch: scalar\nexpected: { columns: [n], rows: [[42]] }\n";
        let case: GoldenCase = serde_yaml::from_str(yaml).expect("legacy case parses");
        let result = serde_json::json!({"columns": ["n"], "rows": [[42]]});
        let verdict = score_value(&result, &case).expect("table case scores");
        assert!(verdict.pass);
    }
}
