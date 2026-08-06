use warble_eval_compare::{compare, CompareRequest, MatchMode};
use warble_eval_runner::{
    aggregate, extract_result, format_pareto, Backend, CaseResult, Golden, Report,
};

/// A case at `samples == 1` — today's ordinary single-run shape (never flaky at N=1), so
/// `aggregate`/`format_pareto` behave identically to the pre-repeated-sampling formulas.
fn case(id: &str, tags: &[&str], pass: bool, cost: f64, latency: u64) -> CaseResult {
    CaseResult {
        id: id.to_string(),
        tags: tags.iter().map(|s| s.to_string()).collect(),
        samples: 1,
        passes: if pass { 1 } else { 0 },
        pass_rate: if pass { 1.0 } else { 0.0 },
        pass,
        flaky: false,
        reason: if pass {
            "match".into()
        } else {
            "mismatch".into()
        },
        cost: Some(cost),
        latency_ms: latency,
        turns: Some(0),
        cache_hits: 0,
        cache_misses: 1,
        samples_detail: Vec::new(),
        answer_dist: None,
    }
}

#[test]
fn extract_result_from_fenced_json() {
    let text = "Here is the answer:\n```json\n{\"columns\":[\"n\"],\"rows\":[[42]]}\n```\ndone.";
    let t = extract_result(text).expect("table");
    assert_eq!(t.columns, vec!["n"]);
    assert_eq!(t.rows.len(), 1);
}

#[test]
fn extract_result_from_bare_object_in_prose() {
    let text = "the result is {\"columns\":[\"a\",\"b\"],\"rows\":[[1,2],[3,4]]} ok";
    let t = extract_result(text).expect("table");
    assert_eq!(t.columns, vec!["a", "b"]);
    assert_eq!(t.rows.len(), 2);
}

#[test]
fn extract_result_rejects_object_without_rows() {
    assert!(extract_result("{\"columns\":[\"n\"]}").is_none());
    assert!(extract_result("no json here").is_none());
}

#[test]
fn aggregate_computes_accuracy_cost_latency_and_by_tag() {
    let rows = vec![
        case("a", &["simple"], true, 0.10, 20_000),
        case("b", &["simple", "join"], false, 0.05, 40_000),
        case("c", &["join"], true, 0.15, 30_000),
    ];
    let c = aggregate("haiku", rows);
    assert_eq!(c.model, "haiku");
    assert_eq!(c.n, 3);
    assert!((c.accuracy - 2.0 / 3.0).abs() < 1e-9);
    assert!((c.cost_total_usd.expect("cost present") - 0.30).abs() < 1e-9);
    assert_eq!(c.latency_ms_avg, 30_000); // (20+40+30)/3 k
    assert_eq!(c.by_tag["simple"].n, 2);
    assert_eq!(c.by_tag["simple"].pass, 1);
    assert_eq!(c.by_tag["join"].n, 2);
    assert_eq!(c.by_tag["join"].pass, 1); // b failed, c passed
}

#[test]
fn aggregate_handles_empty() {
    let c = aggregate("opus", vec![]);
    assert_eq!(c.n, 0);
    assert_eq!(c.accuracy, 0.0);
    assert_eq!(c.latency_ms_avg, 0);
}

#[test]
fn format_pareto_lists_each_binding() {
    let report = Report {
        dataset: Some("jaffle".into()),
        context_version: None,
        context_injection: None,
        parallel: 1,
        selected_cases: 1,
        total_cases: 1,
        configs: vec![
            aggregate("opus", vec![case("a", &["t"], true, 0.3, 25_000)]),
            aggregate("haiku", vec![case("a", &["t"], true, 0.1, 20_000)]),
        ],
        backend: Backend::default(),
    };
    let table = format_pareto(&report);
    assert!(table.contains("strong→opus"));
    assert!(table.contains("strong→haiku"));
    assert!(table.contains("t:1.00"));
}

