//! claude-code target — emits Claude Code agent runtime files from a resolved Warble IR.
//!
//! Dispatch is keyed on IR enum values (`realization_kind`, `trigger.kind`, `effect.outcome.kind`),
//! never on a component's id/verb. Enum values not yet supported by this target fail loudly
//! ("wall-hit") rather than silently emitting something wrong — see `unsupported`.

use crate::error::DispatchError;
use crate::ir::{
    ComponentNode, Guardrail, LlmCall, OutcomeKind, RealizationKind, TriggerKind, WarbleIr,
};
use crate::models::ModelConfig;
use crate::resolve::{resolve_capabilities, ResolutionReport};
use crate::targets::{is_known_target, known_target_names, CapabilityOutcome, TargetId};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::Path;

/// Render flavor (docs/spec/ir-schema.md §v0.3 §4). `programmatic` (default): the agent stays read-only
/// and emits a `{blocks}` envelope; a downstream renderer produces HTML deterministically. `prompt`:
/// the plain-file fallback — the agent is granted scoped write and writes `dashboard.html` itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderFlavor {
    Programmatic,
    Prompt,
}

pub const DEFAULT_RENDER_FLAVOR: RenderFlavor = RenderFlavor::Programmatic;

impl RenderFlavor {
    pub fn as_str(&self) -> &'static str {
        match self {
            RenderFlavor::Programmatic => "programmatic",
            RenderFlavor::Prompt => "prompt",
        }
    }

    pub fn parse(value: &str) -> Option<RenderFlavor> {
        match value {
            "programmatic" => Some(RenderFlavor::Programmatic),
            "prompt" => Some(RenderFlavor::Prompt),
            _ => None,
        }
    }
}

const PER_STEP_TIER_CAPABILITY: &str = "llm:per_step_tier";

const DRIVER_TOOLS: [&str; 2] = ["Task", "Read"];
// Capabilities realized by shelling out to the `wren` CLI — any of them means the agent needs
// `Bash(wren:*)`. `semantic_introspection` (realized via `wren context show`) belongs here for the
// same reason `sql_execution:read_only`/`genbi_build` do: without the wren tool it cannot introspect.
const DATA_ACCESS_CAPABILITIES: [&str; 3] = [
    "sql_execution:read_only",
    "genbi_build",
    "semantic_introspection",
];
const READ_ONLY_GUARDRAIL_NAME: &str = "read_only_execution";
const ARTIFACT_WRITE_GUARDRAIL_NAME: &str = "artifact_write";
const RENDER_CONTRACT_CAPABILITY: &str = "render_contract";
const DEFAULT_ARTIFACT_SCOPE: &str = ".";
const DESTRUCTIVE_BASH_DENY_PATTERNS: [&str; 3] = ["Bash(rm:*)", "Bash(sudo:*)", "Bash(dd:*)"];

fn unsupported(field: &str, value: &str) -> DispatchError {
    DispatchError(format!(
        "{field} '{value}' is not supported by the claude-code file target (wall-hit)"
    ))
}

// --- handler support checks (documented extension points; loud-fail today) ----------------------

/// `realization_kind`: `skill` (v1) and `tool` (+Assertive) are realized. Both emit a Claude Code
/// agent; a `tool` is the same agent invoked as an independently-scheduled monitor with its own
/// tier + alert boundary (profile-runtime-model §3). `gated-tool` (a tool behind a hard approval
/// gate) is the +Mutating extension point — still a loud-fail.
fn realization_supported(kind: RealizationKind) -> bool {
    matches!(kind, RealizationKind::Skill | RealizationKind::Tool)
}

/// `trigger.kind`: `one_shot` (v1) and `scheduled` (+Assertive; the cadence is borrowed from the
/// runtime's scheduler — cron / launchd / CI, legalized in RUN.md, never in the IR). `event`
/// (activation *by* an inbound event — proactive monitoring) is not yet a realized handler and
/// loud-fails here, even though the `event_bus` transport it would borrow is now realize-via.
fn trigger_supported(kind: TriggerKind) -> bool {
    matches!(kind, TriggerKind::OneShot | TriggerKind::Scheduled)
}

/// `effect.outcome.kind`: `none` (render-only, v1) and `assertion` (+Assertive: a read-only verdict
/// plus an emitted signal). `mutation`/`dispatch` each map to one borrowed capability — a +1 outcome
/// handler each when built (dispatcher stays thin); still loud-fails.
fn outcome_supported(kind: OutcomeKind) -> bool {
    matches!(kind, OutcomeKind::None | OutcomeKind::Assertion)
}

/// A single Claude Code agent file supports one `model`. When llm_calls span more than one tier,
/// record the collapse as a visible comment rather than silently dropping it.
fn tier_collapse_comment(llm_calls: &[LlmCall], model: &str) -> Option<String> {
    let distinct: HashSet<&str> = llm_calls.iter().map(|c| c.tier.as_str()).collect();
    if distinct.len() <= 1 {
        return None;
    }
    let steps = llm_calls
        .iter()
        .map(|c| format!("{}={}", c.name, c.tier))
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "<!-- warble: per-step tiers [{steps}] collapsed to driver model '{model}' -->"
    ))
}

