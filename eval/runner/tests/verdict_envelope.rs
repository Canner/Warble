//! Verdict-envelope scoring — the +Assertive twin of the Table-scoring path (`trace_cache.rs`,
//! `runner_tests.rs`).
//!
//! Like `trace_cache.rs`, this exercises `run_case`'s actual scoring logic — `TraceStore::load` +
//! `rescore` — WITHOUT spawning `claude`: a cache hit is exactly this pair of calls, so injecting a
//! canned trace and re-scoring it against a verdict-kind golden case IS the live scoring path, not a
//! simulation of it. It then folds the outcome into a `CaseResult` and `aggregate`s it, the same way
//! `run_cases`/`run_eval` would, to confirm a verdict case's pass/fail lands in `by_tag` with no
//! report-side changes — the projection is entirely case- and result-scoped.

use std::path::Path;

use warble_eval_runner::{
    aggregate, rescore, Backend, CaseResult, Golden, GoldenCase, ResultKind, Trace,
};

/// A verdict-kind golden case: `result_kind: verdict` + `verdict_field` project the envelope's
/// `fresh`/`severity` down to `expected`'s scalar shape before the ordinary scalar comparator runs.
fn verdict_case(id: &str, tag: &str, field: &str, expected_rows: &str) -> GoldenCase {
    let yaml = format!(
        "id: {id}\nquestion: \"is `orders` fresh?\"\ntags: [{tag}]\nmatch: scalar\n\
         result_kind: verdict\nverdict_field: {field}\n\
         expected: {{ columns: [{field}], rows: {expected_rows} }}\n"
    );
    serde_yaml::from_str(&yaml).expect("verdict golden case parses")
}

/// The trace a first (paid) monitor_freshness run would have written — its result is the raw
/// +Assertive envelope (not a projected table), matching what `run_case` caches on a fresh run.
fn trace_with_envelope(fresh: bool, severity: &str) -> Trace {
    Trace {
        case_id: "stale_critical".into(),
        agent_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        model: "opus".into(),
        context_version: Some("monitor_freshness@synthetic-v1".into()),
        context_sha: "cccccccccccccccccccccccccccccccccccccccc".into(),
        question: "is `orders` fresh?".into(),
        sql_executed: None,
        result: serde_json::json!({
            "blocks": [
                { "type": "status", "state": if fresh { "fresh" } else { "stale" },
                  "label": "orders freshness",
                  "detail": "max(order_date) is 51h old; expected within 24h",
                  "severity": severity }
            ],
            "verdict": { "type": "freshness_verdict", "fresh": fresh, "observed_lag_hours": 51,
                         "expected_cadence": "24h" },
            "emitted": if fresh { serde_json::json!([]) } else { serde_json::json!(["freshness_breach"]) },
            "verified": true,
        }),
        cost: Some(0.05),
        latency_ms: 8_000,
        turns: Some(3),
        tool_calls: None,
        backend: Backend::default(),
    }
}

/// Wrap a single-sample `CompareResult` into the `CaseResult` shape `fold_samples` would produce for
/// one passing/failing sample — the minimal public-API equivalent, since `fold_samples` itself is
/// crate-private.
fn one_sample_case_result(
    id: &str,
    tags: &[&str],
    verdict: &warble_eval_compare::CompareResult,
) -> CaseResult {
    CaseResult {
        id: id.to_string(),
        tags: tags.iter().map(|s| s.to_string()).collect(),
        samples: 1,
        passes: verdict.pass as u32,
        pass_rate: if verdict.pass { 1.0 } else { 0.0 },
        pass: verdict.pass,
        flaky: false,
        reason: verdict.reason.clone(),
        cost: Some(0.05),
        latency_ms: 8_000,
        turns: Some(3),
        cache_hits: 1,
        cache_misses: 0,
        samples_detail: vec![],
        answer_dist: None,
    }
}

