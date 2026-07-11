//! Per-step tier ablation — the closed loop's core (eval-framework §4, roadmap Phase 1.4 step 8).
//!
//! Where [`crate::run_eval`] ablates the *whole* model (one `--model` for the entire run), this
//! module ablates **one named step at a time**: it holds every step at a `base_tier` and, for each
//! `llm_calls[].name`, re-binds just that step to each swept tier, re-dispatches, and re-runs the
//! goldens. The per-step binding is realized the same way the runtime realizes it — by re-dispatching
//! the IR with a tier→model config so each (sub)agent's frontmatter carries its own model (no
//! `--model` override) — which is exactly the axis the closed loop tunes: measure accuracy Δ vs
//! cost Δ per step, then keep the cheapest tier that stays at/above the accuracy floor.
//!
//! Combinatorial discipline (roadmap risk #1): the full grid is Mᴺ (N steps × M tiers). We do **not**
//! sweep it — one step moves at a time while the rest stay at `base_tier`, so the run is
//! `1 + N·(M−1)` dispatches. What is swept and what is skipped is logged (no silent caps).

use serde::Serialize;
use std::path::PathBuf;
use warble_claude_code::{
    emit_claude_code_with_models, ir::WarbleIr, ModelConfig, DEFAULT_RENDER_FLAVOR,
};

use crate::{agent_name, aggregate, install_agents, run_cases, run_path, ConfigReport, Golden};

/// Inputs for a per-step ablation sweep.
pub struct AblationConfig {
    /// A queryable wren project (connection + data); agent files are installed here per dispatch.
    pub project: PathBuf,
    /// Compiled IR JSON (the same artifact `warble dispatch` consumes). Re-dispatched per point.
    pub ir_path: PathBuf,
    /// Golden cases YAML.
    pub golden_path: PathBuf,
    /// Dispatch target (e.g. `claude-code:headless`).
    pub target: String,
    /// Optional tier→model config YAML; defaults to the standard `strong/cheap/orchestrator` map.
    pub models_config_path: Option<PathBuf>,
    /// Tiers to try per step (e.g. `[cheap, strong]`).
    pub sweep_tiers: Vec<String>,
    /// Tier every non-ablated step is pinned to (the reference point; conventionally `strong`).
    pub base_tier: String,
    /// A tier qualifies for the recommendation if its accuracy is within this much of the baseline.
    pub accuracy_drop_tolerance: f64,
    /// Write the full JSON report here.
    pub out: Option<PathBuf>,
    /// Concurrent cases per dispatched point (1 = serial); see `RunConfig::parallel`.
    pub parallel: usize,
}

/// A single named step in the IR (`verb.step_name`) with its authored tier.
#[derive(Debug, Clone)]
struct StepRef {
    verb: String,
    step_name: String,
    component_idx: usize,
    call_idx: usize,
}

impl StepRef {
    fn label(&self) -> String {
        format!("{}.{}", self.verb, self.step_name)
    }
}

/// One ablation measurement: step `label` bound to `tier`, scored against the goldens.
#[derive(Debug, Clone, Serialize)]
pub struct AblationPoint {
    pub step: String,
    pub tier: String,
    pub accuracy: f64,
    pub cost_total_usd: f64,
    pub latency_ms_avg: u64,
    /// Accuracy minus the baseline accuracy (negative = regression from moving this step).
    pub delta_accuracy: f64,
    /// Cost minus the baseline cost (negative = cheaper than baseline).
    pub delta_cost: f64,
}

