//! Target capability profiles — the declarative side of the capability model
//! (`docs/spec/capability-model.md`).
//!
//! A runtime target is `engine × mode`, never just "claude-code": the same engine in a different
//! mode is a genuinely different capability set (headless *loses* `human_approval` but *gains*
//! `structured_output_capture`). This module only declares profiles; `resolve.rs` links them.

use serde::Serialize;
use std::collections::HashMap;

/// One of the four resolution outcomes a capability can take on a target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityOutcome {
    Native,
    RealizeVia,
    Degrade,
    Fail,
}

/// Who supplies a resolved capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProvidedBy {
    Runtime,
    Warble,
    None,
}

/// safety-critical capabilities must never silently degrade — unsupported means the resolution
/// pass aborts. required/best-effort may degrade with a warning recorded in the report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Criticality {
    SafetyCritical,
    Required,
    BestEffort,
}

#[derive(Debug, Clone)]
pub struct CapabilityEntry {
    pub outcome: CapabilityOutcome,
    pub via: Option<&'static str>,
    pub provided_by: ProvidedBy,
    pub criticality: Criticality,
    pub note: Option<&'static str>,
}

pub type CapabilityProfile = HashMap<&'static str, CapabilityEntry>;

/// The two claude-code targets: engine × mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetId {
    Headless,
    Interactive,
}

impl TargetId {
    pub fn as_str(&self) -> &'static str {
        match self {
            TargetId::Headless => "claude-code:headless",
            TargetId::Interactive => "claude-code:interactive",
        }
    }

    pub fn parse(value: &str) -> Option<TargetId> {
        match value {
            "claude-code:headless" => Some(TargetId::Headless),
            "claude-code:interactive" => Some(TargetId::Interactive),
            _ => None,
        }
    }

    pub fn profile(&self) -> CapabilityProfile {
        match self {
            TargetId::Headless => headless_profile(),
            TargetId::Interactive => interactive_profile(),
        }
    }
}

/// claude-code target's default mode when the caller doesn't specify one.
pub const DEFAULT_TARGET: TargetId = TargetId::Headless;

pub fn is_known_target(value: &str) -> bool {
    TargetId::parse(value).is_some()
}

pub fn known_target_names() -> [&'static str; 2] {
    [TargetId::Headless.as_str(), TargetId::Interactive.as_str()]
}

fn entry(
    outcome: CapabilityOutcome,
    via: Option<&'static str>,
    provided_by: ProvidedBy,
    criticality: Criticality,
    note: Option<&'static str>,
) -> CapabilityEntry {
    CapabilityEntry {
        outcome,
        via,
        provided_by,
        criticality,
        note,
    }
}

fn headless_profile() -> CapabilityProfile {
    use CapabilityOutcome::*;
    use Criticality::*;
    use ProvidedBy::{Runtime, Warble};
    HashMap::from([
        (
            "sql_execution:read_only",
            entry(Native, Some("bash-wren"), Runtime, Required, None),
        ),
        (
            "genbi_build",
            entry(Native, Some("bash-wren"), Runtime, Required, None),
        ),
        (
            "semantic_introspection",
            entry(RealizeVia, Some("bash-wren"), Runtime, Required, None),
        ),
        ("llm:strong", entry(Native, None, Runtime, Required, None)),
        ("llm:cheap", entry(Native, None, Runtime, Required, None)),
        (
            "llm:per_step_tier",
            entry(RealizeVia, Some("subagents"), Runtime, Required, None),
        ),
        (
            "render_contract",
            entry(RealizeVia, Some("html-file"), Runtime, BestEffort, None),
        ),
        (
            "structured_output_capture",
            entry(Native, Some("stream-json"), Runtime, Required, None),
        ),
        (
            "human_approval",
            entry(
                Fail,
                None,
                ProvidedBy::None,
                SafetyCritical,
                Some("no human in the loop in headless mode"),
            ),
        ),
        (
            "write_authz",
            entry(RealizeVia, Some("fs"), Runtime, SafetyCritical, None),
        ),
        (
            "artifact_write",
            entry(RealizeVia, Some("fs"), Runtime, SafetyCritical, None),
        ),
        (
            "scheduler",
            entry(
                Fail,
                None,
                ProvidedBy::None,
                Required,
                Some("no scheduling mechanism wired for this target"),
            ),
        ),
        (
            "event_bus",
            entry(
                Fail,
                None,
                ProvidedBy::None,
                Required,
                Some("no event transport wired for this target"),
            ),
        ),
        (
            "blast_radius",
            entry(
                Fail,
                None,
                Warble,
                SafetyCritical,
                Some("requires fine_grained_binding"),
            ),
        ),
    ])
}

fn interactive_profile() -> CapabilityProfile {
    use CapabilityOutcome::*;
    use Criticality::*;
    use ProvidedBy::{Runtime, Warble};
    HashMap::from([
        (
            "sql_execution:read_only",
            entry(Native, Some("bash-wren"), Runtime, Required, None),
        ),
        (
            "genbi_build",
            entry(Native, Some("bash-wren"), Runtime, Required, None),
        ),
        (
            "semantic_introspection",
            entry(RealizeVia, Some("bash-wren"), Runtime, Required, None),
        ),
        ("llm:strong", entry(Native, None, Runtime, Required, None)),
        ("llm:cheap", entry(Native, None, Runtime, Required, None)),
        (
            "llm:per_step_tier",
            entry(RealizeVia, Some("subagents"), Runtime, Required, None),
        ),
        (
            "render_contract",
            entry(
                Degrade,
                Some("terminal-markdown"),
                Runtime,
                BestEffort,
                None,
            ),
        ),
        (
            "structured_output_capture",
            entry(
                Degrade,
                None,
                ProvidedBy::None,
                BestEffort,
                Some("not captured in the interactive TUI"),
            ),
        ),
        (
            "human_approval",
            entry(Native, None, Runtime, SafetyCritical, None),
        ),
        (
            "write_authz",
            entry(RealizeVia, Some("fs"), Runtime, SafetyCritical, None),
        ),
        (
            "artifact_write",
            entry(RealizeVia, Some("fs"), Runtime, SafetyCritical, None),
        ),
        (
            "scheduler",
            entry(
                Fail,
                None,
                ProvidedBy::None,
                Required,
                Some("no scheduling mechanism wired for this target"),
            ),
        ),
        (
            "event_bus",
            entry(
                Fail,
                None,
                ProvidedBy::None,
                Required,
                Some("no event transport wired for this target"),
            ),
        ),
        (
            "blast_radius",
            entry(
                Fail,
                None,
                Warble,
                SafetyCritical,
                Some("requires fine_grained_binding"),
            ),
        ),
    ])
}
