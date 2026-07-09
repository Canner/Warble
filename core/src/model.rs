//! Deserialized authoring types — the on-disk Warble project shapes (`profile.yml`,
//! `component.yml`, `context/binding.yml`) that the host reads and hands to [`crate::compile`].
//!
//! These derive `Deserialize` only; no filesystem access lives here (sans-IO — see the crate
//! docs). The host (CLI / a binding) is responsible for reading the bytes.

use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Deserialize, Clone)]
pub struct ProfileFile {
    pub profile: String,
    pub context: ProfileContext,
    #[serde(default)]
    pub config: ProfileConfig,
    pub components: Vec<ProfileComponentMount>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ProfileContext {
    /// Path (relative to the project-dir) to the `binding.yml` file. Resolved by the caller.
    pub project: String,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct ProfileConfig {
    #[serde(default)]
    pub tier_policy: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ProfileComponentMount {
    #[serde(rename = "use")]
    pub use_id: String,
    #[serde(default)]
    pub config: Option<serde_yaml::Value>,
    #[serde(default)]
    pub bind: Option<HashMap<String, serde_yaml::Value>>,
    #[serde(default)]
    pub tier_overrides: Option<HashMap<String, String>>,
    #[serde(default)]
    pub realization_kind: Option<String>,
    /// Profile syntax for touching a component's guardrails: a map of guardrail name to a
    /// patch. Patching a guardrail whose component default is `locked: true` is always a
    /// compile error, regardless of what the patch requests.
    #[serde(default)]
    pub guardrails: Option<HashMap<String, GuardrailPatch>>,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct GuardrailPatch {
    #[serde(default)]
    pub locked: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct BindingFile {
    /// As-authored path to the bound wren project, relative to the Warble project-dir.
    pub project: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct ComponentFile {
    pub id: String,
    pub verb: String,
    #[serde(rename = "type")]
    pub component_type: String,
    pub realization_kind: String,
    pub binding_mode: String,
    #[serde(default)]
    pub context_requirements: Vec<String>,
    #[serde(default)]
    pub context_precondition: Vec<Precondition>,
    #[serde(default)]
    pub params: Vec<Param>,
    pub llm_steps: Vec<LlmStep>,
    pub trigger: Trigger,
    pub guardrails: Vec<Guardrail>,
    #[serde(default)]
    pub required_capabilities: Vec<String>,
    #[serde(default)]
    pub borrowed_actions: Vec<String>,
    pub effect: Effect,
    #[serde(default)]
    pub eval: Option<EvalSpec>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Precondition {
    pub predicate: String,
    #[serde(default)]
    pub args: Option<HashMap<String, serde_yaml::Value>>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct EvalSpec {
    pub template_ref: String,
    #[serde(default)]
    pub metrics: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Param {
    pub name: String,
    #[serde(default)]
    pub bind: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub default: Option<serde_yaml::Value>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct LlmStep {
    pub name: String,
    pub tier: String,
    pub prompt_ref: String,
    #[serde(default)]
    pub consumes: Vec<String>,
    #[serde(default)]
    pub produces: Option<String>,
    #[serde(default)]
    pub conditional: bool,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Trigger {
    pub kind: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Guardrail {
    pub name: String,
    #[serde(default)]
    pub locked: Option<bool>,
    #[serde(default)]
    pub overridable: Option<bool>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub threshold: Option<serde_yaml::Value>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Effect {
    pub render_blocks: Vec<RenderBlock>,
    pub outcome: Outcome,
}

/// A render block entry, authored either as a bare type name (shorthand, no fields) or as a
/// mapping with an explicit `fields` schema. Always normalized to `{type, fields}` in the IR.
#[derive(Debug, Clone)]
pub struct RenderBlock {
    pub block_type: String,
    pub fields: HashMap<String, String>,
}

impl<'de> Deserialize<'de> for RenderBlock {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Repr {
            Bare(String),
            Typed {
                #[serde(rename = "type")]
                block_type: String,
                #[serde(default)]
                fields: HashMap<String, String>,
            },
        }

        Ok(match Repr::deserialize(deserializer)? {
            Repr::Bare(block_type) => RenderBlock {
                block_type,
                fields: HashMap::new(),
            },
            Repr::Typed { block_type, fields } => RenderBlock { block_type, fields },
        })
    }
}

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Outcome {
    pub kind: String,
    #[serde(default)]
    pub verdict_type: Option<String>,
    #[serde(default)]
    pub emits: Option<Vec<String>>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub change_type: Option<String>,
    #[serde(default)]
    pub routable_scope: Option<serde_yaml::Value>,
}