/// The cheapest tier that holds accuracy for one step (the closed loop's per-step verdict).
#[derive(Debug, Clone, Serialize)]
pub struct StepRecommendation {
    pub step: String,
    pub recommended_tier: String,
    pub accuracy: f64,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AblationReport {
    pub dataset: Option<String>,
    pub context_version: Option<String>,
    pub base_tier: String,
    pub sweep_tiers: Vec<String>,
    /// Every step at `base_tier` — the reference the per-step deltas are measured against.
    pub baseline: ConfigReport,
    pub points: Vec<AblationPoint>,
    pub recommendations: Vec<StepRecommendation>,
}

/// Enumerate every named step across all components, in a stable order.
fn enumerate_steps(ir: &WarbleIr) -> Vec<StepRef> {
    let mut steps = Vec::new();
    for (component_idx, node) in ir.components.iter().enumerate() {
        for (call_idx, call) in node.llm_calls.iter().enumerate() {
            steps.push(StepRef {
                verb: node.verb.clone(),
                step_name: call.name.clone(),
                component_idx,
                call_idx,
            });
        }
    }
    steps
}

/// Clone `ir` and set every step to `base_tier`, except `focus` (when given) which is set to
/// `focus_tier`. This is the per-step binding: one step moves, the rest are pinned.
fn rebind_tiers(
    ir: &WarbleIr,
    base_tier: &str,
    focus: Option<&StepRef>,
    focus_tier: &str,
) -> WarbleIr {
    let mut ir = ir.clone();
    for (ci, node) in ir.components.iter_mut().enumerate() {
        for (li, call) in node.llm_calls.iter_mut().enumerate() {
            let is_focus = focus
                .map(|f| f.component_idx == ci && f.call_idx == li)
                .unwrap_or(false);
            call.tier = if is_focus {
                focus_tier.to_string()
            } else {
                base_tier.to_string()
            };
        }
    }
    ir
}

/// Dispatch `ir` under `models` into a fresh temp dir, install it into `project`, run every golden
/// case (frontmatter models — no `--model` override), and aggregate under `label`.
fn dispatch_and_run(
    ir: &WarbleIr,
    models: &ModelConfig,
    target: &str,
    project: &std::path::Path,
    golden: &Golden,
    label: &str,
    parallel: usize,
) -> Result<ConfigReport, String> {
    let tmp = tempfile::tempdir().map_err(|e| format!("tempdir: {e}"))?;
    emit_claude_code_with_models(ir, tmp.path(), target, DEFAULT_RENDER_FLAVOR, models)
        .map_err(|e| format!("dispatch {label}: {e}"))?;

    let agent = agent_name(tmp.path())?;
    let path_env = run_path(project);
    let _installed = install_agents(tmp.path(), project)?;
    let rows = run_cases(project, &agent, &path_env, None, &golden.cases, parallel);
    Ok(aggregate(label, rows))
}

/// Run the per-step ablation: baseline (all steps at `base_tier`) plus, for each named step, one
/// re-dispatch per swept tier. Streams progress to stderr and returns the aggregated report.
pub fn run_ablation(cfg: &AblationConfig) -> Result<AblationReport, String> {
    let golden_text = std::fs::read_to_string(&cfg.golden_path)
        .map_err(|e| format!("read {}: {e}", cfg.golden_path.display()))?;
    let golden: Golden =
        serde_yaml::from_str(&golden_text).map_err(|e| format!("parse golden: {e}"))?;

    let ir_text = std::fs::read_to_string(&cfg.ir_path)
        .map_err(|e| format!("read {}: {e}", cfg.ir_path.display()))?;
    let ir: WarbleIr = serde_json::from_str(&ir_text).map_err(|e| format!("parse IR: {e}"))?;

    let models = match &cfg.models_config_path {
        Some(path) => {
            let text = std::fs::read_to_string(path)
                .map_err(|e| format!("read {}: {e}", path.display()))?;
            ModelConfig::from_yaml(&text).map_err(|e| e.to_string())?
        }
        None => ModelConfig::default(),
    };
    // Front-load the tier→model checks so a bad config fails before any dispatch/claude spend.
    models.require(&cfg.base_tier).map_err(|e| e.to_string())?;
    for tier in &cfg.sweep_tiers {
        models.require(tier).map_err(|e| e.to_string())?;
    }

    let steps = enumerate_steps(&ir);
    if steps.is_empty() {
        return Err("IR has no llm_calls to ablate".to_string());
    }

    // Log the plan (no silent caps): what we sweep vs the full grid we deliberately skip.
    let per_step_tiers: Vec<&String> = cfg
        .sweep_tiers
        .iter()
        .filter(|t| *t != &cfg.base_tier)
        .collect();
    let planned = 1 + steps.len() * per_step_tiers.len();
    let full_grid = (cfg.sweep_tiers.len().max(1)).pow(steps.len() as u32);
    eprintln!(
        "### per-step ablation: {} step(s), base_tier={}, sweep={:?}",
        steps.len(),
        cfg.base_tier,
        cfg.sweep_tiers
    );
    eprintln!(
        "    steps: {}",
        steps
            .iter()
            .map(StepRef::label)
            .collect::<Vec<_>>()
            .join(", ")
    );
    eprintln!(
        "    dispatches: {planned} (1 baseline + {} steps × {} swept tier(s)); \
skipping the full {full_grid}-combo grid (one step moves at a time)",
        steps.len(),
        per_step_tiers.len()
    );

    // Baseline: every step at base_tier.
    eprintln!("\n## baseline: all steps → {}", cfg.base_tier);
    let baseline_ir = rebind_tiers(&ir, &cfg.base_tier, None, &cfg.base_tier);
    let baseline = dispatch_and_run(
        &baseline_ir,
        &models,
        &cfg.target,
        &cfg.project,
        &golden,
        &format!("baseline:all→{}", cfg.base_tier),
        cfg.parallel.max(1),
    )?;

    // Per-step sweep: move one step to each swept tier, hold the rest at base_tier.
    let mut points = Vec::new();
    for step in &steps {
        for tier in &per_step_tiers {
            eprintln!(
                "\n## {} → {} (others → {})",
                step.label(),
                tier,
                cfg.base_tier
            );
            let point_ir = rebind_tiers(&ir, &cfg.base_tier, Some(step), tier);
            let report = dispatch_and_run(
                &point_ir,
                &models,
                &cfg.target,
                &cfg.project,
                &golden,
                &format!("{}→{}", step.label(), tier),
                cfg.parallel.max(1),
            )?;
            points.push(AblationPoint {
                step: step.label(),
                tier: (*tier).clone(),
                accuracy: report.accuracy,
                cost_total_usd: report.cost_total_usd,
                latency_ms_avg: report.latency_ms_avg,
                delta_accuracy: report.accuracy - baseline.accuracy,
                delta_cost: report.cost_total_usd - baseline.cost_total_usd,
            });
        }
    }

    let recommendations = recommend(
        &steps,
        &cfg.base_tier,
        &baseline,
        &points,
        cfg.accuracy_drop_tolerance,
    );

    Ok(AblationReport {
        dataset: golden.dataset,
        context_version: golden.context_version,
        base_tier: cfg.base_tier.clone(),
        sweep_tiers: cfg.sweep_tiers.clone(),
        baseline,
        points,
        recommendations,
    })
}

/// For each step, pick the cheapest tier whose accuracy stays within `tolerance` of the baseline.
/// Candidates are the swept points for that step plus the baseline (which represents that step at
/// `base_tier`). "Cheapest" is lowest measured cost; when costs are all zero (subscription mode) we
/// fall back to preferring the swept tier and say so in the note.
fn recommend(
    steps: &[StepRef],
    base_tier: &str,
    baseline: &ConfigReport,
    points: &[AblationPoint],
    tolerance: f64,
) -> Vec<StepRecommendation> {
    let floor = baseline.accuracy - tolerance;
    let mut out = Vec::new();
    for step in steps {
        let label = step.label();
        // Candidate: (tier, accuracy, cost). Start with the baseline (this step at base_tier).
        let mut candidates: Vec<(String, f64, f64)> = vec![(
            base_tier.to_string(),
            baseline.accuracy,
            baseline.cost_total_usd,
        )];
        for p in points.iter().filter(|p| p.step == label) {
            candidates.push((p.tier.clone(), p.accuracy, p.cost_total_usd));
        }

        let qualifying: Vec<&(String, f64, f64)> = candidates
            .iter()
            .filter(|(_, acc, _)| *acc >= floor)
            .collect();
        let costs_all_zero = qualifying.iter().all(|(_, _, cost)| *cost <= 0.0);

        // Cheapest qualifying tier: lowest cost, ties → non-base (the ablation's candidate) wins.
        let best = qualifying.iter().min_by(|a, b| {
            a.2.partial_cmp(&b.2)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    // prefer a non-base tier on ties so a cost-neutral downgrade is surfaced
                    let a_base = a.0 == base_tier;
                    let b_base = b.0 == base_tier;
                    a_base.cmp(&b_base)
                })
        });

