//! Target capability profiles — the declarative side of the capability model
//! (`docs/spec/capability-model.md`).
//!
//! A runtime target is `engine × mode`, never just "vercel": the same harness in a different mode
//! is a genuinely different capability set (headless has no synchronous human; interactive does).
//! Unlike the sibling `claude-code-cli` back-end, this harness is never a terminal — it is an
//! LLM-agnostic structured-output tool-loop (Vercel AI SDK), so `render_contract` is realized
//! natively via JSON-Schema-driven structured output on BOTH modes, not degraded in interactive
//! mode. This module only declares profiles; `resolve.rs` links them.

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

/// The two vercel targets: engine × mode.
///
/// Note: this `vercel:*` target id names the back-end crate/target, and is a different concept
/// from the `via: "vercel-ai-sdk"` string used in `CapabilityEntry` below — the latter names the
/// mechanism a capability is realized through, not the target itself. Same word, different axes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetId {
    Headless,
    Interactive,
}

impl TargetId {
    pub fn as_str(&self) -> &'static str {
        match self {
            TargetId::Headless => "vercel:headless",
            TargetId::Interactive => "vercel:interactive",
        }
    }

    pub fn parse(value: &str) -> Option<TargetId> {
        match value {
            "vercel:headless" => Some(TargetId::Headless),
            "vercel:interactive" => Some(TargetId::Interactive),
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

/// vercel target's default mode when the caller doesn't specify one.
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
            entry(Native, Some("mcp:wren"), Runtime, Required, None),
        ),
        (
            "genbi_build",
            entry(Native, Some("mcp:wren"), Runtime, Required, None),
        ),
        (
            "semantic_introspection",
            entry(RealizeVia, Some("mcp:wren"), Runtime, Required, None),
        ),
        // +Constitutive: reading the semantic model's structure to propose a context edit — realized
        // the same way as semantic_introspection, via the `mcp:wren` server.
        (
            "schema_introspection",
            entry(RealizeVia, Some("mcp:wren"), Runtime, Required, None),
        ),
        ("llm:strong", entry(Native, None, Runtime, Required, None)),
        ("llm:cheap", entry(Native, None, Runtime, Required, None)),
        (
            "llm:per_step_tier",
            entry(RealizeVia, Some("vercel-ai-sdk"), Runtime, Required, None),
        ),
        // This harness is never a terminal — every agent's final output is captured as structured,
        // schema-validated JSON via the Vercel AI SDK's tool-loop, so the render contract is native
        // (not a best-effort file artifact) on both modes.
        (
            "render_contract",
            entry(Native, Some("vercel-ai-sdk"), Runtime, Required, None),
        ),
        (
            "structured_output_capture",
            entry(Native, Some("vercel-ai-sdk"), Runtime, Required, None),
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
        // +Constitutive: the path-scoped authorization gate for a `context`-target mutation, distinct
        // from `write_authz` (data writes) and `artifact_write` (render writes) — scopes must never
        // cross. Realized via the same filesystem, scoped to a path.
        (
            "context_write_authz",
            entry(RealizeVia, Some("scoped-fs"), Runtime, SafetyCritical, None),
        ),
        (
            "artifact_write",
            entry(RealizeVia, Some("fs"), Runtime, SafetyCritical, None),
        ),
        // +Assertive borrows the scheduling / event / notify transports from the harness runtime —
        // the IR names the capability + criticality only; the mechanism is legalized here, never in
        // the IR (capability-model §6/§7). A target with no such mechanism wired keeps these `fail`.
        (
            "scheduler",
            entry(RealizeVia, Some("mcp:runtime"), Runtime, Required, None),
        ),
        (
            "event_bus",
            entry(RealizeVia, Some("mcp:runtime"), Runtime, Required, None),
        ),
        (
            "notify_channel",
            entry(RealizeVia, Some("mcp:runtime"), Runtime, Required, None),
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
        // +Mutating borrows version control (git) from the runtime as the apply-time checkpoint a
        // rollback restores from. Warble declares the requirement; git itself is never owned here.
        (
            "version_control",
            entry(RealizeVia, Some("git"), Runtime, Required, None),
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
            entry(Native, Some("mcp:wren"), Runtime, Required, None),
        ),
        (
            "genbi_build",
            entry(Native, Some("mcp:wren"), Runtime, Required, None),
        ),
        (
            "semantic_introspection",
            entry(RealizeVia, Some("mcp:wren"), Runtime, Required, None),
        ),
        // +Constitutive: see headless_profile — same mechanism, not a differentiator across modes.
        (
            "schema_introspection",
            entry(RealizeVia, Some("mcp:wren"), Runtime, Required, None),
        ),
        ("llm:strong", entry(Native, None, Runtime, Required, None)),
        ("llm:cheap", entry(Native, None, Runtime, Required, None)),
        (
            "llm:per_step_tier",
            entry(RealizeVia, Some("vercel-ai-sdk"), Runtime, Required, None),
        ),
        // See headless_profile: the harness is never a terminal on either mode, so structured output
        // stays native here too — this is the point of an LLM-agnostic structured-output harness.
        (
            "render_contract",
            entry(Native, Some("vercel-ai-sdk"), Runtime, Required, None),
        ),
        (
            "structured_output_capture",
            entry(Native, Some("vercel-ai-sdk"), Runtime, Required, None),
        ),
        (
            "human_approval",
            entry(Native, None, Runtime, SafetyCritical, None),
        ),
        (
            "write_authz",
            entry(RealizeVia, Some("fs"), Runtime, SafetyCritical, None),
        ),
        // +Constitutive: see headless_profile — same path-scoped gate, not a differentiator across
        // modes.
        (
            "context_write_authz",
            entry(RealizeVia, Some("scoped-fs"), Runtime, SafetyCritical, None),
        ),
        (
            "artifact_write",
            entry(RealizeVia, Some("fs"), Runtime, SafetyCritical, None),
        ),
        // Same borrowed transports as headless (+Assertive): scheduler/event/notify are runtime-
        // supplied on both modes; only human_approval differs between the two.
        (
            "scheduler",
            entry(RealizeVia, Some("mcp:runtime"), Runtime, Required, None),
        ),
        (
            "event_bus",
            entry(RealizeVia, Some("mcp:runtime"), Runtime, Required, None),
        ),
        (
            "notify_channel",
            entry(RealizeVia, Some("mcp:runtime"), Runtime, Required, None),
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
        // +Mutating borrows version control (git) from the runtime as the apply-time checkpoint a
        // rollback restores from. Warble declares the requirement; git itself is never owned here.
        (
            "version_control",
            entry(RealizeVia, Some("git"), Runtime, Required, None),
        ),
    ])
}
