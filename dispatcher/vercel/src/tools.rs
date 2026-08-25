//! Tool-ref derivation — the bundle's declaration of which callable tools an agent needs.
//!
//! A Vercel AI SDK tool-loop needs concrete tool bindings, not abstract capability names. This
//! module maps each of a component's required capabilities (declared + implied — the same set
//! `resolve::collect_required_capabilities` produces) onto the tool a harness should register,
//! when that capability corresponds to a callable action at all. Capabilities that resolve to
//! something other than a callable tool (LLM tiers, the structured-output contract, authorization
//! gates, human approval, blast-radius analysis) are intentionally not tools and are skipped here.
//!
//! The base tool map only covers the two substrate capabilities that are callable actions
//! (`artifact_write`, `version_control`); domain capabilities (SQL execution, semantic model
//! access, scheduler/event/notify transports) get their tool bindings from a provider fragment,
//! composed in via `provider::compose_target` — see `targets.rs` for the matching profile split.

use crate::ir::ComponentNode;
use crate::resolve::collect_required_capabilities;
use serde::Serialize;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize)]
pub struct ToolRef {
    pub name: String,
    /// Where the tool is realized: `mcp:<server>/<tool>` for MCP-backed tools, or a bare
    /// mechanism label (e.g. `native`) for tools the harness itself implements.
    pub source: String,
}

/// One capability's tool binding: the callable name plus where it's realized. `Cow<'static, str>`
/// so base-static bindings (`Cow::Borrowed`) and provider-loaded ones (`Cow::Owned`) share one
/// type — mirrors `CapabilityEntry`'s `via`/`note` fields in `targets.rs`.
#[derive(Debug, Clone)]
pub struct ToolBinding {
    pub name: Cow<'static, str>,
    pub source: Cow<'static, str>,
}

/// Keyed by owned `String` for the same reason as `CapabilityProfile`: a base-only map and a
/// base-⊕-provider-composed map must be the same type.
pub type ToolMap = HashMap<String, ToolBinding>;

fn binding(name: &'static str, source: &'static str) -> ToolBinding {
    ToolBinding {
        name: Cow::Borrowed(name),
        source: Cow::Borrowed(source),
    }
}

/// The base substrate tool map: only the capabilities that are both (a) callable actions and
/// (b) not domain-specific — `artifact_write` (native) and `version_control` (borrowed from the
/// runtime's git). All 7 domain capability → tool bindings live in a provider fragment instead.
pub fn base_tool_map() -> ToolMap {
    HashMap::from([
        (
            "artifact_write".to_string(),
            binding("write_artifact", "native"),
        ),
        (
            "version_control".to_string(),
            binding("commit", "mcp:git/commit"),
        ),
    ])
}

/// Build the de-duplicated list of tool refs `node` needs, derived from its declared + implied
/// required capabilities, looked up against the composed `tool_map` (base ⊕ providers).
pub fn build_tools(node: &ComponentNode, tool_map: &ToolMap) -> Vec<ToolRef> {
    let mut seen = HashSet::new();
    collect_required_capabilities(node)
        .iter()
        .filter_map(|capability| tool_map.get(capability))
        .filter(|b| seen.insert(b.name.clone()))
        .map(|b| ToolRef {
            name: b.name.to_string(),
            source: b.source.to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn llm_and_contract_capabilities_are_not_tools() {
        let tool_map = base_tool_map();
        for capability in [
            "llm:strong",
            "llm:cheap",
            "llm:per_step_tier",
            "render_contract",
            "structured_output_capture",
            "write_authz",
            "context_write_authz",
            "human_approval",
            "blast_radius",
        ] {
            assert!(
                !tool_map.contains_key(capability),
                "'{capability}' should not have a base tool binding"
            );
        }
    }

    #[test]
    fn base_tool_map_only_covers_substrate_capabilities() {
        let tool_map = base_tool_map();
        assert_eq!(
            tool_map.len(),
            2,
            "base tool map should hold exactly artifact_write + version_control"
        );
        assert_eq!(tool_map.get("artifact_write").unwrap().source, "native");
        assert_eq!(
            tool_map.get("version_control").unwrap().source,
            "mcp:git/commit"
        );
    }
}
