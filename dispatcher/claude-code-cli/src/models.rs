//! Tier → concrete model binding, resolved at **dispatch** (the runtime-injected mapping).
//!
//! Tiers travel in the IR as names (`strong`/`cheap`, or custom); which model each name becomes is
//! decided here, not in the profile — so the same compiled IR can run against different models
//! (exactly the axis the eval loop ablates). Authored either inline (`--strong/--cheap`) or as a
//! deployment-scoped YAML config (`--models-config`, never committed with a profile).
//!
//! For the claude-code CLI target a tier maps to a **model alias** only; connection/auth are owned
//! by the Claude Code runtime, not by the emitted files. The richer per-tier fields
//! (`provider`/`endpoint`) added by the hybrid-LLM spike (§9.2 layer 3) are *parsed* here so the one
//! `--models-config` format is shared across back-ends, but this file target only consumes the
//! `model` — connection/provider selection for the headless run is the session's (`ANTHROPIC_BASE_URL`
//! whole-session redirect), not per-step. Per-step provider routing is realized by the direct-driving
//! Agent SDK back-end (`dispatcher/claude-agent-sdk`), which reads [`TierBinding::provider`]/`endpoint`.

use crate::error::DispatchError;
use crate::ir::WarbleIr;
use std::collections::BTreeSet;

/// The standard-core authoring tiers — components declare these on steps to stay portable.
const STRONG_TIER: &str = "strong";
const CHEAP_TIER: &str = "cheap";

/// Reserved core tier used by the per-step-tier split's driver/routing loop. It is a *dispatch
/// role*, not an authoring tier — components never declare `tier: orchestrator` on a step — but it
/// lives in the same `tiers` map so the config has a single concept.
const ORCHESTRATOR_TIER: &str = "orchestrator";

/// Which provider serves a tier's model. `Anthropic` (the default) rides the Claude runtime;
/// `OpenAiCompat` is an OpenAI-compatible endpoint (e.g. ollama's `/v1`) that a direct-driving
/// back-end calls itself. §9.2 layer-3 binding: cloud-vs-local lives on this axis, never in the IR.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Provider {
    Anthropic,
    OpenAiCompat,
}

impl Provider {
    /// Parse the `provider:` field. Absent ⇒ `Anthropic` (the shorthand string form's default).
    fn parse(s: &str) -> Result<Self, DispatchError> {
        match s {
            "anthropic" => Ok(Provider::Anthropic),
            "openai_compat" => Ok(Provider::OpenAiCompat),
            other => Err(DispatchError(format!(
                "models config: unknown provider '{other}' (expected: anthropic, openai_compat)"
            ))),
        }
    }

    /// The wire name (round-trips [`Provider::parse`]).
    pub fn as_str(&self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::OpenAiCompat => "openai_compat",
        }
    }
}

/// A tier's full runtime binding: which `provider` serves it, at what `endpoint` (for
/// OpenAI-compatible providers), running which `model`. The shorthand YAML form `tier: <model>` is a
/// `{ provider: anthropic, endpoint: none, model: <model> }` binding — so existing configs are
/// unchanged, and the file target (which only reads `model`) behaves exactly as before.
#[derive(Debug, Clone)]
pub struct TierBinding {
    pub provider: Provider,
    pub endpoint: Option<String>,
    pub model: String,
}

impl TierBinding {
    /// An Anthropic-provider binding from a bare model alias (the shorthand / inline-flag form).
    fn anthropic(model: String) -> Self {
        TierBinding {
            provider: Provider::Anthropic,
            endpoint: None,
            model,
        }
    }
}

/// An ordered tier→binding map. Declaration order is priority: earlier tiers are "stronger" — used to
/// pick the single model when a multi-tier component collapses to one agent. Alongside the authoring
/// tiers (`strong`/`cheap`/custom, which components declare on steps) it carries the reserved
/// [`ORCHESTRATOR_TIER`] used by the split driver.
#[derive(Debug, Clone)]
pub struct ModelConfig {
    /// `(tier name, binding)` in declaration order (earliest = strongest).
    tiers: Vec<(String, TierBinding)>,
}

impl Default for ModelConfig {
    /// The Claude Code defaults: `strong→opus`, `cheap→haiku`, `orchestrator→sonnet` (all Anthropic).
    fn default() -> Self {
        ModelConfig {
            tiers: vec![
                (
                    STRONG_TIER.to_string(),
                    TierBinding::anthropic("opus".into()),
                ),
                (
                    CHEAP_TIER.to_string(),
                    TierBinding::anthropic("haiku".into()),
                ),
                (
                    ORCHESTRATOR_TIER.to_string(),
                    TierBinding::anthropic("sonnet".into()),
                ),
            ],
        }
    }
}

impl ModelConfig {
    /// Build from the inline `--strong/--cheap/--orchestrator` flags (the standard-core convenience).
    /// Inline flags are always Anthropic-provider aliases; provider/endpoint routing is `--models-config`
    /// only (so a non-alias inline flag still loud-fails on the SDK split path, as before).
    pub fn from_flags(strong: String, cheap: String, orchestrator: String) -> Self {
        ModelConfig {
            tiers: vec![
                (STRONG_TIER.to_string(), TierBinding::anthropic(strong)),
                (CHEAP_TIER.to_string(), TierBinding::anthropic(cheap)),
                (
                    ORCHESTRATOR_TIER.to_string(),
                    TierBinding::anthropic(orchestrator),
                ),
            ],
        }
    }

