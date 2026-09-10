//! Phase 4b constitutive — execution-based, LLM-free evals for the CONSTITUTIVE closed loop:
//! `schema_fidelity` scores a bootstrapped MDL against a known-expected MDL derived from a
//! controlled synthetic raw source, and a closed-loop check proves that Context, once prepared,
//! satisfies the preconditions the downstream consumer components require (answer_query /
//! generate_dashboard).
//!
//! As with the Phase 4a mutate-change evals, the column-fidelity scorer is DETERMINISTIC, so the
//! eval runs WITHOUT an LLM against committed fixtures that cannot drift like a live DB would. The
//! fidelity test IS the reference oracle: it runs the same computation production uses and asserts
//! it reproduces every labelled expectation (accuracy == 1.0).
//!
//! **What this file no longer claims.** It once scored metric soundness by calling the MDL
//! adapter's additivity oracle directly. Warble reads no semantic format any more, so the oracle
//! left with the adapter and that eval retired rather than being reimplemented here — a local copy
//! would have kept every gate green while silently drifting from the classification the producing
//! host actually applies. Additivity is now checked only as the prepared document *reports* it.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;
use warble::{ContextLoader, PreparedContext};

fn golden(rel: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../golden/bootstrap-context")
        .join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn example(rel: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/bootstrap-agent")
        .join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

// --- schema_fidelity ------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct Column {
    name: String,
    #[serde(rename = "type")]
    col_type: String,
}

#[derive(Debug, Deserialize)]
struct Model {
    name: String,
    columns: Vec<Column>,
}

#[derive(Debug, Deserialize)]
struct Mdl {
    models: Vec<Model>,
}

#[derive(Debug, Deserialize)]
struct SchemaFidelityGroundTruth {
    expected: Mdl,
    cases: Vec<SchemaFidelityCase>,
}

#[derive(Debug, Deserialize)]
struct SchemaFidelityCase {
    id: String,
    produced: Mdl,
    expected_correct: usize,
    expected_total: usize,
}

/// Flatten an MDL into a `{model.column -> TYPE}` map (types upper-cased so the compare is
/// case-insensitive). This is the shape the fidelity scorer compares over.
fn columns_of(mdl: &Mdl) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for model in &mdl.models {
        for col in &model.columns {
            map.insert(
                format!("{}.{}", model.name, col.name),
                col.col_type.to_uppercase(),
            );
        }
    }
    map
}

/// The fidelity oracle: `(correct, total)` where `total` is the number of expected columns and
/// `correct` is how many are present in `produced` under the same model with a matching type.
fn schema_fidelity(expected: &Mdl, produced: &Mdl) -> (usize, usize) {
    let exp = columns_of(expected);
    let prod = columns_of(produced);
    let total = exp.len();
    let correct = exp
        .iter()
        .filter(|(key, ty)| prod.get(*key).map(|p| p == *ty).unwrap_or(false))
        .count();
    (correct, total)
}

#[test]
fn schema_fidelity_scorer_reproduces_every_labelled_case() {
    let gt: SchemaFidelityGroundTruth =
        serde_yaml::from_str(&golden("schema_fidelity_ground_truth.yaml"))
            .expect("schema_fidelity ground truth parses");
    assert!(
        gt.cases.len() >= 4,
        "want faithful + missing-column + wrong-type + missing-table"
    );

    let mut reproduced = 0usize;
    for case in &gt.cases {
        let (correct, total) = schema_fidelity(&gt.expected, &case.produced);
        assert_eq!(
            (correct, total),
            (case.expected_correct, case.expected_total),
            "case '{}': scorer gave ({correct}/{total}) but ground truth expects ({}/{})",
            case.id,
            case.expected_correct,
            case.expected_total
        );
        reproduced += 1;
    }
    assert_eq!(reproduced, gt.cases.len());

    // The headline: a faithful bootstrap scores fidelity 1.0.
    let faithful = gt.cases.iter().find(|c| c.id == "faithful").unwrap();
    let (correct, total) = schema_fidelity(&gt.expected, &faithful.produced);
    assert_eq!(
        correct, total,
        "a faithful bootstrap must score fidelity 1.0"
    );
}

/// The committed expected-mdl fixture must agree with the ground-truth `expected:` block — otherwise
/// the eval would score against a phantom MDL, not the one bootstrap is meant to produce.
#[test]
fn expected_mdl_fixture_matches_ground_truth() {
    let gt: SchemaFidelityGroundTruth =
        serde_yaml::from_str(&golden("schema_fidelity_ground_truth.yaml")).unwrap();
    // Parsed through this file's own `Mdl` projection rather than a semantic-format manifest type:
    // the comparison is over `{model.column -> TYPE}`, which is all either side needs, and it keeps
    // the eval free of any format library.
    let manifest: Mdl =
        serde_json::from_str(&example("expected-mdl/manifest.json")).expect("expected MDL parses");

    assert_eq!(
        columns_of(&gt.expected),
        columns_of(&manifest),
        "the schema_fidelity ground truth must mirror examples/bootstrap-agent/expected-mdl/manifest.json"
    );
}

// --- the closed loop: produced Context feeds downstream consumers ---------------------------------

/// The bootstrapped Context, loaded exactly as a downstream consumer would load it, must satisfy
/// the preconditions those consumers require — this is what "constitutive closed loop" means: the
/// OUTPUT of bootstrap_mdl is a valid INPUT to answer_query / generate_dashboard.
///
/// Scope, stated precisely because the honest scope is narrower than it was. This asserts that
/// **warble's consumer-precondition logic holds over a prepared context**, NOT that a bootstrap run
/// produces a sound one. Warble no longer reads a semantic format, so it cannot re-derive the
/// document from `expected-mdl/manifest.json`; the committed document is a frozen projection,
/// generated by the MDL adapter over that manifest before the adapter moved out of this repo.
/// Whether a bootstrap still produces *that* projection is a claim only the producing host can
/// make, and it belongs to the host's own tests.
#[test]
fn a_prepared_bootstrapped_context_satisfies_downstream_consumer_preconditions() {
    let ctx = PreparedContext::from_json(&golden("expected_mdl_prepared_context.json"))
        .expect("the committed prepared-context document loads");

    // The bootstrapped Context parses and carries queryable structure.
    assert!(ctx.is_parseable(), "bootstrapped MDL must parse");
    assert!(
        !ctx.metrics().is_empty(),
        "has_metric: bootstrapped MDL exposes queryable metrics (answer_query needs this)"
    );
    assert!(
        !ctx.time_dimensions().is_empty(),
        "has_time_dimension: bootstrapped MDL exposes a time dimension (explain_change/dashboards need this)"
    );

    // metric_additive (existential) is ANSWERABLE and TRUE — the revenue cube's SUM(amount) is a
    // declared additive measure, so explain_change's decomposition precondition would pass. This is
    // the constitutive → consumer handoff the whole family exists to enable.
    assert!(
        ctx.can_answer("metric_additive"),
        "the bootstrapped cube declares a measure, so metric_additive is answerable"
    );
    let total_revenue = ctx
        .metrics()
        .iter()
        .find(|m| m.name == "total_revenue")
        .expect("the revenue cube's total_revenue measure is bootstrapped");
    assert!(
        total_revenue.declared,
        "total_revenue is a declared measure"
    );
    assert_eq!(
        total_revenue.additivity,
        Some(warble::Additivity::Additive),
        "SUM(amount) is additive — decomposition-safe for downstream consumers"
    );
}
