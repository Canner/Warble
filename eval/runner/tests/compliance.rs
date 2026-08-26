//! `eval compliance` golden fixtures — execution-based, LLM-free, mirroring the Phase 4a
//! precedent (`mutate_change.rs`). Each case IS the reference oracle: it runs
//! [`score_compliance`] against a hand-authored trace + a reused golden IR and asserts the
//! verdict reproduces the labelled ground truth exactly (accuracy == 1.0) — both the overall
//! `compliant` flag and the precise set of guardrails that failed.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use warble_eval_runner::{score_compliance, CheckStatus, ComplianceIr, ComplianceTrace};

#[derive(Debug, Deserialize)]
struct GroundTruth {
    cases: Vec<GroundTruthCase>,
}

#[derive(Debug, Deserialize)]
struct GroundTruthCase {
    trace: String,
    ir: String,
    expected_compliant: bool,
    #[serde(default)]
    expected_violations: Vec<String>,
}

/// `eval/runner` is `CARGO_MANIFEST_DIR`; the compliance fixtures live one level up, alongside the
/// existing `mutate-change` golden dir.
fn golden_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../golden/compliance")
}

/// The reused IR fixtures (`examples/mutate-agent/…`, `examples/analysis-agent/…`) live at the repo root,
/// two levels up from `eval/runner` — NOT under `eval/`, unlike the trace fixtures above.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn load_ground_truth() -> GroundTruth {
    let path = golden_dir().join("ground_truth.yaml");
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_yaml::from_str(&raw).expect("ground truth parses")
}

fn load_trace(name: &str) -> ComplianceTrace {
    let path = golden_dir().join(name);
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

fn load_ir(relative_to_repo_root: &str) -> ComplianceIr {
    let path = repo_root().join(relative_to_repo_root);
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

#[test]
fn compliance_scorer_matches_every_labelled_golden_trace() {
    let gt = load_ground_truth();
    assert!(
        gt.cases.len() >= 7,
        "want good + one bad fixture per modeled guardrail"
    );

    let mut correct = 0usize;
    for case in &gt.cases {
        let trace = load_trace(&case.trace);
        let ir = load_ir(&case.ir);
        let report = score_compliance(&trace, &ir);

        let actual_violations: BTreeSet<&str> = report
            .checks
            .iter()
            .filter(|c| c.status == CheckStatus::Fail)
            .map(|c| c.guardrail.as_str())
            .collect();
        let expected_violations: BTreeSet<&str> = case
            .expected_violations
            .iter()
            .map(String::as_str)
            .collect();

        let matches =
            report.compliant == case.expected_compliant && actual_violations == expected_violations;
        assert!(
            matches,
            "trace '{}': scorer gave compliant={} violations={:?} but ground truth expects compliant={} violations={:?}",
            case.trace, report.compliant, actual_violations, case.expected_compliant, expected_violations
        );
        if matches {
            correct += 1;
        }
    }

    let compliance_accuracy = correct as f64 / gt.cases.len() as f64;
    assert_eq!(
        compliance_accuracy, 1.0,
        "score_compliance must reproduce every labelled golden trace exactly"
    );
}
