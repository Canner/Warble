//! Phase 4a mutating — execution-based, LLM-free evals for `blast_radius` and the change-safety
//! gate that will guard a mutating `edit_pipeline` apply.
//!
//! Both underlying computations are DETERMINISTIC: `LineageGraph::blast_radius` is a pure graph
//! traversal (`core/src/context.rs`), and the gate is pure policy over an already-computed radius
//! (`cli/src/gate.rs::decide`). So — mirroring the Phase 3 litmus precedent
//! (`freshness_detection.rs`) — both evals are scored WITHOUT an LLM, against a synthetic, inline
//! lineage graph that cannot drift like a live semantic layer would (eval-framework §7). Each test
//! IS the reference oracle: it runs the same computation the production code runs and asserts it
//! reproduces every labelled expectation (accuracy == 1.0).

use std::path::Path;

use serde::Deserialize;
use warble::{BlastRadius, LineageEdge, LineageGraph, LineageKind, LineageNode, Severity};

// --- shared graph shape ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct Node {
    id: String,
    kind: String,
}

#[derive(Debug, Deserialize)]
struct Edge {
    from: String,
    to: String,
}

#[derive(Debug, Deserialize)]
struct Graph {
    nodes: Vec<Node>,
    edges: Vec<Edge>,
}

/// Map a golden `kind:` string to the core [`LineageKind`] variant it names.
fn parse_kind(s: &str) -> LineageKind {
    match s {
        "Model" => LineageKind::Model,
        "Column" => LineageKind::Column,
        "Relationship" => LineageKind::Relationship,
        "Cube" => LineageKind::Cube,
        "Metric" => LineageKind::Metric,
        "Dimension" => LineageKind::Dimension,
        "View" => LineageKind::View,
        other => panic!("unknown LineageKind '{other}' in golden graph"),
    }
}

/// Build a `warble::LineageGraph` from the golden `graph:` block.
fn build_graph(g: &Graph) -> LineageGraph {
    LineageGraph {
        nodes: g
            .nodes
            .iter()
            .map(|n| LineageNode {
                id: n.id.clone(),
                kind: parse_kind(&n.kind),
            })
            .collect(),
        edges: g
            .edges
            .iter()
            .map(|e| LineageEdge {
                from: e.from.clone(),
                to: e.to.clone(),
            })
            .collect(),
    }
}

/// Human-readable name for a [`Severity`] (matches `cli::gate::severity_str`).
fn severity_str(s: Severity) -> &'static str {
    match s {
        Severity::None => "none",
        Severity::Compatibility => "compatibility",
        Severity::Structural => "structural",
        Severity::Semantic => "semantic",
    }
}

/// Parse a [`Severity`] from its human-readable name (the inverse of [`severity_str`]).
fn parse_severity(s: &str) -> Severity {
    match s {
        "none" => Severity::None,
        "compatibility" => Severity::Compatibility,
        "structural" => Severity::Structural,
        "semantic" => Severity::Semantic,
        other => panic!("unknown severity '{other}' in golden case"),
    }
}

// --- blast_radius_accuracy ------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct BlastRadiusGroundTruth {
    graph: Graph,
    cases: Vec<BlastRadiusCase>,
}

#[derive(Debug, Deserialize)]
struct BlastRadiusCase {
    id: String,
    seed: String,
    expected_downstream: Vec<String>,
    expected_severity: String,
}

fn load_blast_radius_ground_truth() -> BlastRadiusGroundTruth {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../golden/mutate-change/blast_radius_ground_truth.yaml");
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_yaml::from_str(&raw).expect("ground truth parses")
}

