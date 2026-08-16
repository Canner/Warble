//! Target capability profiles — the declarative side of the capability model (see
//! [`capability-model.md`][spec-cap]).
//!
//! A runtime target is `engine × mode`, never just "vercel": the same harness in a different mode
//! is a genuinely different capability set (headless has no synchronous human; interactive does).
//! Unlike the sibling `claude-code-cli` back-end, this harness is never a terminal — it is an
//! LLM-agnostic structured-output tool-loop (Vercel AI SDK), so `render_contract` is realized
//! natively via JSON-Schema-driven structured output on BOTH modes, not degraded in interactive
//! mode. This module only declares profiles; `resolve.rs` links them.
//!
//! [spec-cap]: https://github.com/Canner/Warble/blob/v0.2.0/docs/spec/capability-model.md

use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::HashMap;

/// One of the four resolution outcomes a capability can take on a target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityOutcome {
    Native,
    RealizeVia,
    Degrade,
    Fail,
}

/// Who supplies a resolved capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProvidedBy {
    Runtime,
    Warble,
    None,
}

/// safety-critical capabilities must never silently degrade — unsupported means the resolution
/// pass aborts. required/best-effort may degrade with a warning recorded in the report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Criticality {
    SafetyCritical,
    Required,
    BestEffort,
}

/// `via`/`note` are `Cow<'static, str>` rather than `&'static str` so this one type can hold both
/// the base target's zero-alloc borrowed statics (`Cow::Borrowed`) and a provider fragment's
/// runtime-loaded, owned strings (`Cow::Owned`) — see `provider::ProfileEntrySpec`. Composition
/// (`provider::compose_target`) merges both into a single `CapabilityProfile` value, which is why
/// the two shapes must live in the same struct rather than two parallel ones.
#[derive(Debug, Clone)]
pub struct CapabilityEntry {
    pub outcome: CapabilityOutcome,
    pub via: Option<Cow<'static, str>>,
    pub provided_by: ProvidedBy,
    pub criticality: Criticality,
    pub note: Option<Cow<'static, str>>,
}

/// Keyed by owned `String` (not `&'static str`) so a base-only profile and a
/// base-⊕-provider-composed profile are the exact same type — `provider::compose_target` returns
/// this same alias, never a parallel "composed" type.
pub type CapabilityProfile = HashMap<String, CapabilityEntry>;

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

    /// The mode half of `engine × mode`, used by `provider::compose_target` to filter fragments
    /// whose `mode:` field restricts them to the other mode.
    pub fn mode(&self) -> &'static str {
        match self {
            TargetId::Headless => "headless",
            TargetId::Interactive => "interactive",
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
        via: via.map(Cow::Borrowed),
        provided_by,
        criticality,
        note: note.map(Cow::Borrowed),
    }
}

