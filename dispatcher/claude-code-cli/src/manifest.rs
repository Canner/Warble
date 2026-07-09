//! Capability manifest emitter.
//!
//! The manifest is the runtime-agnostic **interop surface** a meta-harness consumes to decide
//! whether it can call a Warble profile and what it needs — without absorbing execution
//! (`spec/capability-model.md`). It is a pure projection of the IR: verbs, context, required
//! capabilities, render contract. Distinct from `resolve.rs`, which links required capabilities
//! against a *specific* target.

use crate::ir::{ComponentNode, WarbleIr};
use serde::Serialize;

pub const MANIFEST_VERSION: &str = "0.1";

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
    pub verb: String,
    #[serde(rename = "type")]
    pub component_type: String,
    pub realization_kind: String,
    pub context: ManifestContext,
    pub trigger: String,
    pub outcome: String,
    pub required_capabilities: Vec<String>,
    /// Declared render block types, or null when the component renders nothing.
    pub render_contract: Option<RenderContract>,
}

#[derive(Debug, Serialize)]
pub struct CapabilityManifest {
    pub warble_manifest_version: String,
    pub profile: String,
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
        verb: node.verb.clone(),
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
        render_contract: if block_types.is_empty() {
            None
        } else {
            Some(RenderContract {
                blocks: block_types,
            })
        },
    }
}

/// Project a resolved IR into its runtime-agnostic capability manifest.
pub fn build_manifest(ir: &WarbleIr) -> CapabilityManifest {
    CapabilityManifest {
        warble_manifest_version: MANIFEST_VERSION.to_string(),
        profile: ir.profile.clone(),
        components: ir.components.iter().map(manifest_component).collect(),
    }
}