/// THE ACCEPTANCE TEST: a verdict envelope scores through the runner's actual cache-hit path
/// (`rescore`, exactly what `run_case` calls on a hit) and the resulting `CaseResult`s land in
/// `by_tag["detection"]` / `by_tag["severity"]` when aggregated — the gap this task closes (the
/// runner used to reject every verdict envelope outright with "no parseable {columns,rows}").
#[test]
fn verdict_envelope_scores_via_rescore_and_lands_in_by_tag() {
    // Ground truth (detection_ground_truth.yaml): lag 51h vs cadence 24h -> fresh=false, severity=critical.
    let trace = trace_with_envelope(false, "critical");

    let detection_case = verdict_case(
        "stale_critical_detection",
        "detection",
        "fresh",
        "[[false]]",
    );
    let detection_verdict = rescore(&trace, &detection_case).expect("verdict envelope scores");
    assert!(
        detection_verdict.pass,
        "envelope fresh=false matches the golden's expected fresh=false"
    );

    let severity_case = verdict_case(
        "stale_critical_severity",
        "severity",
        "severity",
        "[[critical]]",
    );
    let severity_verdict = rescore(&trace, &severity_case).expect("verdict envelope scores");
    assert!(
        severity_verdict.pass,
        "envelope severity=critical matches the golden's expected severity=critical"
    );

    let rows = vec![
        one_sample_case_result(
            "stale_critical_detection",
            &["detection"],
            &detection_verdict,
        ),
        one_sample_case_result("stale_critical_severity", &["severity"], &severity_verdict),
    ];
    let report = aggregate("opus", rows);

    let detection_stat = report
        .by_tag
        .get("detection")
        .expect("detection tag present in by_tag");
    assert_eq!(detection_stat.n, 1);
    assert_eq!(detection_stat.pass, 1);

    let severity_stat = report
        .by_tag
        .get("severity")
        .expect("severity tag present in by_tag");
    assert_eq!(severity_stat.n, 1);
    assert_eq!(severity_stat.pass, 1);
    assert!((report.accuracy - 1.0).abs() < 1e-9);
}

/// A mismatching verdict fails closed — a stale-marked `fresh` envelope does not pass a golden that
/// expects `fresh=true` — and the failure shows up in `by_tag`, not silently swallowed.
#[test]
fn a_mismatching_verdict_fails_and_still_lands_in_by_tag() {
    let trace = trace_with_envelope(false, "critical");
    let case = verdict_case("fresh_recent", "detection", "fresh", "[[true]]");
    let verdict = rescore(&trace, &case).expect("verdict envelope scores");
    assert!(
        !verdict.pass,
        "envelope fresh=false does not match expected fresh=true"
    );

    let report = aggregate(
        "opus",
        vec![one_sample_case_result(
            "fresh_recent",
            &["detection"],
            &verdict,
        )],
    );
    let detection_stat = report.by_tag.get("detection").expect("tag present");
    assert_eq!(detection_stat.n, 1);
    assert_eq!(
        detection_stat.pass, 0,
        "the failing case does not count as a pass"
    );
}

/// A cached Table-kind trace (the pre-existing behavior) is completely unaffected by verdict
/// support — `rescore` still projects `{columns,rows}` straight through, byte-identical to before.
#[test]
fn a_table_kind_trace_scores_exactly_as_before() {
    let trace = Trace {
        case_id: "q1".into(),
        agent_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        model: "opus".into(),
        context_version: None,
        context_sha: "cccccccccccccccccccccccccccccccccccccccc".into(),
        question: "how many orders?".into(),
        sql_executed: None,
        result: serde_json::json!({"columns": ["n"], "rows": [[42]]}),
        cost: Some(0.1),
        latency_ms: 1_000,
        turns: Some(2),
        tool_calls: None,
        backend: Backend::default(),
    };
    let yaml = "id: q1\nquestion: \"how many orders?\"\ntags: [agg]\nmatch: scalar\n\
                expected: { columns: [n], rows: [[42]] }\n";
    let case: GoldenCase = serde_yaml::from_str(yaml).expect("legacy case parses");
    let verdict = rescore(&trace, &case).expect("table case scores");
    assert!(verdict.pass);
}

/// The actual `monitor-freshness/cases.yaml` golden (not a synthetic stand-in) parses cleanly and
/// every case is wired as a verdict case with the field its tag implies — a regression guard against
/// the golden silently drifting back to the pre-projection `{columns,rows}` shape it had before this
/// scoring path existed.
#[test]
fn the_monitor_freshness_golden_wires_every_case_as_a_verdict_case() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../golden/monitor-freshness/cases.yaml");
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let golden: Golden = serde_yaml::from_str(&raw).expect("monitor-freshness golden parses");

    assert_eq!(
        golden.cases.len(),
        6,
        "expected the 4 detection + 2 severity cases"
    );
    for case in &golden.cases {
        assert_eq!(
            case.result_kind,
            ResultKind::Verdict,
            "case {} must score against the +Assertive envelope, not a table",
            case.id
        );
        let expected_field = if case.tags.iter().any(|t| t == "detection") {
            "fresh"
        } else if case.tags.iter().any(|t| t == "severity") {
            "severity"
        } else {
            panic!(
                "case {} carries neither a detection nor severity tag",
                case.id
            );
        };
        assert_eq!(
            case.verdict_field.as_deref(),
            Some(expected_field),
            "case {} verdict_field must match its tag",
            case.id
        );
    }
}
