//! Tool-ref derivation — the bundle's declaration of which callable tools an agent needs.
//!
//! A Vercel AI SDK tool-loop needs concrete tool bindings, not abstract capability names. This
//! module maps each of a component's required capabilities (declared + implied — the same set
//! `resolve::collect_required_capabilities` produces) onto the tool a harness should register,
//! when that capability corresponds to a callable action at all. Capabilities that resolve to
//! something other than a callable tool (LLM tiers, the structured-output contract, authorization
//! gates, human approval, blast-radius analysis) are intentionally not tools and are skipped here.

use crate::ir::ComponentNode;
use crate::resolve::collect_required_capabilities;
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
pub struct ToolRef {
    pub name: String,
    /// Where the tool is realized: `mcp:<server>/<tool>` for MCP-backed tools, or a bare
    /// mechanism label (e.g. `native`) for tools the harness itself implements.
    pub source: String,
}

/// The one capability → tool mapping for capabilities that correspond to a callable action.
/// Capabilities with no entry here (LLM tiers, `render_contract`, `structured_output_capture`,
/// the authorization/approval/blast-radius gates) are not tools and are skipped by `build_tools`.
fn tool_for_capability(capability: &str) -> Option<(&'static str, &'static str)> {
    match capability {
        "semantic_introspection" => Some(("semantic_introspect", "mcp:wren/semantic_introspect")),
        "sql_execution:read_only" => Some(("query", "mcp:wren/query")),
        "genbi_build" => Some(("build_dashboard", "mcp:wren/build_dashboard")),
        "schema_introspection" => Some(("schema_introspect", "mcp:wren/schema_introspect")),
        "artifact_write" => Some(("write_artifact", "native")),
        "scheduler" => Some(("schedule", "mcp:runtime/schedule")),
        "event_bus" => Some(("emit_event", "mcp:runtime/emit_event")),
        "notify_channel" => Some(("notify", "mcp:runtime/notify")),
        "version_control" => Some(("commit", "mcp:git/commit")),
        _ => None,
    }
}

/// Build the de-duplicated list of tool refs `node` needs, derived from its declared + implied
/// required capabilities.
pub fn build_tools(node: &ComponentNode) -> Vec<ToolRef> {
    let mut seen = HashSet::new();
    collect_required_capabilities(node)
        .iter()
        .filter_map(|capability| tool_for_capability(capability))
        .filter(|(name, _)| seen.insert(*name))
        .map(|(name, source)| ToolRef {
            name: name.to_string(),
            source: source.to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn llm_and_contract_capabilities_are_not_tools() {
        assert_eq!(tool_for_capability("llm:strong"), None);
        assert_eq!(tool_for_capability("llm:cheap"), None);
        assert_eq!(tool_for_capability("llm:per_step_tier"), None);
        assert_eq!(tool_for_capability("render_contract"), None);
        assert_eq!(tool_for_capability("structured_output_capture"), None);
        assert_eq!(tool_for_capability("write_authz"), None);
        assert_eq!(tool_for_capability("context_write_authz"), None);
        assert_eq!(tool_for_capability("human_approval"), None);
        assert_eq!(tool_for_capability("blast_radius"), None);
    }

    #[test]
    fn known_capability_maps_to_mcp_qualified_tool() {
        assert_eq!(
            tool_for_capability("sql_execution:read_only"),
            Some(("query", "mcp:wren/query"))
        );
    }
}
