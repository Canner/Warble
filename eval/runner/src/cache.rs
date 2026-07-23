//! Trace cache — content-addressed per-case results + 0-LLM re-scoring.
//!
//! Every replayed golden case emits a **trace**: the agent's captured `{columns, rows}` result plus
//! the run's cost/latency/turns and the inputs that determined it — `(case, agent_sha, model,
//! context_sha, sample)`. The trace is written under a content-addressed key so a later run can
//! reuse it:
//!
//! - **Re-score without re-run** (the killer): a golden's `expected`/`tolerance`/`match` can change
//!   while the agent, model, MDL, and sample index do not. The key deliberately excludes the
//!   expectation, so such a change still *hits* — and [`rescore`] re-compares the cached result
//!   against the **current** expectation with **zero LLM calls**. The v1→v2 golden-calibration
//!   rerun goes from ~90 min to sub-second.
//! - **Content-addressed skip**: identical `(case, agent_sha, model, context_sha, sample)` → reuse
//!   the cached result on a plain re-run too (no re-sampling). `--no-cache` is the escape hatch that
//!   forces every case to re-run and refreshes the cache.
//!
//! The key material reuses the same `git hash-object` content addressing as `eval verify-context`
//! (the MDL SHA): `agent_sha` = SHA of the dispatched agent dir, `context_sha` = MDL SHA of the
//! bound project, and the cache filename is the SHA of the canonical key string. No new deps, no
//! network, single machine — the OSS boundary is preserved.
//!
//! No silent caps: the caller surfaces hit/miss counts in the report and per-case `[cache]` markers,
//! and a re-scored run is never mistaken for a fresh one.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use warble_eval_compare::CompareResult;

use crate::context::hash_str;
use crate::{score_value, GoldenCase};

/// Sentinel `model` component for the ablation / frontmatter path, where there is no whole-run
/// `--model` override (the per-step tier binding is baked into the agent, so `agent_sha` already
/// distinguishes the points). Keeps the key total for every run.
pub(crate) const FRONTMATTER_MODEL: &str = "frontmatter";

/// One captured case result. The `result` is stored as the raw `{columns, rows}` JSON value (the
/// same object `capture` embeds) so no `Serialize` is needed on the compare crate's `Table`; it is
/// deserialized back into a `Table` at re-score time.
///
/// `sql_executed` and `tool_calls` are schema slots the P4 trace shape reserves, but the single-shot
/// `claude -p --output-format json` envelope does not expose either (only `num_turns`), so they are
/// captured as `None` today. `turns` (from `num_turns`) is the delivered per-case diagnostic; full
/// SQL / tool-call granularity would need `--output-format stream-json` (a later change).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trace {
    pub case_id: String,
    pub agent_sha: String,
    pub model: String,
    /// The golden's symbolic `context_version` pin (informational), e.g. `driftwood@a1b2c3d`.
    pub context_version: Option<String>,
    /// The computed MDL SHA of the bound project — the `context_sha` key component.
    pub context_sha: String,
    /// The question the result answers. Part of the key: if a case's question changes under the
    /// same id, the cached result is for a different prompt and must be re-run (a miss).
    pub question: String,
    /// The SQL the agent executed. Not exposed by the `--output-format json` result envelope; `None`.
    pub sql_executed: Option<String>,
    /// The captured `{columns, rows}` result object.
    pub result: serde_json::Value,
    pub cost: f64,
    pub latency_ms: u64,
    /// Conversation turns (`num_turns`) — the round-trip count ("4–8 round-trips" per case, typically).
    pub turns: u64,
    /// Tool-call count. Not exposed by the JSON result envelope; `None` (see struct docs).
    pub tool_calls: Option<u64>,
}

/// The inputs that determine a case's result. Everything here is in the cache key; the golden's
/// expectation (expected/tolerance/match) deliberately is **not**, which is what makes re-scoring a
/// changed expectation a cache hit.
pub struct CaseKey<'a> {
    pub case_id: &'a str,
    pub question: &'a str,
    pub agent_sha: &'a str,
    /// The whole-run `--model` binding, or [`FRONTMATTER_MODEL`] on the ablation path.
    pub model: &'a str,
    pub context_sha: &'a str,
    /// Which repeated-sample run this is (0-indexed). Distinct samples of the same case are
    /// distinct cache entries — the pass-rate methodology depends on each sample actually invoking
    /// the agent (or replaying its OWN prior trace), not silently collapsing onto sample 0.
    pub sample: u32,
}

