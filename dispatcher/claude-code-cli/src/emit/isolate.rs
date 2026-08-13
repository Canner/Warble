//! The `context_isolation` realization: the whole component runs inside ONE child agent, and the
//! session that called it sees a single delegation and a single result.
//!
//! This is a different granularity from the per-step-tier split in [`super::split`], and the
//! difference is the whole point. That split gives each *step* its own child, so the parent must
//! marshal every artifact between them — the intermediate SQL, the repair input, the lot — through
//! its own context. It isolates execution while routing all the data past the reader. Measured on a
//! three-step `answer_query`, that leaves three delegations and four SQL-bearing blocks in the
//! calling session.
//!
//! Collapsing the component into one child moves the entire chain — intent, generation, repair —
//! behind a single boundary. The cost is that per-step tiers collapse to one model (the strongest
//! declared), which is a real loss and is why this is opt-in per component rather than the default.
//! The collapse is reported, never silent: the child's own markdown carries the standard tier
//! comment and `capability-report.json` records what it collapsed to.

use super::agent::{build_agent_markdown_named, to_yaml, AgentFrontmatter};
use super::gate::{gate_grants_write, resolve_render_gate};
use super::support::DRIVER_TOOLS;
use super::types::{ContextInjection, RenderFlavor};
use crate::error::DispatchError;
use crate::ir::ComponentNode;
use crate::models::ModelConfig;
use crate::provider::ToolMap;
use crate::resolve::ResolutionReport;
use crate::targets::CONTEXT_ISOLATION_CAPABILITY;

/// Whether this component asked for its work to be kept out of the calling session's context.
pub(super) fn should_isolate(node: &ComponentNode) -> bool {
    node.required_capabilities
        .iter()
        .any(|c| c == CONTEXT_ISOLATION_CAPABILITY)
}

/// The child that runs the whole component. Named off the verb so the parent's instruction and the
/// emitted file cannot drift apart.
pub(super) fn isolated_agent_name(verb: &str) -> String {
    format!("{verb}__isolated")
}

/// The parent: delegate once, relay the result, hold no data tools of its own.
///
/// Withholding those tools is what makes the boundary real rather than advisory. A parent that
/// could run `wren` itself would be free to "just check something quickly" and put the very
/// technical detail this shape exists to contain back into the session.
pub(super) fn build_isolating_parent_markdown(
    node: &ComponentNode,
    report: &ResolutionReport,
    flavor: RenderFlavor,
    models: &ModelConfig,
) -> Result<String, DispatchError> {
    let gate = resolve_render_gate(node, report, flavor);
    let mut tools: Vec<String> = DRIVER_TOOLS.iter().map(|s| s.to_string()).collect();
    if gate_grants_write(&gate) {
        tools.push("Write".to_string());
    }
    let child = isolated_agent_name(&node.verb);
    let frontmatter = AgentFrontmatter {
        name: node.verb.clone(),
        description: format!(
            "{} entry point that delegates all of {}'s work to an isolated subagent (outcome: {}).",
            node.component_type.as_str(),
            node.verb,
            node.effect.outcome.kind.as_str()
        ),
        tools,
        // An isolated component runs the whole node in one child agent at a single collapsed
        // model, so this target is explicit rather than inheriting the session's.
        model: Some(models.orchestrator()?.to_string()),
    };

    Ok([
        "---".to_string(),
        to_yaml(&frontmatter),
        "---".to_string(),
        String::new(),
        format!(
            "Hand the user's question to the `{child}` subagent with the Task tool, in one call, \
and report what it returns."
        ),
        String::new(),
        "That subagent does the entire job — working out what is being asked, querying, and \
repairing anything that fails. You do none of it, and you have no tools to do it with."
            .to_string(),
        String::new(),
        "Report its final result and nothing else. Do not narrate the delegation, do not summarize \
what it did to get there, and do not restate any query, model name or error it may mention along \
the way. If it reports a derivation, keep that in the result's own `definition` block rather than \
folding it into the answer text."
            .to_string(),
        String::new(),
        "If it comes back with a question for the user rather than an answer, pass that question \
through as it stands."
            .to_string(),
        String::new(),
    ]
    .join("\n"))
}

/// The child agent: the ordinary whole-component agent, under the isolated name.
#[allow(clippy::too_many_arguments)]
pub(super) fn build_isolated_child_markdown(
    node: &ComponentNode,
    report: &ResolutionReport,
    flavor: RenderFlavor,
    models: &ModelConfig,
    context: &ContextInjection,
    tool_map: &ToolMap,
    include_setup_recovery_tool: bool,
) -> Result<String, DispatchError> {
    // The child is the one that actually runs the component; the parent deliberately holds no
    // data tools, so a recovery tool granted to the parent would be unreachable.
    build_agent_markdown_named(
        &isolated_agent_name(&node.verb),
        node,
        report,
        flavor,
        models,
        context,
        tool_map,
        include_setup_recovery_tool,
    )
}
