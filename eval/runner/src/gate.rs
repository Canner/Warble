//! CI gate — the G4 hard line (roadmap Phase 1.4 step 7).
//!
//! Compares a candidate eval [`Report`] against a committed baseline and **fails on regression**:
//! any config whose overall accuracy, per-tag accuracy, or a previously-passing case drops beyond
//! `tolerance` is reported by name, and the caller turns that into a non-zero exit. This is what
//! turns "did this profile/context/eval PR make the agent dumber?" from a vibe into a build break.
//!
//! Honest bounds (roadmap risk #2): the gate *logic* runs anywhere (locally, pre-push). Wiring it to
//! an actual CI run needs a remote + secrets + a queryable eval project — see the shipped GitHub
//! Actions template. Nothing here pretends CI is live.

use crate::Report;
use serde::Serialize;
use std::collections::BTreeMap;

/// One regression the gate found, named so a human knows exactly what got worse.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Regression {
    /// The config (tier→model binding label) the regression is in.
    pub config: String,
    /// What regressed: `overall`, `tag:<tag>`, or `case:<id>`.
    pub kind: String,
    pub baseline: f64,
    pub current: f64,
    pub detail: String,
}

/// A case that passed fully in the baseline but is inconsistent (`0 < pass_rate < 1`) in the
/// candidate — reported separately from [`Regression`] because it isn't a hard regression: the
/// case can still pass, just not every time.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FlakyCase {
    pub config: String,
    pub id: String,
    pub pass_rate: f64,
}

/// The gate verdict: `passed` plus every regression and any structural notes.
#[derive(Debug, Clone, Serialize)]
pub struct GateResult {
    pub passed: bool,
    pub tolerance: f64,
    pub regressions: Vec<Regression>,
    /// Cases that flipped from fully-passing to inconsistent — surfaced, but never fails the gate.
    pub flaky: Vec<FlakyCase>,
    /// Non-fatal structural observations (e.g. a baseline config absent from the candidate).
    pub notes: Vec<String>,
}

fn tag_accuracy(config: &crate::ConfigReport, tag: &str) -> Option<f64> {
    config
        .by_tag
        .get(tag)
        .map(|s| s.pass_rate_sum / s.n.max(1) as f64)
}

/// Index a config's cases by id → pass_rate, so case-level regressions/flakiness can be found by id.
fn case_pass_rate_map(config: &crate::ConfigReport) -> BTreeMap<&str, f64> {
    config
        .cases
        .iter()
        .map(|c| (c.id.as_str(), c.pass_rate))
        .collect()
}

/// Gate a candidate report against a baseline. A metric regresses when
/// `current < baseline - tolerance`. Configs are matched by their `model` label; a case regresses
/// when it passed in the baseline but fails or is absent in the candidate.
pub fn run_gate(baseline: &Report, current: &Report, tolerance: f64) -> GateResult {
    let mut regressions = Vec::new();
    let mut flaky = Vec::new();
    let mut notes = Vec::new();

    for base_cfg in &baseline.configs {
        let Some(cur_cfg) = current.configs.iter().find(|c| c.model == base_cfg.model) else {
            notes.push(format!(
                "baseline config '{}' has no match in the candidate report (configs changed?)",
                base_cfg.model
            ));
            continue;
        };

        // Overall accuracy.
        if cur_cfg.accuracy < base_cfg.accuracy - tolerance {
            regressions.push(Regression {
                config: base_cfg.model.clone(),
                kind: "overall".to_string(),
                baseline: base_cfg.accuracy,
                current: cur_cfg.accuracy,
                detail: format!(
                    "overall accuracy {:.3} → {:.3} (drop {:.3} > tolerance {:.3})",
                    base_cfg.accuracy,
                    cur_cfg.accuracy,
                    base_cfg.accuracy - cur_cfg.accuracy,
                    tolerance
                ),
            });
        }

        // Per-tag accuracy — pinpoints *which class* of question regressed.
        for tag in base_cfg.by_tag.keys() {
            let base_acc = tag_accuracy(base_cfg, tag).unwrap_or(0.0);
            match tag_accuracy(cur_cfg, tag) {
                Some(cur_acc) if cur_acc < base_acc - tolerance => regressions.push(Regression {
                    config: base_cfg.model.clone(),
                    kind: format!("tag:{tag}"),
                    baseline: base_acc,
                    current: cur_acc,
                    detail: format!("tag '{tag}' accuracy {base_acc:.3} → {cur_acc:.3}"),
                }),
                Some(_) => {}
                None => notes.push(format!(
                    "config '{}': tag '{tag}' present in baseline but absent in candidate",
                    base_cfg.model
                )),
            }
        }

        // Case-level — name every case that used to pass fully and now doesn't. A case that
        // dropped to a partial pass_rate is flaky (it still passes sometimes), not a hard
        // regression; only 0.0 (or the case going missing) fails the gate.
        let cur_rates = case_pass_rate_map(cur_cfg);
        for base_case in base_cfg.cases.iter().filter(|c| c.pass) {
            match cur_rates.get(base_case.id.as_str()).copied() {
                Some(rate) if rate >= 1.0 => {} // still fully passing
                Some(rate) if rate > 0.0 => flaky.push(FlakyCase {
                    config: base_cfg.model.clone(),
                    id: base_case.id.clone(),
                    pass_rate: rate,
                }),
                Some(rate) => regressions.push(Regression {
                    config: base_cfg.model.clone(),
                    kind: format!("case:{}", base_case.id),
                    baseline: 1.0,
                    current: rate,
                    detail: format!("case '{}' passed in baseline, now fails", base_case.id),
                }),
                None => regressions.push(Regression {
                    config: base_cfg.model.clone(),
                    kind: format!("case:{}", base_case.id),
                    baseline: 1.0,
                    current: f64::NAN,
                    detail: format!("case '{}' passed in baseline, now absent", base_case.id),
                }),
            }
        }
    }

    GateResult {
        passed: regressions.is_empty(),
        tolerance,
        regressions,
        flaky,
        notes,
    }
}