impl CaseKey<'_> {
    /// The canonical, order-fixed key string that gets hashed. Encoded as a fixed-order JSON array
    /// so a field value can never spoof the delimiter structure — a `question` may legitimately
    /// contain newlines or `=`, which a plain `k=v\n` join could use to collide with a different
    /// logical key (relevant once goldens are machine-generated, not just hand-authored). `sample`
    /// is stringified and placed last so the first five elements stay stable for anyone comparing
    /// keys across a `samples`-unaware era.
    fn canonical(&self) -> String {
        serde_json::to_string(&[
            self.case_id,
            self.question,
            self.agent_sha,
            self.model,
            self.context_sha,
            &self.sample.to_string(),
        ])
        .expect("array of strings serializes")
    }

    /// Content-addressed hash of the key → the cache entry's filename stem.
    pub fn hash(&self) -> Result<String, String> {
        hash_str(&self.canonical())
    }
}

/// A content-addressed store of [`Trace`]s under one directory (`<dir>/<key-hash>.json`).
///
/// When `enabled` is false (the `--no-cache` escape hatch) [`load`](Self::load) always misses and
/// [`store`](Self::store) is a no-op, so a run behaves exactly as it did before P4.
pub struct TraceStore {
    dir: PathBuf,
    enabled: bool,
}

impl TraceStore {
    /// A store rooted at `dir`. `enabled = false` disables both read and write (`--no-cache`).
    pub fn new(dir: PathBuf, enabled: bool) -> Self {
        TraceStore { dir, enabled }
    }

    /// An always-missing store (used when the cache key material can't be computed, so the run
    /// still proceeds — every case just re-runs and nothing is cached).
    pub fn disabled() -> Self {
        TraceStore {
            dir: PathBuf::new(),
            enabled: false,
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn entry_path(&self, key_hash: &str) -> PathBuf {
        self.dir.join(format!("{key_hash}.json"))
    }

    /// Load a cached trace for `key`, or `None` on a disabled store, a missing entry, or an
    /// unreadable/corrupt one (a corrupt entry is treated as a miss — the case just re-runs).
    pub fn load(&self, key: &CaseKey) -> Option<Trace> {
        if !self.enabled {
            return None;
        }
        let hash = key.hash().ok()?;
        let raw = std::fs::read_to_string(self.entry_path(&hash)).ok()?;
        serde_json::from_str(&raw).ok()
    }

    /// Write `trace` under `key`. A no-op on a disabled store. Creates the cache dir on first write.
    pub fn store(&self, key: &CaseKey, trace: &Trace) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        let hash = key.hash()?;
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| format!("create cache dir {}: {e}", self.dir.display()))?;
        let json = serde_json::to_string_pretty(trace).map_err(|e| e.to_string())?;
        std::fs::write(self.entry_path(&hash), json)
            .map_err(|e| format!("write trace {}: {e}", self.entry_path(&hash).display()))
    }
}

/// Re-score a cached `trace` against a golden case's **current** expectation — the 0-LLM path.
/// Dispatches on the case's [`crate::ResultKind`] via [`score_value`] just like a fresh run does, so
/// a Table case's cached `{columns,rows}` and a Verdict case's cached envelope both re-project the
/// same way. Returns `None` if the cached result doesn't have the shape the case's kind expects (a
/// corrupt entry, or a case whose `result_kind` changed since the trace was captured; the caller then
/// re-runs the case). This is what makes "only the golden's expected changed" cost zero LLM calls:
/// the result is reused, only the comparison is redone.
pub fn rescore(trace: &Trace, case: &GoldenCase) -> Option<CompareResult> {
    score_value(&trace.result, case)
}

#[cfg(test)]
mod tests {
    use super::*;
    use warble_eval_compare::{MatchMode, Tolerance};

    fn trace_with(result: serde_json::Value) -> Trace {
        Trace {
            case_id: "q1".into(),
            agent_sha: "AAAA".into(),
            model: "opus".into(),
            context_version: Some("driftwood@c0ffee".into()),
            context_sha: "CCCC".into(),
            question: "how many orders?".into(),
            sql_executed: None,
            result,
            cost: 0.12,
            latency_ms: 20_000,
            turns: 5,
            tool_calls: None,
        }
    }