#[test]
fn committed_goldens_all_parse() {
    // Every golden file shipped in eval/golden/ must deserialize into the runner's Golden schema
    // (so the eval loop can actually run them once a queryable project is injected). Includes the
    // Phase 1.2 fixtures: explore_model coverage, generate_dashboard panels, explain_change drivers.
    let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../golden");
    let cases: &[(&str, usize)] = &[
        ("jaffle/cases.yaml", 8),
        ("jaffle/hard.yaml", 6),
        ("jaffle/coverage.yaml", 1),
        ("jaffle/dashboard_panels.yaml", 3),
        ("explain-change/drivers.yaml", 1),
        ("driftwood/cases.yaml", 53),
    ];
    for (rel, expected_n) in cases {
        let text = std::fs::read_to_string(base.join(rel))
            .unwrap_or_else(|e| panic!("read golden {rel}: {e}"));
        let g: Golden =
            serde_yaml::from_str(&text).unwrap_or_else(|e| panic!("parse golden {rel}: {e}"));
        assert_eq!(g.cases.len(), *expected_n, "case count for {rel}");
        for c in &g.cases {
            assert!(
                !c.expected.columns.is_empty(),
                "{rel}/{}: expected columns",
                c.id
            );
            assert!(!c.expected.rows.is_empty(), "{rel}/{}: expected rows", c.id);
        }
    }
}

#[test]
fn new_driftwood_multi_row_cases_exercise_set_and_ordered_comparison() {
    let golden: Golden = serde_yaml::from_str(include_str!("../../golden/driftwood/cases.yaml"))
        .expect("parse committed Driftwood golden");
    let expected_ids = [
        "g45_orders_by_year",
        "g46_legacy_value_by_year",
        "g47_mrr_by_month_2025",
        "g48_orders_by_fy2024_quarter",
        "g49_legacy_orders_by_utc_week",
        "g50_unreconciled_by_month_2025",
        "g51_buyers_by_channel_2025",
        "g52_legacy_shipped_by_year",
        "g53_returned_units_by_disposition_2025",
        "g54_top5_products_by_units_2025",
    ];
    let new_cases: Vec<_> = golden
        .cases
        .iter()
        .filter(|case| expected_ids.contains(&case.id.as_str()))
        .collect();

    assert_eq!(new_cases.len(), 10, "exactly the ten added cases");
    assert_eq!(
        new_cases
            .iter()
            .filter(|case| matches!(case.match_mode, MatchMode::Set))
            .count(),
        4,
        "four unordered grouped-result cases"
    );
    assert_eq!(
        new_cases
            .iter()
            .filter(|case| matches!(case.match_mode, MatchMode::Ordered))
            .count(),
        6,
        "six ordered time-series or ranking cases"
    );
    assert!(
        new_cases.iter().all(|case| case.expected.rows.len() > 1),
        "every new case is genuinely multi-row"
    );

    for case in new_cases {
        let mut permuted = case.expected.clone();
        permuted.rows.reverse();
        let pass = compare(&CompareRequest {
            match_mode: case.match_mode,
            tolerance: case.tolerance,
            expected: case.expected.clone(),
            actual: permuted,
        })
        .pass;
        match case.match_mode {
            MatchMode::Set => assert!(pass, "{}: set accepts a row permutation", case.id),
            MatchMode::Ordered => assert!(!pass, "{}: ordered rejects a row permutation", case.id),
            MatchMode::Scalar => panic!("{}: expected a multi-row match mode", case.id),
        }
    }
}

#[test]
fn golden_yaml_parses_into_cases() {
    let yaml = r#"
dataset: jaffle_shop
context_version: v1
cases:
  - id: total_customers
    question: "How many customers?"
    tags: [simple-agg]
    match: scalar
    tolerance: { numeric: 0.0 }
    expected: { columns: [total_customers], rows: [[100]] }
"#;
    let g: Golden = serde_yaml::from_str(yaml).expect("parse golden");
    assert_eq!(g.dataset.as_deref(), Some("jaffle_shop"));
    assert_eq!(g.cases.len(), 1);
    assert_eq!(g.cases[0].id, "total_customers");
    assert_eq!(g.cases[0].expected.columns, vec!["total_customers"]);
}
