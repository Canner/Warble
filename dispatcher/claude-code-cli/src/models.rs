//! Tier → concrete model binding, resolved at **dispatch** (the runtime-injected mapping).
//!
//! Tiers travel in the IR as names (`strong`/`cheap`, or custom); which model each name becomes is
//! decided here, not in the profile — so the same compiled IR can run against different models
//! (exactly the axis the eval loop ablates). Authored either inline (`--strong/--cheap`) or as a
//! deployment-scoped YAML config (`--models-config`, never committed with a profile).
//!
//! For the claude-code CLI target a tier maps to a **model alias** only; connection/auth are owned
//! by the Claude Code runtime, not by the emitted files. Richer per-tier fields
//! (provider/endpoint/auth) are a future extension for targets that drive the model directly.

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

/// An ordered tier→model map. Declaration order is priority: earlier tiers are "stronger" — used to
/// pick the single model when a multi-tier component collapses to one agent. Alongside the authoring
/// tiers (`strong`/`cheap`/custom, which components declare on steps) it carries the reserved
/// [`ORCHESTRATOR_TIER`] used by the split driver.
#[derive(Debug, Clone)]
pub struct ModelConfig {
    /// `(tier name, model alias)` in declaration order (earliest = strongest).
    tiers: Vec<(String, String)>,
}

impl Default for ModelConfig {
    /// The Claude Code defaults: `strong→opus`, `cheap→haiku`, `orchestrator→sonnet`.
    fn default() -> Self {
        ModelConfig {
            tiers: vec![
                (STRONG_TIER.to_string(), "opus".to_string()),
                (CHEAP_TIER.to_string(), "haiku".to_string()),
                (ORCHESTRATOR_TIER.to_string(), "sonnet".to_string()),
            ],
        }
    }
}

impl ModelConfig {
    /// Build from the inline `--strong/--cheap/--orchestrator` flags (the standard-core convenience).
    pub fn from_flags(strong: String, cheap: String, orchestrator: String) -> Self {
        ModelConfig {
            tiers: vec![
                (STRONG_TIER.to_string(), strong),
                (CHEAP_TIER.to_string(), cheap),
                (ORCHESTRATOR_TIER.to_string(), orchestrator),
            ],
        }
    }

    /// Parse a `--models-config` YAML document (tier name → model alias; declaration order is
    /// priority). `orchestrator` is a reserved tier the split driver uses:
    ///
    /// ```yaml
    /// tiers:
    ///   strong: opus
    ///   cheap: haiku
    ///   local: qwen2.5        # custom tiers allowed
    ///   orchestrator: sonnet  # reserved: the per-step-tier split driver
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
            let model = value
                .as_str()
                .ok_or_else(|| {
                    DispatchError(format!(
                        "models config: tier '{name}' must map to a model alias string"
                    ))
                })?
                .to_string();
            tiers.push((name, model));
        }
        if tiers.is_empty() {
            return Err(DispatchError::new(
                "models config: `tiers` must not be empty",
            ));
        }
        Ok(ModelConfig { tiers })
    }

    /// The model for the reserved `orchestrator` tier (the split driver), or a loud-fail if a
    /// `--models-config` omitted it while a component needs a per-step-tier split.
    pub fn orchestrator(&self) -> Result<&str, DispatchError> {
        self.require(ORCHESTRATOR_TIER)
    }

    fn model_for(&self, tier: &str) -> Option<&str> {
        self.tiers
            .iter()
            .find(|(name, _)| name == tier)
            .map(|(_, model)| model.as_str())
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
