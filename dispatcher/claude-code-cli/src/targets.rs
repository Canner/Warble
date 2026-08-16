//! Target capability profiles — the declarative side of the capability model (see
//! [`capability-model.md`][spec-cap]).
//!
//! A runtime target is `engine × mode`, never just "claude-code": the same engine in a different
//! mode is a genuinely different capability set (headless *loses* `human_approval` but *gains*
//! `structured_output_capture`). This module only declares profiles; `resolve.rs` links them.
//!
//! [spec-cap]: https://github.com/Canner/Warble/blob/main/docs/spec/capability-model.md

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

/// Keeping a component's intermediate work out of the context of whatever called it. The IR names
/// the requirement; how a target provides a child context — and whether it can at all — is the
/// target's business, which is why this is a capability rather than a flag.
pub(crate) const CONTEXT_ISOLATION_CAPABILITY: &str = "context_isolation";

#[derive(Debug, Clone)]
pub struct CapabilityEntry {
    pub outcome: CapabilityOutcome,
    /// `Cow` so a statically-declared entry and one loaded from a provider fragment at dispatch are
    /// the same type — a base-only profile and a base-⊕-provider-composed one must be, or they
    /// cannot be merged. Same reason the profile is keyed by `String`.
    pub via: Option<Cow<'static, str>>,
    pub provided_by: ProvidedBy,
    pub criticality: Criticality,
    pub note: Option<Cow<'static, str>>,
}

pub type CapabilityProfile = HashMap<String, CapabilityEntry>;

/// Build a profile from statically-declared entries, owning the keys. The declarations below stay
/// `&'static str` literals; only the map they land in is owned.
fn profile(
    entries: impl IntoIterator<Item = (&'static str, CapabilityEntry)>,
) -> CapabilityProfile {
    entries
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect()
}

/// The two claude-code targets: engine × mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetId {
    Headless,
    Interactive,
    CodexInteractive,
}

impl TargetId {
    pub fn as_str(&self) -> &'static str {
        match self {
            TargetId::Headless => "claude-code:headless",
            TargetId::Interactive => "claude-code:interactive",
            TargetId::CodexInteractive => "codex:interactive",
        }
    }

    /// The mode half of `engine × mode`, which is what a provider fragment's optional `mode:`
    /// field is matched against.
    pub fn mode(&self) -> &'static str {
        match self {
            TargetId::Headless => "headless",
            TargetId::Interactive => "interactive",
            // Named for symmetry with the other interactive target. Nothing consults it today:
            // `codex:interactive` rejects `--provider` outright, since it realizes no capability
            // of its own and a fragment would silently do nothing.
            TargetId::CodexInteractive => "interactive",
        }
    }

    pub fn parse(value: &str) -> Option<TargetId> {
        match value {
            "claude-code:headless" => Some(TargetId::Headless),
            "claude-code:interactive" => Some(TargetId::Interactive),
            "codex:interactive" => Some(TargetId::CodexInteractive),
            _ => None,
        }
    }

    pub fn profile(&self) -> CapabilityProfile {
        match self {
            TargetId::Headless => headless_profile(),
            TargetId::Interactive => interactive_profile(),
            TargetId::CodexInteractive => codex_interactive_profile(),
        }
    }
}

/// claude-code target's default mode when the caller doesn't specify one.
pub const DEFAULT_TARGET: TargetId = TargetId::Headless;

pub fn is_known_target(value: &str) -> bool {
    TargetId::parse(value).is_some()
}

