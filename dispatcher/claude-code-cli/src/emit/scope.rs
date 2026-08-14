//! Scope-level artifacts: the session envelope (`.claude/settings.json`) and the scope system
//! prompt (`.claude/CLAUDE.md`).
//!
//! A dispatch output is one directory with one `.claude/`, one data-layer config and N agent files
//! — a materialized scope, not a callable agent. Everything that describes or governs that scope is
//! therefore computed once for the profile. Both artifacts here used to be, or would naturally have
//! been, written inside the per-component loop, where they collide on one path and the last
//! component silently decides the whole session.

use super::gate::{resolve_render_gate, GateKind};
use super::isolate::{isolated_agent_name, should_isolate};
use super::split::{should_split_per_step_tier, subagent_name};
use super::types::RenderFlavor;
use crate::ir::{ComponentNode, TriggerKind, WarbleIr};
use crate::resolve::ResolutionReport;
use crate::targets::CapabilityOutcome;
use serde_json::Value;

/// Merge the per-component envelopes into the one session envelope the runtime actually loads.
///
/// The runtime loads `.claude/settings.json` once per session, so a per-component file is not a
/// stricter design — it is the same file written N times, where whichever component the IR happens
/// to end with decides the session. Union is the honest merge: `allow` only pre-approves a tool so
/// the session does not prompt for it, and what an agent may actually use stays its own frontmatter
/// `tools:` list. `deny` unions too, and denial wins — a deny demanded by any component holds for
/// the scope.
pub(super) fn merge_scope_settings(per_component: &[(String, Value)]) -> Value {
    let mut allow: Vec<Value> = Vec::new();
    let mut deny: Vec<Value> = Vec::new();
    let mut comments: Vec<String> = Vec::new();

    for (verb, settings) in per_component {
        for (key, into) in [("allow", &mut allow), ("deny", &mut deny)] {
            if let Some(entries) = settings
                .pointer(&format!("/permissions/{key}"))
                .and_then(Value::as_array)
            {
                for entry in entries {
                    if !into.contains(entry) {
                        into.push(entry.clone());
                    }
                }
            }
        }
        // Component comments are written from the component's point of view ("locked on this
        // component"), which is ambiguous once several of them share one file — so each keeps its
        // subject.
        if let Some(comment) = settings.get("$comment").and_then(Value::as_str) {
            comments.push(format!("{verb}: {comment}"));
        }
    }

    let mut permissions = serde_json::Map::new();
    permissions.insert("allow".to_string(), Value::Array(allow));
    if !deny.is_empty() {
        permissions.insert("deny".to_string(), Value::Array(deny));
    }

    let mut scope_comment = vec![
        "Session-scoped envelope: the union of this profile's component grants, since the runtime \
loads one settings file per session, not one per agent. `allow` pre-approves a tool so the session \
does not prompt for it — it does not restrict what that tool can do, and it does not decide which \
agent may use it (each agent's own `tools:` list in .claude/agents/ does). The enforced limits are \
`deny` below and the data layer's strict_mode in .wren/config.json."
            .to_string(),
    ];
    scope_comment.extend(comments);

    serde_json::json!({
        "$comment": scope_comment.join(" "),
        "permissions": Value::Object(permissions),
    })
}

/// Whether any component of the profile demanded the destructive-bash denials, which the union
/// keeps for the whole scope.
pub(super) fn scope_denies_destructive_bash(per_component: &[(String, Value)]) -> bool {
    per_component.iter().any(|(_, settings)| {
        settings
            .pointer("/permissions/deny")
            .and_then(Value::as_array)
            .is_some_and(|deny| !deny.is_empty())
    })
}