fn has_data_access_capability(caps: &[String]) -> bool {
    caps.iter()
        .any(|c| DATA_ACCESS_CAPABILITIES.contains(&c.as_str()))
}

fn is_read_only(guardrails: &[Guardrail]) -> bool {
    guardrails
        .iter()
        .any(|g| g.name == READ_ONLY_GUARDRAIL_NAME)
}

fn find_guardrail<'a>(guardrails: &'a [Guardrail], name: &str) -> Option<&'a Guardrail> {
    guardrails.iter().find(|g| g.name == name)
}

// --- render gate --------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GateKind {
    Realize,
    Degrade,
    None,
}

struct RenderGate {
    kind: GateKind,
    scope: Option<String>,
    flavor: Option<RenderFlavor>,
}

/// The render gate only resolves to `realize` when `render_contract` is `realize-via` on the
/// target — in this POC only `claude-code:headless`, which always has `structured_output_capture`
/// native, so the requested flavor is honored as-is. Interactive degrades render to markdown and
/// never reaches `realize`.
fn resolve_render_gate(
    node: &ComponentNode,
    report: &ResolutionReport,
    flavor: RenderFlavor,
) -> RenderGate {
    let artifact_write = find_guardrail(&node.guardrails, ARTIFACT_WRITE_GUARDRAIL_NAME);
    let Some(artifact_write) = artifact_write else {
        return RenderGate {
            kind: GateKind::None,
            scope: None,
            flavor: None,
        };
    };
    if node.effect.render_blocks.is_empty() {
        return RenderGate {
            kind: GateKind::None,
            scope: None,
            flavor: None,
        };
    }
    let render_entry = report
        .iter()
        .find(|r| r.capability == RENDER_CONTRACT_CAPABILITY);
    match render_entry.map(|e| e.outcome) {
        Some(CapabilityOutcome::RealizeVia) => RenderGate {
            kind: GateKind::Realize,
            scope: Some(
                artifact_write
                    .scope
                    .clone()
                    .unwrap_or_else(|| DEFAULT_ARTIFACT_SCOPE.to_string()),
            ),
            flavor: Some(flavor),
        },
        Some(CapabilityOutcome::Degrade) => RenderGate {
            kind: GateKind::Degrade,
            scope: None,
            flavor: None,
        },
        _ => RenderGate {
            kind: GateKind::None,
            scope: None,
            flavor: None,
        },
    }
}

/// Only the prompt flavor needs the agent to write the file itself; programmatic keeps it read-only.
fn gate_grants_write(gate: &RenderGate) -> bool {
    gate.kind == GateKind::Realize && gate.flavor == Some(RenderFlavor::Prompt)
}

fn build_tools(node: &ComponentNode, gate: &RenderGate) -> Vec<String> {
    let mut tools: Vec<String> = Vec::new();
    if has_data_access_capability(&node.required_capabilities) {
        tools.push("Read".to_string());
        tools.push("Bash(wren:*)".to_string());
    } else {
        tools.push("Read".to_string());
    }
    let mutating = !is_read_only(&node.guardrails);
    if mutating {
        tools.push("Edit".to_string());
    }
    if mutating || gate_grants_write(gate) {
        tools.push("Write".to_string());
    }
    tools
}

fn build_description(node: &ComponentNode) -> String {
    let block_types: Vec<&str> = node
        .effect
        .render_blocks
        .iter()
        .map(|b| b.block_type.as_str())
        .collect();
    let blocks = if block_types.is_empty() {
        "no render blocks".to_string()
    } else {
        block_types.join(", ")
    };
    format!(
        "{} {} that renders {blocks} (outcome: {}).",
        node.component_type.as_str(),
        node.realization_kind.as_str(),
        node.effect.outcome.kind.as_str()
    )
}

