//! Deserialized authoring types — the on-disk Warble project shapes (`profile.yml`,
//! `component.yml`, `context/binding.yml`) that the host reads and hands to [`crate::compile`].
//!
//! These derive `Deserialize` only; no filesystem access lives here (sans-IO — see the crate
//! docs). The host (CLI / a binding) is responsible for reading the bytes.

use serde::Deserialize;
use std::collections::HashMap;

/// The root of `profile.yml`: which components are mounted, the context this profile binds
/// against, and profile-level config defaults.
#[derive(Debug, Deserialize, Clone)]
pub struct ProfileFile {
    pub profile: String,
    pub context: ProfileContext,
    #[serde(default)]
    pub config: ProfileConfig,
    pub components: Vec<ProfileComponentMount>,
}

/// Where the bound context lives, relative to the profile.
#[derive(Debug, Deserialize, Clone)]
pub struct ProfileContext {
    /// Path (relative to the project-dir) to the `binding.yml` file. Resolved by the caller.
    pub project: String,
}

/// Profile-level config defaults threaded through to every mounted component.
#[derive(Debug, Deserialize, Clone, Default)]
pub struct ProfileConfig {
    #[serde(default)]
    pub tier_policy: Option<String>,
}

/// One `components:` entry: which component to mount, plus the config/binding/tier-override/
/// guardrail patches layered on top of that component's own defaults.
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
    /// A profile-level replacement for the mounted component's `brief` (see
    /// [`ComponentFile::brief`]). When present, it replaces the component's own `brief` entirely
    /// (never merged); when absent, the component's `brief` (if any) is used unchanged.
    #[serde(default)]
    pub brief: Option<String>,
}

/// A profile-level override to a mounted component's guardrail. Only `locked` is patchable
/// today; patching a guardrail whose component default is `locked: true` is always a compile
/// error, regardless of what the patch requests.
#[derive(Debug, Deserialize, Clone, Default)]
pub struct GuardrailPatch {
    #[serde(default)]
    pub locked: Option<bool>,
}

/// The root of `context/binding.yml`: which context a profile binds against.
///
/// `kind` is what the host resolves on. Before it existed, a host had to *infer* which adapter a
/// binding wanted by inspecting the bound directory, which cannot express a context that is not a
/// directory at all — a semantic layer held by a service, say. Declaring it also makes the choice
/// reviewable in git rather than a property of whatever happens to be on disk.
#[derive(Debug, Deserialize, Clone)]
pub struct BindingFile {
    /// Which kind of context this binds. An **open string**, opaque to the compiler — like `tier`
    /// and `provider` elsewhere — because the set of context kinds is a host's to extend. Defaults
    /// to `wren_project`, which is what every binding authored before this field meant.
    #[serde(default = "BindingFile::default_kind")]
    pub kind: String,
    /// As-authored locator for the bound context. A path relative to the Warble project-dir for the
    /// kinds a host reads off disk; for any other kind, whatever that host's resolver understands
    /// (e.g. a service-qualified id). The compiler only ever echoes it — into the IR's
    /// `context_binding.project` and the `{{project}}` placeholder — never interprets it.
    pub project: String,
    /// Fields a host's own `kind` declares that the compiler knows nothing about, kept so its
    /// resolver can read them. Empty for the kinds warble resolves itself.
    #[serde(flatten)]
    pub extra: HashMap<String, serde_yaml::Value>,
}

impl BindingFile {
    /// The kind a binding means when it does not say — i.e. every binding authored before `kind`
    /// existed.
    pub const WREN_PROJECT: &'static str = "wren_project";

    /// A raw source with no semantic layer over it yet: the input shape of the constitutive family,
    /// whose *output* is the MDL.
    pub const RAW_SOURCE: &'static str = "raw_source";

    /// A semantic layer that is not here — held by whatever will answer the questions. `project` is
    /// a locator naming it, never a path, and nothing is read: the compiler binds
    /// [`crate::ExternalContext`], which answers no predicate at all.
    pub const EXTERNAL: &'static str = "external";

    fn default_kind() -> String {
        Self::WREN_PROJECT.to_string()
    }
}

/// The root of a `component.yml`: identity, anatomy (`type` / `realization_kind` / `trigger`),
/// the LLM steps that realize it, and everything that gates or governs how it runs
/// (guardrails, preconditions, capabilities).
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
    /// Optional free-form framing shared by every step of this component — what steps/*.md leave
    /// unsaid because it applies to all of them rather than to one. Supports the same
    /// `{{project}}`/`{{project_name}}` placeholders as step bodies. A profile mount may replace it
    /// wholesale via [`ProfileComponentMount::brief`]. Absent by default; only present on components
    /// an author has explicitly given one.
    #[serde(default)]
    pub brief: Option<String>,
}

/// A `context_precondition` entry: a closed-vocabulary predicate the bound context must
/// satisfy before the component runs (e.g. `has_metric`), plus its predicate-specific `args`.
#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Precondition {
    pub predicate: String,
    #[serde(default)]
    pub args: Option<HashMap<String, serde_yaml::Value>>,
}

/// An authored evaluation spec: which eval template to run for this component, and which
/// metrics it scores.
#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct EvalSpec {
    pub template_ref: String,
    #[serde(default)]
    pub metrics: Vec<String>,
}

/// A component parameter, either bound at dispatch time (`bind`, with an optional `default`)
/// or sourced from context (`source`). Exactly one of `bind`/`source` is expected to be
/// present per the schema, but both are optional here since this is a Deserialize-only view.
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

/// One `llm_steps` entry: a single LLM call — its tier, its prompt reference, and the
/// artifact-flow (`consumes`/`produces`) linking it to other steps.
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
    /// The guard deciding whether this conditional step runs (closed vocabulary — see
    /// `compile::GUARD_VOCABULARY`). A step with `conditional: true` must declare one; compile
    /// refuses to guess the condition (see `compile::check_when_guards`).
    #[serde(default)]
    pub when: Option<WhenGuard>,
}

/// A closed-vocabulary predicate gating a conditional `llm_step`: `guard` names one of
/// `on_failure` / `on_flag` / `on_missing`, and `target` is the guard-specific argument (a step
/// name, a dotted `artifact.field`, or an artifact name — see `compile::check_when_guards`).
/// No boolean algebra, no expressions, no imperative logic — mirrors the `context_precondition`
/// closed-vocabulary philosophy (invariant #3: no DSL in the composition layer).
#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct WhenGuard {
    pub guard: String,
    pub target: String,
}

/// How this component starts (`kind`: `one_shot` / `scheduled` / `event`).
#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Trigger {
    pub kind: String,
}

/// A guardrail attached to a component: whether it is `locked` (unpatchable by a mounting
/// profile) or `overridable`, its scope, and an optional threshold.
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

/// What a component's steps produce for the host to act on: any render blocks plus the
/// outcome classification.
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

/// The component's outcome classification (`kind`: `none` / `assertion` / `mutation` /
/// `dispatch`) and the outcome-kind-specific fields that go with it.
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
