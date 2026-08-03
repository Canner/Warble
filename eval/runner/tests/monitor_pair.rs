use std::collections::{BTreeMap, BTreeSet};

use warble_eval_runner::{score_monitor_pair, CaseResult, ConfigReport, Report, TagStat};

const MANIFEST: &str = r#"
dataset: driftwood
scenario: stopped_updates
injections:
  - id: stopped_updates_subscription_snapshots
    kind: stopped_updates
    entity: subscription_snapshots
    expected_verdict: anomaly
    expected_fresh: false
    expected_severity: critical
    attribution_keywords:
      - snapshots
      - stopped
      - subscription
"#;

fn report(fresh: bool, severity: Option<&str>, detail: &str, pass: bool) -> Report {
    let envelope = serde_json::json!({
        "blocks": [{
            "type": "status",
            "state": if fresh { "fresh" } else { "stale" },
            "label": "subscription_snapshots freshness",
            "detail": detail,
            "severity": severity,
        }],
        "verdict": {
            "type": "freshness_verdict",
            "fresh": fresh,
            "observed_lag_hours": if fresh { 0 } else { 2184 },
            "expected_cadence": "730h",
        },
        "emitted": if fresh { serde_json::json!([]) } else { serde_json::json!(["freshness_breach"]) },
        "verified": true,
    });
    let answer_dist = BTreeMap::from([(envelope.to_string(), 1)]);
    let case = CaseResult {
        id: "stopped_updates_subscription_snapshots".into(),
        tags: vec!["detection".into()],
        samples: 1,
        passes: u32::from(pass),
        pass_rate: if pass { 1.0 } else { 0.0 },
        pass,
        flaky: false,
        reason: if pass { "match" } else { "mismatch" }.into(),
        cost: 0.01,
        latency_ms: 100,
        turns: 2,
        cache_hits: 0,
        cache_misses: 1,
        samples_detail: vec![],
        answer_dist: Some(answer_dist),
    };
    Report {
        dataset: Some("driftwood".into()),
        context_version: None,
        parallel: 1,
        selected_cases: 1,
        total_cases: 1,
        configs: vec![ConfigReport {
            model: "haiku".into(),
            n: 1,
            accuracy: if pass { 1.0 } else { 0.0 },
            cost_total_usd: 0.01,
            latency_ms_avg: 100,
            turns_avg: 2,
            cache_hits: 0,
            cache_misses: 1,
            flaky_cases: 0,
            by_tag: BTreeMap::from([(
                "detection".into(),
                TagStat {
                    pass: u32::from(pass),
                    n: 1,
                    pass_rate_sum: if pass { 1.0 } else { 0.0 },
                },
            )]),
            cases: vec![case],
        }],
    }
}

#[test]
fn perfect_clean_injected_pair_scores_all_headline_metrics() {
    let clean = report(
        true,
        None,
        "max snapshot_date is at the reference time",
        true,
    );
    let injected = report(
        false,
        Some("critical"),
        "subscription_snapshots stopped receiving monthly snapshots after March",
        true,
    );
    let scored = score_monitor_pair(MANIFEST, &clean, &injected).expect("pair scores");

    assert!(scored.passed);
    assert_eq!(scored.by_tag["recall"].value, 1.0);
    assert_eq!(scored.by_tag["precision"].value, 1.0);
    assert_eq!(scored.by_tag["false_alarm_rate"].value, 0.0);
    assert_eq!(scored.by_tag["attribution_accuracy"].value, 1.0);
    assert!(scored.clean.fresh);
    assert!(!scored.injected.fresh);
}

#[test]
fn clean_anomaly_is_counted_as_a_false_alarm_and_fails_the_pair() {
    let clean = report(
        false,
        Some("warn"),
        "subscription snapshots look delayed",
        false,
    );
    let injected = report(
        false,
        Some("critical"),
        "subscription snapshots stopped updating",
        true,
    );
    let scored = score_monitor_pair(MANIFEST, &clean, &injected).expect("pair scores");

    assert!(!scored.passed);
    assert_eq!(scored.by_tag["recall"].value, 1.0);
    assert_eq!(scored.by_tag["precision"].value, 0.5);
    assert_eq!(scored.by_tag["false_alarm_rate"].value, 1.0);
}

#[test]
fn manifest_ground_truth_and_recorded_envelope_are_required() {
    let clean = report(true, None, "fresh", true);
    let injected = report(false, Some("critical"), "stopped", true);

    let wrong_scenario = MANIFEST.replace("stopped_updates\n", "sudden_drop\n");
    assert!(score_monitor_pair(&wrong_scenario, &clean, &injected)
        .unwrap_err()
        .contains("only stopped_updates"));

    let mut missing_answers = clean.clone();
    missing_answers.configs[0].cases[0].answer_dist = None;
    assert!(score_monitor_pair(MANIFEST, &missing_answers, &injected)
        .unwrap_err()
        .contains("--record-answers"));
}

#[test]
fn attribution_uses_manifest_keywords_not_exact_sentence_matching() {
    let clean = report(true, None, "fresh", true);
    let injected = report(
        false,
        Some("critical"),
        "subscription snapshots are stale; the latest row is March 31",
        true,
    );
    let scored = score_monitor_pair(MANIFEST, &clean, &injected).expect("pair scores");

    assert_eq!(scored.by_tag["attribution_accuracy"].value, 1.0);
    assert_eq!(
        scored.by_tag.keys().cloned().collect::<BTreeSet<_>>(),
        BTreeSet::from([
            "attribution_accuracy".into(),
            "false_alarm_rate".into(),
            "precision".into(),
            "recall".into(),
        ])
    );
}

#[test]
fn attribution_rejects_phrase_that_only_the_reconstructed_oracle_accepted() {
    let clean = report(true, None, "fresh", true);
    let injected = report(false, Some("critical"), "stopped updates", true);
    let scored = score_monitor_pair(MANIFEST, &clean, &injected).expect("pair scores");

    assert_eq!(scored.by_tag["attribution_accuracy"].value, 0.0);
}
