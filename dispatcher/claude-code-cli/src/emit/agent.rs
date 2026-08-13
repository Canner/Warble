//! The agent-file YAML frontmatter type (`AgentFrontmatter` / `to_yaml`) and the single-agent
//! markdown assembly (`build_agent_markdown`) — the v1 non-split emit path.

use super::gate::{build_description, build_tools, resolve_render_gate};
use super::sections::{build_assertion_section, build_mutation_section, build_render_section};
use super::support::{
    has_data_access_capability, is_assertion, is_mutation, tier_collapse_comment,
};
use super::types::{ContextInjection, RenderFlavor};
use crate::error::DispatchError;
use crate::ir::ComponentNode;
use crate::models::ModelConfig;
use crate::provider::ToolMap;
use crate::resolve::ResolutionReport;
use serde::Serialize;

// --- YAML frontmatter -----------------------------------------------------------------------------

#[derive(Serialize)]
pub(super) struct AgentFrontmatter {
    pub(super) name: String,
    pub(super) description: String,
    pub(super) tools: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) model: Option<String>,
}

pub(super) fn to_yaml(fm: &impl Serialize) -> String {
    serde_yaml::to_string(fm)
        .expect("frontmatter serializes")
        .trim_end()
        .to_string()
}

pub(super) fn build_agent_markdown(
    node: &ComponentNode,
    report: &ResolutionReport,
    flavor: RenderFlavor,
    models: &ModelConfig,
    context: &ContextInjection,
    tool_map: &ToolMap,
) -> Result<String, DispatchError> {
    build_agent_markdown_named(&node.verb, node, report, flavor, models, context, tool_map)
}

/// As [`build_agent_markdown`], under a caller-chosen agent name. The whole-component agent is
/// emitted twice over in different shapes — once as the session's own agent, once as the child an
/// isolating parent delegates to — and only the name differs, so the body is built once.
pub(super) fn build_agent_markdown_named(
    name: &str,
    node: &ComponentNode,
    report: &ResolutionReport,
    flavor: RenderFlavor,
    models: &ModelConfig,
    context: &ContextInjection,
    tool_map: &ToolMap,
) -> Result<String, DispatchError> {
    let gate = resolve_render_gate(node, report, flavor);
    // A deterministic gated-tool can intentionally have no LLM step (for example the final
    // approved apply). Claude should inherit the interactive session model in that case.
    let model = (!node.llm_calls.is_empty())
        .then(|| models.collapsed_model(&node.llm_calls).map(str::to_string))
        .transpose()?;
    let frontmatter = AgentFrontmatter {
        name: name.to_string(),
        description: build_description(node),
        tools: build_tools(node, &gate, tool_map),
        model: model.clone(),
    };
    let yaml_block = to_yaml(&frontmatter);

    // The `wren` sentence holds only for an agent that was actually granted `Bash(wren:*)` — the
    // same condition `build_tools` uses. A component that delegates its analysis elsewhere gets no
    // data tools at all, and ordering it to route data access through a CLI it cannot invoke is an
    // instruction it disproves on its first attempt.
    let data_access_line =
        if has_data_access_capability(&node.required_capabilities) || is_mutation(node) {
            "All data access MUST go through the `wren` CLI (e.g. `wren --sql ...`, `wren cube \
list`, `wren genbi build ...`) — never raw SQL clients, never filesystem tricks against the \
underlying warehouse."
        } else {
            "You hold no data-access tools: this agent never queries that project itself. Report \
what your own tools return and nothing beyond it."
        };
    // Only call it a wren project when one was actually read. An un-introspected binding's
    // `project` is a locator for a layer held elsewhere, and naming it a local project invites the
    // agent to reason about it as though it had seen it.
    let binding_line = if context.introspected() {
        format!(
            "You are bound to the wren project at `{}`.",
            node.context_binding.project
        )
    } else {
        format!(
            "You are bound to the semantic layer `{}`, which lives elsewhere and was not read here.",
            node.context_binding.project
        )
    };
    let preamble = [binding_line, data_access_line.to_string()].join("\n");

    let mut parts: Vec<String> = vec![
        "---".to_string(),
        yaml_block,
        "---".to_string(),
        String::new(),
        preamble,
        String::new(),
        context.prompt_section(),
    ];
    if let Some(comment) = model
        .as_deref()
        .and_then(|model| tier_collapse_comment(&node.llm_calls, model))
    {
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
    if is_mutation(node) {
        parts.push(String::new());
        parts.push(build_mutation_section(node));
    }

    Ok(format!("{}\n", parts.join("\n")))
}