/// One agent's line in the scope prompt's inventory.
fn agent_line(node: &ComponentNode) -> String {
    let mut facts = vec![node.component_type.as_str().to_string()];
    if node.trigger.kind != TriggerKind::OneShot {
        facts.push(format!("trigger `{}`", node.trigger.kind.as_str()));
    }
    let outcome = node.effect.outcome.kind.as_str();
    if outcome != "none" {
        facts.push(format!("outcome `{outcome}`"));
    }
    let internals = if should_isolate(node) {
        vec![isolated_agent_name(&node.verb)]
    } else if should_split_per_step_tier(node) {
        node.llm_calls
            .iter()
            .map(|call| subagent_name(&node.verb, call))
            .collect()
    } else {
        vec![]
    };
    let mut line = format!("- `{}` — {}", node.verb, facts.join(", "));
    if let Some(brief) = node.brief.as_deref() {
        // The component's own framing, when it has one; nothing is invented here.
        let brief = brief.split("\n\n").next().unwrap_or(brief).trim();
        if !brief.is_empty() {
            line.push_str(&format!(". {brief}"));
        }
    }
    if !internals.is_empty() {
        line.push_str(&format!(
            " (its steps run as {})",
            internals
                .iter()
                .map(|name| format!("`{name}`"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    line
}

/// Degrades this target applied, named so a session cannot promise what it cannot deliver.
fn degrade_lines(
    components: &[(&ComponentNode, &ResolutionReport)],
    flavor: RenderFlavor,
) -> Vec<String> {
    let mut lines = Vec::new();
    for (node, report) in components {
        // The render degrade is the one a session would otherwise act on wrongly (by promising a
        // file), so it is spelled out; naming the same capability again generically underneath adds
        // nothing.
        let render_degraded = resolve_render_gate(node, report, flavor).kind == GateKind::Degrade;
        if render_degraded {
            lines.push(format!(
                "- `{}` cannot write a rendered artifact here: its render contract degrades to a \
markdown table plus a prose summary. Do not offer a dashboard file.",
                node.verb
            ));
        }
        for resolved in report.iter() {
            if render_degraded && resolved.capability == "render_contract" {
                continue;
            }
            if resolved.outcome == CapabilityOutcome::Degrade {
                let line = format!(
                    "- `{}`: capability `{}` is degraded on this target.{}",
                    node.verb,
                    resolved.capability,
                    resolved
                        .note
                        .as_deref()
                        .map(|note| format!(" {note}"))
                        .unwrap_or_default()
                );
                if !lines.contains(&line) {
                    lines.push(line);
                }
            }
        }
    }
    lines
}

/// The scope's system prompt: what this directory is, what it binds, what lives in it, and what it
/// cannot do here.
///
/// Every line is a restatement of already-resolved state — the binding, the emitted inventory, the
/// capability report, the envelope. It describes; it does not route. Which agent handles a given
/// request is a decision this file must not pre-empt with per-profile policy, because that policy
/// exists in no IR and in no other target.
pub(super) fn build_scope_prompt(
    ir: &WarbleIr,
    components: &[(&ComponentNode, &ResolutionReport)],
    flavor: RenderFlavor,
    denies_destructive_bash: bool,
) -> String {
    let mut parts = vec![
        format!("# Warble scope: `{}`", ir.profile),
        String::new(),
        "This directory is a materialized Warble profile. It is a scope, not an agent: the \
behavior lives in the agents below, and every session started here runs under this scope's \
binding and limits. Work that one of these agents covers belongs to that agent — select it rather \
than reproducing its job yourself."
            .to_string(),
        String::new(),
        "## Binding".to_string(),
        String::new(),
    ];

    // Deduplicated across the whole profile, not just adjacent entries: the binding is coarse and
    // shared today, but a repeated line here would be a wrong description of the scope, and the
    // order components were mounted in is the only meaningful one.
    let mut bindings: Vec<&str> = Vec::new();
    for (node, _) in components {
        let project = node.context_binding.project.as_str();
        if !bindings.contains(&project) {
            bindings.push(project);
        }
    }
    for project in bindings {
        parts.push(format!("- Semantic project: `{project}`"));
    }
    parts.push(
        "- Data access goes through the `wren` CLI. The data layer runs in strict mode and denies \
`pg_read_file`, `dblink`, `lo_import` (`.wren/config.json`)."
            .to_string(),
    );

    parts.push(String::new());
    parts.push("## Agents in this scope".to_string());
    parts.push(String::new());
    for (node, _) in components {
        parts.push(agent_line(node));
    }
    if components
        .iter()
        .any(|(node, _)| should_split_per_step_tier(node) || should_isolate(node))
    {
        parts.push(String::new());
        parts.push(
            "An agent named `<agent>__<step>` is one agent's internal step, not an entry point; \
its own agent drives it."
                .to_string(),
        );
    }

    let degrades = degrade_lines(components, flavor);
    if !degrades.is_empty() {
        parts.push(String::new());
        parts.push("## Limits resolved for this target".to_string());
        parts.push(String::new());
        parts.extend(degrades);
    }

    parts.push(String::new());
    parts.push("## Permissions".to_string());
    parts.push(String::new());
    parts.push(
        "`.claude/settings.json` pre-approves tools so the session does not prompt for them; it \
does not restrict what a tool does, and each agent's own `tools:` list decides which of them that \
agent may use."
            .to_string(),
    );
    if denies_destructive_bash {
        parts.push(
            "Destructive shell patterns (`rm`, `sudo`, `dd`) are denied outright for every agent \
here."
                .to_string(),
        );
    }
    parts.push(String::new());
    parts.join("\n")
}
