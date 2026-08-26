//! RUN.md assembly. RUN.md is one profile-level document (`build_profile_run_md` for the file
//! targets, `build_interactive_run_md` for native interactive dispatch) with a section per emitted
//! component agent, built from the per-outcome run-note and run-command builders below.

use super::gate::{resolve_render_gate, GateKind, RenderGate};
use super::isolate::{isolated_agent_name, should_isolate};
use super::split::{should_split_per_step_tier, subagent_name};
use super::support::{
    find_guardrail, is_assertion, is_mutation, tier_collapse_comment, DEFAULT_ARTIFACT_SCOPE,
};
use super::types::RenderFlavor;
use crate::error::DispatchError;
use crate::ir::{ComponentNode, TriggerKind};
use crate::models::ModelConfig;
use crate::resolve::ResolutionReport;

pub(super) fn run_command_block(node: &ComponentNode, gate: &RenderGate) -> Vec<String> {
    let verb = &node.verb;
    // +Mutating: the gated two-phase lifecycle, shown conceptually — dry-run capture diff, run the
    // `warble blast-radius` gate, wait for human approval (interactive only), then apply. Apply
    // itself and rollback are BORROWED (git) and not shown as a warble subcommand here.
    //
    // +Constitutive (`outcome.target == "context"`) reuses this same arm but phase 2 is a scoped
    // context-write gate (path authorization), not a `warble blast-radius` subcommand — there is no
    // blast-radius computation on this path.
    if is_mutation(node) {
        return vec![
            "This target does not provide a headless apply command. Start a native interactive CLI only after an external, enforceable approval path is available; otherwise `apply_enrichment` loud-fails.".to_string(),
        ];
    }
    // +Assertive: a scheduled monitor emits a read-only verdict envelope; capture it and render the
    // `status` block. The cadence is borrowed from the runtime scheduler (cron / launchd / CI) — the
    // mechanism is named here (a back-end artifact), never in the IR.
    if is_assertion(node) {
        let mut lines = vec!["```sh".to_string()];
        if node.trigger.kind == TriggerKind::Scheduled {
            lines.push(
                "# register with the runtime scheduler (e.g. cron / launchd / CI) to run on the \
declared cadence; each tick:"
                    .to_string(),
            );
        }
        lines.push(
            "# 1. run the assertion (read-only) and capture its verdict envelope".to_string(),
        );
        lines.push(format!(
            "claude -p \"<check freshness>\" --agent {verb} --output-format json > verdict.json"
        ));
        lines.push("# 2. render the verdict's status block deterministically".to_string());
        lines.push("warble render verdict.json --out status.html".to_string());
        lines.push("```".to_string());
        return lines;
    }
    if gate.kind == GateKind::Realize && gate.flavor == Some(RenderFlavor::Programmatic) {
        vec![
            "```sh".to_string(),
            "# 1. run the agent (read-only) and capture its render envelope".to_string(),
            format!(
                "claude -p \"<data question>\" --agent {verb} --output-format json > result.json"
            ),
            "# 2. render the captured envelope to a dashboard deterministically".to_string(),
            "warble render result.json --out dashboard.html".to_string(),
            "```".to_string(),
        ]
    } else {
        vec![
            "```sh".to_string(),
            format!("claude -p \"<data question>\" --agent {verb}"),
            "```".to_string(),
        ]
    }
}

/// The `Trigger:` line for RUN.md. `scheduled` (+Assertive) borrows the runtime's scheduler and
/// says so; `one_shot` keeps the single-invocation note.
pub(super) fn trigger_note(node: &ComponentNode) -> String {
    match node.trigger.kind {
        TriggerKind::Scheduled => format!(
            "Trigger: `{}` — a resident monitor; register it with the runtime's scheduler (local \
cron / launchd / CI schedule) to run on the cadence. The schedule mechanism is BORROWED from the \
runtime (capability `scheduler`, realize-via), never owned by Warble.",
            node.trigger.kind.as_str()
        ),
        _ => format!(
            "Trigger: `{}` (single headless invocation, no scheduling/event wiring in this POC).",
            node.trigger.kind.as_str()
        ),
    }
}

/// On-breach emit + notify notes for an assertion outcome (RUN.md). Names the emitted signals and
/// the borrowed notify actions; the transport is borrowed (MCP), the wiring is Warble's.
pub(super) fn assertion_run_notes(node: &ComponentNode) -> Vec<String> {
    if !is_assertion(node) {
        return vec![];
    }
    let mut notes = vec![
        "Outcome: `assertion` — the agent stays read-only and emits a `{ blocks, verdict, emitted }` \
verdict envelope; the core fresh/stale decision is deterministic SQL (`max(timestamp)` vs cadence), \
not an LLM call."
            .to_string(),
    ];
    if let Some(emits) = &node.effect.outcome.emits {
        if !emits.is_empty() {
            let actions = if node.borrowed_actions.is_empty() {
                "a runtime notify channel".to_string()
            } else {
                node.borrowed_actions.join(", ")
            };
            notes.push(format!(
                "On breach it emits [{}]; the runtime routes those to borrowed on-breach actions \
({actions}) over the `notify_channel` (realize-via, MCP). Warble declares the wiring; the transport \
is borrowed.",
                emits.join(", ")
            ));
        }
    }
    notes
}