#[test]
fn blast_radius_accuracy_matches_core_oracle() {
    let gt = load_blast_radius_ground_truth();
    assert!(
        gt.cases.len() >= 5,
        "want a mix of downstream shapes and severities"
    );
    let graph = build_graph(&gt.graph);

    let mut correct = 0usize;
    for case in &gt.cases {
        let radius = graph.blast_radius(&case.seed);
        let severity = severity_str(radius.severity);
        let matches =
            radius.downstream == case.expected_downstream && severity == case.expected_severity;
        assert!(
            matches,
            "case '{}': core oracle gave downstream={:?} severity={} but ground truth expects downstream={:?} severity={}",
            case.id, radius.downstream, severity, case.expected_downstream, case.expected_severity
        );
        if matches {
            correct += 1;
        }
    }
    let blast_radius_accuracy = correct as f64 / gt.cases.len() as f64;
    assert_eq!(
        blast_radius_accuracy, 1.0,
        "core's blast_radius must reproduce every labelled case exactly"
    );
}

// --- change_safety ---------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ChangeSafetyGroundTruth {
    graph: Graph,
    cases: Vec<ChangeSafetyCase>,
}

#[derive(Debug, Deserialize)]
struct ChangeSafetyCase {
    id: String,
    seed: String,
    #[serde(default)]
    max_severity: Option<String>,
    #[serde(default)]
    max_downstream: Option<usize>,
    #[serde(default)]
    protected: Vec<String>,
    expected_verdict: String,
}

fn load_change_safety_ground_truth() -> ChangeSafetyGroundTruth {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../golden/mutate-change/change_safety_ground_truth.yaml");
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_yaml::from_str(&raw).expect("ground truth parses")
}

/// The gate decision, mirroring `cli::gate::GateDecision` (kept local so this eval doesn't need to
/// depend on the `cli` crate — only on `warble`, the core type the gate is computed over).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    Allow,
    Escalate,
    Block,
}

impl Verdict {
    fn as_str(self) -> &'static str {
        match self {
            Verdict::Allow => "allow",
            Verdict::Escalate => "escalate",
            Verdict::Block => "block",
        }
    }
}

/// Reference gate oracle. Mirrors `cli::gate::decide`'s policy exactly, in the same order (first
/// match wins) — this must not drift from the production gate:
/// 1. empty radius -> allow
/// 2. seed or any downstream node in `protected` -> block
/// 3. `max_severity` set and `radius.severity > max_severity` -> escalate
/// 4. `max_downstream` set and `radius.downstream.len() > max_downstream` -> escalate
/// 5. otherwise -> allow
fn reference_gate(
    radius: &BlastRadius,
    max_severity: Option<Severity>,
    max_downstream: Option<usize>,
    protected: &[String],
) -> Verdict {
    if radius.downstream.is_empty() {
        return Verdict::Allow;
    }
    if std::iter::once(&radius.seed)
        .chain(radius.downstream.iter())
        .any(|id| protected.contains(id))
    {
        return Verdict::Block;
    }
    if let Some(max) = max_severity {
        if radius.severity > max {
            return Verdict::Escalate;
        }
    }
    if let Some(max) = max_downstream {
        if radius.downstream.len() > max {
            return Verdict::Escalate;
        }
    }
    Verdict::Allow
}

#[test]
fn change_safety_gate_matches_reference_oracle() {
    let gt = load_change_safety_ground_truth();
    assert!(
        gt.cases.len() >= 5,
        "want allow, escalate, and block all represented"
    );
    let graph = build_graph(&gt.graph);

    let mut correct = 0usize;
    for case in &gt.cases {
        let radius = graph.blast_radius(&case.seed);
        let max_severity = case.max_severity.as_deref().map(parse_severity);
        let verdict = reference_gate(&radius, max_severity, case.max_downstream, &case.protected);
        let matches = verdict.as_str() == case.expected_verdict;
        assert!(
            matches,
            "case '{}': reference gate gave '{}' but ground truth expects '{}'",
            case.id,
            verdict.as_str(),
            case.expected_verdict
        );
        if matches {
            correct += 1;
        }
    }
    let change_safety_accuracy = correct as f64 / gt.cases.len() as f64;
    assert_eq!(
        change_safety_accuracy, 1.0,
        "the reference gate must reproduce every labelled verdict exactly"
    );
}
