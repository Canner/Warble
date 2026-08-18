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
use crate::{score_value, Backend, GoldenCase};

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
    /// `None` when the backend that produced this trace couldn't report cost — absent is not zero.
    #[serde(default)]
    pub cost: Option<f64>,
    pub latency_ms: u64,
    /// Conversation turns (`num_turns`) — the round-trip count ("4–8 round-trips" per case, typically).
    /// `None` when the backend couldn't report a turn count.
    #[serde(default)]
    pub turns: Option<u64>,
    /// Tool-call count. Not exposed by the JSON result envelope; `None` (see struct docs).
    pub tool_calls: Option<u64>,
    /// Which back-end/runtime produced this trace — part of the cache key (see [`CaseKey::backend`])
    /// so a trace from one back-end is never replayed as another's result. `#[serde(default)]` so a
    /// pre-existing on-disk trace (no field at all) deserializes to [`Backend::default`] — the
    /// back-end that behavior always meant before this dimension existed.
    #[serde(default)]
    pub backend: Backend,
}

/// The inputs that determine a case's result. Everything here is in the cache key; the golden's
/// expectation (expected/tolerance/match) deliberately is **not**, which is what makes re-scoring a
/// changed expectation a cache hit.
pub struct CaseKey<'a> {
    pub case_id: &'a str,
    pub question: &'a str,
    pub agent_sha: &'a str,
    /// The whole-run `--model` binding, or `FRONTMATTER_MODEL` on the ablation path.
    pub model: &'a str,
    pub context_sha: &'a str,
    /// Which repeated-sample run this is (0-indexed). Distinct samples of the same case are
    /// distinct cache entries — the pass-rate methodology depends on each sample actually invoking
    /// the agent (or replaying its OWN prior trace), not silently collapsing onto sample 0.
    pub sample: u32,
    /// Which back-end/runtime this run is measuring. Part of the key so runs on different
    /// back-ends can never hit each other's cache.
    pub backend: Backend,
    /// The `--max-turns` cap this run was invoked with, or `None` when the back-end's own default
    /// applied. Part of the key for the same reason `backend` is: a run capped to 1 turn and a run
    /// left at the default turn budget are different experiments and must never share a cache
    /// entry. `None` keeps the pre-existing (no-such-knob) key shape untouched — see `canonical()`
    /// below, which appends this field to the key array only when it is `Some`.
    pub max_turns: Option<u32>,
}

