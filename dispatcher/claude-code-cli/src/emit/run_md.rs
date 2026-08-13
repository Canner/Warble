//! RUN.md assembly for the single-agent path (`build_run_md`) plus the per-outcome run-note and
//! run-command builders (`run_command_block` / `trigger_note` / `*_run_notes`) reused by the split
//! path.

use super::gate::{resolve_render_gate, GateKind, RenderGate};
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

pub(super) fn build_run_md(
    node: &ComponentNode,
    report: &ResolutionReport,
    flavor: RenderFlavor,
    models: &ModelConfig,
) -> Result<String, DispatchError> {
    let collapse = if node.llm_calls.is_empty() {
        None
    } else {
        let model = models.collapsed_model(&node.llm_calls)?;
        tier_collapse_comment(&node.llm_calls, model)
    };
    let gate = resolve_render_gate(node, report, flavor);

    let mut notes: Vec<String> = vec![
        format!("Bound wren project: `{}`", node.context_binding.project),
        trigger_note(node),
    ];
    if collapse.is_some() {
        notes.push(
            "Note: this component's llm_calls span more than one tier; the emitted agent uses a \
single collapsed driver model (see the comment in the agent markdown file)."
                .to_string(),
        );
    }
    notes.extend(render_run_notes(&node.verb, &gate));
    notes.extend(assertion_run_notes(node));
    notes.extend(mutation_run_notes(node));

    let mut parts: Vec<String> = vec![
        format!("# Running `{}`", node.verb),
        String::new(),
        "Run from this directory (so `.claude/` and `.wren/` are picked up):".to_string(),
        String::new(),
    ];
    parts.extend(run_command_block(node, &gate));
    parts.push(String::new());
    parts.extend(notes.iter().map(|n| format!("- {n}")));
    parts.push(String::new());
    Ok(parts.join("\n"))
}

/// Native interactive dispatch never owns a one-shot/print-mode invocation. The caller starts the
/// TUI in the canonical output cwd recorded in the launch spec; `--agent` selects the emitted
/// artifact for that interactive session.
pub(super) fn build_interactive_run_md(
    node: &ComponentNode,
    purpose: Option<crate::interactive::NativePurpose>,
) -> String {
    let agent = purpose.map_or(node.verb.as_str(), |purpose| purpose.claude_agent());
    [
        format!("# Running `{}` interactively", node.verb),
        String::new(),
        "Read `.warble/interactive-launch.json` and start the native Claude Code TUI from its canonical `cwd`."
            .to_string(),
        String::new(),
        "```sh".to_string(),
        format!("claude --agent {agent}"),
        "```".to_string(),
        String::new(),
        "This opens a native interactive session with the emitted agent selected. Submit the enrichment request inside the TUI; the caller owns the PTY, prompt, transcript, and session lifecycle."
            .to_string(),
    ]
    .join("\n")
}
