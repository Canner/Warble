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

/// The gate verdict: `passed` plus every regression and any structural notes.
#[derive(Debug, Clone, Serialize)]
pub struct GateResult {
    pub passed: bool,
    pub tolerance: f64,
    pub regressions: Vec<Regression>,
    /// Non-fatal structural observations (e.g. a baseline config absent from the candidate).
    pub notes: Vec<String>,
}

fn tag_accuracy(config: &crate::ConfigReport, tag: &str) -> Option<f64> {
    config
        .by_tag
        .get(tag)
        .map(|s| s.pass as f64 / s.n.max(1) as f64)
}

/// Index a config's cases by id → pass, so case-level regressions can be found by id.
fn case_pass_map(config: &crate::ConfigReport) -> BTreeMap<&str, bool> {
    config
        .cases
        .iter()
        .map(|c| (c.id.as_str(), c.pass))
        .collect()
}

/// Gate a candidate report against a baseline. A metric regresses when
/// `current < baseline - tolerance`. Configs are matched by their `model` label; a case regresses
/// when it passed in the baseline but fails or is absent in the candidate.
pub fn run_gate(baseline: &Report, current: &Report, tolerance: f64) -> GateResult {
    let mut regressions = Vec::new();
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

        // Case-level — name every case that used to pass and now doesn't.
        let cur_cases = case_pass_map(cur_cfg);
        for base_case in base_cfg.cases.iter().filter(|c| c.pass) {
            let now_passes = cur_cases.get(base_case.id.as_str()).copied();
            if now_passes != Some(true) {
                let detail = match now_passes {
                    Some(false) => format!("case '{}' passed in baseline, now fails", base_case.id),
                    _ => format!("case '{}' passed in baseline, now absent", base_case.id),
                };
                regressions.push(Regression {
                    config: base_cfg.model.clone(),
                    kind: format!("case:{}", base_case.id),
                    baseline: 1.0,
                    current: if now_passes == Some(false) {
                        0.0
                    } else {
                        f64::NAN
                    },
                    detail,
                });
            }
        }
    }

    GateResult {
        passed: regressions.is_empty(),
        tolerance,
        regressions,
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
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CaseResult, ConfigReport, Report, TagStat};

    fn case(id: &str, tag: &str, pass: bool) -> CaseResult {
        CaseResult {
            id: id.to_string(),
            tags: vec![tag.to_string()],
            pass,
            reason: if pass { "match" } else { "mismatch" }.to_string(),
            cost: 0.0,
            latency_ms: 100,
            turns: 0,
            cache_hit: false,
        }
    }

    fn config(model: &str, cases: Vec<CaseResult>) -> ConfigReport {
        let n = cases.len();
        let passes = cases.iter().filter(|c| c.pass).count();
        let mut by_tag: BTreeMap<String, TagStat> = BTreeMap::new();
        for c in &cases {
            for t in &c.tags {
                let e = by_tag.entry(t.clone()).or_insert(TagStat { pass: 0, n: 0 });
                e.n += 1;
                if c.pass {
                    e.pass += 1;
                }
            }
        }
        ConfigReport {
            model: model.to_string(),
            n,
            accuracy: if n > 0 { passes as f64 / n as f64 } else { 0.0 },
            cost_total_usd: 0.0,
            latency_ms_avg: 100,
            turns_avg: 0,
            cache_hits: 0,
            cache_misses: 0,
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
}
