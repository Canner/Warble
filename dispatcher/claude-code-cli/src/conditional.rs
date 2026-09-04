//! Deterministic realization of a `conditional` step's closed-vocabulary `when` guard — mirrors
//! `dispatcher/claude-agent-sdk/src/conditional.ts` field-for-field (see that module's doc for the
//! full R1 repair-fold-into-loop / R2 guarded-skip design).
//!
//! This module is deliberately **not** wired into this back-end's actual static-file emission
//! (`emit.rs`): the Claude Code CLI target has no deterministic runtime, so its conditional/repair
//! behavior is entirely textual — the live CLI agent judges the guard emergently from the emitted
//! prompt text (see `ir.rs`'s `LlmCall::when` doc comment), not from an evaluator like this one.
//! No existing profile calls into this module; it exists solely so the two back-ends' understanding
//! of the SAME closed guard vocabulary can be held to a shared conformance fixture
//! (`dispatcher/conformance-fixtures/conditional.json`, asserted against here and against
//! `conditional.ts`) — a semantic drift between them fails whichever suite moved.

use crate::error::DispatchError;
use crate::ir::WhenGuard;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepOutcome {
    Success,
    Failure,
}

/// The subset of a step's identity this module needs: its name (an `on_failure` target) and the
/// artifact its output would land in (an `on_failure`-repair shape also requires it to be consumed).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepIdentity {
    pub name: String,
    pub produces: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct GuardState {
    /// Every artifact produced by steps run so far, keyed by their `produces` name.
    ///
    /// Named `artifacts` rather than `slots` because IR 0.7 uses "slot" for a named position in
    /// prompt text with alternative wordings — a different thing entirely. The spec has always
    /// called these artifacts: `on_flag`'s target is documented as a dotted `artifact.field`.
    pub artifacts: HashMap<String, String>,
    /// Every step's outcome recorded so far, keyed by step name.
    pub outcomes: HashMap<String, StepOutcome>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ConditionalDecision {
    Run,
    Skip,
    Repair { target: StepIdentity },
}

/// Default bound on repair attempts. Not (yet) an IR field — `max_attempts` is not part of the
/// schema either back-end reads — so this mirrors conditional.ts's back-end-local runtime constant.
pub const DEFAULT_MAX_REPAIR_ATTEMPTS: usize = 1;

/// Resolve a dotted `artifact.field.nested` path against the parsed JSON of the named artifact.
/// Any failure along the way (artifact absent, not JSON, path doesn't resolve) reads as
/// `false`/absent — a guard never fails on a shape mismatch, it just doesn't fire.
fn read_flag(artifacts: &HashMap<String, String>, target: &str) -> bool {
    let mut parts = target.split('.');
    let Some(artifact_name) = parts.next() else {
        return false;
    };
    let Some(raw) = artifacts.get(artifact_name) else {
        return false;
    };
    let Ok(mut cur) = serde_json::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    for key in parts {
        let serde_json::Value::Object(map) = &cur else {
            return false;
        };
        match map.get(key) {
            Some(v) => cur = v.clone(),
            None => return false,
        }
    }
    matches!(cur, serde_json::Value::Bool(true))
}

/// Evaluate a guard's truth value directly (R2 — guarded-skip). Does not special-case the R1 repair
/// shape; callers that need to distinguish repair-fold from a plain `on_failure` skip should use
/// [`classify_conditional_step`] instead.
pub fn evaluate_guard(when: &WhenGuard, state: &GuardState) -> Result<bool, DispatchError> {
    match when.guard.as_str() {
        "on_failure" => Ok(state.outcomes.get(&when.target) == Some(&StepOutcome::Failure)),
        "on_flag" => Ok(read_flag(&state.artifacts, &when.target)),
        "on_missing" => Ok(!state.artifacts.contains_key(&when.target)),
        // The compiler validates guard names against the closed vocabulary before this IR ever
        // reaches a back-end (core/src/compile.rs); an unrecognized value here means a hand-edited
        // or future-versioned IR slipped through — loud-fail rather than silently treating it as false.
        other => Err(DispatchError::new(format!(
            "unknown guard '{other}' (closed vocabulary: on_failure, on_flag, on_missing)"
        ))),
    }
}

/// Structural test for the R1 repair shape: an `on_failure` guard whose target is `preceding_step`,
/// where that step's sole produced artifact is also consumed by the conditional step. Returns the
/// target's identity when the shape matches, else `None` (falls back to R2 guarded-skip).
pub fn repair_fold_target(
    when: &WhenGuard,
    consumes: &[String],
    preceding_step: Option<&StepIdentity>,
) -> Option<StepIdentity> {
    let preceding = preceding_step?;
    if when.guard != "on_failure" || when.target != preceding.name {
        return None;
    }
    let produces = preceding.produces.as_ref()?;
    if !consumes.iter().any(|c| c == produces) {
        return None;
    }
    Some(preceding.clone())
}

/// The single entry point a staged executor would use to decide what a conditional step does next:
/// fold into a bounded repair turn (R1), run (R2 guard true), or skip (R2 guard false / R1 target
/// didn't fail).
pub fn classify_conditional_step(
    when: &WhenGuard,
    consumes: &[String],
    preceding_step: Option<&StepIdentity>,
    state: &GuardState,
) -> Result<ConditionalDecision, DispatchError> {
    if let Some(target) = repair_fold_target(when, consumes, preceding_step) {
        return Ok(
            if state.outcomes.get(&target.name) == Some(&StepOutcome::Failure) {
                ConditionalDecision::Repair { target }
            } else {
                ConditionalDecision::Skip
            },
        );
    }
    Ok(if evaluate_guard(when, state)? {
        ConditionalDecision::Run
    } else {
        ConditionalDecision::Skip
    })
}

/// Drive a bounded repair loop: call `attempt_failed` up to `max_attempts` times (1-indexed),
/// stopping at the first attempt that reports success. Mirrors conditional.ts's `runRepairLoop`:
/// returns `(recovered, attempts)` and never loops past `max_attempts` — exhaustion is reported back
/// (`recovered = false`) for the caller to loud-fail, not swallowed here.
pub fn run_repair_loop(
    max_attempts: usize,
    mut attempt_failed: impl FnMut(usize) -> bool,
) -> (bool, usize) {
    for attempt in 1..=max_attempts {
        if !attempt_failed(attempt) {
            return (true, attempt);
        }
    }
    (false, max_attempts)
}
