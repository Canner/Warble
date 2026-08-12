//! Provider fragments — the dispatch-time supplement to this target's capability profile and tool
//! grants.
//!
//! The base `claude-code` target (`targets.rs`) declares only **substrate** capabilities: LLM tiers,
//! the render and structured-output contracts, the authz/approval/blast-radius gates, version
//! control, context isolation. Those describe the runtime itself. Any **domain** capability — an
//! external service the component talks to, and the tools that reach it — is supplied at dispatch by
//! one or more provider fragments loaded through the CLI's repeatable `--provider` flag, so warble
//! never hardcodes whose product realizes a capability.
//!
//! This mirrors `dispatcher/vercel/src/provider.rs`. The two are deliberately separate
//! implementations of one written contract (`docs/spec/provider-fragment.md`), the same arrangement
//! `binding-spec.md` describes for the tier→model binding: no shared codegen, a shared spec, and a
//! shared conformance fixture (`dispatcher/conformance-fixtures/provider-composition.json`) that
//! fails whichever side drifts.

use crate::error::DispatchError;
use crate::targets::{
    CapabilityEntry, CapabilityOutcome, CapabilityProfile, Criticality, ProvidedBy, TargetId,
};
use serde::Deserialize;
use std::borrow::Cow;
use std::collections::HashMap;

/// The engine a fragment must declare to apply here.
pub const ENGINE: &str = "claude-code";

/// One capability's profile-entry contribution from a fragment.
#[derive(Debug, Clone, Deserialize)]
pub struct ProfileEntrySpec {
    pub outcome: CapabilityOutcome,
    #[serde(default)]
    pub via: Option<String>,
    pub provided_by: ProvidedBy,
    pub criticality: Criticality,
    #[serde(default)]
    pub note: Option<String>,
}

impl From<ProfileEntrySpec> for CapabilityEntry {
    fn from(spec: ProfileEntrySpec) -> Self {
        CapabilityEntry {
            outcome: spec.outcome,
            via: spec.via.map(Cow::Owned),
            provided_by: spec.provided_by,
            criticality: spec.criticality,
            note: spec.note.map(Cow::Owned),
        }
    }
}

/// One capability's tool binding.
///
/// `name`/`names` is the tool **as this engine spells it** — for Claude Code, the allowlist entry,
/// e.g. `mcp__remote_agent__ask`. A capability may need more than one callable (asking a service and
/// answering the question it asks back are one ability, two tools), so the list form exists; the
/// single-`name` form is the same thing with one entry and is what a vercel-shaped fragment uses.
#[derive(Debug, Clone, Deserialize)]
pub struct ToolBindingSpec {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub names: Vec<String>,
    pub source: String,
}

impl ToolBindingSpec {
    /// Every callable this binding grants, single and list forms normalized together.
    fn all_names(&self) -> Vec<String> {
        self.name
            .iter()
            .cloned()
            .chain(self.names.iter().cloned())
            .collect()
    }
}

/// A resolved tool binding: the callables to grant, plus where they are realized (provenance for
/// the report — the grant itself is just the names).
#[derive(Debug, Clone)]
pub struct ToolBinding {
    pub names: Vec<String>,
    pub source: String,
}

pub type ToolMap = HashMap<String, ToolBinding>;

/// A single provider fragment: a partial target definition. Field names are snake_case to match the
/// fragment YAML verbatim.
#[derive(Debug, Clone, Deserialize)]
pub struct ProviderFragment {
    pub fragment_version: String,
    pub provider: String,
    pub engine: String,
    /// Restrict to one mode (`"headless"` | `"interactive"`); omitted ⇒ both. A fragment whose mode
    /// does not match is skipped rather than rejected, so one file can carry both halves.
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub capabilities: HashMap<String, ProfileEntrySpec>,
    #[serde(default)]
    pub tools: HashMap<String, ToolBindingSpec>,
}

/// A fragment file: either one fragment, or `{ providers: [...] }`.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum ProviderFile {
    List { providers: Vec<ProviderFragment> },
    Single(ProviderFragment),
}