/// Two-phase gated lifecycle notes for a mutation outcome (RUN.md). Names the borrowed version-
/// control/rollback mechanism and the gate step; mirrors `assertion_run_notes`. +Constitutive
/// (`outcome.target == "context"`) reuses this same arm but names the scoped `context_write_authz`
/// gate instead of `warble blast-radius`, since there is no blast-radius computation on that path.
pub(super) fn mutation_run_notes(node: &ComponentNode) -> Vec<String> {
    if !is_mutation(node) {
        return vec![];
    }
    let gate_note = if node.effect.outcome.target.as_deref() == Some("context") {
        let context_guardrail = find_guardrail(&node.guardrails, "context_write_authz");
        let scope = context_guardrail
            .and_then(|g| g.scope.as_deref())
            .unwrap_or(DEFAULT_ARTIFACT_SCOPE);
        format!(
            "Outcome: `mutation` (target `context`) — a gated two-phase lifecycle: the agent \
proposes a DIFF (dry-run, never applies), a scoped `context_write_authz` gate (scope '{scope}') \
authorizes the write path, then the apply is gated on explicit human approval; headless mode has \
no human in the loop and cannot complete this lifecycle."
        )
    } else {
        "Outcome: `mutation` — a gated two-phase lifecycle: the agent proposes a DIFF (dry-run, \
never applies), a `warble blast-radius` gate computes the downstream impact, then the apply is \
gated on explicit human approval; headless mode has no human in the loop and cannot complete this \
lifecycle."
            .to_string()
    };
    vec![
        gate_note,
        "Apply + rollback are BORROWED: a version-control (git) checkpoint is taken before applying \
so the change can be rolled back; Warble does not own or reimplement git."
            .to_string(),
    ]
}

pub(super) fn render_run_notes(verb: &str, gate: &RenderGate) -> Vec<String> {
    match gate.kind {
        GateKind::Realize if gate.flavor == Some(RenderFlavor::Programmatic) => vec![format!(
            "Render output: `{verb}` stays fully read-only and emits a `{{ blocks, summary }}` \
render envelope as its final message; `warble render` turns that into `dashboard.html` \
deterministically (no LLM in the render step)."
        )],
        GateKind::Realize => vec![format!(
            "Render output: the agent writes `dashboard.html` into the artifact-write scope \
directory (`{}`) (prompt render flavor).",
            gate.scope
                .clone()
                .unwrap_or_else(|| DEFAULT_ARTIFACT_SCOPE.to_string())
        )],
        GateKind::Degrade => vec![
            "Render output: this target degrades the render contract to a markdown table + prose \
summary (no file is written)."
                .to_string(),
        ],
        GateKind::None => vec![],
    }
}

/// One component's run section inside the profile-level RUN.md: its own invocation plus the notes
/// that belong to its enum arms. Emitting the whole profile is what makes the sections necessary —
/// a per-component document could put this at the top level, but then only one component could own
/// RUN.md.
fn component_run_section(
    node: &ComponentNode,
    report: &ResolutionReport,
    flavor: RenderFlavor,
    models: &ModelConfig,
    binding_is_shared: bool,
) -> Result<Vec<String>, DispatchError> {
    let gate = resolve_render_gate(node, report, flavor);
    let split = should_split_per_step_tier(node) && !should_isolate(node);

    let mut notes: Vec<String> = Vec::new();
    // Every component of a profile normally resolves to the same bound project, and repeating it in
    // each section reads as if they could differ per invocation. The binding is per component in the
    // IR though, so a profile that really does bind two projects still says so section by section.
    if !binding_is_shared {
        notes.push(format!(
            "Bound wren project: `{}`",
            node.context_binding.project
        ));
    }
    notes.push(trigger_note(node));
    if split {
        let subagent_models = node
            .llm_calls
            .iter()
            .map(|call| {
                Ok(format!(
                    "`{}`={}",
                    subagent_name(&node.verb, call),
                    models.require(&call.tier)?
                ))
            })
            .collect::<Result<Vec<_>, DispatchError>>()?
            .join(", ");
        notes.push(format!(
            "Per-step tiers are realized as subagents ({subagent_models}); the driver ({}) only \
routes + marshals between them via the Task tool.",
            models.orchestrator()?
        ));
    } else if !node.llm_calls.is_empty()
        && tier_collapse_comment(&node.llm_calls, models.collapsed_model(&node.llm_calls)?)
            .is_some()
    {
        notes.push(
            "Note: this component's llm_calls span more than one tier; the emitted agent uses a \
single collapsed driver model (see the comment in the agent markdown file)."
                .to_string(),
        );
    }
    notes.extend(render_run_notes(&node.verb, &gate));
    notes.extend(assertion_run_notes(node));
    notes.extend(mutation_run_notes(node));

    let mut parts = vec![format!("## `{}`", node.verb), String::new()];
    parts.extend(run_command_block(node, &gate));
    parts.push(String::new());
    parts.extend(notes.iter().map(|note| format!("- {note}")));
    parts.push(String::new());
    Ok(parts)
}

