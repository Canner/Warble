//! End-to-end `blast_radius_for_project` + `gate::decide` over the real jaffle-wren project (bound
//! by `examples/monitor-agent`, per `examples/monitor-agent/context/binding.yml` → `../jaffle-wren`).
//! Grounding truth: `bindings/mdl-context/tests/jaffle_wren.rs` and `docs/spec/blast-radius.md` §5.

use std::path::{Path, PathBuf};

use warble::Severity;
use warble_cli::blast_radius_for_project;
use warble_cli::gate::{self, GateDecision, GateThreshold};

fn monitor_agent_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("examples/monitor-agent")
}

#[test]
fn blast_radius_of_orders_reaches_the_revenue_cube_and_is_semantic() {
    let radius = blast_radius_for_project(&monitor_agent_dir(), "model:orders")
        .expect("model:orders must resolve against the bound jaffle-wren project");

    assert_eq!(radius.seed, "model:orders");
    assert!(
        radius.downstream.contains(&"cube:revenue".to_string()),
        "downstream was: {:?}",
        radius.downstream
    );
    assert!(
        radius
            .downstream
            .contains(&"metric:revenue.total_revenue".to_string()),
        "downstream was: {:?}",
        radius.downstream
    );
    assert_eq!(
        radius.severity,
        Severity::Semantic,
        "a downstream metric makes the worst impact semantic"
    );
}

#[test]
fn decide_escalates_when_severity_exceeds_max() {
    let radius = blast_radius_for_project(&monitor_agent_dir(), "model:orders").unwrap();
    let threshold = GateThreshold {
        max_severity: Some(Severity::Structural),
        max_downstream: None,
        protected: vec![],
    };
    let (decision, reason) = gate::decide(&radius, &threshold);
    assert_eq!(decision, GateDecision::Escalate);
    assert!(reason.contains("semantic"), "reason was: {reason}");
}

#[test]
fn decide_blocks_when_a_protected_asset_is_touched() {
    let radius = blast_radius_for_project(&monitor_agent_dir(), "model:orders").unwrap();
    let threshold = GateThreshold {
        max_severity: None,
        max_downstream: None,
        protected: vec!["metric:revenue.total_revenue".to_string()],
    };
    let (decision, reason) = gate::decide(&radius, &threshold);
    assert_eq!(decision, GateDecision::Block);
    assert!(
        reason.contains("metric:revenue.total_revenue"),
        "reason was: {reason}"
    );
}

#[test]
fn blast_radius_of_a_leaf_metric_is_empty_and_allows() {
    let radius = blast_radius_for_project(&monitor_agent_dir(), "metric:revenue.total_revenue")
        .expect("metric:revenue.total_revenue must resolve as a known (leaf) node");
    assert!(radius.downstream.is_empty());
    assert_eq!(radius.severity, Severity::None);

    let (decision, _) = gate::decide(&radius, &GateThreshold::default());
    assert_eq!(decision, GateDecision::Allow);
}

#[test]
fn blast_radius_of_a_nonexistent_seed_is_empty_and_allows() {
    let radius = blast_radius_for_project(&monitor_agent_dir(), "model:does_not_exist")
        .expect("an unknown seed still resolves — just with an empty radius");
    assert!(radius.downstream.is_empty());
    assert_eq!(radius.severity, Severity::None);

    let (decision, _) = gate::decide(&radius, &GateThreshold::default());
    assert_eq!(decision, GateDecision::Allow);
}