/// Parse one fragment file's contents. Pure — file I/O stays in the CLI.
pub fn parse_provider_fragments(raw: &str) -> Result<Vec<ProviderFragment>, DispatchError> {
    let file: ProviderFile = serde_yaml::from_str(raw)
        .map_err(|e| DispatchError(format!("failed to parse provider fragment: {e}")))?;
    Ok(match file {
        ProviderFile::Single(fragment) => vec![fragment],
        ProviderFile::List { providers } => providers,
    })
}

/// A target's profile and tool map after composition, carried together so callers never juggle two
/// separately-composed halves.
pub struct ComposedTarget {
    pub profile: CapabilityProfile,
    pub tool_map: ToolMap,
}

/// `source` grammar: `mcp:<server>/<tool>`, or a bare mechanism label carrying neither `:` nor `/`.
fn validate_source_grammar(
    provider_id: &str,
    capability: &str,
    source: &str,
) -> Result<(), DispatchError> {
    if let Some(rest) = source.strip_prefix("mcp:") {
        let mut parts = rest.splitn(2, '/');
        let server = parts.next().unwrap_or("");
        let tool = parts.next();
        if server.is_empty() || tool.is_none_or(str::is_empty) {
            return Err(DispatchError(format!(
                "provider '{provider_id}': capability '{capability}' has a malformed tool source \
                 '{source}' — expected 'mcp:<server>/<tool>'"
            )));
        }
    } else if source.is_empty() || source.contains(':') || source.contains('/') {
        return Err(DispatchError(format!(
            "provider '{provider_id}': capability '{capability}' has a malformed tool source \
             '{source}' — a bare mechanism label must not contain ':' or '/'"
        )));
    }
    Ok(())
}

/// When a source is `mcp:<S>/<tool>`, the capability's `via` must be `mcp:<S>` — otherwise the
/// resolution report and the tool grant disagree about which server is behind the capability.
fn validate_via_source_coherence(
    provider_id: &str,
    capability: &str,
    via: Option<&str>,
    source: &str,
) -> Result<(), DispatchError> {
    let Some(rest) = source.strip_prefix("mcp:") else {
        return Ok(());
    };
    let Some(server) = rest.split('/').next().filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let expected = format!("mcp:{server}");
    if via != Some(expected.as_str()) {
        return Err(DispatchError(format!(
            "provider '{provider_id}': capability '{capability}' has tool source '{source}' \
             (server '{server}') but via is {via:?} — via should be '{expected}' so the report and \
             the tool grant agree on the backing server"
        )));
    }
    Ok(())
}

/// A grant must name a tool the runtime can actually be told to allow. Claude Code spells an MCP
/// tool `mcp__<server>__<tool>`, and a fragment that says otherwise produces an allowlist entry that
/// silently matches nothing — a tool the agent is told it has and then cannot call.
fn validate_names_match_source(
    provider_id: &str,
    capability: &str,
    names: &[String],
    source: &str,
) -> Result<(), DispatchError> {
    if names.is_empty() {
        return Err(DispatchError(format!(
            "provider '{provider_id}': tool binding for '{capability}' grants no tool — set `name` \
             or `names`"
        )));
    }
    let Some(rest) = source.strip_prefix("mcp:") else {
        return Ok(());
    };
    let server = rest.split('/').next().unwrap_or("");
    let expected_prefix = format!("mcp__{server}__");
    for name in names {
        if !name.starts_with(&expected_prefix) {
            return Err(DispatchError(format!(
                "provider '{provider_id}': tool binding for '{capability}' grants '{name}', which \
                 cannot come from server '{server}' — on {ENGINE} an MCP tool is spelled \
                 '{expected_prefix}<tool>'"
            )));
        }
    }
    Ok(())
}

/// Whether the base owns `capability` and a provider may therefore not redefine it: safety-critical
/// unconditionally, or any outcome other than `fail`. A base entry that is merely a non-safety
/// `fail` is the "raise a base fail into support" case a provider is allowed to take.
fn base_locks_capability(base: &CapabilityProfile, capability: &str) -> bool {
    base.get(capability).is_some_and(|e| {
        e.criticality == Criticality::SafetyCritical || e.outcome != CapabilityOutcome::Fail
    })
}

