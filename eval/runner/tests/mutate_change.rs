//! Phase 4a mutating — an execution-based, LLM-free eval for the change-safety gate that guards a
//! mutating `edit_pipeline` apply.
//!
//! **What this scores, stated precisely.** The gate is pure policy over an impact the bound layer
//! supplied, so it can be scored without an LLM against a synthetic fixture that cannot drift. What
//! runs here is an **independent reimplementation** of that policy (`reference_gate` below), not the
//! shipped `cli::gate::decide`.
//!
//! So this eval proves the policy **as specified in the golden** is self-consistent and reproduces
//! every labelled verdict. It does **not** prove the shipped gate agrees with that specification —
//! a divergence between `decide` and `reference_gate` would leave this eval green. Do not read a
//! passing run as coverage of the production gate.
//!
//! Why it is not simply repointed: `warble-cli` depends on `warble-eval-runner`, so calling into it
//! from here needs a dev-dependency back-edge. Cargo permits that (dev-deps are outside a published
//! crate's consumer graph) and it was measured to build, so this is a scope call rather than an
//! impossibility — it alters two publishable crates' dependency graph, which does not belong in a
//! change about deleting a traversal. Tracked separately.
//!
//! The blast-radius half of this file is gone with the traversal it scored: Warble no longer
//! computes a downstream closure, so there is no Warble computation left to score against
//! hand-labelled reachability. The layer's owner computes it, and the `impact:` block below is that
//! owner's answer, in the shape the prepared-context document carries.

use std::path::Path;

use serde::Deserialize;
use warble::{HostImpact, LineageEdge, LineageGraph, LineageKind, LineageNode, RankedSeverity};

// --- golden shapes --------------------------------------------------------------------------------

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

#[derive(Debug, Deserialize)]
struct GoldenSeverity {
    rank: u32,
    name: String,
}

#[derive(Debug, Deserialize)]
struct GoldenImpact {
    severity: GoldenSeverity,
    downstream: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ChangeSafetyGroundTruth {
    graph: Graph,
    impact: std::collections::BTreeMap<String, GoldenImpact>,
    cases: Vec<ChangeSafetyCase>,
}

#[derive(Debug, Deserialize)]
struct ChangeSafetyCase {
    id: String,
    seed: String,
    #[serde(default)]
    max_severity_rank: Option<u32>,
    #[serde(default)]
    max_downstream: Option<usize>,
    #[serde(default)]
    protected: Vec<String>,
    expected_verdict: String,
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
        "Query" => LineageKind::Query,
        "Dashboard" => LineageKind::Dashboard,
        other => panic!("unknown LineageKind '{other}' in golden graph"),
    }
}

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

fn load_change_safety_ground_truth() -> ChangeSafetyGroundTruth {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../golden/mutate-change/change_safety_ground_truth.yaml");
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_yaml::from_str(&raw).expect("ground truth parses")
}

/// The golden's reported impact for `seed`, in the core shape the gate consumes.
fn impact_of(gt: &ChangeSafetyGroundTruth, seed: &str) -> HostImpact {
    let reported = gt
        .impact
        .get(seed)
        .unwrap_or_else(|| panic!("the golden's `impact:` block must report seed '{seed}'"));
    HostImpact {
        downstream: reported.downstream.clone(),
        severity: RankedSeverity {
            rank: reported.severity.rank,
            name: reported.severity.name.clone(),
        },
    }
}

// --- the policy under test ------------------------------------------------------------------------

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

/// An independent reimplementation of the gate policy, in evaluation order (first match wins):
/// 1. empty radius -> allow
/// 2. seed or any downstream node in `protected` -> block
/// 3. `max_severity_rank` set and the reported rank exceeds it -> escalate
/// 4. `max_downstream` set and the downstream count exceeds it -> escalate
/// 5. otherwise -> allow
///
/// It is **not** `cli::gate::decide` and nothing here checks that the two agree — see the module
/// header for why this crate cannot call the shipped gate. Treat a divergence as undetected by this
/// file rather than as ruled out by it.
fn reference_gate(
    seed: &str,
    impact: &HostImpact,
    max_severity_rank: Option<u32>,
    max_downstream: Option<usize>,
    protected: &[String],
) -> Verdict {
    if impact.downstream.is_empty() {
        return Verdict::Allow;
    }
    if std::iter::once(&seed.to_string())
        .chain(impact.downstream.iter())
        .any(|id| protected.contains(id))
    {
        return Verdict::Block;
    }
    if let Some(max) = max_severity_rank {
        if impact.severity.rank > max {
            return Verdict::Escalate;
        }
    }
    if let Some(max) = max_downstream {
        if impact.downstream.len() > max {
            return Verdict::Escalate;
        }
    }
    Verdict::Allow
}

// --- the eval -------------------------------------------------------------------------------------

#[test]
fn change_safety_gate_matches_the_specified_policy() {
    let gt = load_change_safety_ground_truth();
    assert!(
        gt.cases.len() >= 5,
        "want allow, escalate, and block all represented"
    );

    let mut correct = 0usize;
    for case in &gt.cases {
        let impact = impact_of(&gt, &case.seed);
        let verdict = reference_gate(
            &case.seed,
            &impact,
            case.max_severity_rank,
            case.max_downstream,
            &case.protected,
        );
        let matches = verdict.as_str() == case.expected_verdict;
        assert!(
            matches,
            "case '{}': the policy gave '{}' but ground truth expects '{}'",
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
        "the policy must reproduce every labelled verdict exactly"
    );
}

/// The golden's `graph:` block is not dead data: every node the `impact:` block reports on must
/// exist in it, and the graph must satisfy the same structural condition Warble checks on a real
/// binding. Without this, a seed could be renamed in one block and not the other and every case
/// would still pass.
#[test]
fn the_golden_graph_is_resolvable_and_covers_every_reported_seed() {
    let gt = load_change_safety_ground_truth();
    let graph = build_graph(&gt.graph);

    assert!(
        graph.is_resolvable(),
        "every edge endpoint must be a declared node — the `lineage_resolvable` condition"
    );
    for seed in gt.impact.keys() {
        assert!(
            graph.contains(seed),
            "the `impact:` block reports on '{seed}', which the graph does not declare"
        );
    }
    for case in &gt.cases {
        assert!(
            gt.impact.contains_key(&case.seed),
            "case '{}' seeds on '{}', which the `impact:` block does not report",
            case.id,
            case.seed
        );
    }
}