    /// Parse a `--models-config` YAML document. A tier value is EITHER a bare model-alias string
    /// (Anthropic shorthand) OR a `{ provider, endpoint?, model }` map. Declaration order is priority;
    /// `orchestrator` is a reserved tier the split driver uses:
    ///
    /// ```yaml
    /// tiers:
    ///   strong: opus                          # shorthand ⇒ provider: anthropic
    ///   cheap:                                # structured binding (§9.2 layer 3)
    ///     provider: openai_compat
    ///     endpoint: http://localhost:11434/v1
    ///     model: qwen2.5
    ///   orchestrator: sonnet                  # reserved: the per-step-tier split driver
    /// ```
    pub fn from_yaml(text: &str) -> Result<Self, DispatchError> {
        #[derive(serde::Deserialize)]
        struct Raw {
            #[serde(default)]
            tiers: serde_yaml::Mapping,
        }
        let raw: Raw = serde_yaml::from_str(text)
            .map_err(|e| DispatchError(format!("invalid models config: {e}")))?;

        let mut tiers = Vec::new();
        for (key, value) in raw.tiers {
            let name = key
                .as_str()
                .ok_or_else(|| DispatchError::new("models config: tier name must be a string"))?
                .to_string();
            let binding = Self::parse_tier_value(&name, &value)?;
            tiers.push((name, binding));
        }
        if tiers.is_empty() {
            return Err(DispatchError::new(
                "models config: `tiers` must not be empty",
            ));
        }
        Ok(ModelConfig { tiers })
    }

    /// A tier value: a bare model string (Anthropic shorthand) or a `{provider, endpoint?, model}` map.
    fn parse_tier_value(
        name: &str,
        value: &serde_yaml::Value,
    ) -> Result<TierBinding, DispatchError> {
        if let Some(model) = value.as_str() {
            return Ok(TierBinding::anthropic(model.to_string()));
        }
        let map = value.as_mapping().ok_or_else(|| {
            DispatchError(format!(
                "models config: tier '{name}' must be a model-alias string or a \
{{provider, endpoint?, model}} map"
            ))
        })?;
        let get = |k: &str| map.get(serde_yaml::Value::from(k)).and_then(|v| v.as_str());
        let model = get("model")
            .ok_or_else(|| {
                DispatchError(format!(
                    "models config: tier '{name}' map is missing `model`"
                ))
            })?
            .to_string();
        let provider = match get("provider") {
            Some(p) => Provider::parse(p)?,
            None => Provider::Anthropic,
        };
        let endpoint = get("endpoint").map(str::to_string);
        if provider == Provider::OpenAiCompat && endpoint.is_none() {
            return Err(DispatchError(format!(
                "models config: tier '{name}' uses provider openai_compat but has no `endpoint`"
            )));
        }
        Ok(TierBinding {
            provider,
            endpoint,
            model,
        })
    }

    /// The model for the reserved `orchestrator` tier (the split driver), or a loud-fail if a
    /// `--models-config` omitted it while a component needs a per-step-tier split.
    pub fn orchestrator(&self) -> Result<&str, DispatchError> {
        self.require(ORCHESTRATOR_TIER)
    }

    fn binding_for(&self, tier: &str) -> Option<&TierBinding> {
        self.tiers
            .iter()
            .find(|(name, _)| name == tier)
            .map(|(_, binding)| binding)
    }

    fn model_for(&self, tier: &str) -> Option<&str> {
        self.binding_for(tier).map(|b| b.model.as_str())
    }

    fn rank(&self, tier: &str) -> usize {
        self.tiers
            .iter()
            .position(|(name, _)| name == tier)
            .unwrap_or(usize::MAX)
    }

    fn tier_names(&self) -> String {
        self.tiers
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The model a tier maps to, or a loud-fail naming the undefined tier.
    pub fn require(&self, tier: &str) -> Result<&str, DispatchError> {
        self.model_for(tier).ok_or_else(|| {
            DispatchError(format!(
                "tier '{tier}' has no model binding — define it in --models-config or via \
--strong/--cheap (known tiers: {})",
                self.tier_names()
            ))
        })
    }

    /// The full `{provider, endpoint, model}` binding a tier maps to (§9.2 layer 3), or a loud-fail.
    /// Direct-driving back-ends read this to route a step cloud-vs-local; the file target uses only
    /// [`ModelConfig::require`] (the model) because its provider is the session's, not per-step.
    pub fn binding(&self, tier: &str) -> Result<&TierBinding, DispatchError> {
        self.binding_for(tier).ok_or_else(|| {
            DispatchError(format!(
                "tier '{tier}' has no model binding — define it in --models-config or via \
--strong/--cheap (known tiers: {})",
                self.tier_names()
            ))
        })
    }

    /// The model for a single collapsed agent: the strongest (lowest-rank) tier among the calls.
    pub fn collapsed_model<'a>(
        &'a self,
        calls: &[crate::ir::LlmCall],
    ) -> Result<&'a str, DispatchError> {
        let strongest = calls
            .iter()
            .min_by_key(|c| self.rank(&c.tier))
            .ok_or_else(|| {
                DispatchError::new("component has no llm_calls; cannot select a model")
            })?;
        self.require(&strongest.tier)
    }

    /// Validate every step tier in the IR maps to a model (front-loaded so emission is infallible).
    pub fn validate(&self, ir: &WarbleIr) -> Result<(), DispatchError> {
        let mut checked = BTreeSet::new();
        for node in &ir.components {
            for call in &node.llm_calls {
                if checked.insert(call.tier.as_str()) {
                    self.require(&call.tier)?;
                }
            }
        }
        Ok(())
    }
}