/// Compose the base profile and tool map with a flattened fragment set.
///
/// 1. A provider may only add a capability the base lacks, or raise a base `fail` into support.
/// 2. It may never weaken a safety-critical base capability nor redefine one the base provides.
/// 3. At most one fragment may claim a capability, across both maps. Ownership is the fragment's
///    *index*, never its self-declared `provider` string — that string comes from the file, so two
///    fragments sharing one would otherwise not collide and the later would silently win.
/// 4. A tool binding needs its capability's profile entry to exist (from the base or the same
///    fragment) by the time it is processed.
pub fn compose_target(
    base_profile: CapabilityProfile,
    base_tool_map: ToolMap,
    providers: &[ProviderFragment],
    target_id: TargetId,
) -> Result<ComposedTarget, DispatchError> {
    let base_profile_snapshot = base_profile.clone();
    let base_tool_keys: Vec<String> = base_tool_map.keys().cloned().collect();
    let mut profile = base_profile;
    let mut tool_map = base_tool_map;
    let mut claimed: HashMap<String, usize> = HashMap::new();

    for (idx, fragment) in providers.iter().enumerate() {
        if fragment.engine != ENGINE {
            return Err(DispatchError(format!(
                "provider '{}': engine '{}' does not match target engine '{ENGINE}'",
                fragment.provider, fragment.engine
            )));
        }
        if let Some(mode) = fragment.mode.as_deref() {
            if mode != target_id.mode() {
                continue;
            }
        }

        for (capability, spec) in &fragment.capabilities {
            if base_locks_capability(&base_profile_snapshot, capability) {
                return Err(DispatchError(format!(
                    "provider '{}': capability '{capability}' is already provided by the base \
                     target and cannot be redefined",
                    fragment.provider
                )));
            }
            claim_capability(&mut claimed, providers, capability, idx, fragment)?;
            profile.insert(capability.clone(), spec.clone().into());
        }

        for (capability, spec) in &fragment.tools {
            let names = spec.all_names();
            validate_source_grammar(&fragment.provider, capability, &spec.source)?;
            validate_via_source_coherence(
                &fragment.provider,
                capability,
                profile.get(capability).and_then(|e| e.via.as_deref()),
                &spec.source,
            )?;
            validate_names_match_source(&fragment.provider, capability, &names, &spec.source)?;
            if base_locks_capability(&base_profile_snapshot, capability)
                || base_tool_keys.iter().any(|k| k == capability)
            {
                return Err(DispatchError(format!(
                    "provider '{}': tool binding for '{capability}' is already provided by the \
                     base target and cannot be redefined",
                    fragment.provider
                )));
            }
            claim_capability(&mut claimed, providers, capability, idx, fragment)?;
            if !profile.contains_key(capability) {
                return Err(DispatchError(format!(
                    "provider '{}': tool binding for '{capability}' has no corresponding \
                     capability profile entry (from the base or this provider)",
                    fragment.provider
                )));
            }
            tool_map.insert(
                capability.clone(),
                ToolBinding {
                    names,
                    source: spec.source.clone(),
                },
            );
        }
    }

    Ok(ComposedTarget { profile, tool_map })
}

fn claim_capability(
    claimed: &mut HashMap<String, usize>,
    providers: &[ProviderFragment],
    capability: &str,
    idx: usize,
    fragment: &ProviderFragment,
) -> Result<(), DispatchError> {
    match claimed.get(capability) {
        Some(&owner) if owner != idx => Err(DispatchError(format!(
            "capability '{capability}' is claimed by both provider '{}' and provider '{}' — at \
             most one provider source per capability",
            providers[owner].provider, fragment.provider
        ))),
        Some(_) => Ok(()),
        None => {
            claimed.insert(capability.to_string(), idx);
            Ok(())
        }
    }
}

/// Compose against an empty tool map and report only the capability keys — the shape the shared
/// conformance fixture asserts. Exposed for that suite rather than for the emit path, which needs
/// the whole composed target and reaches `compose_target` directly.
pub fn compose_for_conformance(
    base_profile: CapabilityProfile,
    providers: &[ProviderFragment],
    target_id: TargetId,
) -> Result<Vec<String>, DispatchError> {
    let composed = compose_target(base_profile, ToolMap::new(), providers, target_id)?;
    Ok(composed.profile.into_keys().collect())
}