/// Render the gate verdict for humans / CI logs.
pub fn format_gate(result: &GateResult) -> String {
    let mut out = String::new();
    out.push_str("\n=== Warble eval — CI gate (accuracy regression check) ===\n");
    out.push_str(&format!("tolerance: {:.3}\n", result.tolerance));
    for note in &result.notes {
        out.push_str(&format!("note: {note}\n"));
    }
    if result.passed {
        out.push_str("GATE PASS — no accuracy regression beyond tolerance.\n");
    } else {
        out.push_str(&format!(
            "GATE FAIL — {} regression(s):\n",
            result.regressions.len()
        ));
        for r in &result.regressions {
            out.push_str(&format!("  [{}] {} — {}\n", r.config, r.kind, r.detail));
        }
    }
    if !result.flaky.is_empty() {
        out.push_str(&format!(
            "flaky (not failing the gate) — {} case(s) passed in baseline but are now inconsistent:\n",
            result.flaky.len()
        ));
        for f in &result.flaky {
            out.push_str(&format!(
                "  [{}] {} — pass_rate {:.2}\n",
                f.config, f.id, f.pass_rate
            ));
        }
    }
    out
}

impl Report {
    /// Migrate a report from before repeated sampling to today's shape. A case with `samples == 0`
    /// is the legacy sentinel — freshly-produced results always set `samples >= 1` — so such a case
    /// is backfilled to a single deterministic sample matching its recorded `pass` outcome, and each
    /// touched tag's `pass_rate_sum` is rebuilt from the (now-backfilled) case pass rates.
    ///
    /// One historical distinction is lost in the backfill: whether a legacy case was a cache hit.
    /// The old schema's single `cache_hit` bool has no home in the new per-case `cache_hits`/
    /// `cache_misses` counts once it's not in the JSON at all (serde drops unknown fields), so every
    /// legacy case backfills to `cache_hits: 0, cache_misses: 1` (as if freshly run). This only
    /// affects cache-visibility reporting on a re-processed old report, never gate correctness —
    /// the gate never looks at cache counts.
    pub fn backfill_legacy(&mut self) {
        for config in &mut self.configs {
            let mut touched_tags: Vec<String> = Vec::new();
            for case in &mut config.cases {
                if case.samples == 0 {
                    case.samples = 1;
                    case.passes = case.pass as u32;
                    case.pass_rate = if case.pass { 1.0 } else { 0.0 };
                    case.cache_hits = 0;
                    case.cache_misses = 1;
                    for tag in &case.tags {
                        if !touched_tags.contains(tag) {
                            touched_tags.push(tag.clone());
                        }
                    }
                }
            }
            for tag in &touched_tags {
                if let Some(stat) = config.by_tag.get_mut(tag) {
                    stat.pass_rate_sum = config
                        .cases
                        .iter()
                        .filter(|c| c.tags.contains(tag))
                        .map(|c| c.pass_rate)
                        .sum();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CaseResult, ConfigReport, Report, TagStat};

    /// A fully-passing or fully-failing case at `samples == 1` — today's ordinary single-run shape.
    fn case(id: &str, tag: &str, pass: bool) -> CaseResult {
        CaseResult {
            id: id.to_string(),
            tags: vec![tag.to_string()],
            samples: 1,
            passes: if pass { 1 } else { 0 },
            pass_rate: if pass { 1.0 } else { 0.0 },
            pass,
            flaky: false,
            reason: if pass { "match" } else { "mismatch" }.to_string(),
            cost: 0.0,
            latency_ms: 100,
            turns: 0,
            cache_hits: 0,
            cache_misses: 1,
            samples_detail: Vec::new(),
            answer_dist: None,
        }
    }

    /// A case sampled `samples` times with `passes` of them passing — for exercising the
    /// flaky (`0 < passes < samples`) path specifically.
    fn sampled_case(id: &str, tag: &str, passes: u32, samples: u32) -> CaseResult {
        let pass_rate = passes as f64 / samples as f64;
        CaseResult {
            id: id.to_string(),
            tags: vec![tag.to_string()],
            samples,
            passes,
            pass_rate,
            pass: passes == samples,
            flaky: passes > 0 && passes < samples,
            reason: if passes == samples {
                "match".to_string()
            } else {
                "mismatch".to_string()
            },
            cost: 0.0,
            latency_ms: 100,
            turns: 0,
            cache_hits: 0,
            cache_misses: samples,
            samples_detail: Vec::new(),
            answer_dist: None,
        }
    }

    fn config(model: &str, cases: Vec<CaseResult>) -> ConfigReport {
        let n = cases.len();
        let pass_rate_sum: f64 = cases.iter().map(|c| c.pass_rate).sum();
        let flaky_cases = cases.iter().filter(|c| c.flaky).count() as u32;
        let mut by_tag: BTreeMap<String, TagStat> = BTreeMap::new();
        for c in &cases {
            for t in &c.tags {
                let e = by_tag.entry(t.clone()).or_insert(TagStat {
                    pass: 0,
                    n: 0,
                    pass_rate_sum: 0.0,
                });
                e.n += 1;
                if c.pass {
                    e.pass += 1;
                }
                e.pass_rate_sum += c.pass_rate;
            }
        }
        ConfigReport {
            model: model.to_string(),
            n,
            accuracy: if n > 0 { pass_rate_sum / n as f64 } else { 0.0 },
            cost_total_usd: 0.0,
            latency_ms_avg: 100,
            turns_avg: 0,
            cache_hits: 0,
            cache_misses: 0,
            flaky_cases,
            by_tag,
            cases,
        }
    }

    fn report(configs: Vec<ConfigReport>) -> Report {
        let n = configs.first().map(|c| c.n).unwrap_or(0);
        Report {
            dataset: Some("jaffle".into()),
            context_version: None,
            parallel: 1,
            selected_cases: n,
            total_cases: n,
            configs,
        }
    }

    #[test]
    fn identical_reports_pass() {
        let base = report(vec![config(
            "haiku",
            vec![case("a", "agg", true), case("b", "join", true)],
        )]);
        let cur = report(vec![config(
            "haiku",
            vec![case("a", "agg", true), case("b", "join", true)],
        )]);
        let r = run_gate(&base, &cur, 0.0);
        assert!(r.passed, "{:?}", r.regressions);
    }

    #[test]
    fn improvement_passes() {
        let base = report(vec![config("haiku", vec![case("a", "agg", false)])]);
        let cur = report(vec![config("haiku", vec![case("a", "agg", true)])]);
        assert!(run_gate(&base, &cur, 0.0).passed);
    }

    #[test]
    fn a_regressed_case_fails_and_is_named() {
        let base = report(vec![config(
            "haiku",
            vec![case("a", "agg", true), case("b", "join", true)],
        )]);
        let cur = report(vec![config(
            "haiku",
            vec![case("a", "agg", true), case("b", "join", false)],
        )]);
        let r = run_gate(&base, &cur, 0.0);
        assert!(!r.passed);
        // Both the overall accuracy, the join tag, and the specific case are flagged.
        assert!(r.regressions.iter().any(|x| x.kind == "overall"));
        assert!(r.regressions.iter().any(|x| x.kind == "tag:join"));
        assert!(r.regressions.iter().any(|x| x.kind == "case:b"));
    }

    #[test]
    fn drop_within_tolerance_passes() {
        // 2/2 → 3/4 = 0.75, a 0.25 drop. Tolerance 0.30 forgives it; 0.10 does not.
        let base = report(vec![config(
            "haiku",
            vec![case("a", "agg", true), case("b", "agg", true)],
        )]);
        let cur = report(vec![config(
            "haiku",
            vec![
                case("a", "agg", true),
                case("b", "agg", true),
                case("c", "agg", true),
                case("d", "agg", false),
            ],
        )]);
        assert!(run_gate(&base, &cur, 0.30).passed);
        assert!(!run_gate(&base, &cur, 0.10).passed);
    }

    #[test]
    fn missing_config_is_a_note_not_a_crash() {
        let base = report(vec![config("opus", vec![case("a", "agg", true)])]);
        let cur = report(vec![config("haiku", vec![case("a", "agg", true)])]);
        let r = run_gate(&base, &cur, 0.0);
        assert!(r.passed, "missing config is a note, not a regression");
        assert!(!r.notes.is_empty());
    }

    #[test]
    fn a_flaky_case_is_reported_separately_not_as_a_regression() {
        // Baseline: fully passing at samples == 1 (today's ordinary case). Candidate: same case
        // now sampled 4x, passing 3 of them — inconsistent, but still passes most of the time.
        // Tolerance 0.30 absorbs the resulting 0.25 drop in overall/tag accuracy so only the
        // case-level classification is under test here.
        let base = report(vec![config("haiku", vec![case("a", "agg", true)])]);
        let cur = report(vec![config("haiku", vec![sampled_case("a", "agg", 3, 4)])]);
        let r = run_gate(&base, &cur, 0.30);
        assert!(
            r.passed,
            "a flaky case must not fail the gate: {:?}",
            r.regressions
        );
        assert!(r.regressions.is_empty());
        assert_eq!(r.flaky.len(), 1);
        assert_eq!(r.flaky[0].id, "a");
        assert_eq!(r.flaky[0].config, "haiku");
        assert!((r.flaky[0].pass_rate - 0.75).abs() < 1e-9);
    }

    #[test]
    fn legacy_report_round_trips_through_backfill() {
        // Hand-written JSON shaped like a report from before repeated sampling: no samples/passes/
        // pass_rate/flaky/cache_hits/cache_misses/samples_detail/answer_dist on the case, no
        // pass_rate_sum on the tag stat, no flaky_cases on the config. Every one of those is
        // `#[serde(default)]`, so it still deserializes — with the `samples == 0` sentinel.
        let legacy = r#"{
            "dataset": "jaffle",
            "context_version": null,
            "parallel": 1,
            "selected_cases": 2,
            "total_cases": 2,
            "configs": [{
                "model": "haiku",
                "n": 2,
                "accuracy": 0.5,
                "cost_total_usd": 0.2,
                "latency_ms_avg": 100,
                "by_tag": { "agg": { "pass": 1, "n": 2 } },
                "cases": [
                    { "id": "a", "tags": ["agg"], "pass": true, "reason": "match", "cost": 0.1, "latency_ms": 90 },
                    { "id": "b", "tags": ["agg"], "pass": false, "reason": "mismatch", "cost": 0.1, "latency_ms": 110 }
                ]
            }]
        }"#;
        let mut r: Report = serde_json::from_str(legacy).expect("legacy report deserializes");

        // Pre-backfill: the sentinel is visible.
        assert_eq!(r.configs[0].cases[0].samples, 0);
        assert_eq!(r.configs[0].by_tag["agg"].pass_rate_sum, 0.0);

        r.backfill_legacy();

        let cases = &r.configs[0].cases;
        assert_eq!(cases[0].samples, 1);
        assert_eq!(cases[0].passes, 1);
        assert_eq!(cases[0].pass_rate, 1.0);
        assert_eq!(cases[0].cache_hits, 0);
        assert_eq!(cases[0].cache_misses, 1);
        assert!(!cases[0].flaky);
        assert_eq!(cases[1].samples, 1);
        assert_eq!(cases[1].passes, 0);
        assert_eq!(cases[1].pass_rate, 0.0);

        // by_tag.pass_rate_sum is rebuilt from the (now-backfilled) case pass rates: 1.0 + 0.0.
        assert_eq!(r.configs[0].by_tag["agg"].pass_rate_sum, 1.0);

        // And the gate can now run its pass_rate-based comparisons against this migrated report
        // without panicking or misclassifying anything.
        let cur = report(vec![config(
            "haiku",
            vec![case("a", "agg", true), case("b", "agg", false)],
        )]);
        let gated = run_gate(&r, &cur, 0.0);
        assert!(gated.passed, "identical (post-backfill) reports gate clean");
    }
}
