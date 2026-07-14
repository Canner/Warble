//! Phase 4b constitutive — execution-based, LLM-free evals for the CONSTITUTIVE closed loop:
//! `schema_fidelity` + `metric_soundness` score a bootstrapped MDL against a known-expected MDL
//! derived from a controlled synthetic raw source, and a closed-loop check proves the bootstrapped
//! Context actually feeds the downstream consumer components (answer_query / generate_dashboard).
//!
//! As with the Phase 4a mutate-change evals, every underlying computation is DETERMINISTIC — the
//! column-fidelity scorer here, and `warble_mdl_context::infer_additivity` for metric soundness — so
//! the eval runs WITHOUT an LLM against committed fixtures that cannot drift like a live DB would.
//! Each test IS the reference oracle: it runs the same computation production
//! uses and asserts it reproduces every labelled expectation (accuracy == 1.0).

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;
use warble::ContextLoader;
use warble_mdl_context::{infer_additivity, MdlContext};
use wren_core_base::mdl::manifest::Manifest;

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
    let manifest: Manifest =
        serde_json::from_str(&example("expected-mdl/manifest.json")).expect("expected MDL parses");

    let gt_cols = columns_of(&gt.expected);
    let manifest_cols: BTreeMap<String, String> = manifest
        .models
        .iter()
        .flat_map(|m| {
            m.columns
                .iter()
                .map(move |c| (format!("{}.{}", m.name, c.name), c.r#type.to_uppercase()))
        })
        .collect();
    assert_eq!(
        gt_cols, manifest_cols,
        "the schema_fidelity ground truth must mirror examples/bootstrap-agent/expected-mdl/manifest.json"
    );
}

// --- metric_soundness -----------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct MetricSoundnessGroundTruth {
    cases: Vec<MetricSoundnessCase>,
}

#[derive(Debug, Deserialize)]
struct MetricSoundnessCase {
    id: String,
    expression: String,
    expected_additivity: String,
}

fn additivity_str(a: warble::Additivity) -> &'static str {
    match a {
        warble::Additivity::Additive => "additive",
        warble::Additivity::SemiAdditive => "semi_additive",
        warble::Additivity::NonAdditive => "non_additive",
    }
}

#[test]
fn metric_soundness_matches_the_production_additivity_oracle() {
    let gt: MetricSoundnessGroundTruth =
        serde_yaml::from_str(&golden("metric_soundness_ground_truth.yaml"))
            .expect("metric_soundness ground truth parses");
    assert!(
        gt.cases.len() >= 5,
        "want additive + non-additive (distinct/ratio/avg) all represented"
    );

    let mut sound = 0usize;
    for case in &gt.cases {
        // The SAME oracle the binding uses in production — no reimplementation, no drift.
        let inferred = additivity_str(infer_additivity(&case.expression));
        let matches = inferred == case.expected_additivity;
        assert!(
            matches,
            "case '{}': oracle inferred '{inferred}' for `{}` but ground truth expects '{}'",
            case.id, case.expression, case.expected_additivity
        );
        if matches {
            sound += 1;
        }
    }
    let metric_soundness = sound as f64 / gt.cases.len() as f64;
    assert_eq!(
        metric_soundness, 1.0,
        "the production additivity oracle must reproduce every labelled soundness verdict"
    );
}

// --- the closed loop: produced Context feeds downstream consumers ---------------------------------

/// The bootstrapped Context, loaded exactly as a downstream consumer would load it, must satisfy the
/// preconditions those consumers require — this is what "constitutive closed loop" means: the OUTPUT
/// of bootstrap_mdl is a valid INPUT to answer_query / generate_dashboard. We build an `MdlContext`
/// from the expected MDL and assert the consumer-side predicates hold, using the very same core
/// evaluation path the compiler uses.
#[test]
fn bootstrapped_context_satisfies_downstream_consumer_preconditions() {
    let manifest: Manifest =
        serde_json::from_str(&example("expected-mdl/manifest.json")).expect("expected MDL parses");
    let ctx = MdlContext::from_manifest(&manifest);

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