    fn case_expecting(rows: serde_json::Value) -> GoldenCase {
        // Build a GoldenCase via YAML so we don't depend on field visibility.
        let yaml = format!(
            "id: q1\nquestion: \"how many orders?\"\nmatch: scalar\nexpected: {{ columns: [n], rows: {rows} }}\n"
        );
        serde_yaml::from_str(&yaml).expect("golden case parses")
    }

    #[test]
    fn key_hash_is_stable_and_expectation_independent() {
        let k1 = CaseKey {
            case_id: "q1",
            question: "how many orders?",
            agent_sha: "AAAA",
            model: "opus",
            context_sha: "CCCC",
            sample: 0,
        };
        // Same inputs → same hash (content-addressed, deterministic).
        assert_eq!(k1.hash().unwrap(), k1.hash().unwrap());
        assert_eq!(k1.hash().unwrap().len(), 40, "git blob sha is 40 hex");
    }

    #[test]
    fn changing_a_key_component_changes_the_hash() {
        let base = CaseKey {
            case_id: "q1",
            question: "how many orders?",
            agent_sha: "AAAA",
            model: "opus",
            context_sha: "CCCC",
            sample: 0,
        };
        let base_hash = base.hash().unwrap();
        // Each of the five key components moves the hash (→ a miss → a re-run).
        for changed in [
            CaseKey {
                question: "how many customers?",
                ..key_copy(&base)
            },
            CaseKey {
                agent_sha: "BBBB",
                ..key_copy(&base)
            },
            CaseKey {
                model: "haiku",
                ..key_copy(&base)
            },
            CaseKey {
                context_sha: "DDDD",
                ..key_copy(&base)
            },
            CaseKey {
                sample: 1,
                ..key_copy(&base)
            },
        ] {
            assert_ne!(base_hash, changed.hash().unwrap());
        }
    }

    // Helper to copy a CaseKey's fields (CaseKey holds &str, so this is cheap).
    fn key_copy<'a>(k: &CaseKey<'a>) -> CaseKey<'a> {
        CaseKey {
            case_id: k.case_id,
            question: k.question,
            agent_sha: k.agent_sha,
            model: k.model,
            context_sha: k.context_sha,
            sample: k.sample,
        }
    }

    #[test]
    fn store_round_trips_and_no_cache_never_hits() {
        let dir = tempfile::tempdir().unwrap();
        let key = CaseKey {
            case_id: "q1",
            question: "how many orders?",
            agent_sha: "AAAA",
            model: "opus",
            context_sha: "CCCC",
            sample: 0,
        };
        let trace = trace_with(serde_json::json!({"columns":["n"],"rows":[[42]]}));

        let enabled = TraceStore::new(dir.path().to_path_buf(), true);
        enabled.store(&key, &trace).unwrap();
        let loaded = enabled.load(&key).expect("hit");
        assert_eq!(loaded.result, trace.result);
        assert_eq!(loaded.turns, 5);

        // A disabled store (the --no-cache path) never hits, even with the entry on disk.
        let disabled = TraceStore::new(dir.path().to_path_buf(), false);
        assert!(disabled.load(&key).is_none());
        // …and writing is a silent no-op.
        disabled.store(&key, &trace).unwrap();
    }

    #[test]
    fn rescore_reuses_result_against_the_current_expectation() {
        let trace = trace_with(serde_json::json!({"columns":["n"],"rows":[[42]]}));

        // Golden still expects 42 → pass, using only the cached result (no LLM).
        let pass = rescore(&trace, &case_expecting(serde_json::json!([[42]]))).unwrap();
        assert!(pass.pass, "cached 42 matches expected 42");

        // The golden's expected changes to 99 → the SAME cached result now fails the re-score.
        // This is the "only the expectation changed" path: 0 LLM, correct new verdict.
        let fail = rescore(&trace, &case_expecting(serde_json::json!([[99]]))).unwrap();
        assert!(!fail.pass, "cached 42 no longer matches expected 99");

        let _ = Tolerance::default();
        let _ = MatchMode::Scalar;
    }

    #[test]
    fn canonical_key_is_a_six_element_array() {
        let key = CaseKey {
            case_id: "q1",
            question: "how many orders?",
            agent_sha: "AAAA",
            model: "opus",
            context_sha: "CCCC",
            sample: 2,
        };
        let parsed: Vec<String> = serde_json::from_str(&key.canonical()).unwrap();
        assert_eq!(
            parsed,
            vec!["q1", "how many orders?", "AAAA", "opus", "CCCC", "2"]
        );
    }
}
