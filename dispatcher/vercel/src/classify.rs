//! Conditional-step realization classifier for the vercel bundle target.
//!
//! An IR `llm_call` with a `when` guard (see `ir::WhenGuard`) is conditional, but "conditional"
//! is not itself a runtime shape — a target has to decide *how* a guarded step actually runs.
//! This module classifies each conditional step into one of two well-defined realizations so the
//! bundle never carries an undefined in-between state:
//!
//! - **R1 (repair fold-into-loop)**: a step whose guard is `on_failure` and whose target names the
//!   step immediately preceding it is not an independent pipeline node — it is a bounded
//!   error-recovery turn folded into that adjacent step's own loop. The bundle records the fold
//!   target and a `max_attempts` bound; a runtime that exhausts its attempts with no declared
//!   `fallback` must loud-fail, never retry unboundedly or silently swallow the failure. (The IR
//!   has no field declaring a fallback artifact today, so `fallback` is always emitted as `None` —
//!   an honest reflection of that gap, not a limitation this module works around.)
//! - **R2 (guarded-skip)**: every other conditional step (`on_flag` / `on_missing`, or an
//!   `on_failure` that isn't adjacent-preceding) is an independent pipeline node whose guard is
//!   evaluated deterministically before it runs. When the guard is false the step is skipped, and
//!   any artifact whose only producer is a skipped step is simply optional for downstream
//!   consumers — an interpretation rule, not new IR syntax.
//!
//! Both branches are always well-defined for every conditional step, so classification never
//! leaves a step unclassified.
//!
//! This module only **emits** the classification into the bundle (`StepRealization`) — it does
//! not implement the retry loop or the skip-evaluation runtime itself. Those are a separate, later
//! component (the harness that consumes the bundle).

use crate::ir::ComponentNode;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StepRealization {
    Independent,
    /// R1 — repair fold-into-loop: this conditional step is NOT an independent node; it folds
    /// into the adjacent tool-bearing step's loop as a bounded error-recovery turn.
    RepairFold {
        fold_into: String,
        max_attempts: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        fallback: Option<String>,
    },
    /// R2 — guarded-skip: an independent step whose guard is evaluated deterministically before
    /// running; false ⇒ skip (its `produces` does not materialize, making it optional downstream).
    GuardedSkip,
}

pub const DEFAULT_MAX_ATTEMPTS: u32 = 1;

/// Classify `node`'s `llm_calls[step_index]` into one of the two well-defined realizations.
///
/// - No `when` guard ⇒ [`StepRealization::Independent`].
/// - `when.guard == "on_failure"` and `when.target` names the immediately-preceding call's `name`
///   ⇒ [`StepRealization::RepairFold`] (R1).
/// - Any other guard (`on_flag` / `on_missing`, or a non-adjacent `on_failure`) ⇒
///   [`StepRealization::GuardedSkip`] (R2).
pub fn classify_step(node: &ComponentNode, step_index: usize) -> StepRealization {
    let Some(when) = node.llm_calls[step_index].when.as_ref() else {
        return StepRealization::Independent;
    };

    let adjacent_preceding = step_index > 0
        && when.guard == "on_failure"
        && node.llm_calls[step_index - 1].name == when.target;

    if adjacent_preceding {
        StepRealization::RepairFold {
            fold_into: when.target.clone(),
            max_attempts: DEFAULT_MAX_ATTEMPTS,
            fallback: None,
        }
    } else {
        StepRealization::GuardedSkip
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Hand-build a minimal `ComponentNode` carrying only the given `llm_calls`, to pin the
    /// classifier's adjacency rule in isolation from any real profile fixture.
    fn node_with_calls(calls: Vec<serde_json::Value>) -> ComponentNode {
        let value = json!({
            "id": "test_component",
            "verb": "test_component",
            "type": "analytical",
            "realization_kind": "skill",
            "context_binding": { "project": "x", "binding_mode": "runtime_selected" },
            "precondition_result": { "status": "pass" },
            "prompt_fragment": "",
            "llm_calls": calls,
            "guardrails": [],
            "trigger": { "kind": "one_shot" },
            "eval_ref": "test_component.eval",
            "effect": { "outcome": { "kind": "none" } }
        });
        serde_json::from_value(value).expect("valid ComponentNode fixture")
    }

    #[test]
    fn on_failure_targeting_immediately_preceding_call_folds_into_repair() {
        let node = node_with_calls(vec![
            json!({"name": "step_a", "tier": "strong", "prompt": "p"}),
            json!({
                "name": "step_b", "tier": "strong", "prompt": "p",
                "when": {"guard": "on_failure", "target": "step_a"}
            }),
        ]);
        match classify_step(&node, 1) {
            StepRealization::RepairFold {
                fold_into,
                max_attempts,
                fallback,
            } => {
                assert_eq!(fold_into, "step_a");
                assert_eq!(max_attempts, DEFAULT_MAX_ATTEMPTS);
                assert_eq!(fallback, None);
            }
            other => panic!("expected RepairFold, got {other:?}"),
        }
    }

    #[test]
    fn on_failure_targeting_a_call_two_back_is_guarded_skip_not_repair_fold() {
        let node = node_with_calls(vec![
            json!({"name": "step_a", "tier": "strong", "prompt": "p"}),
            json!({"name": "step_b", "tier": "strong", "prompt": "p"}),
            json!({
                "name": "step_c", "tier": "strong", "prompt": "p",
                "when": {"guard": "on_failure", "target": "step_a"}
            }),
        ]);
        assert!(matches!(
            classify_step(&node, 2),
            StepRealization::GuardedSkip
        ));
    }

    #[test]
    fn on_flag_guard_is_guarded_skip() {
        let node = node_with_calls(vec![json!({
            "name": "step_a", "tier": "strong", "prompt": "p",
            "when": {"guard": "on_flag", "target": "some.flag"}
        })]);
        assert!(matches!(
            classify_step(&node, 0),
            StepRealization::GuardedSkip
        ));
    }

    #[test]
    fn no_guard_is_independent() {
        let node = node_with_calls(vec![
            json!({"name": "step_a", "tier": "strong", "prompt": "p"}),
        ]);
        assert!(matches!(
            classify_step(&node, 0),
            StepRealization::Independent
        ));
    }
}