fn format_render_block(block: &crate::ir::RenderBlock) -> String {
    let fields = block
        .fields
        .iter()
        .map(|(k, v)| format!("{k}: {v}"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("- `{}`: {{ {fields} }}", block.block_type)
}

const ENVELOPE_EXAMPLE: &str = r#"```json
{
  "blocks": [
    { "type": "kpi_card", "label": "Total revenue", "value": 1672.4, "unit": "USD" },
    { "type": "table", "columns": ["status", "orders"], "rows": [["completed", 67], ["shipped", 32]] },
    { "type": "chart", "chart_type": "bar", "x": "status", "series": ["orders"],
      "rows": [["completed", 67], ["shipped", 32]] },
    { "type": "definition", "sql": "SELECT status, count(*) AS orders FROM orders GROUP BY status",
      "source_tables": ["orders"], "filters": [] }
  ],
  "verified": true,
  "summary": "One or two sentences of prose (optional)."
}
```"#;

/// Shared verify + definition contract text (G2 hard line + G3 shallow card). Appended to any
/// realize-path render section so both back-ends instruct the agent identically.
const VERIFY_DEFINITION_CONTRACT: &str = "Before you answer you MUST verify (per-answer verify, \
required): actually execute the query through `wren`, then validate the result set is legitimate \
(non-empty where a value is expected, types/units sane, grain matches the question). If it is not, \
repair the query and re-run; if it still cannot be validated, REFUSE — say so plainly and do not \
fabricate a number. Set the envelope's top-level `\"verified\": true` ONLY when a query ran and its \
result set passed validation. Always include one `definition` block — the shallow \"how this was \
computed\" card: the exact `sql` you ran, the `source_tables` it read, and the `filters` you \
applied. This is run-level provenance only; do not invent unit/owner/formal-metric lineage (that \
is Phase 2).";

fn build_render_section(node: &ComponentNode, gate: &RenderGate) -> Option<String> {
    match gate.kind {
        GateKind::Realize => Some(if gate.flavor == Some(RenderFlavor::Prompt) {
            build_prompt_render_section(node, gate)
        } else {
            build_programmatic_render_section(node)
        }),
        GateKind::Degrade => Some(
            [
                "## Render output",
                "",
                "This target has no artifact-write surface for render output: render the results \
as a markdown table plus a short prose summary instead. Do not write any files.",
            ]
            .join("\n"),
        ),
        GateKind::None => None,
    }
}

fn build_programmatic_render_section(node: &ComponentNode) -> String {
    let mut lines: Vec<String> = vec![
        "## Render output".to_string(),
        String::new(),
        "Block contract (produce data matching these shapes, not prose):".to_string(),
        String::new(),
    ];
    lines.extend(node.effect.render_blocks.iter().map(format_render_block));
    lines.push(String::new());
    lines.push(
        "Do NOT write any files and do NOT format the answer as prose or markdown. After \
gathering the data via `wren`, your FINAL message must be a SINGLE JSON object — the render \
envelope — and nothing else: a `blocks` array of instances conforming to the contract above, \
plus an optional `summary` string. A downstream renderer turns this envelope into the dashboard \
deterministically; you stay read-only."
            .to_string(),
    );
    lines.push(String::new());
    lines.push(VERIFY_DEFINITION_CONTRACT.to_string());
    lines.push(String::new());
    lines.push("Envelope shape:".to_string());
    lines.push(String::new());
    lines.push(ENVELOPE_EXAMPLE.to_string());
    lines.join("\n")
}

fn build_prompt_render_section(node: &ComponentNode, gate: &RenderGate) -> String {
    let scope = gate
        .scope
        .clone()
        .unwrap_or_else(|| DEFAULT_ARTIFACT_SCOPE.to_string());
    let mut lines: Vec<String> = vec![
        "## Render output".to_string(),
        String::new(),
        "Block contract (produce data matching these shapes, not prose):".to_string(),
        String::new(),
    ];
    lines.extend(node.effect.render_blocks.iter().map(format_render_block));
    lines.push(String::new());
    lines.push(format!(
        "After gathering the data via `wren`, write a SINGLE self-contained `dashboard.html` file \
into the artifact-write scope directory (`{scope}`), rendering the blocks above: KPI cards, an \
HTML table, and a simple chart (inline SVG or a CDN-loaded chart library — no build step). Also \
render a `✓ Verified` pill next to the title and a \"how this was computed\" definition panel (the \
SQL you ran, source tables, filters). End your reply stating the path of the file you wrote."
    ));
    lines.push(String::new());
    lines.push(VERIFY_DEFINITION_CONTRACT.to_string());
    lines.join("\n")
}

// --- assertion outcome section (+Assertive) -----------------------------------------------------

/// Whether this component's outcome is an `assertion` (a read-only verdict + emitted signal), the
/// +Assertive outcome handler. Keyed on the outcome enum only — never on the component's id/verb.
fn is_assertion(node: &ComponentNode) -> bool {
    node.effect.outcome.kind == OutcomeKind::Assertion
}

const VERDICT_ENVELOPE_EXAMPLE: &str = r#"```json
{
  "blocks": [
    { "type": "status", "state": "stale", "label": "orders freshness",
      "detail": "max(order_date) is 51h old; expected within 24h", "severity": "critical" }
  ],
  "verdict": { "type": "freshness_verdict", "fresh": false, "observed_lag_hours": 51, "expected_cadence": "24h" },
  "emitted": ["freshness_breach"],
  "verified": true
}
```"#;

/// The assertion output contract (+Assertive). The structural twin of the programmatic render
/// section: the agent stays fully read-only and emits a single `{ blocks, verdict, emitted }`
/// envelope as its final message; the dispatcher's `warble render` turns the `status` block into
/// HTML deterministically. The core assert is deterministic SQL (`max(timestamp)` vs cadence); the
/// LLM only classifies severity when stale (the `assess_severity` step, conditional). `verdict_type`
/// and `emits` come straight from `effect.outcome` — the assertion arm the IR spine already carries.
fn build_assertion_section(node: &ComponentNode) -> String {
    let outcome = &node.effect.outcome;
    let verdict_type = outcome.verdict_type.as_deref().unwrap_or("verdict");
    let emits = outcome.emits.clone().unwrap_or_default();
    let emits_line = if emits.is_empty() {
        "This assertion emits no signals.".to_string()
    } else {
        format!(
            "On breach, list the emitted signal name(s) in the envelope's `emitted` array: [{}]. \
The runtime routes those signals to the borrowed on-breach actions ({}) over the notify channel — \
Warble declares the wiring (signal ↔ action); the transport (Slack / Jira / MCP) is borrowed, not \
owned by this agent.",
            emits
                .iter()
                .map(|e| format!("`{e}`"))
                .collect::<Vec<_>>()
                .join(", "),
            if node.borrowed_actions.is_empty() {
                "a runtime notify channel".to_string()
            } else {
                node.borrowed_actions
                    .iter()
                    .map(|a| format!("`{a}`"))
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        )
    };

    let mut lines: Vec<String> = vec![
        "## Assertion output".to_string(),
        String::new(),
        format!(
            "This is an **assertive** component (outcome: assertion, verdict_type `{verdict_type}`). \
Its core is a DETERMINISTIC check, not a judgment call: run the freshness assert through `wren` — \
`SELECT max(<timestamp column>)` on the bound model — and compare the observed lag against the \
expected cadence (`expected_cadence` param, or the MDL's declared cadence). Fresh iff the newest \
row is within the cadence; stale otherwise. Do NOT ask an LLM to decide fresh-vs-stale — that is a \
SQL comparison and must be reproducible."
        ),
        String::new(),
        "Only when the data is STALE do you use judgment, via the `assess_severity` step, to \
classify how bad it is (e.g. warn vs critical) from the lag magnitude and history. When fresh, \
there is no severity to assess."
            .to_string(),
        String::new(),
        "Verdict block contract (produce data matching these shapes, not prose):".to_string(),
        String::new(),
    ];
    lines.extend(node.effect.render_blocks.iter().map(format_render_block));
    lines.push(String::new());
    lines.push(
        "Stay strictly read-only: only `SELECT` through `wren`, never write to the warehouse and \
never write any files. Your FINAL message MUST be a SINGLE JSON object — the verdict envelope — \
and nothing else: a `blocks` array (the `status` block above), a `verdict` object \
(`{ type, fresh, ... }`), and, on breach, an `emitted` array. A downstream renderer turns the \
`status` block into HTML deterministically; you stay read-only. Set the top-level `\"verified\": \
true` only when the assert query actually ran and its result was validated."
            .to_string(),
    );
    lines.push(String::new());
    lines.push(emits_line);
    lines.push(String::new());
    lines.push("Envelope shape:".to_string());
    lines.push(String::new());
    lines.push(VERDICT_ENVELOPE_EXAMPLE.to_string());
    lines.join("\n")
}

