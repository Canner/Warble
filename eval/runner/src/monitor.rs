//! Live assertive-eval pair scoring.
//!
//! `eval run --record-answers` preserves each raw verdict envelope in the ordinary report. This
//! module joins a clean report, an injected report, and the generator's injection manifest into the
//! precision / recall / false-alarm / attribution view that a single report cannot express.

use crate::Report;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Deserialize)]
struct InjectionManifest {
    dataset: String,
    scenario: String,
    injections: Vec<Injection>,
}

#[derive(Debug, Deserialize)]
struct Injection {
    id: String,
    kind: String,
    entity: String,
    expected_verdict: String,
    #[serde(default)]
    expected_fresh: Option<bool>,
    #[serde(default)]
    expected_severity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MonitorMetric {
    pub value: f64,
    pub numerator: u32,
    pub denominator: u32,
}

impl MonitorMetric {
    fn new(numerator: u32, denominator: u32) -> Self {
        Self {
            value: if denominator == 0 {
                0.0
            } else {
                numerator as f64 / denominator as f64
            },
            numerator,
            denominator,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MonitorObservation {
    pub fresh: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
    pub cause: String,
    pub verified: bool,
    pub runner_pass: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MonitorReport {
    pub dataset: String,
    pub scenario: String,
    pub injection_id: String,
    pub entity: String,
    pub passed: bool,
    pub clean: MonitorObservation,
    pub injected: MonitorObservation,
    pub by_tag: BTreeMap<String, MonitorMetric>,
    pub notes: Vec<String>,
}

/// Score the one currently-live freshness scenario. Other injection kinds deliberately remain a
/// follow-up: only `stopped_updates` has deterministic freshness labels in the manifest.
pub fn score_monitor_pair(
    manifest_yaml: &str,
    clean_report: &Report,
    injected_report: &Report,
) -> Result<MonitorReport, String> {
    let manifest: InjectionManifest = serde_yaml::from_str(manifest_yaml)
        .map_err(|e| format!("parse injection manifest: {e}"))?;
    if manifest.scenario != "stopped_updates" {
        return Err(format!(
            "unsupported monitor scenario '{}': only stopped_updates has freshness ground truth",
            manifest.scenario
        ));
    }
    if manifest.injections.len() != 1 {
        return Err(format!(
            "stopped_updates manifest must contain exactly one injection, found {}",
            manifest.injections.len()
        ));
    }
    let injection = &manifest.injections[0];
    if injection.expected_verdict != "anomaly" || injection.expected_fresh != Some(false) {
        return Err("stopped_updates manifest must declare anomaly + expected_fresh=false".into());
    }

    let clean = observation(clean_report, &injection.id)?;
    let injected = observation(injected_report, &injection.id)?;
    let clean_anomaly = !clean.fresh;
    let injected_anomaly = !injected.fresh;
    let true_positive = u32::from(injected_anomaly);
    let anomaly_claims = u32::from(clean_anomaly) + u32::from(injected_anomaly);
    let attribution_match = u32::from(
        injected_anomaly && cause_matches(&injected.cause, &injection.kind, &injection.entity),
    );

    let mut by_tag = BTreeMap::new();
    by_tag.insert("recall".into(), MonitorMetric::new(true_positive, 1));
    by_tag.insert(
        "precision".into(),
        MonitorMetric::new(true_positive, anomaly_claims),
    );
    by_tag.insert(
        "false_alarm_rate".into(),
        MonitorMetric::new(u32::from(clean_anomaly), 1),
    );
    by_tag.insert(
        "attribution_accuracy".into(),
        MonitorMetric::new(attribution_match, true_positive),
    );

    let severity_matches = injection
        .expected_severity
        .as_deref()
        .is_none_or(|expected| injected.severity.as_deref() == Some(expected));
    let passed = clean.runner_pass
        && injected.runner_pass
        && clean.verified
        && injected.verified
        && !clean_anomaly
        && injected_anomaly
        && severity_matches;
    let mut notes = vec![
        "false_alarm_rate is measured on the clean half of the same seed-42 pair".into(),
        "attribution is observational; matcher calibration across other anomaly kinds is deferred"
            .into(),
    ];
    if !severity_matches {
        notes.push(format!(
            "injected severity {:?} did not match manifest {:?}",
            injected.severity, injection.expected_severity
        ));
    }

    Ok(MonitorReport {
        dataset: manifest.dataset,
        scenario: manifest.scenario,
        injection_id: injection.id.clone(),
        entity: injection.entity.clone(),
        passed,
        clean,
        injected,
        by_tag,
        notes,
    })
}

fn observation(report: &Report, case_id: &str) -> Result<MonitorObservation, String> {
    if report.configs.len() != 1 {
        return Err(format!(
            "monitor pair report requires exactly one model config, found {}",
            report.configs.len()
        ));
    }
    let config = &report.configs[0];
    let case = config
        .cases
        .iter()
        .find(|case| case.id == case_id)
        .ok_or_else(|| format!("report has no case '{case_id}'"))?;
    let answers = case.answer_dist.as_ref().ok_or_else(|| {
        format!("case '{case_id}' has no answer_dist; rerun with --record-answers")
    })?;
    let (raw, _) = answers
        .iter()
        .max_by(|a, b| a.1.cmp(b.1).then_with(|| b.0.cmp(a.0)))
        .ok_or_else(|| format!("case '{case_id}' recorded no parseable verdict envelope"))?;
    let envelope: Value = serde_json::from_str(raw)
        .map_err(|e| format!("parse recorded verdict for '{case_id}': {e}"))?;
    let verdict = envelope
        .get("verdict")
        .ok_or_else(|| format!("case '{case_id}' envelope has no verdict"))?;
    let fresh = verdict
        .get("fresh")
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("case '{case_id}' verdict has no boolean fresh field"))?;
    let status = envelope
        .get("blocks")
        .and_then(Value::as_array)
        .and_then(|blocks| {
            blocks
                .iter()
                .find(|block| block.get("type").and_then(Value::as_str) == Some("status"))
        });
    let severity = status
        .and_then(|block| block.get("severity"))
        .and_then(Value::as_str)
        .or_else(|| verdict.get("severity").and_then(Value::as_str))
        .map(str::to_string);
    let cause = [
        status
            .and_then(|block| block.get("label"))
            .and_then(Value::as_str),
        status
            .and_then(|block| block.get("detail"))
            .and_then(Value::as_str),
        verdict.get("cause").and_then(Value::as_str),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");

    Ok(MonitorObservation {
        fresh,
        severity,
        cause,
        verified: envelope
            .get("verified")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        runner_pass: case.pass,
    })
}

fn tokens(text: &str) -> BTreeSet<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .map(str::to_lowercase)
        .filter(|token| token.len() > 2)
        .collect()
}

/// The generator's attribution oracle uses a short canonical set: phenomenon + table identity,
/// not exact sentence matching. The manifest already carries those two stable facts.
fn cause_matches(cause: &str, kind: &str, entity: &str) -> bool {
    let expected = tokens(&format!("{kind} {entity}"));
    if expected.is_empty() {
        return false;
    }
    let actual = tokens(cause);
    expected.intersection(&actual).count() * 2 >= expected.len()
}

pub fn format_monitor_report(report: &MonitorReport) -> String {
    let mut out = String::new();
    out.push_str("\n=== Warble eval — live monitor pair ===\n");
    out.push_str(&format!(
        "dataset={} scenario={} entity={}\n",
        report.dataset, report.scenario, report.entity
    ));
    for (tag, metric) in &report.by_tag {
        out.push_str(&format!(
            "{tag}: {:.3} ({}/{})\n",
            metric.value, metric.numerator, metric.denominator
        ));
    }
    out.push_str(if report.passed {
        "MONITOR PAIR PASS\n"
    } else {
        "MONITOR PAIR FAIL\n"
    });
    out
}
