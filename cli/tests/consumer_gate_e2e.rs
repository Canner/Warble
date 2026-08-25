//! Gate e2e over **consumer nodes** (the follow-on to `mutating_e2e.rs`): with driftwood-wren's
//! consumer fixtures in the graph, `--protected dashboard:<name>` is now a real, enforceable
//! guardrail — a change whose radius reaches the dashboard hard-blocks (exit 11), while a change
//! that never touches it passes untouched. `gate.rs` itself is unchanged by consumer lineage; the
//! richer graph alone is what makes the gate stronger.

use std::path::{Path, PathBuf};
use std::process::Command;

fn driftwood_agent_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("examples/driftwood-agent")
}

fn blast_radius(args: &[&str]) -> (Option<i32>, serde_json::Value) {
    let output = Command::new(env!("CARGO_BIN_EXE_warble"))
        .arg("blast-radius")
        .arg(driftwood_agent_dir())
        .args(args)
        .output()
        .expect("warble blast-radius runs");
    let json = serde_json::from_slice(&output.stdout).unwrap_or_else(|e| {
        panic!(
            "blast-radius must print JSON; parse failed: {e}; stdout: {}; stderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    });
    (output.status.code(), json)
}

#[test]
fn protecting_a_dashboard_blocks_a_change_that_reaches_it() {
    // subscription_snapshots → cube:mrr_metrics → metric:mrr_metrics.mrr → dashboard:exec-weekly:
    // the motivating sentence, enforced — "this change is depended on by a dashboard" → exit 11.
    let (code, json) = blast_radius(&[
        "--node",
        "model:subscription_snapshots",
        "--protected",
        "dashboard:exec-weekly",
    ]);
    assert_eq!(code, Some(11), "block must exit 11; json: {json}");
    assert_eq!(json["decision"], "block");
    let downstream: Vec<&str> = json["downstream"]
        .as_array()
        .expect("downstream is an array")
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(
        downstream.contains(&"dashboard:exec-weekly"),
        "downstream was: {downstream:?}"
    );
    assert!(
        downstream.contains(&"query:mrr-trend"),
        "the confirmed query rides the same radius; downstream was: {downstream:?}"
    );
}

#[test]
fn a_change_that_never_reaches_the_dashboard_is_allowed() {
    // active_subscriptions is declared on the cube but consumed by nothing — an empty radius, so
    // the same protection does not fire.
    let (code, json) = blast_radius(&[
        "--node",
        "metric:mrr_metrics.active_subscriptions",
        "--protected",
        "dashboard:exec-weekly",
    ]);
    assert_eq!(code, Some(0), "allow must exit 0; json: {json}");
    assert_eq!(json["decision"], "allow");
}

#[test]
fn consumer_severity_is_semantic_for_the_metrics_own_radius() {
    // A metric consumed by a query + dashboard: its radius is exactly those consumers, and the
    // worst impact is semantic (the end user's numbers shift silently, nothing errors).
    let (code, json) = blast_radius(&["--node", "metric:mrr_metrics.mrr"]);
    assert_eq!(code, Some(0), "no threshold flags → allow; json: {json}");
    assert_eq!(json["severity"], "semantic");
    let downstream: Vec<&str> = json["downstream"]
        .as_array()
        .expect("downstream is an array")
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(downstream, vec!["dashboard:exec-weekly", "query:mrr-trend"]);
}