// --- YAML frontmatter -----------------------------------------------------------------------------

#[derive(Serialize)]
struct AgentFrontmatter {
    name: String,
    description: String,
    tools: Vec<String>,
    model: String,
}

fn to_yaml(fm: &impl Serialize) -> String {
    serde_yaml::to_string(fm)
        .expect("frontmatter serializes")
        .trim_end()
        .to_string()
}

fn build_agent_markdown(
    node: &ComponentNode,
    report: &ResolutionReport,
    flavor: RenderFlavor,
    models: &ModelConfig,
) -> Result<String, DispatchError> {
    let gate = resolve_render_gate(node, report, flavor);
    let model = models.collapsed_model(&node.llm_calls)?;
    let frontmatter = AgentFrontmatter {
        name: node.verb.clone(),
        description: build_description(node),
        tools: build_tools(node, &gate),
        model: model.to_string(),
    };
    let yaml_block = to_yaml(&frontmatter);

    let preamble = [
        format!(
            "You are bound to the wren project at `{}`.",
            node.context_binding.project
        ),
        "All data access MUST go through the `wren` CLI (e.g. `wren --sql ...`, `wren cube list`, \
`wren genbi build ...`) — never raw SQL clients, never filesystem tricks against the underlying \
warehouse."
            .to_string(),
    ]
    .join("\n");

    let mut parts: Vec<String> = vec![
        "---".to_string(),
        yaml_block,
        "---".to_string(),
        String::new(),
        preamble,
    ];
    if let Some(comment) = tier_collapse_comment(&node.llm_calls, model) {
        parts.push(String::new());
        parts.push(comment);
    }
    parts.push(String::new());
    parts.push(node.prompt_fragment.clone());

    if let Some(section) = build_render_section(node, &gate) {
        parts.push(String::new());
        parts.push(section);
    }
    if is_assertion(node) {
        parts.push(String::new());
        parts.push(build_assertion_section(node));
    }

    Ok(format!("{}\n", parts.join("\n")))
}