pub fn known_target_names() -> [&'static str; 3] {
    [
        TargetId::Headless.as_str(),
        TargetId::Interactive.as_str(),
        TargetId::CodexInteractive.as_str(),
    ]
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

fn headless_profile() -> CapabilityProfile {
    use CapabilityOutcome::*;
    use Criticality::*;
    use ProvidedBy::{Runtime, Warble};
    profile([
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
        // +Constitutive: reading the semantic model's structure to propose a context edit (models/
        // metrics/knowledge) — realized the same way as semantic_introspection, via the `wren` CLI.
        (
            "schema_introspection",
            entry(RealizeVia, Some("bash-wren"), Runtime, Required, None),
        ),
        ("llm:strong", entry(Native, None, Runtime, Required, None)),
        ("llm:cheap", entry(Native, None, Runtime, Required, None)),
        (
            "llm:per_step_tier",
            entry(RealizeVia, Some("subagents"), Runtime, Required, None),
        ),
        // Per-step PROVIDER routing (cloud+local in one run) — distinct from per_step_tier, which is
        // same-provider model selection. The whole-session `claude` process can't switch provider
        // mid-run, so Warble realizes the LOCAL step two ways (--hybrid-realization): `bash-script`
        // (a Bash-run local-inference script) or `mcp-server` (a `.mcp.json` registering `warble
        // mcp-serve`, so the local call is an MCP tool — no bash widening). Cloud steps stay the
        // driver's own `wren` work either way.
        (
            "llm:per_step_provider",
            entry(
                RealizeVia,
                Some("bash-script|mcp-server"),
                Warble,
                Required,
                Some("local step via a bash-script script or an mcp-server (warble mcp-serve); cloud steps are the driver's own wren work"),
            ),
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
        // +Constitutive: the path-scoped authorization gate for a `context`-target mutation (models/
        // metrics/knowledge), distinct from `write_authz` (data writes) and `artifact_write` (render
        // writes) — scopes must never cross. Realized via the same filesystem, scoped to a path.
        (
            "context_write_authz",
            entry(RealizeVia, Some("scoped-fs"), Runtime, SafetyCritical, None),
        ),
        (
            "artifact_write",
            entry(RealizeVia, Some("fs"), Runtime, SafetyCritical, None),
        ),
        // A component may need its working-out kept out of the caller's context — the delegated
        // steps, the queries, the repairs. Realized here as a subagent: the child holds the whole
        // component, the caller sees one delegation and one result. A target with no child-context
        // mechanism must loud-fail rather than run the work in the open.
        (
            CONTEXT_ISOLATION_CAPABILITY,
            entry(RealizeVia, Some("subagent"), Runtime, Required, None),
        ),
        // +Assertive borrows the scheduling / event / notify transports from the runtime (OS cron,
        // pub/sub, MCP) — the IR names the capability + criticality only; the mechanism (cron / slack)
        // is legalized here, never in the IR (capability-model §6/§7). A target with no such mechanism
        // wired keeps these `fail` (loud, never silent).
        (
            "scheduler",
            entry(RealizeVia, Some("os-cron"), Runtime, Required, None),
        ),
        (
            "event_bus",
            entry(RealizeVia, Some("pub-sub"), Runtime, Required, None),
        ),
        (
            "notify_channel",
            entry(RealizeVia, Some("mcp-notify"), Runtime, Required, None),
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
    profile([
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
        (
            "source_connect",
            entry(RealizeVia, Some("native-interactive-command"), Runtime, Required, None),
        ),
        // +Constitutive: see headless_profile — same mechanism, not a differentiator across modes.
        (
            "schema_introspection",
            entry(RealizeVia, Some("bash-wren"), Runtime, Required, None),
        ),
        ("raw_material_read", entry(Native, Some("Read"), Runtime, Required, Some("Claude Code's cwd-scoped Read tool; prompts forbid credentials and raw excerpts"))),
        ("context_validate", entry(RealizeVia, Some("Bash(wren:*)"), Runtime, Required, None)),
        ("context_build", entry(RealizeVia, Some("Bash(wren:*)"), Runtime, Required, None)),
        ("enrichment_apply:deterministic", entry(RealizeVia, Some("native-interactive-approved-tool"), Runtime, SafetyCritical, Some("only after the native human-approval gate; Warble does not run it"))),
        ("llm:strong", entry(Native, None, Runtime, Required, None)),
        ("llm:cheap", entry(Native, None, Runtime, Required, None)),
        (
            "llm:per_step_tier",
            entry(RealizeVia, Some("subagents"), Runtime, Required, None),
        ),
        // See headless_profile: per-step provider routing (hybrid) is realized via an emitted
        // local-inference script (bash-script); same in interactive mode.
        (
            "llm:per_step_provider",
            entry(
                RealizeVia,
                Some("bash-script|mcp-server"),
                Warble,
                Required,
                Some("local step via an emitted local-inference script (Bash); cloud steps stay native subagents"),
            ),
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
        // A component may need its working-out kept out of the caller's context — the delegated
        // steps, the queries, the repairs. Realized here as a subagent: the child holds the whole
        // component, the caller sees one delegation and one result. A target with no child-context
        // mechanism must loud-fail rather than run the work in the open.
        (
            CONTEXT_ISOLATION_CAPABILITY,
            entry(RealizeVia, Some("subagent"), Runtime, Required, None),
        ),
        // Same borrowed transports as headless (+Assertive): scheduler/event/notify are runtime-
        // supplied on both modes; only render_contract + structured_output_capture + human_approval
        // differ between the two.
        (
            "scheduler",
            entry(RealizeVia, Some("os-cron"), Runtime, Required, None),
        ),
        (
            "event_bus",
            entry(RealizeVia, Some("pub-sub"), Runtime, Required, None),
        ),
        (
            "notify_channel",
            entry(RealizeVia, Some("mcp-notify"), Runtime, Required, None),
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

/// Codex's repository-scoped TUI target. This is intentionally a discovery/materialization
/// target, not the existing app-server based `codex:local` runtime.
fn codex_interactive_profile() -> CapabilityProfile {
    use CapabilityOutcome::*;
    use Criticality::*;
    use ProvidedBy::{Runtime, Warble};
    profile([
        ("sql_execution:read_only", entry(RealizeVia, Some("native-interactive-command"), Runtime, Required, None)),
        ("genbi_build", entry(RealizeVia, Some("native-interactive-command"), Runtime, Required, None)),
        ("source_connect", entry(RealizeVia, Some("native-interactive-command"), Runtime, Required, None)),
        ("semantic_introspection", entry(RealizeVia, Some("codex-repository-read"), Runtime, Required, None)),
        ("raw_material_read", entry(RealizeVia, Some("codex-repository-read"), Runtime, Required, Some("repository-scoped native TUI reads only; prompts forbid credentials and raw excerpts"))),
        ("llm:strong", entry(Native, None, Runtime, Required, None)),
        ("llm:cheap", entry(Native, None, Runtime, Required, None)),
        ("llm:per_step_tier", entry(RealizeVia, Some("native-interactive-subagents"), Runtime, Required, None)),
        ("context_write_authz", entry(RealizeVia, Some("native-interactive-human-approval"), Runtime, SafetyCritical, None)),
        ("context_validate", entry(RealizeVia, Some("native-interactive-command"), Runtime, Required, None)),
        ("context_build", entry(RealizeVia, Some("native-interactive-command"), Runtime, Required, None)),
        ("version_control", entry(RealizeVia, Some("git"), Runtime, Required, None)),
        ("human_approval", entry(Native, Some("native-interactive-human"), Runtime, SafetyCritical, None)),
        ("enrichment_apply:deterministic", entry(RealizeVia, Some("native-interactive-approved-tool"), Runtime, SafetyCritical, Some("only after the native human-approval gate; Warble does not run it"))),
        ("render_contract", entry(Degrade, Some("terminal-markdown"), Runtime, BestEffort, None)),
        ("artifact_write", entry(RealizeVia, Some("session-scoped-artifact-api"), Runtime, SafetyCritical, Some("the host owns the artifact API and persistence"))),
        ("blast_radius", entry(Fail, None, Warble, SafetyCritical, Some("requires fine_grained_binding"))),
    ])
}
