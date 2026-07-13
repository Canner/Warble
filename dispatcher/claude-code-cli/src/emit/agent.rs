//! The agent-file YAML frontmatter type (`AgentFrontmatter` / `to_yaml`) and the single-agent
//! markdown assembly (`build_agent_markdown`) — the v1 non-split emit path.

use super::gate::{build_description, build_tools, resolve_render_gate};
use super::sections::{build_assertion_section, build_mutation_section, build_render_section};
use super::support::{is_assertion, is_mutation, tier_collapse_comment};
use super::types::RenderFlavor;
use crate::error::DispatchError;
use crate::ir::ComponentNode;
use crate::models::ModelConfig;
use crate::resolve::ResolutionReport;
use serde::Serialize;

// --- YAML frontmatter -----------------------------------------------------------------------------

#[derive(Serialize)]
pub(super) struct AgentFrontmatter {
    pub(super) name: String,
    pub(super) description: String,
    pub(super) tools: Vec<String>,
    pub(super) model: String,
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
    if is_mutation(node) {
        parts.push(String::new());
        parts.push(build_mutation_section(node));
    }

    Ok(format!("{}\n", parts.join("\n")))
}
