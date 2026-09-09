//! End-to-end `blast_radius_for_project` + `gate::decide` over the real jaffle-wren project (bound
//! by `examples/monitor-agent`, per `examples/monitor-agent/context/binding.yml` → `../jaffle-wren`).
//! Grounding truth: `bindings/mdl-context/tests/jaffle_wren.rs` and `docs/spec/blast-radius.md` §5.

use std::path::{Path, PathBuf};

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
        .expect("model:orders must resolve against the bound jaffle-wren project")
        .expect("model:orders is a declared node, so the layer's analysis covers it");
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
    // The rank is what warble acts on; the name is the layer's own word for it, carried through.
    assert_eq!(
        radius.severity.rank, 3,
        "a downstream metric makes the worst impact the layer's top rank"
    );
    assert_eq!(radius.severity.name, "semantic");
}

#[test]
fn decide_escalates_when_severity_exceeds_max() {
    let impact = blast_radius_for_project(&monitor_agent_dir(), "model:orders")
        .unwrap()
        .expect("a declared node is covered by the analysis");
    let threshold = GateThreshold {
        max_severity_rank: Some(2),
        max_downstream: None,
        protected: vec![],
    };
    let (decision, reason) = gate::decide("model:orders", Some(&impact), &threshold);
    assert_eq!(decision, GateDecision::Escalate);
    assert!(reason.contains("semantic"), "reason was: {reason}");
}

#[test]
fn decide_blocks_when_a_protected_asset_is_touched() {
    let impact = blast_radius_for_project(&monitor_agent_dir(), "model:orders")
        .unwrap()
        .expect("a declared node is covered by the analysis");
    let threshold = GateThreshold {
        max_severity_rank: None,
        max_downstream: None,
        protected: vec!["metric:revenue.total_revenue".to_string()],
    };
    let (decision, reason) = gate::decide("model:orders", Some(&impact), &threshold);
    assert_eq!(decision, GateDecision::Block);
    assert!(
        reason.contains("metric:revenue.total_revenue"),
        "reason was: {reason}"
    );
}

#[test]
fn blast_radius_of_a_leaf_metric_is_empty_and_allows() {
    let impact = blast_radius_for_project(&monitor_agent_dir(), "metric:revenue.total_revenue")
        .expect("metric:revenue.total_revenue must resolve as a known (leaf) node")
        .expect("a declared leaf is still covered by the analysis");
    assert!(impact.downstream.is_empty());
    assert_eq!(impact.severity.rank, 0);

    let (decision, _) = gate::decide(
        "metric:revenue.total_revenue",
        Some(&impact),
        &GateThreshold::default(),
    );
    assert_eq!(decision, GateDecision::Allow);
}

#[test]
fn blast_radius_of_a_nonexistent_seed_is_empty_and_allows() {
    // An id the layer never declared is answered, not refused: the analysis simply has no entry
    // for it, which the gate reads as nothing downstream.
    let impact = blast_radius_for_project(&monitor_agent_dir(), "model:does_not_exist")
        .expect("an unknown seed still resolves");
    assert!(impact.is_none());

    let (decision, _) = gate::decide(
        "model:does_not_exist",
        impact.as_ref(),
        &GateThreshold::default(),
    );
    assert_eq!(decision, GateDecision::Allow);
}
