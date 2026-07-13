//! Prompt-body section builders that assemble the markdown an emitted agent carries: the render
//! output contract (programmatic / prompt flavors), the +Assertive verdict contract, and the
//! +Mutating / +Constitutive gated-lifecycle contract.

use super::gate::{GateKind, RenderGate};
use super::support::{find_guardrail, DEFAULT_ARTIFACT_SCOPE};
use super::types::RenderFlavor;
use crate::ir::ComponentNode;

// --- render output sections ---------------------------------------------------------------------

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

pub(super) fn build_render_section(node: &ComponentNode, gate: &RenderGate) -> Option<String> {
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
pub(super) fn build_assertion_section(node: &ComponentNode) -> String {
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

// --- mutation outcome section (+Mutating) -------------------------------------------------------

const MUTATION_DIFF_ENVELOPE_EXAMPLE: &str = r#"```json
{
  "blocks": [
    { "type": "diff", "path": "models/orders.yml",
      "diff": "--- a/models/orders.yml\n+++ b/models/orders.yml\n@@ -3,6 +3,7 @@\n   columns:\n     - name: order_id\n+    - name: customer_id\n" }
  ],
  "verified": true
}
```"#;

/// The mutation lifecycle contract (+Mutating). A gated-tool component behind a hard two-phase
/// approval gate: propose (dry-run diff, read-only), gate (blast-radius + human approval), then —
/// only then — apply. Every phase below is shape-derived from the outcome enum + the component's
/// own declared guardrails; none of it is keyed on id/verb. `apply` and `rollback` BORROW version
/// control (git) from the runtime — this agent documents and enables that two-phase lifecycle, it
/// does not build a `warble apply` or any VCS logic itself.
pub(super) fn build_mutation_section(node: &ComponentNode) -> String {
    // +Constitutive: `outcome.target == "context"` reuses this same mutation arm but phase 2 is a
    // scoped context-write gate, never blast-radius — split off before computing the blast-radius
    // guardrail/threshold below, which don't apply to this path.
    if node.effect.outcome.target.as_deref() == Some("context") {
        return build_context_mutation_section(node);
    }

    let outcome = &node.effect.outcome;
    let target = outcome.target.as_deref().unwrap_or("data");
    let change_type_note = outcome
        .change_type
        .as_deref()
        .map(|c| format!(", change_type `{c}`"))
        .unwrap_or_default();

    let dry_run_guardrail = find_guardrail(&node.guardrails, "must_dry_run");
    let blast_guardrail = find_guardrail(&node.guardrails, "blast_radius_limit");
    let threshold_note = blast_guardrail
        .and_then(|g| g.threshold.as_ref())
        .map(|t| format!(" (threshold: {t})"))
        .unwrap_or_default();

    let lines: Vec<String> = vec![
        "## Mutation lifecycle".to_string(),
        String::new(),
        format!(
            "This is a **mutating** component (outcome: mutation, target `{target}`{change_type_note}). \
Applying a change here is a two-phase GATED lifecycle: propose, then gate, and only then apply. \
None of the four phases below is optional and none may be skipped by this agent."
        ),
        String::new(),
        format!(
            "1. **Dry-run first**{}: propose the edit as a DIFF only — do NOT apply it yet. Render \
the proposed change via a `diff` render block (`path` + the unified diff text); this is a preview, \
never a write.",
            if dry_run_guardrail.is_some() {
                " (guardrail `must_dry_run`, locked)"
            } else {
                ""
            }
        ),
        format!(
            "2. **Blast-radius gate**{}: run `warble blast-radius {} --node <the lineage node id of \
the target you are editing, e.g. `model:orders` / `metric:revenue.total_revenue`>` to compute the \
downstream impact of the proposed change before it may be applied. The `--node` seed is the node \
BEING EDITED (identified in the dry-run), never this component's id. An empty radius auto-allows; a \
radius exceeding the guardrail's threshold{threshold_note} escalates to human approval; a radius \
touching a protected asset blocks the change outright.",
            if blast_guardrail.is_some() {
                " (guardrail `blast_radius_limit`)"
            } else {
                ""
            },
            node.context_binding.project
        ),
        "3. **Human approval**: the apply step is gated on EXPLICIT human approval delivered over \
the runtime's approval channel (guardrail `human_approval`, locked). Headless mode has no human in \
the loop, so this component honestly CANNOT run headless — that capability edge is not worked \
around."
            .to_string(),
        "4. **Apply + rollback**: only once approved do you apply the edit. A version-control (git) \
checkpoint is taken first — BORROWED from the runtime, not built by this agent — so the change can \
be rolled back if it turns out wrong (guardrail `rollback_available`)."
            .to_string(),
        String::new(),
        "Your dry-run message MUST be a SINGLE JSON object — the diff envelope — containing a \
`diff`-typed block with the proposed change and nothing else. Do not proceed past dry-run until \
the blast-radius gate and human approval have both cleared; do not apply, and do not write any \
file yourself outside of that gated apply step."
            .to_string(),
        String::new(),
        "Mutation diff envelope example:".to_string(),
        String::new(),
        MUTATION_DIFF_ENVELOPE_EXAMPLE.to_string(),
    ];
    lines.join("\n")
}

/// +Constitutive (`outcome.target == "context"`): reuses the same `mutation` outcome arm as
/// +Mutating (see `build_mutation_section`), but phase 2 is a scoped CONTEXT-WRITE gate
/// (`context_write_authz`) rather than a `warble blast-radius` computation — the write is confined
/// to a path scope (e.g. `models/`), never a downstream-lineage blast radius. Phases 1/3/4 (dry-run,
/// human approval, apply+rollback) are unchanged from the data path.
fn build_context_mutation_section(node: &ComponentNode) -> String {
    let outcome = &node.effect.outcome;
    let change_type_note = outcome
        .change_type
        .as_deref()
        .map(|c| format!(", change_type `{c}`"))
        .unwrap_or_default();

    let context_guardrail = find_guardrail(&node.guardrails, "context_write_authz");
    let scope = context_guardrail
        .and_then(|g| g.scope.as_deref())
        .unwrap_or(DEFAULT_ARTIFACT_SCOPE);

    let lines: Vec<String> = vec![
        "## Mutation lifecycle".to_string(),
        String::new(),
        format!(
            "This is a **constitutive** component (outcome: mutation, target `context`{change_type_note}). \
Applying a change here is a two-phase GATED lifecycle: propose, then gate, and only then apply. \
None of the four phases below is optional and none may be skipped by this agent."
        ),
        String::new(),
        "1. **Dry-run first** (guardrail `must_dry_run`, locked): propose the edit as a DIFF only — \
do NOT apply it yet. Render the proposed change via a `diff` render block (`path` + the unified \
diff text); this is a preview, never a write."
            .to_string(),
        format!(
            "2. **Context-write gate** (guardrail `context_write_authz`, locked, scope `{scope}`): \
this is a scoped PATH-AUTHORIZATION check, NOT a downstream-lineage impact computation — the \
proposed write must resolve to a path inside the `{scope}` scope or it is denied outright. Writing \
outside this scope (the models/metrics/knowledge structure this component owns) is never \
permitted, however small the change."
        ),
        "3. **Human approval**: the apply step is gated on EXPLICIT human approval delivered over \
the runtime's approval channel (guardrail `human_approval`, locked). Headless mode has no human in \
the loop, so this component honestly CANNOT run headless — that capability edge is not worked \
around."
            .to_string(),
        "4. **Apply + rollback**: only once approved do you apply the edit. A version-control (git) \
checkpoint is taken first — BORROWED from the runtime, not built by this agent — so the change can \
be rolled back if it turns out wrong (guardrail `rollback_available`)."
            .to_string(),
        String::new(),
        "Your dry-run message MUST be a SINGLE JSON object — the diff envelope — containing a \
`diff`-typed block with the proposed change and nothing else. Do not proceed past dry-run until \
the context-write gate and human approval have both cleared; do not apply, and do not write any \
file yourself outside of that gated apply step, or outside the scoped path above."
            .to_string(),
        String::new(),
        "Mutation diff envelope example:".to_string(),
        String::new(),
        MUTATION_DIFF_ENVELOPE_EXAMPLE.to_string(),
    ];
    lines.join("\n")
}
