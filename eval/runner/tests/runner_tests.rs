use warble_eval_runner::{aggregate, extract_result, format_pareto, CaseResult, Golden, Report};

fn case(id: &str, tags: &[&str], pass: bool, cost: f64, latency: u64) -> CaseResult {
    CaseResult {
        id: id.to_string(),
        tags: tags.iter().map(|s| s.to_string()).collect(),
        pass,
        reason: if pass {
            "match".into()
        } else {
            "mismatch".into()
        },
        cost,
        latency_ms: latency,
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
    assert!((c.cost_total_usd - 0.30).abs() < 1e-9);
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
        configs: vec![
            aggregate("opus", vec![case("a", &["t"], true, 0.3, 25_000)]),
            aggregate("haiku", vec![case("a", &["t"], true, 0.1, 20_000)]),
        ],
    };
    let table = format_pareto(&report);
    assert!(table.contains("strong→opus"));
    assert!(table.contains("strong→haiku"));
    assert!(table.contains("t:1.00"));
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