        match best {
            Some((tier, acc, _)) => {
                let note = if costs_all_zero {
                    format!(
                        "costs are zero (subscription-computed); recommending the cheapest tier by \
config order at/above the {floor:.2} accuracy floor"
                    )
                } else if tier == base_tier {
                    format!("no swept tier held the {floor:.2} accuracy floor more cheaply")
                } else {
                    format!("holds the {floor:.2} accuracy floor at lower cost than {base_tier}")
                };
                out.push(StepRecommendation {
                    step: label,
                    recommended_tier: tier.clone(),
                    accuracy: *acc,
                    note,
                });
            }
            None => out.push(StepRecommendation {
                step: label,
                recommended_tier: base_tier.to_string(),
                accuracy: baseline.accuracy,
                note: format!("no tier met the {floor:.2} accuracy floor; keeping {base_tier}"),
            }),
        }
    }
    out
}

/// Render the per-step ablation as a table: baseline first, then each (step, tier) with Δacc / Δcost,
/// followed by the per-step recommendation.
pub fn format_ablation(report: &AblationReport) -> String {
    let mut out = String::new();
    out.push_str("\n=== Warble eval — per-step tier ablation (closed loop) ===\n");
    out.push_str(&format!(
        "baseline: all steps → {}   acc={:.2}  cost={}  lat={}ms\n\n",
        report.base_tier,
        report.baseline.accuracy,
        fmt_cost(report.baseline.cost_total_usd),
        report.baseline.latency_ms_avg
    ));
    out.push_str(&format!(
        "{:<28} {:<8} {:<7} {:<9} {:<9} {:<9}\n",
        "step", "tier", "acc", "Δacc", "cost($)", "Δcost($)"
    ));
    for p in &report.points {
        out.push_str(&format!(
            "{:<28} {:<8} {:<7} {:<+9.2} {:<9} {:<+9.4}\n",
            p.step,
            p.tier,
            format!("{:.2}", p.accuracy),
            p.delta_accuracy,
            fmt_cost(p.cost_total_usd),
            p.delta_cost,
        ));
    }
    out.push_str("\n--- per-step recommendation (cheapest tier at/above accuracy floor) ---\n");
    for r in &report.recommendations {
        out.push_str(&format!(
            "{:<28} → {:<8} (acc {:.2})  {}\n",
            r.step, r.recommended_tier, r.accuracy, r.note
        ));
    }
    out
}

