//! Per-step-tier split realization (v0.2): when a skill's steps span more than one tier, emit an
//! orchestrator driver agent plus one tier-appropriate subagent per step, with matching settings and
//! RUN.md.

use super::agent::{to_yaml, AgentFrontmatter};
use super::gate::{build_tools, gate_grants_write, resolve_render_gate, GateKind, RenderGate};
use super::run_md::{
    assertion_run_notes, mutation_run_notes, render_run_notes, run_command_block, trigger_note,
};
use super::sections::{build_assertion_section, build_mutation_section, build_render_section};
use super::support::{
    is_assertion, is_mutation, DEFAULT_ARTIFACT_SCOPE, DESTRUCTIVE_BASH_DENY_PATTERNS,
    DRIVER_TOOLS, PER_STEP_TIER_CAPABILITY,
};
use super::types::{ContextInjection, RenderFlavor};
use crate::ir::{ComponentNode, LlmCall, RealizationKind};
use crate::models::ModelConfig;
use crate::provider::ToolMap;
use crate::resolve::ResolutionReport;
use std::collections::HashSet;

// --- per-step-tier split realization (v0.2) -------------------------------------------------------

fn distinct_tier_count(llm_calls: &[LlmCall]) -> usize {
    llm_calls
        .iter()
        .map(|c| c.tier.as_str())
        .collect::<HashSet<_>>()
        .len()
}

pub(super) fn should_split_per_step_tier(node: &ComponentNode) -> bool {
    node.realization_kind == RealizationKind::Skill
        && node
            .required_capabilities
            .iter()
            .any(|c| c == PER_STEP_TIER_CAPABILITY)
        && distinct_tier_count(&node.llm_calls) > 1
}

pub(super) fn subagent_name(verb: &str, call: &LlmCall) -> String {
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

pub(super) fn build_driver_markdown(
    node: &ComponentNode,
    report: &ResolutionReport,
    flavor: RenderFlavor,
    models: &ModelConfig,
    context: &ContextInjection,
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
        context.prompt_section(),
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
    if is_mutation(node) {
        parts.push(String::new());
        parts.push(build_mutation_section(node));
    }

    format!("{}\n", parts.join("\n"))
}

pub(super) fn build_subagent_markdown(
    node: &ComponentNode,
    call: &LlmCall,
    models: &ModelConfig,
    context: &ContextInjection,
    tool_map: &ToolMap,
) -> String {
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
        tools: build_tools(node, &no_gate, tool_map),
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
        context.prompt_section(),
        String::new(),
        call.prompt.clone(),
        String::new(),
        io_note,
    ];
    format!("{}\n", parts.join("\n"))
}

pub(super) fn build_split_settings(
    node: &ComponentNode,
    report: &ResolutionReport,
    flavor: RenderFlavor,
    tool_map: &ToolMap,
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
    for t in driver_tools
        .into_iter()
        .chain(build_tools(node, &no_gate, tool_map))
    {
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

pub(super) fn build_split_run_md(
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
    notes.extend(
        mutation_run_notes(node)
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