// --- settings + wren config -----------------------------------------------------------------------

fn build_settings(
    node: &ComponentNode,
    report: &ResolutionReport,
    flavor: RenderFlavor,
) -> serde_json::Value {
    let gate = resolve_render_gate(node, report, flavor);
    let allow = build_tools(node, &gate);
    let read_only = is_read_only(&node.guardrails);

    let mut comments: Vec<String> = Vec::new();
    if read_only {
        comments.push(
            "Guardrail 'read_only_execution' is locked on this component: it enforces DATA \
read-only (destructive bash patterns denied here, plus wren's strict_mode at the data layer — \
see .wren/config.json). It does NOT, by itself, withhold artifact writes."
                .to_string(),
        );
    }
    if gate_grants_write(&gate) {
        comments.push(format!(
            "Guardrail 'artifact_write' is locked, scope '{}': grants the Write tool above so the \
agent can write the rendered dashboard.html into that scope only (prompt render flavor).",
            gate.scope
                .clone()
                .unwrap_or_else(|| DEFAULT_ARTIFACT_SCOPE.to_string())
        ));
    } else if gate.kind == GateKind::Realize {
        comments.push(
            "Render flavor is programmatic: the agent stays fully read-only (no Write) and emits a \
render envelope as output; the dispatcher's warble-render produces dashboard.html."
                .to_string(),
        );
    }

    let permissions = if read_only {
        serde_json::json!({ "allow": allow, "deny": DESTRUCTIVE_BASH_DENY_PATTERNS })
    } else {
        serde_json::json!({ "allow": allow })
    };
    if comments.is_empty() {
        serde_json::json!({ "permissions": permissions })
    } else {
        serde_json::json!({ "$comment": comments.join(" "), "permissions": permissions })
    }
}

fn wren_config() -> serde_json::Value {
    serde_json::json!({
        "strict_mode": true,
        "denied_functions": ["pg_read_file", "dblink", "lo_import"],
    })
}

// --- RUN.md ---------------------------------------------------------------------------------------