/// Convert a base profile's `&'static str`-keyed array into the owned-`String`-keyed
/// `CapabilityProfile` — the same type a provider-composed profile is, so callers never
/// distinguish "base" from "composed" profiles.
fn to_profile<const N: usize>(entries: [(&'static str, CapabilityEntry); N]) -> CapabilityProfile {
    entries
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect()
}

/// Base substrate profile shared by both modes: LLM tiers, the structured-output contract, the
/// authorization/approval/blast-radius gates, and version control. The 7 domain capabilities
/// (SQL execution, semantic model access, and the scheduler/event/notify transports) are NOT
/// declared here — they are contributed at dispatch time by a `--provider` fragment (see
/// `provider::compose_target`). A bare dispatch with no provider loaded correctly loud-fails any
/// component that needs one of those, via `resolve::unknown_capability_entry`.
fn headless_profile() -> CapabilityProfile {
    use CapabilityOutcome::*;
    use Criticality::*;
    use ProvidedBy::Warble;
    to_profile([
        (
            "llm:strong",
            entry(Native, None, ProvidedBy::Runtime, Required, None),
        ),
        (
            "llm:cheap",
            entry(Native, None, ProvidedBy::Runtime, Required, None),
        ),
        (
            "llm:per_step_tier",
            entry(
                RealizeVia,
                Some("vercel-ai-sdk"),
                ProvidedBy::Runtime,
                Required,
                None,
            ),
        ),
        // This harness is never a terminal — every agent's final output is captured as structured,
        // schema-validated JSON via the Vercel AI SDK's tool-loop, so the render contract is native
        // (not a best-effort file artifact) on both modes.
        (
            "render_contract",
            entry(
                Native,
                Some("vercel-ai-sdk"),
                ProvidedBy::Runtime,
                Required,
                None,
            ),
        ),
        (
            "structured_output_capture",
            entry(
                Native,
                Some("vercel-ai-sdk"),
                ProvidedBy::Runtime,
                Required,
                None,
            ),
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
            entry(
                RealizeVia,
                Some("fs"),
                ProvidedBy::Runtime,
                SafetyCritical,
                None,
            ),
        ),
        // +Constitutive: the path-scoped authorization gate for a `context`-target mutation, distinct
        // from `write_authz` (data writes) and `artifact_write` (render writes) — scopes must never
        // cross. Realized via the same filesystem, scoped to a path.
        (
            "context_write_authz",
            entry(
                RealizeVia,
                Some("scoped-fs"),
                ProvidedBy::Runtime,
                SafetyCritical,
                None,
            ),
        ),
        (
            "artifact_write",
            entry(
                RealizeVia,
                Some("fs"),
                ProvidedBy::Runtime,
                SafetyCritical,
                None,
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
        // +Mutating borrows version control (git) from the runtime as the apply-time checkpoint a
        // rollback restores from. Warble declares the requirement; git itself is never owned here.
        (
            "version_control",
            entry(
                RealizeVia,
                Some("mcp:git"),
                ProvidedBy::Runtime,
                Required,
                None,
            ),
        ),
    ])
}

fn interactive_profile() -> CapabilityProfile {
    use CapabilityOutcome::*;
    use Criticality::*;
    use ProvidedBy::Warble;
    to_profile([
        (
            "llm:strong",
            entry(Native, None, ProvidedBy::Runtime, Required, None),
        ),
        (
            "llm:cheap",
            entry(Native, None, ProvidedBy::Runtime, Required, None),
        ),
        (
            "llm:per_step_tier",
            entry(
                RealizeVia,
                Some("vercel-ai-sdk"),
                ProvidedBy::Runtime,
                Required,
                None,
            ),
        ),
        // See headless_profile: the harness is never a terminal on either mode, so structured output
        // stays native here too — this is the point of an LLM-agnostic structured-output harness.
        (
            "render_contract",
            entry(
                Native,
                Some("vercel-ai-sdk"),
                ProvidedBy::Runtime,
                Required,
                None,
            ),
        ),
        (
            "structured_output_capture",
            entry(
                Native,
                Some("vercel-ai-sdk"),
                ProvidedBy::Runtime,
                Required,
                None,
            ),
        ),
        (
            "human_approval",
            entry(Native, None, ProvidedBy::Runtime, SafetyCritical, None),
        ),
        (
            "write_authz",
            entry(
                RealizeVia,
                Some("fs"),
                ProvidedBy::Runtime,
                SafetyCritical,
                None,
            ),
        ),
        // +Constitutive: see headless_profile — same path-scoped gate, not a differentiator across
        // modes.
        (
            "context_write_authz",
            entry(
                RealizeVia,
                Some("scoped-fs"),
                ProvidedBy::Runtime,
                SafetyCritical,
                None,
            ),
        ),
        (
            "artifact_write",
            entry(
                RealizeVia,
                Some("fs"),
                ProvidedBy::Runtime,
                SafetyCritical,
                None,
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
        // +Mutating borrows version control (git) from the runtime as the apply-time checkpoint a
        // rollback restores from. Warble declares the requirement; git itself is never owned here.
        (
            "version_control",
            entry(
                RealizeVia,
                Some("mcp:git"),
                ProvidedBy::Runtime,
                Required,
                None,
            ),
        ),
    ])
}
