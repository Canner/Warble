//! Phase 3 litmus — execution-based `detection_accuracy` for `monitor_freshness` (eval M6).
//!
//! The core freshness assert is DETERMINISTIC (decision D1): `fresh` iff the newest row is within the
//! cadence. So detection_accuracy is scored WITHOUT an LLM, against synthetic controllable-timestamp
//! ground truth (`eval/golden/monitor-freshness/detection_ground_truth.yaml`) that cannot drift like a
//! live warehouse (eval-framework §7). This test IS the reference oracle: it runs the same comparison
//! the monitor's SQL runs and asserts it reproduces every labelled verdict — proving the assertion is
//! execution-eval, and that the synthetic ground truth is mechanically consistent, not hand-waved.
//!
//! Calibrating the live cheap-judge `assess_severity` against the `expected_severity` labels is
//! runtime-gated (needs the model); the labels themselves are deterministic and are checked here for
//! self-consistency with the assess_severity.md heuristic (warn within ~2x cadence, else critical).

use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct GroundTruth {
    scenarios: Vec<Scenario>,
}

#[derive(Debug, Deserialize)]
struct Scenario {
    id: String,
    lag_hours: f64,
    cadence_hours: f64,
    expected_fresh: bool,
    /// `warn` | `critical` when stale; `None` (YAML `null`) when fresh.
    #[serde(default)]
    expected_severity: Option<String>,
}

/// The deterministic freshness assert the monitor runs in SQL, as pure arithmetic: fresh iff the
/// newest row's lag is within the cadence.
fn assert_fresh(lag_hours: f64, cadence_hours: f64) -> bool {
    lag_hours <= cadence_hours
}

/// The reference severity oracle (assess_severity.md heuristic): no severity when fresh; `warn` when
/// overdue but within ~2x the cadence; `critical` beyond that. This is the label the LLM judge is
/// calibrated against — deterministic here so the calibration target itself never drifts.
fn reference_severity(lag_hours: f64, cadence_hours: f64) -> Option<&'static str> {
    if assert_fresh(lag_hours, cadence_hours) {
        None
    } else if lag_hours <= 2.0 * cadence_hours {
        Some("warn")
    } else {
        Some("critical")
    }
}

fn load_ground_truth() -> GroundTruth {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../golden/monitor-freshness/detection_ground_truth.yaml");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_yaml::from_str(&raw).expect("ground truth parses")
}

#[test]
fn detection_accuracy_is_perfect_on_the_synthetic_ground_truth() {
    let gt = load_ground_truth();
    assert!(gt.scenarios.len() >= 5, "want a mix of fresh + stale scenarios");

    let mut correct = 0usize;
    for s in &gt.scenarios {
        let verdict = assert_fresh(s.lag_hours, s.cadence_hours);
        assert_eq!(
            verdict, s.expected_fresh,
            "scenario '{}': deterministic assert (lag {}h vs cadence {}h) disagrees with the labelled verdict",
            s.id, s.lag_hours, s.cadence_hours
        );
        if verdict == s.expected_fresh {
            correct += 1;
        }
    }
    let detection_accuracy = correct as f64 / gt.scenarios.len() as f64;
    assert_eq!(
        detection_accuracy, 1.0,
        "the deterministic assert must detect every synthetic overdue/fresh case exactly"
    );
}

#[test]
fn severity_reference_labels_match_the_assess_severity_heuristic() {
    // The cheap judge is calibrated against these labels; the labels must themselves be consistent
    // with the documented heuristic, or the calibration target is meaningless.
    let gt = load_ground_truth();
    let mut saw_warn = false;
    let mut saw_critical = false;
    for s in &gt.scenarios {
        let expected = s.expected_severity.as_deref();
        let reference = reference_severity(s.lag_hours, s.cadence_hours);
        assert_eq!(
            expected, reference,
            "scenario '{}': labelled severity {:?} disagrees with the heuristic {:?}",
            s.id, expected, reference
        );
        match reference {
            Some("warn") => saw_warn = true,
            Some("critical") => saw_critical = true,
            _ => {}
        }
    }
    assert!(saw_warn && saw_critical, "want both warn and critical severities represented");
}
