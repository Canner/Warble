//! Capability manifest emitter.
//!
//! The manifest is the runtime-agnostic **interop surface** a meta-harness consumes to decide
//! whether it can call a Warble profile and what it needs — without absorbing execution (see
//! [`capability-model.md`][spec-cap]). It is a pure projection of the IR: verbs, context, required
//! capabilities, render contract. Distinct from `resolve.rs`, which links required capabilities
//! against a *specific* target.
//!
//! [spec-cap]: https://github.com/Canner/Warble/blob/main/docs/spec/capability-model.md

use crate::ir::{ComponentNode, WarbleIr};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

pub const MANIFEST_VERSION: &str = "0.3";

#[derive(Debug, Serialize)]
pub struct RenderContract {
    pub blocks: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ManifestContext {
    pub project: String,
    pub binding_mode: String,
    pub precondition: String,
}

#[derive(Debug, Serialize)]
pub struct ManifestComponent {
    pub id: String,
    pub verb: String,
    /// Whether this mounted component may be selected as a root entry. A false value keeps the
    /// component visible for structural inspection without advertising it as independent work.
    pub entrypoint: bool,
    #[serde(rename = "type")]
    pub component_type: String,
    pub realization_kind: String,
    pub context: ManifestContext,
    pub trigger: String,
    pub outcome: String,
    pub required_capabilities: Vec<String>,
    pub dependencies: Vec<ManifestDependency>,
    /// Declared render block types, or null when the component renders nothing.
    pub render_contract: Option<RenderContract>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ManifestDependency {
    pub step: String,
    pub alias: String,
    pub component: String,
}

#[derive(Debug, Serialize)]
pub struct ManifestEntry {
    pub id: String,
    /// Root-first deterministic transitive closure. Internal-only mounts never get an entry row.
    pub closure: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CapabilityManifest {
    pub warble_manifest_version: String,
    pub profile: String,
    pub entries: Vec<ManifestEntry>,
    pub components: Vec<ManifestComponent>,
}

fn manifest_component(node: &ComponentNode) -> ManifestComponent {
    let block_types: Vec<String> = node
        .effect
        .render_blocks
        .iter()
        .map(|b| b.block_type.clone())
        .collect();
    ManifestComponent {
        id: node.id.clone(),
        verb: node.verb.clone(),
        entrypoint: node.entrypoint,
        component_type: node.component_type.as_str().to_string(),
        realization_kind: node.realization_kind.as_str().to_string(),
        context: ManifestContext {
            project: node.context_binding.project.clone(),
            binding_mode: node.context_binding.binding_mode.clone(),
            precondition: node.precondition_result.status.clone(),
        },
        trigger: node.trigger.kind.as_str().to_string(),
        outcome: node.effect.outcome.kind.as_str().to_string(),
        required_capabilities: node.required_capabilities.clone(),
        dependencies: node
            .llm_calls
            .iter()
            .flat_map(|step| {
                step.component_calls.iter().map(|call| ManifestDependency {
                    step: step.name.clone(),
                    alias: call.alias.clone(),
                    component: call.component.clone(),
                })
            })
            .collect(),
        render_contract: if block_types.is_empty() {
            None
        } else {
            Some(RenderContract {
                blocks: block_types,
            })
        },
    }
}

fn entry_closure(root: &ComponentNode, by_id: &HashMap<&str, &ComponentNode>) -> Vec<String> {
    fn visit(
        id: &str,
        by_id: &HashMap<&str, &ComponentNode>,
        visited: &mut HashSet<String>,
        closure: &mut Vec<String>,
    ) {
        if !visited.insert(id.to_string()) {
            return;
        }
        closure.push(id.to_string());
        let Some(node) = by_id.get(id) else { return };
        for step in &node.llm_calls {
            for call in &step.component_calls {
                visit(&call.component, by_id, visited, closure);
            }
        }
    }

    let mut visited = HashSet::new();
    let mut closure = Vec::new();
    visit(&root.id, by_id, &mut visited, &mut closure);
    closure
}

/// Project a resolved IR into its runtime-agnostic capability manifest.
pub fn build_manifest(ir: &WarbleIr) -> CapabilityManifest {
    let by_id: HashMap<&str, &ComponentNode> = ir
        .components
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    CapabilityManifest {
        warble_manifest_version: MANIFEST_VERSION.to_string(),
        profile: ir.profile.clone(),
        entries: ir
            .components
            .iter()
            .filter(|node| node.entrypoint)
            .map(|node| ManifestEntry {
                id: node.id.clone(),
                closure: entry_closure(node, &by_id),
            })
            .collect(),
        components: ir.components.iter().map(manifest_component).collect(),
    }
}