impl CaseKey<'_> {
    /// The canonical, order-fixed key string that gets hashed. Encoded as a fixed-order JSON array
    /// so a field value can never spoof the delimiter structure — a `question` may legitimately
    /// contain newlines or `=`, which a plain `k=v\n` join could use to collide with a different
    /// logical key (relevant once goldens are machine-generated, not just hand-authored). `sample`
    /// is stringified and placed among the first five so they stay stable for anyone comparing
    /// keys across a `samples`-unaware era.
    ///
    /// `backend` is appended as a **sixth** element only when it isn't [`Backend::default`], and
    /// `max_turns` is appended after that (sixth or seventh, depending on whether `backend` was
    /// appended) only when it is `Some` — so a run that names neither still produces the exact
    /// legacy 6-element array (byte-identical, same hash), keeping pre-existing cache entries for
    /// the default back-end at the default turn budget valid, while setting either dimension grows
    /// the array and is guaranteed not to collide with a key that left it unset for the same case.
    fn canonical(&self) -> String {
        let sample = self.sample.to_string();
        let max_turns = self.max_turns.map(|n| n.to_string());
        let mut parts: Vec<&str> = vec![
            self.case_id,
            self.question,
            self.agent_sha,
            self.model,
            self.context_sha,
            &sample,
        ];
        if self.backend != Backend::default() {
            parts.push(self.backend.as_str());
        }
        if let Some(ref max_turns) = max_turns {
            parts.push(max_turns);
        }
        serde_json::to_string(&parts).expect("array of strings serializes")
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
            cost: Some(0.12),
            latency_ms: 20_000,
            turns: Some(5),
            tool_calls: None,
            backend: Backend::default(),
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
            backend: Backend::default(),
            max_turns: None,
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
            backend: Backend::default(),
            max_turns: None,
        };
        let base_hash = base.hash().unwrap();
        // Each of the six key components moves the hash (→ a miss → a re-run). Covers decision 5's
        // testing mandate: a non-default backend must never hit a default-backend key's cache entry.
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
            CaseKey {
                backend: Backend::ClaudeAgentSdk,
                ..key_copy(&base)
            },
            CaseKey {
                max_turns: Some(1),
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
            backend: k.backend,
            max_turns: k.max_turns,
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
            backend: Backend::default(),
            max_turns: None,
        };
        let trace = trace_with(serde_json::json!({"columns":["n"],"rows":[[42]]}));

        let enabled = TraceStore::new(dir.path().to_path_buf(), true);
        enabled.store(&key, &trace).unwrap();
        let loaded = enabled.load(&key).expect("hit");
        assert_eq!(loaded.result, trace.result);
        assert_eq!(loaded.turns, Some(5));

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
    fn canonical_key_is_a_six_element_array_for_the_default_backend() {
        // The default backend's canonical key stays byte-identical to the pre-Backend-dimension
        // shape — this is what keeps legacy cache entries valid for the default target (decision 5).
        let key = CaseKey {
            case_id: "q1",
            question: "how many orders?",
            agent_sha: "AAAA",
            model: "opus",
            context_sha: "CCCC",
            sample: 2,
            backend: Backend::default(),
            max_turns: None,
        };
        let parsed: Vec<String> = serde_json::from_str(&key.canonical()).unwrap();
        assert_eq!(
            parsed,
            vec!["q1", "how many orders?", "AAAA", "opus", "CCCC", "2"]
        );
    }

    #[test]
    fn canonical_key_is_a_seven_element_array_for_a_non_default_backend() {
        // A non-default backend gets an extra element — guaranteed not to collide with any
        // default-backend (legacy) key for the same case, so no cross-backend cache hit is even
        // representable at the key-encoding level.
        let key = CaseKey {
            case_id: "q1",
            question: "how many orders?",
            agent_sha: "AAAA",
            model: "opus",
            context_sha: "CCCC",
            sample: 2,
            backend: Backend::ClaudeAgentSdk,
            max_turns: None,
        };
        let parsed: Vec<String> = serde_json::from_str(&key.canonical()).unwrap();
        assert_eq!(
            parsed,
            vec![
                "q1",
                "how many orders?",
                "AAAA",
                "opus",
                "CCCC",
                "2",
                "claude-agent-sdk"
            ]
        );
    }

    #[test]
    fn max_turns_none_key_is_byte_identical_to_the_pre_max_turns_key() {
        // The exact guard the 24 already-paid driftwood traces depend on: a run that never
        // mentions `--max-turns` (max_turns: None) must still hash to the same key it always did,
        // for both the default backend (6-element legacy array) and a non-default one (7-element
        // array) — adding the max_turns dimension must not move either.
        let default_backend = CaseKey {
            case_id: "q1",
            question: "how many orders?",
            agent_sha: "AAAA",
            model: "opus",
            context_sha: "CCCC",
            sample: 2,
            backend: Backend::default(),
            max_turns: None,
        };
        assert_eq!(
            default_backend.canonical(),
            r#"["q1","how many orders?","AAAA","opus","CCCC","2"]"#
        );

        let sdk_backend = CaseKey {
            backend: Backend::ClaudeAgentSdk,
            ..key_copy(&default_backend)
        };
        assert_eq!(
            sdk_backend.canonical(),
            r#"["q1","how many orders?","AAAA","opus","CCCC","2","claude-agent-sdk"]"#
        );
    }

    #[test]
    fn max_turns_some_key_differs_from_the_none_key() {
        // The guard against silent-replay: a 1-turn sdk run must never hash to the same key as
        // the existing (max_turns-less) sdk traces, or the experiment would just replay old data.
        let none_key = CaseKey {
            case_id: "q1",
            question: "how many orders?",
            agent_sha: "AAAA",
            model: "opus",
            context_sha: "CCCC",
            sample: 0,
            backend: Backend::ClaudeAgentSdk,
            max_turns: None,
        };
        let some_key = CaseKey {
            max_turns: Some(1),
            ..key_copy(&none_key)
        };
        assert_ne!(none_key.hash().unwrap(), some_key.hash().unwrap());
        assert_ne!(none_key.canonical(), some_key.canonical());
        assert_eq!(
            some_key.canonical(),
            r#"["q1","how many orders?","AAAA","opus","CCCC","0","claude-agent-sdk","1"]"#
        );
    }
}
