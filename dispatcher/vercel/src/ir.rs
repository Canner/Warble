//! Typed view of the Warble IR (`warble_ir_version: 0.5`) that this back-end consumes.
//!
//! Mirrors [`ir-schema.md`][spec-ir] field-for-field. The IR JSON is the language-neutral seam
//! between the front-end compiler and any back-end: this module depends on the schema doc, not on
//! the front-end's Rust types. Enum arms cover every schema-valid value; arms this target does not
//! yet realize are rejected at emit time (a "wall-hit"), not at deserialization.
//!
//! [spec-ir]: https://github.com/Canner/Warble/blob/v0.2.0/docs/spec/ir-schema.md

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A step's tier is an **open string**, not a fixed enum. Warble ships a standard core vocabulary
/// (`strong`, `cheap`) that keeps components portable, but a component may name a custom tier; the
/// dispatch-time model config maps each tier name to a concrete model, and a tier with no mapping
/// is a loud-fail. Kept as `String` so the seam never constrains the vocabulary.
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
    Constitutive,
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
            ComponentType::Constitutive => "constitutive",
            ComponentType::Orchestrating => "orchestrating",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ContextBinding {
    pub project: String,
    pub binding_mode: String,
    /// Fine-grained resolved binding (IR v0.3): metrics/dimensions/grains/lineage summary the
    /// front-end learned from the bound semantic layer. Carried through and tolerated here; this
    /// back-end does not yet consume it (it still drives off the coarse project path).
    #[serde(default)]
    pub resolved: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IrConfig {
    #[serde(default)]
    pub tier_policy: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LlmCall {
    pub name: String,
    /// Tier name (conventionally `strong`/`cheap`; custom names allowed — see [`RealizationKind`]
    /// docs). Resolved to a concrete model at dispatch.
    pub tier: String,
    #[serde(default)]
    pub consumes: Vec<String>,
    #[serde(default)]
    pub produces: Option<String>,
    pub prompt: String,
    /// Whether this step only runs under a runtime condition (e.g. a prior step's outcome).
    #[serde(default)]
    pub conditional: bool,
    /// The closed-vocabulary guard deciding whether a `conditional` step runs (IR v0.3+; see
    /// [`ir-schema.md`][spec-ir]). This back-end realizes two shapes of it (see `classify.rs`): an
    /// `on_failure` guard targeting the immediately-preceding call folds into that call's own
    /// bounded repair loop (R1), and every other guard in the closed vocabulary (`on_flag`,
    /// `on_missing`, or a non-adjacent `on_failure`) is an independent step whose guard the bundle
    /// consumer evaluates deterministically before running it (R2 — see `StepRealization`). Any
    /// `conditional`/`when` shape outside that — an unrecognized guard name, or `conditional` and
    /// `when` disagreeing about whether a guard exists — fails loudly at emit time
    /// (`emit::check_conditional_shapes`) rather than being silently folded into either
    /// realization.
    ///
    /// [spec-ir]: https://github.com/Canner/Warble/blob/v0.2.0/docs/spec/ir-schema.md
    #[serde(default)]
    pub when: Option<WhenGuard>,
}

/// A closed-vocabulary guard on a conditional `llm_call`: `guard` is one of `on_failure` /
/// `on_flag` / `on_missing`, `target` is the guard-specific argument. See
/// [`ir-schema.md`][spec-ir].
///
/// [spec-ir]: https://github.com/Canner/Warble/blob/v0.2.0/docs/spec/ir-schema.md
#[derive(Debug, Clone, Deserialize)]
pub struct WhenGuard {
    pub guard: String,
    pub target: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Guardrail {
    pub name: String,
    pub locked: bool,
    #[serde(default)]
    pub scope: Option<String>,
    /// Optional numeric or structured threshold the guardrail enforces (shape is guardrail-specific).
    #[serde(default)]
    pub threshold: Option<serde_json::Value>,
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
    /// Free-form verdict classification for `assertion`-kind outcomes.
    #[serde(default)]
    pub verdict_type: Option<String>,
    /// Event/signal names this outcome emits (e.g. for `dispatch`-kind outcomes).
    #[serde(default)]
    pub emits: Option<Vec<String>>,
    /// The mutation/dispatch target, when applicable.
    #[serde(default)]
    pub target: Option<String>,
    /// The kind of change made, for `mutation`-kind outcomes.
    #[serde(default)]
    pub change_type: Option<String>,
    /// Routing scope for `dispatch`-kind outcomes (shape is dispatch-target-specific).
    #[serde(default)]
    pub routable_scope: Option<serde_json::Value>,
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
    /// Per-predicate evaluation results (IR v0.3): each `{predicate, outcome}`. In v0.2 this was a
    /// free-form string list; v0.3 makes it structured now that predicates are really evaluated.
    #[serde(default)]
    pub checks: Vec<PreconditionCheck>,
}

/// One evaluated `context_precondition` and its outcome (`pass` in emitted IR — a failing
/// predicate loud-fails the compile before any IR is emitted).
#[derive(Debug, Clone, Deserialize)]
pub struct PreconditionCheck {
    pub predicate: String,
    pub outcome: String,
}

/// A context precondition a component requires to hold before it runs (e.g. `has_metric`).
#[derive(Debug, Clone, Deserialize)]
pub struct Precondition {
    pub predicate: String,
    #[serde(default)]
    pub args: Option<serde_json::Value>,
}

/// A component parameter, either bound at dispatch time (`bind`, with an optional `default`) or
/// sourced from context (`source`). Exactly one of `bind`/`source` is expected to be present per
/// the schema, but both are optional here since this is a Deserialize-only view.
#[derive(Debug, Clone, Deserialize)]
pub struct Param {
    pub name: String,
    #[serde(default)]
    pub bind: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub default: Option<serde_json::Value>,
}

/// An authored evaluation spec: which eval template to run and which metrics it scores.
#[derive(Debug, Clone, Deserialize)]
pub struct EvalSpec {
    pub template_ref: String,
    #[serde(default)]
    pub metrics: Vec<String>,
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
    /// Free-text context capabilities this component requires (e.g. "a wren project ...").
    #[serde(default)]
    pub context_requirements: Vec<String>,
    /// Structured preconditions the bound context must satisfy (e.g. `has_metric`).
    #[serde(default)]
    pub context_precondition: Vec<Precondition>,
    /// Component parameters, either context-sourced or dispatch-bound.
    #[serde(default)]
    pub params: Vec<Param>,
    /// Authored evaluation spec, when the component declares one.
    #[serde(default)]
    pub eval: Option<EvalSpec>,
    /// Optional free-form framing shared by every step of this component (see
    /// `docs/spec/ir-schema.md`).
    #[serde(default)]
    pub brief: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WarbleIr {
    pub warble_ir_version: String,
    pub profile: String,
    pub context_binding: ContextBinding,
    pub config: IrConfig,
    pub components: Vec<ComponentNode>,
}