fn fmt_cost(cost: f64) -> String {
    if cost > 0.0 {
        format!("{cost:.4}")
    } else {
        "n/a".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CaseResult, ConfigReport};
    use std::collections::BTreeMap;

    /// A two-step, single-component IR (steps `plan`@strong, `draft`@cheap) for enumerate/rebind.
    fn two_step_ir() -> WarbleIr {
        let json = r#"{
          "warble_ir_version": "0.2",
          "profile": "t",
          "context_binding": {"project": "p", "binding_mode": "runtime_selected"},
          "config": {},
          "components": [{
            "id": "build_thing", "verb": "build_thing", "type": "analytical",
            "realization_kind": "skill",
            "context_binding": {"project": "p", "binding_mode": "runtime_selected"},
            "precondition_result": {"status": "ok", "checks": []},
            "prompt_fragment": "",
            "llm_calls": [
              {"name": "plan", "tier": "strong", "prompt": "plan it"},
              {"name": "draft", "tier": "cheap", "prompt": "draft it"}
            ],
            "guardrails": [], "trigger": {"kind": "one_shot"},
            "eval_ref": "eval/",
            "effect": {"render_blocks": [], "outcome": {"kind": "none"}}
          }]
        }"#;
        serde_json::from_str(json).expect("fixture IR parses")
    }

    fn config(model: &str, accuracy: f64, cost: f64) -> ConfigReport {
        ConfigReport {
            model: model.to_string(),
            n: 10,
            accuracy,
            cost_total_usd: cost,
            latency_ms_avg: 1000,
            by_tag: BTreeMap::new(),
            cases: vec![CaseResult {
                id: "c".into(),
                tags: vec![],
                pass: true,
                reason: "match".into(),
                cost,
                latency_ms: 1000,
            }],
        }
    }

    #[test]
    fn enumerate_lists_every_named_step_in_order() {
        let ir = two_step_ir();
        let steps = enumerate_steps(&ir);
        let labels: Vec<String> = steps.iter().map(StepRef::label).collect();
        assert_eq!(labels, vec!["build_thing.plan", "build_thing.draft"]);
    }

    #[test]
    fn rebind_pins_others_to_base_and_moves_only_the_focus_step() {
        let ir = two_step_ir();
        let steps = enumerate_steps(&ir);
        // Move `draft` (index 1) to strong, everything else to base=cheap.
        let rebound = rebind_tiers(&ir, "cheap", Some(&steps[1]), "strong");
        let calls = &rebound.components[0].llm_calls;
        assert_eq!(calls[0].tier, "cheap", "non-focus step pinned to base");
        assert_eq!(calls[1].tier, "strong", "focus step moved to swept tier");
    }

    #[test]
    fn rebind_baseline_sets_all_steps_to_base() {
        let ir = two_step_ir();
        let baseline = rebind_tiers(&ir, "strong", None, "strong");
        for call in &baseline.components[0].llm_calls {
            assert_eq!(call.tier, "strong");
        }
    }

    #[test]
    fn recommend_downgrades_a_step_that_holds_accuracy_more_cheaply() {
        // baseline: all strong, acc 1.0, cost 0.30. Moving `answer` to cheap keeps acc 1.0 at 0.10.
        let steps = enumerate_steps(&two_step_ir());
        let baseline = config("all-strong", 1.0, 0.30);
        let points = vec![
            AblationPoint {
                step: "build_thing.plan".into(),
                tier: "cheap".into(),
                accuracy: 1.0,
                cost_total_usd: 0.10,
                latency_ms_avg: 900,
                delta_accuracy: 0.0,
                delta_cost: -0.20,
            },
            AblationPoint {
                step: "build_thing.draft".into(),
                tier: "cheap".into(),
                accuracy: 0.80, // regresses — must NOT be recommended
                cost_total_usd: 0.10,
                latency_ms_avg: 900,
                delta_accuracy: -0.20,
                delta_cost: -0.20,
            },
        ];
        let recs = recommend(&steps, "strong", &baseline, &points, 0.0);
        let plan = recs.iter().find(|r| r.step == "build_thing.plan").unwrap();
        let draft = recs.iter().find(|r| r.step == "build_thing.draft").unwrap();
        assert_eq!(
            plan.recommended_tier, "cheap",
            "cost-neutral downgrade taken"
        );
        assert_eq!(
            draft.recommended_tier, "strong",
            "accuracy regression kept at base"
        );
    }

    #[test]
    fn recommend_respects_accuracy_drop_tolerance() {
        let steps = enumerate_steps(&two_step_ir());
        let baseline = config("all-strong", 1.0, 0.30);
        let points = vec![AblationPoint {
            step: "build_thing.plan".into(),
            tier: "cheap".into(),
            accuracy: 0.95,
            cost_total_usd: 0.10,
            latency_ms_avg: 900,
            delta_accuracy: -0.05,
            delta_cost: -0.20,
        }];
        // With a 0.10 tolerance, a 0.05 drop qualifies → downgrade.
        let lenient = recommend(&steps, "strong", &baseline, &points, 0.10);
        assert_eq!(
            lenient
                .iter()
                .find(|r| r.step == "build_thing.plan")
                .unwrap()
                .recommended_tier,
            "cheap"
        );
        // With zero tolerance, any drop disqualifies → keep base.
        let strict = recommend(&steps, "strong", &baseline, &points, 0.0);
        assert_eq!(
            strict
                .iter()
                .find(|r| r.step == "build_thing.plan")
                .unwrap()
                .recommended_tier,
            "strong"
        );
    }

    #[test]
    fn format_ablation_shows_baseline_points_and_recommendations() {
        let report = AblationReport {
            dataset: Some("jaffle".into()),
            context_version: None,
            base_tier: "strong".into(),
            sweep_tiers: vec!["cheap".into(), "strong".into()],
            baseline: config("all-strong", 1.0, 0.30),
            points: vec![AblationPoint {
                step: "answer_query.answer".into(),
                tier: "cheap".into(),
                accuracy: 1.0,
                cost_total_usd: 0.10,
                latency_ms_avg: 900,
                delta_accuracy: 0.0,
                delta_cost: -0.20,
            }],
            recommendations: vec![StepRecommendation {
                step: "answer_query.answer".into(),
                recommended_tier: "cheap".into(),
                accuracy: 1.0,
                note: "cheaper".into(),
            }],
        };
        let out = format_ablation(&report);
        assert!(out.contains("per-step tier ablation"));
        assert!(out.contains("answer_query.answer"));
        assert!(out.contains("cheap"));
        assert!(out.contains("recommendation"));
    }
}
