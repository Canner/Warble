//! Typed view of the Warble IR (`warble_ir_version: 0.2`) that this back-end consumes.
//!
//! Mirrors `docs/spec/ir-schema.md` field-for-field. The IR JSON is the language-neutral seam
//! between the front-end compiler and any back-end: this module depends on the schema doc, not on
//! the front-end's Rust types. Enum arms cover every schema-valid value; arms this target does not
//! yet realize are rejected at emit time (a "wall-hit"), not at deserialization.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LlmTier {
    Strong,
    Cheap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RealizationKind {
    Skill,
    Tool,
    GatedTool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComponentType {
    Analytical,
    Assertive,
    Mutating,
    Orchestrating,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerKind {
    OneShot,
    Scheduled,
    Event,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutcomeKind {
    None,
    Assertion,
    Mutation,
    Dispatch,
}

impl RealizationKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            RealizationKind::Skill => "skill",
            RealizationKind::Tool => "tool",
            RealizationKind::GatedTool => "gated-tool",
        }
    }
}

impl TriggerKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TriggerKind::OneShot => "one_shot",
            TriggerKind::Scheduled => "scheduled",
            TriggerKind::Event => "event",
        }
    }
}

impl OutcomeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            OutcomeKind::None => "none",
            OutcomeKind::Assertion => "assertion",
            OutcomeKind::Mutation => "mutation",
            OutcomeKind::Dispatch => "dispatch",
        }
    }
}

impl ComponentType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ComponentType::Analytical => "analytical",
            ComponentType::Assertive => "assertive",
            ComponentType::Mutating => "mutating",
            ComponentType::Orchestrating => "orchestrating",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ContextBinding {
    pub project: String,
    pub binding_mode: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IrConfig {
    #[serde(default)]
    pub tier_policy: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LlmCall {
    pub name: String,
    pub tier: LlmTier,
    #[serde(default)]
    pub consumes: Vec<String>,
    #[serde(default)]
    pub produces: Option<String>,
    pub prompt: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Guardrail {
    pub name: String,
    pub locked: bool,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Trigger {
    pub kind: TriggerKind,
}

/// A typed render block: a block type plus its field-name → field-type schema. The field-type
/// strings are echoed into the agent's render contract verbatim; the back-end never interprets
/// them. `BTreeMap` keeps field order stable (deterministic output).
#[derive(Debug, Clone, Deserialize)]
pub struct RenderBlock {
    #[serde(rename = "type")]
    pub block_type: String,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Outcome {
    pub kind: OutcomeKind,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Effect {
    #[serde(default)]
    pub render_blocks: Vec<RenderBlock>,
    pub outcome: Outcome,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PreconditionResult {
    pub status: String,
    #[serde(default)]
    pub checks: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ComponentNode {
    pub id: String,
    pub verb: String,
    #[serde(rename = "type")]
    pub component_type: ComponentType,
    pub realization_kind: RealizationKind,
    pub context_binding: ContextBinding,
    pub precondition_result: PreconditionResult,
    pub prompt_fragment: String,
    pub llm_calls: Vec<LlmCall>,
    pub guardrails: Vec<Guardrail>,
    pub trigger: Trigger,
    #[serde(default)]
    pub required_capabilities: Vec<String>,
    #[serde(default)]
    pub borrowed_actions: Vec<String>,
    pub eval_ref: String,
    pub effect: Effect,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WarbleIr {
    pub warble_ir_version: String,
    pub profile: String,
    pub context_binding: ContextBinding,
    pub config: IrConfig,
    pub components: Vec<ComponentNode>,
}