/// RUN.md for the file targets, written once for the whole profile.
///
/// RUN.md is a profile-level artifact because the emitted directory is: one `.claude/`, one
/// `.wren/`, one settings file, N component agents. Building it per component would mean N writes
/// to one path, where the last component silently wins and the rest of the profile is undocumented.
pub(super) fn build_profile_run_md(
    profile: &str,
    components: &[(&ComponentNode, &ResolutionReport)],
    flavor: RenderFlavor,
    models: &ModelConfig,
) -> Result<String, DispatchError> {
    let shared_binding = components
        .first()
        .map(|(node, _)| node.context_binding.project.as_str())
        .filter(|project| {
            components
                .iter()
                .all(|(node, _)| node.context_binding.project == *project)
        });

    let mut parts: Vec<String> = vec![
        format!("# Running `{profile}`"),
        String::new(),
        "Run each agent from this directory (so `.claude/` and `.wren/` are picked up)."
            .to_string(),
        String::new(),
        match components.len() {
            1 => "This profile emits one component agent.".to_string(),
            n => format!("This profile emits {n} component agents; each is invoked on its own."),
        },
        String::new(),
    ];
    if let Some(project) = shared_binding {
        parts.push(format!("- Bound wren project: `{project}`"));
        parts.push(String::new());
    }
    for (node, report) in components {
        parts.extend(component_run_section(
            node,
            report,
            flavor,
            models,
            shared_binding.is_some(),
        )?);
    }
    Ok(parts.join("\n"))
}

/// RUN.md for native interactive dispatch, written once for the whole profile.
///
/// Interactive dispatch never owns a one-shot/print-mode invocation, and it never selects a
/// component of its own accord: the caller starts the TUI in the canonical output cwd with the
/// launch spec's `argv`, which is empty unless a native purpose declares the profile's entry agent.
/// The emitted component agents are listed as what that one session has available, not as N
/// alternative sessions to start.
pub(super) fn build_interactive_run_md(
    ir: &crate::ir::WarbleIr,
    purpose: Option<crate::interactive::NativePurpose>,
    entry_verb: Option<&str>,
) -> String {
    let entry = entry_verb;
    let mut parts = vec![
        format!("# Running `{}` interactively", ir.profile),
        String::new(),
        "Read `.warble/interactive-launch.json` and start the native Claude Code TUI from its canonical `cwd` with its `argv`."
            .to_string(),
        String::new(),
        "```sh".to_string(),
        match entry {
            Some(agent) => format!("claude --agent {agent}"),
            None => "claude".to_string(),
        },
        "```".to_string(),
        String::new(),
    ];
    match (entry, purpose) {
        (Some(agent), Some(purpose)) => parts.push(format!(
            "This opens a native interactive session on this profile, with `{agent}` — its entry \
agent for the `{}` session purpose — selected. Submit the request inside the TUI; the caller owns \
the PTY, prompt, transcript, and session lifecycle.",
            purpose.as_str()
        )),
        // No purpose declares an entry agent, so the spec selects none — and a session that selects
        // none is NOT running this profile's behavior. Its agents are on disk, but nothing puts one
        // in charge: the emitted descriptions state each component's IR shape, not when to use it,
        // so vendor-side auto-delegation has nothing to match on. Saying otherwise here would claim
        // routing that no emitted artifact provides.
        _ => parts.push(
            "That starts a native interactive session with no agent selected: a plain session in \
this directory, which has this profile's agents on disk but none of them in charge. Do not rely on \
it delegating to them by itself. Select the component whose behavior you want instead:"
                .to_string(),
        ),
    }
    parts.push(String::new());
    if entry.is_none() {
        parts.push("```sh".to_string());
        for node in &ir.components {
            parts.push(format!("claude --agent {}", node.verb));
        }
        parts.push("```".to_string());
        parts.push(String::new());
        parts.push(
            "The caller owns the PTY, prompt, transcript, and session lifecycle either way."
                .to_string(),
        );
        parts.push(String::new());
    }
    parts.push("Agents emitted by this profile:".to_string());
    parts.push(String::new());
    for node in &ir.components {
        let steps = if should_split_per_step_tier(node) && !should_isolate(node) {
            node.llm_calls
                .iter()
                .map(|call| format!("`{}`", subagent_name(&node.verb, call)))
                .collect::<Vec<_>>()
                .join(", ")
        } else if should_isolate(node) {
            format!("`{}`", isolated_agent_name(&node.verb))
        } else {
            String::new()
        };
        let entry_marker = if entry == Some(node.verb.as_str()) {
            " (entry)"
        } else {
            ""
        };
        parts.push(if steps.is_empty() {
            format!("- `{}`{entry_marker}", node.verb)
        } else {
            format!("- `{}`{entry_marker} — subagents: {steps}", node.verb)
        });
    }
    parts.push(String::new());
    parts.join("\n")
}
