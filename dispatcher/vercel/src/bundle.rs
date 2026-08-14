//! The vercel bundle schema — the file-based JSON artifact this back-end emits for the harness.
//!
//! `ir.rs` is intentionally Deserialize-only (it consumes IR, never re-emits it verbatim), so any
//! IR shape the bundle needs to re-serialize gets a small `*Out` mirror type here rather than
//! adding `Serialize` back onto the IR view — keeping the IR module's contract ("this is what we
//! read off the wire") unambiguous.

use crate::classify::StepRealization;
use crate::ir::{ComponentType, OutcomeKind, RealizationKind, TriggerKind, WhenGuard};
use crate::resolve::ResolutionReport;
use crate::tools::ToolRef;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

pub const VERCEL_BUNDLE_VERSION: &str = "0.1";

/// Serialize mirror of `ir::WhenGuard` — the IR view stays Deserialize-only.
#[derive(Debug, Clone, Serialize)]
pub struct WhenGuardOut {
    pub guard: String,
    pub target: String,
}

impl From<&WhenGuard> for WhenGuardOut {
    fn from(guard: &WhenGuard) -> Self {
        WhenGuardOut {
            guard: guard.guard.clone(),
            target: guard.target.clone(),
        }
    }
}

/// The IR version range this bundle format was built against. A harness that reads a bundle
/// should check its `warble_ir_version` provenance against this policy before trusting the
/// classification/tooling decisions baked into it.
#[derive(Debug, Clone, Serialize)]
pub struct CompatibilityPolicy {
    pub min_ir_version: String,
    pub max_ir_version: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StepBundle {
    pub name: String,
    pub tier: String,
    pub consumes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub produces: Option<String>,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when: Option<WhenGuardOut>,
    /// How this step's `when` guard (if any) is realized — see `classify::classify_step`. The
    /// consumer that evaluates this bundle at runtime must recognize every `realization` tag it is
    /// handed; see `classify.rs`'s module doc ("The consumer's obligation") for why silently
    /// ignoring an unimplemented tag is not an acceptable fallback here.
    pub realization: StepRealization,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentBundle {
    pub id: String,
    pub verb: String,
    pub component_type: ComponentType,
    pub realization_kind: RealizationKind,
    pub trigger: TriggerKind,
    pub outcome: OutcomeKind,
    /// Optional free-form framing shared by every step of this component (see
    /// `docs/spec/ir-schema.md`). The harness that assembles this bundle's steps into a system
    /// prompt is expected to place this ahead of the per-step prompts, mirroring how the other two
    /// back-ends splice it in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    pub steps: Vec<StepBundle>,
    pub guardrails: BTreeMap<String, Value>,
    pub tools: Vec<ToolRef>,
    pub output_schema: Value,
    pub capabilities: ResolutionReport,
}

#[derive(Debug, Clone, Serialize)]
pub struct VercelBundle {
    pub vercel_bundle_version: String,
    pub compat: CompatibilityPolicy,
    pub profile: String,
    pub target: String,
    pub agents: Vec<AgentBundle>,
}
