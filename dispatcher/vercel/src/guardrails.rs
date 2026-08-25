//! Machine-readable guardrails section for the bundle.
//!
//! The IR's `guardrails` list names each guardrail plus its optional `scope`/`threshold`, but
//! leaves *how* a runtime enforces one implicit. This module derives an `enforcement` tag per
//! guardrail from a small closed vocabulary keyed on the guardrail's name — never on the owning
//! component's id/verb — so a harness can dispatch enforcement mechanically instead of pattern
//! matching guardrail names itself.

use crate::ir::{ComponentNode, Guardrail};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

fn enforcement_for(name: &str, has_threshold: bool) -> &'static str {
    if name == "read_only_execution" {
        "read_only"
    } else if name == "artifact_write" {
        "scoped_write"
    } else if name.contains("_limit")
        || name.ends_with("_gate")
        || name == "deterministic_gate"
        || name == "additivity_guard"
    {
        if has_threshold {
            "threshold_limit"
        } else {
            "gated_check"
        }
    } else {
        "generic"
    }
}

fn guardrail_value(guardrail: &Guardrail) -> Value {
    let mut obj = Map::new();
    obj.insert(
        "enforcement".to_string(),
        Value::String(enforcement_for(&guardrail.name, guardrail.threshold.is_some()).to_string()),
    );
    obj.insert("locked".to_string(), Value::Bool(guardrail.locked));
    if let Some(scope) = &guardrail.scope {
        obj.insert("scope".to_string(), Value::String(scope.clone()));
    }
    if let Some(threshold) = &guardrail.threshold {
        obj.insert("threshold".to_string(), threshold.clone());
    }
    Value::Object(obj)
}

/// Build the guardrails section for `node`: one entry per declared guardrail, keyed by name
/// (a `BTreeMap` for deterministic, sorted bundle output).
pub fn build_guardrails(node: &ComponentNode) -> BTreeMap<String, Value> {
    node.guardrails
        .iter()
        .map(|g| (g.name.clone(), guardrail_value(g)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_execution_maps_to_read_only() {
        assert_eq!(enforcement_for("read_only_execution", false), "read_only");
    }

    #[test]
    fn artifact_write_maps_to_scoped_write() {
        assert_eq!(enforcement_for("artifact_write", false), "scoped_write");
    }

    #[test]
    fn limit_suffix_with_threshold_is_threshold_limit() {
        assert_eq!(enforcement_for("row_limit", true), "threshold_limit");
    }

    #[test]
    fn limit_suffix_without_threshold_is_gated_check() {
        assert_eq!(enforcement_for("drill_depth_limit", false), "gated_check");
    }

    #[test]
    fn gate_and_guard_suffixes_are_recognized() {
        assert_eq!(enforcement_for("deterministic_gate", false), "gated_check");
        assert_eq!(enforcement_for("additivity_guard", false), "gated_check");
    }

    #[test]
    fn unmatched_name_is_generic() {
        assert_eq!(enforcement_for("statement_timeout", true), "generic");
    }
}