fn run_command_block(node: &ComponentNode, gate: &RenderGate) -> Vec<String> {
    let verb = &node.verb;
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
fn trigger_note(node: &ComponentNode) -> String {
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
fn assertion_run_notes(node: &ComponentNode) -> Vec<String> {
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

fn render_run_notes(verb: &str, gate: &RenderGate) -> Vec<String> {
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

fn build_run_md(
    node: &ComponentNode,
    report: &ResolutionReport,
    flavor: RenderFlavor,
    models: &ModelConfig,
) -> Result<String, DispatchError> {
    let model = models.collapsed_model(&node.llm_calls)?;
    let collapse = tier_collapse_comment(&node.llm_calls, model);
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

// --- per-step-tier split realization (v0.2) -------------------------------------------------------

fn distinct_tier_count(llm_calls: &[LlmCall]) -> usize {
    llm_calls
        .iter()
        .map(|c| c.tier.as_str())
        .collect::<HashSet<_>>()
        .len()
}

fn should_split_per_step_tier(node: &ComponentNode) -> bool {
    node.realization_kind == RealizationKind::Skill
        && node
            .required_capabilities
            .iter()
            .any(|c| c == PER_STEP_TIER_CAPABILITY)
        && distinct_tier_count(&node.llm_calls) > 1
}

fn subagent_name(verb: &str, call: &LlmCall) -> String {
    format!("{verb}__{}", call.name)
}

fn producer_by_produces(llm_calls: &[LlmCall]) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for call in llm_calls {
        if let Some(p) = &call.produces {
            map.insert(p.clone(), call.name.clone());
        }
    }
    map
}

fn build_driver_wiring_line(
    node: &ComponentNode,
    call: &LlmCall,
    producers: &std::collections::HashMap<String, String>,
) -> String {
    let name = subagent_name(&node.verb, call);
    let mut parts = vec![format!(
        "Run the `{name}` subagent (step `{}`) via the Task tool.",
        call.name
    )];
    if !call.consumes.is_empty() {
        let sources = call
            .consumes
            .iter()
            .map(|slot| match producers.get(slot) {
                Some(producer) => format!("`{slot}` (the `{producer}` subagent's output)"),
                None => format!("`{slot}`"),
            })
            .collect::<Vec<_>>()
            .join(", ");
        parts.push(format!("Pass it {sources} as input."));
    }
    if let Some(p) = &call.produces {
        parts.push(format!("Take its output as `{p}` for the steps after it."));
    }
    parts.join(" ")
}

fn build_driver_body(node: &ComponentNode) -> String {
    let producers = producer_by_produces(&node.llm_calls);
    let steps = node
        .llm_calls
        .iter()
        .enumerate()
        .map(|(i, call)| {
            format!(
                "{}. {}",
                i + 1,
                build_driver_wiring_line(node, call, &producers)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    [
        format!(
            "You orchestrate the `{}` steps by delegating each one to its dedicated subagent via \
the Task tool, in order. Do not perform a step's work yourself — each step's tier-appropriate \
subagent does it.",
            node.verb
        ),
        String::new(),
        "Steps, in order:".to_string(),
        String::new(),
        steps,
        String::new(),
        "Marshal each subagent's declared output into the next subagent's declared input exactly \
as named above; do not invent or rename slots."
            .to_string(),
    ]
    .join("\n")
}

fn build_driver_markdown(
    node: &ComponentNode,
    report: &ResolutionReport,
    flavor: RenderFlavor,
    models: &ModelConfig,
) -> String {
    let gate = resolve_render_gate(node, report, flavor);
    let mut tools: Vec<String> = DRIVER_TOOLS.iter().map(|s| s.to_string()).collect();
    if gate_grants_write(&gate) {
        tools.push("Write".to_string());
    }
    let frontmatter = AgentFrontmatter {
        name: node.verb.clone(),
        description: format!(
            "{} orchestrator that delegates {}'s per-step-tier work to subagents (outcome: {}).",
            node.component_type.as_str(),
            node.verb,
            node.effect.outcome.kind.as_str()
        ),
        tools,
        model: models
            .orchestrator()
            .expect("orchestrator tier validated up front in emit_claude_code_with_models")
            .to_string(),
    };
    let yaml_block = to_yaml(&frontmatter);

    let model_comment = format!(
        "<!-- warble: model '{}' is the reserved `orchestrator` tier chosen by the claude-code \
back-end for the driver's routing loop; it is NOT derived from the IR's per-step llm_calls tiers \
— those are realized by the delegated subagents below, each at its own tier. -->",
        models
            .orchestrator()
            .expect("orchestrator tier validated up front in emit_claude_code_with_models")
    );

    let mut parts: Vec<String> = vec![
        "---".to_string(),
        yaml_block,
        "---".to_string(),
        String::new(),
        model_comment,
        String::new(),
        format!(
            "You are bound to the wren project at `{}`.",
            node.context_binding.project
        ),
        String::new(),
        build_driver_body(node),
    ];

    if let Some(section) = build_render_section(node, &gate) {
        parts.push(String::new());
        parts.push(
            "<!-- warble: render-contract realization folded into the driver, since this component \
is split per-step-tier — the driver collects subagent output and is the one that produces the \
render output (emits the envelope on the programmatic flavor, or writes the artifact on the \
prompt flavor). -->"
                .to_string(),
        );
        parts.push(String::new());
        parts.push(section);
    } else {
        // No render section (e.g. answer_query): the terminal step already produced the user-facing
        // structured answer, carrying its `verified` facet + shallow `definition` (G2/G3). The driver
        // must pass it through verbatim, or the ✓ Verified cue and definition card are lost.
        parts.push(String::new());
        parts.push(
            "Your FINAL message MUST be the terminal step's structured output verbatim — a single \
JSON object with its `columns`/`rows` (or refusal) plus the `verified` boolean and the shallow \
`definition` it emitted. Do not summarize it into prose or drop any field."
                .to_string(),
        );
    }

    if is_assertion(node) {
        parts.push(String::new());
        parts.push(build_assertion_section(node));
    }

    format!("{}\n", parts.join("\n"))
}

fn build_subagent_markdown(node: &ComponentNode, call: &LlmCall, models: &ModelConfig) -> String {
    let no_gate = RenderGate {
        kind: GateKind::None,
        scope: None,
        flavor: None,
    };
    let frontmatter = AgentFrontmatter {
        name: subagent_name(&node.verb, call),
        description: format!(
            "'{}' step of `{}` (tier: {}).",
            call.name, node.verb, call.tier
        ),
        tools: build_tools(node, &no_gate),
        model: models
            .require(&call.tier)
            .expect("tier validated up front in emit_claude_code_with_models")
            .to_string(),
    };
    let yaml_block = to_yaml(&frontmatter);

    let io_note = format!(
        "<!-- warble: consumes [{}] / produces {} -->",
        call.consumes.join(", "),
        call.produces
            .clone()
            .unwrap_or_else(|| "(none)".to_string())
    );

    let parts = [
        "---".to_string(),
        yaml_block,
        "---".to_string(),
        String::new(),
        call.prompt.clone(),
        String::new(),
        io_note,
    ];
    format!("{}\n", parts.join("\n"))
}

fn build_split_settings(
    node: &ComponentNode,
    report: &ResolutionReport,
    flavor: RenderFlavor,
) -> serde_json::Value {
    let gate = resolve_render_gate(node, report, flavor);
    let no_gate = RenderGate {
        kind: GateKind::None,
        scope: None,
        flavor: None,
    };
    let mut driver_tools: Vec<String> = DRIVER_TOOLS.iter().map(|s| s.to_string()).collect();
    if gate_grants_write(&gate) {
        driver_tools.push("Write".to_string());
    }
    let mut allow: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for t in driver_tools.into_iter().chain(build_tools(node, &no_gate)) {
        if seen.insert(t.clone()) {
            allow.push(t);
        }
    }

    let mut comments = vec![
        "Driver uses Task/Read to delegate; subagents get the per-component data tools, minus \
Write/Edit when guardrail 'read_only_execution' is locked. Destructive bash patterns are denied \
below regardless. Read-only access is additionally enforced at the data layer by wren's \
strict_mode (see .wren/config.json)."
            .to_string(),
    ];
    if gate_grants_write(&gate) {
        comments.push(format!(
            "Guardrail 'artifact_write' is locked, scope '{}': grants the driver (not the \
subagents) Write, since the driver collects subagent output and writes the rendered \
dashboard.html (prompt render flavor).",
            gate.scope
                .clone()
                .unwrap_or_else(|| DEFAULT_ARTIFACT_SCOPE.to_string())
        ));
    } else if gate.kind == GateKind::Realize {
        comments.push(
            "Render flavor is programmatic: neither the driver nor the subagents get Write; the \
driver emits a render envelope and warble-render produces dashboard.html."
                .to_string(),
        );
    }

    serde_json::json!({
        "$comment": comments.join(" "),
        "permissions": { "allow": allow, "deny": DESTRUCTIVE_BASH_DENY_PATTERNS },
    })
}

fn build_split_run_md(
    node: &ComponentNode,
    report: &ResolutionReport,
    flavor: RenderFlavor,
    models: &ModelConfig,
) -> String {
    let gate = resolve_render_gate(node, report, flavor);
    let subagent_models = node
        .llm_calls
        .iter()
        .map(|c| {
            format!(
                "`{}`={}",
                subagent_name(&node.verb, c),
                models
                    .require(&c.tier)
                    .expect("tier validated up front in emit_claude_code_with_models")
            )
        })
        .collect::<Vec<_>>()
        .join(", ");

    let mut notes: Vec<String> = vec![
        format!("- Bound wren project: `{}`", node.context_binding.project),
        format!("- {}", trigger_note(node)),
        format!(
            "- Per-step tiers are realized as subagents ({subagent_models}); the driver ({}) only \
routes + marshals between them via the Task tool.",
            models
                .orchestrator()
                .expect("orchestrator tier validated up front in emit_claude_code_with_models")
        ),
    ];
    notes.extend(
        render_run_notes(&node.verb, &gate)
            .into_iter()
            .map(|n| format!("- {n}")),
    );
    notes.extend(
        assertion_run_notes(node)
            .into_iter()
            .map(|n| format!("- {n}")),
    );

    let mut parts: Vec<String> = vec![
        format!("# Running `{}`", node.verb),
        String::new(),
        "Run from this directory (so `.claude/` and `.wren/` are picked up):".to_string(),
        String::new(),
    ];
    parts.extend(run_command_block(node, &gate));
    parts.push(String::new());
    parts.extend(notes);
    parts.push(String::new());
    parts.join("\n")
}

// --- capability resolution + summary --------------------------------------------------------------

fn format_summary_line(entry: &crate::resolve::ResolvedCapability) -> String {
    let outcome = serde_json::to_value(entry.outcome)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    let provided = serde_json::to_value(entry.provided_by)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    let criticality = serde_json::to_value(entry.criticality)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    let suffix = entry
        .note
        .as_ref()
        .map(|n| format!(" — {n}"))
        .unwrap_or_default();
    format!(
        "  {:<28} {:<12} ({provided}, {criticality}){suffix}",
        entry.capability, outcome
    )
}

fn print_resolution_summary(target_label: &str, report: &ResolutionReport) {
    eprintln!("warble-dispatch: capability resolution for target '{target_label}':");
    for entry in report {
        eprintln!("{}", format_summary_line(entry));
    }
}

/// Resolve one node's required capabilities against `target_id`, erroring on any `fail` outcome
/// (no silent degradation). Callers must not emit files when this errors.
pub fn resolve_node_capabilities(
    node: &ComponentNode,
    target_id: &str,
) -> Result<ResolutionReport, DispatchError> {
    if !is_known_target(target_id) {
        return Err(DispatchError(format!(
            "target '{target_id}' has no capability profile (known targets: {})",
            known_target_names().join(", ")
        )));
    }
    let profile = TargetId::parse(target_id)
        .expect("known target parses")
        .profile();
    resolve_capabilities(node, target_id, &profile)
}

fn write_file(path: &Path, contents: &str) -> Result<(), DispatchError> {
    fs::write(path, contents)
        .map_err(|e| DispatchError(format!("failed to write {}: {e}", path.display())))
}

fn write_json(path: &Path, value: &serde_json::Value) -> Result<(), DispatchError> {
    let rendered = format!(
        "{}\n",
        serde_json::to_string_pretty(value).map_err(|e| DispatchError(e.to_string()))?
    );
    write_file(path, &rendered)
}

fn mkdir_all(path: &Path) -> Result<(), DispatchError> {
    fs::create_dir_all(path)
        .map_err(|e| DispatchError(format!("failed to create {}: {e}", path.display())))
}

/// Emit Claude Code agent runtime files for a resolved IR into `out_dir`, using the default tier →
/// model binding (`strong→opus`, `cheap→haiku`, orchestrator `sonnet`). See
/// [`emit_claude_code_with_models`] to override the mapping at dispatch.
pub fn emit_claude_code(
    ir: &WarbleIr,
    out_dir: &Path,
    target_id: &str,
    render_flavor: RenderFlavor,
) -> Result<(), DispatchError> {
    emit_claude_code_with_models(
        ir,
        out_dir,
        target_id,
        render_flavor,
        &ModelConfig::default(),
    )
}

/// Emit Claude Code agent runtime files for a resolved IR into `out_dir`. Errors on any unsupported
/// enum value rather than emitting a silently-wrong file. Runs the capability resolution pass first;
/// on abort it errors and writes nothing. `models` resolves each step's tier to a concrete model.
pub fn emit_claude_code_with_models(
    ir: &WarbleIr,
    out_dir: &Path,
    target_id: &str,
    render_flavor: RenderFlavor,
    models: &ModelConfig,
) -> Result<(), DispatchError> {
    // Every step tier must map to a model — abort before writing anything if one is undefined.
    models.validate(ir)?;
    // A per-step-tier split needs the reserved `orchestrator` tier; require it up front so the
    // split builders can resolve it infallibly.
    if ir.components.iter().any(should_split_per_step_tier) {
        models.orchestrator()?;
    }

    // Resolve every node first — abort before writing anything if any capability fails.
    let mut reports: Vec<(String, ResolutionReport)> = Vec::with_capacity(ir.components.len());
    for node in &ir.components {
        reports.push((node.id.clone(), resolve_node_capabilities(node, target_id)?));
    }
    let report_for = |id: &str| -> &ResolutionReport {
        &reports
            .iter()
            .find(|(nid, _)| nid == id)
            .expect("report exists")
            .1
    };

    for node in &ir.components {
        if !realization_supported(node.realization_kind) {
            return Err(unsupported(
                "realization_kind",
                node.realization_kind.as_str(),
            ));
        }
        if !trigger_supported(node.trigger.kind) {
            return Err(unsupported("trigger.kind", node.trigger.kind.as_str()));
        }
        if !outcome_supported(node.effect.outcome.kind) {
            return Err(unsupported(
                "outcome.kind",
                node.effect.outcome.kind.as_str(),
            ));
        }

        let claude_dir = out_dir.join(".claude");
        let agents_dir = claude_dir.join("agents");
        let wren_dir = out_dir.join(".wren");
        mkdir_all(&agents_dir)?;
        mkdir_all(&wren_dir)?;

        let report = report_for(&node.id);

        if should_split_per_step_tier(node) {
            write_file(
                &agents_dir.join(format!("{}.md", node.verb)),
                &build_driver_markdown(node, report, render_flavor, models),
            )?;
            for call in &node.llm_calls {
                write_file(
                    &agents_dir.join(format!("{}.md", subagent_name(&node.verb, call))),
                    &build_subagent_markdown(node, call, models),
                )?;
            }
            write_json(
                &claude_dir.join("settings.json"),
                &build_split_settings(node, report, render_flavor),
            )?;
            write_json(&wren_dir.join("config.json"), &wren_config())?;
            write_file(
                &out_dir.join("RUN.md"),
                &build_split_run_md(node, report, render_flavor, models),
            )?;
        } else {
            write_file(
                &agents_dir.join(format!("{}.md", node.verb)),
                &build_agent_markdown(node, report, render_flavor, models)?,
            )?;
            // P1 (design-notes follow-up 1): the single-agent path now also writes
            // `.claude/settings.json` — same location as the split path — so Claude Code
            // auto-loads the allowlist without a manual `--settings` flag or a copy step.
            write_json(
                &claude_dir.join("settings.json"),
                &build_settings(node, report, render_flavor),
            )?;
            write_json(&wren_dir.join("config.json"), &wren_config())?;
            write_file(
                &out_dir.join("RUN.md"),
                &build_run_md(node, report, render_flavor, models)?,
            )?;
        }
    }

    let capability_report = serde_json::json!({
        "target": target_id,
        "components": ir.components.iter().map(|node| serde_json::json!({
            "id": node.id,
            "capabilities": report_for(&node.id),
        })).collect::<Vec<_>>(),
    });
    write_json(&out_dir.join("capability-report.json"), &capability_report)?;

    for node in &ir.components {
        print_resolution_summary(
            &format!("{target_id} (component '{}')", node.id),
            report_for(&node.id),
        );
    }

    Ok(())
}
