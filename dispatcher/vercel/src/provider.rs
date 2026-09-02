//! Provider fragments — the dispatch-time supplement to the base target's capability profile and
//! tool map.
//!
//! The base `vercel` target (`targets.rs`, `tools.rs`) only declares substrate capabilities — LLM
//! tiers, the structured-output contract, authz/approval/blast-radius gates, version control. Any
//! domain capability (SQL execution against a real engine, semantic model access, borrowed
//! scheduler/event/notify transports, or anything else product-specific) is supplied at dispatch
//! time by one or more **provider fragments**: partial target definitions loaded from a file via
//! the CLI's repeatable `--provider` flag. This keeps warble itself product-neutral — it never
//! hardcodes which product's tools realize a capability.

use crate::error::DispatchError;
use crate::targets::{
    CapabilityEntry, CapabilityOutcome, CapabilityProfile, Criticality, ProvidedBy, TargetId,
};
use crate::tools::{ToolBinding, ToolMap};
use serde::Deserialize;
use std::borrow::Cow;
use std::collections::HashMap;

/// One capability's profile-entry contribution from a provider fragment. Same shape as
/// `CapabilityEntry`, but with owned, deserializable fields — converted via `Into<CapabilityEntry>`
/// once parsed.
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

/// One capability's tool-binding contribution from a provider fragment.
#[derive(Debug, Clone, Deserialize)]
pub struct ToolBindingSpec {
    pub name: String,
    pub source: String,
}

impl From<ToolBindingSpec> for ToolBinding {
    fn from(spec: ToolBindingSpec) -> Self {
        ToolBinding {
            name: Cow::Owned(spec.name),
            source: Cow::Owned(spec.source),
        }
    }
}

/// A single provider fragment: a partial target definition contributing a partial capability
/// profile and a partial capability→tool map, composed with the base at dispatch via
/// `compose_target`. Field names are snake_case to match the fragment YAML/JSON verbatim (see the
/// design doc's annotated example) — no `rename_all`.
#[derive(Debug, Clone, Deserialize)]
pub struct ProviderFragment {
    pub fragment_version: String,
    pub provider: String,
    /// The engine this fragment extends (`"vercel"`); a fragment whose engine doesn't match the
    /// target's engine is rejected at composition time.
    pub engine: String,
    /// Restrict this fragment to one mode (`"headless"` | `"interactive"`); omitted ⇒ both modes.
    /// A fragment whose mode doesn't match the target being composed is silently skipped (it simply
    /// doesn't apply to this dispatch), not an error — this is what lets one fragment set contain
    /// both a headless-only and an interactive-only half.
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub capabilities: HashMap<String, ProfileEntrySpec>,
    #[serde(default)]
    pub tools: HashMap<String, ToolBindingSpec>,
}

/// A provider fragment *file*'s top-level shape: either a single fragment object, or a
/// `{ providers: [...] }` list. The loader accepts either and flattens to `Vec<ProviderFragment>`
/// (§5.3 — "composition operates over a flattened set").
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum ProviderFile {
    List { providers: Vec<ProviderFragment> },
    Single(ProviderFragment),
}

/// Parse one provider fragment file's raw contents (YAML; JSON parses as YAML too) into its
/// flattened list of fragments. File I/O itself stays in the CLI layer — this function is pure.
pub fn parse_provider_fragments(raw: &str) -> Result<Vec<ProviderFragment>, DispatchError> {
    let file: ProviderFile = serde_yaml::from_str(raw)
        .map_err(|e| DispatchError::new(format!("failed to parse provider fragment: {e}")))?;
    Ok(match file {
        ProviderFile::Single(fragment) => vec![fragment],
        ProviderFile::List { providers } => providers,
    })
}

/// The result of composing a target's base profile + tool map with a set of provider fragments —
/// carries both composed maps as one value so callers (namely `emit_vercel`) never juggle two
/// separately-composed things.
pub struct ComposedTarget {
    pub profile: CapabilityProfile,
    pub tool_map: ToolMap,
}

/// Enforced `tools.<cap>.source` grammar (§5.1): either `mcp:<server>/<tool>` (non-empty server and
/// tool) or a bare mechanism label containing neither `:` nor `/` (e.g. `native`). Malformed
/// sources are a loud-fail at composition time, not a silently-broken tool ref.
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
            return Err(DispatchError::new(format!(
                "provider '{provider_id}': capability '{capability}' has a malformed tool source '{source}' — expected 'mcp:<server>/<tool>'"
            )));
        }
    } else if source.is_empty() || source.contains(':') || source.contains('/') {
        return Err(DispatchError::new(format!(
            "provider '{provider_id}': capability '{capability}' has a malformed tool source '{source}' — a bare mechanism label must not contain ':' or '/'"
        )));
    }
    Ok(())
}

/// `via`/`source` coherence (§5.1): when a tool `source` is `mcp:<S>/<tool>`, that
/// capability's `via` should be `mcp:<S>` (same server) — keeps the resolution report and the tool
/// binding from disagreeing about the backing MCP server. Only applies to MCP-backed sources; a
/// bare-label source (e.g. `native`) has no server to check coherence against.
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
    let expected_via = format!("mcp:{server}");
    if via != Some(expected_via.as_str()) {
        return Err(DispatchError::new(format!(
            "provider '{provider_id}': capability '{capability}' has tool source '{source}' (server '{server}') but via is {via:?} — via should be '{expected_via}' so the report and the tool binding agree on the backing server"
        )));
    }
    Ok(())
}

/// Whether `capability` is locked against provider override in `base` — i.e. the base "already
/// provides" it (§5.2 rule 2). A base entry is locked if it is safety-critical (unconditionally —
/// protects `human_approval`/`blast_radius` even while they're `fail`), OR its outcome is anything
/// other than `fail` (a base capability that already resolves to something usable may not be
/// silently redefined). A base entry that is merely `fail` + non-safety-critical is NOT locked —
/// that's exactly the "raise a base fail→supported" case rule 1 allows.
fn base_locks_capability(base: &CapabilityProfile, capability: &str) -> bool {
    base.get(capability).is_some_and(|e| {
        e.criticality == Criticality::SafetyCritical || e.outcome != CapabilityOutcome::Fail
    })
}

/// Compose a target's base capability profile + tool map with a flattened set of provider
/// fragments, applying the §5.2 merge/safety rules:
///
/// 1. A provider may only add a capability absent from the base, or raise a base `fail`→supported.
/// 2. A provider may never weaken a safety-critical base capability, nor redefine one the base
///    already provides (see `base_locks_capability`).
/// 3. At most one source (base excluded) per capability key, across both maps — a collision
///    between two fragments is a loud-fail, deterministic and order-independent (tracked via a
///    single `claimed` map keyed by capability, spanning both `capabilities` and `tools`, since
///    end-to-end ownership requires attributing both to the same source). Ownership identity is
///    the loaded fragment's *index*, never its self-declared `provider` string — that string is
///    caller-suppliable, so two fragments sharing one string are still distinct owners and collide.
/// 4. A provider that declares a `tools` entry for a capability must have that capability's
///    profile entry available (from the base, or from this same fragment) by the time its tool
///    entry is processed. **Scoping note:** only this forward direction is enforced — the reverse
///    ("every capability that's supposed to be callable must have a tool binding") would require a
///    capability-vocabulary registry telling us which capabilities are meant to be callable, which
///    is deliberately out of scope here. A capability with a profile entry but no
///    tool binding is simply not a callable action (the same as most base substrate capabilities
///    today), and is not flagged.
/// 5. Unprovided required capabilities still fall through to `unknown_capability_entry()` in
///    `resolve.rs`, unchanged.
///
/// Fragments whose `engine` doesn't match `target_id`'s engine (`"vercel"`) are rejected. Fragments
/// whose `mode` doesn't match `target_id`'s mode are silently skipped (they simply don't apply to
/// this dispatch, not an error).
pub fn compose_target(
    base_profile: CapabilityProfile,
    base_tool_map: ToolMap,
    providers: &[ProviderFragment],
    target_id: TargetId,
) -> Result<ComposedTarget, DispatchError> {
    const ENGINE: &str = "vercel";

    let base_profile_snapshot = base_profile.clone();
    let base_tool_map_snapshot = base_tool_map.clone();
    let mut profile = base_profile;
    let mut tool_map = base_tool_map;
    // Ownership (rule 3) is keyed by the *loaded fragment's index*, never by its self-declared
    // `provider` string — that string is caller-suppliable from the fragment file, so two distinct
    // fragments could both claim `provider: "wren"` and, keyed by string, silently NOT collide
    // (the second would overwrite the first via the unconditional insert below, letting a spoofed
    // fragment hijack a legitimate capability's tool source, load-order-dependently). The index is
    // the fragment's true identity; the `provider` string is provenance/error text only. A single
    // fragment claiming the same key in both its `capabilities` and `tools` maps is fine (idx == idx).
    let mut claimed: HashMap<String, usize> = HashMap::new();

    for (idx, fragment) in providers.iter().enumerate() {
        if fragment.engine != ENGINE {
            return Err(DispatchError::new(format!(
                "provider '{}': engine '{}' does not match target engine '{ENGINE}'",
                fragment.provider, fragment.engine
            )));
        }
        if let Some(fragment_mode) = fragment.mode.as_deref() {
            if fragment_mode != target_id.mode() {
                continue;
            }
        }

        for (capability, spec) in &fragment.capabilities {
            if base_locks_capability(&base_profile_snapshot, capability) {
                return Err(DispatchError::new(format!(
                    "provider '{}': capability '{capability}' is already provided by the base target and cannot be redefined",
                    fragment.provider
                )));
            }
            claim_capability(&mut claimed, providers, capability, idx, fragment)?;
            profile.insert(capability.clone(), spec.clone().into());
        }

        for (capability, spec) in &fragment.tools {
            validate_source_grammar(&fragment.provider, capability, &spec.source)?;
            validate_via_source_coherence(
                &fragment.provider,
                capability,
                profile.get(capability).and_then(|e| e.via.as_deref()),
                &spec.source,
            )?;
            // Rule 2 applies to a tool binding exactly as it does to a profile entry: a capability
            // the base already owns (locked — safety-critical, or already resolving to something
            // usable) must not be redefined by a provider, whether or not the base happens to expose
            // a tool for it today. Checking only `base_tool_map_snapshot` here would let a provider
            // attach a brand-new tool to e.g. `write_authz` or `human_approval` — capabilities the
            // base owns in its profile but doesn't currently bind a tool to.
            if base_locks_capability(&base_profile_snapshot, capability)
                || base_tool_map_snapshot.contains_key(capability)
            {
                return Err(DispatchError::new(format!(
                    "provider '{}': tool binding for '{capability}' is already provided by the base target and cannot be redefined",
                    fragment.provider
                )));
            }
            claim_capability(&mut claimed, providers, capability, idx, fragment)?;
            if !profile.contains_key(capability) {
                return Err(DispatchError::new(format!(
                    "provider '{}': tool binding for '{capability}' has no corresponding capability profile entry (from the base or this provider)",
                    fragment.provider
                )));
            }
            tool_map.insert(capability.clone(), spec.clone().into());
        }
    }

    Ok(ComposedTarget { profile, tool_map })
}

/// Record that fragment `idx` claims `capability`, or loud-fail if a *different* fragment already
/// claimed it (rule 3: at most one provider-source per capability key, deterministic and
/// order-independent). Ownership is keyed by fragment index — two fragments with the same
/// self-declared `provider` string are still distinct owners and collide here. The same fragment
/// re-claiming its own key (once from `capabilities`, once from `tools`) is a no-op.
fn claim_capability(
    claimed: &mut HashMap<String, usize>,
    providers: &[ProviderFragment],
    capability: &str,
    idx: usize,
    fragment: &ProviderFragment,
) -> Result<(), DispatchError> {
    match claimed.get(capability) {
        Some(&owner_idx) if owner_idx != idx => Err(DispatchError::new(format!(
            "capability '{capability}' is claimed by both provider '{}' and provider '{}' — at most one provider source per capability",
            providers[owner_idx].provider, fragment.provider
        ))),
        Some(_) => Ok(()),
        None => {
            claimed.insert(capability.to_string(), idx);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::targets::TargetId;
    use crate::tools::base_tool_map;

    fn fragment(
        provider: &str,
        capabilities: &[(&str, ProfileEntrySpec)],
        tools: &[(&str, ToolBindingSpec)],
    ) -> ProviderFragment {
        ProviderFragment {
            fragment_version: "0.1".to_string(),
            provider: provider.to_string(),
            engine: "vercel".to_string(),
            mode: None,
            capabilities: capabilities
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
            tools: tools
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        }
    }

    fn native_entry(via: &str) -> ProfileEntrySpec {
        ProfileEntrySpec {
            outcome: CapabilityOutcome::Native,
            via: Some(via.to_string()),
            provided_by: ProvidedBy::Runtime,
            criticality: Criticality::Required,
            note: None,
        }
    }

    fn tool(name: &str, source: &str) -> ToolBindingSpec {
        ToolBindingSpec {
            name: name.to_string(),
            source: source.to_string(),
        }
    }

    /// Regression test for the bug the local review round caught: a provider must not be able to
    /// attach a *tool binding* to a capability the base already owns in its *profile*
    /// (`write_authz`, safety-critical), even though base has no tool entry for that capability —
    /// only the `capabilities` loop rejected this before the fix; the `tools` loop let it through.
    #[test]
    fn provider_tool_binding_cannot_target_a_base_owned_safety_critical_capability() {
        let frag = fragment(
            "malicious",
            &[],
            &[("write_authz", tool("escalate_privileges", "native"))],
        );
        let result = compose_target(
            TargetId::Headless.profile(),
            base_tool_map(),
            &[frag],
            TargetId::Headless,
        );
        assert!(
            result.is_err(),
            "a provider tool binding must not override a base-locked capability's tool, even \
             when base itself has no tool entry for that capability"
        );
    }

    /// Same regression, `human_approval` (safety-critical, `Fail` outcome — locked unconditionally
    /// regardless of outcome per `base_locks_capability`'s safety-critical branch).
    #[test]
    fn provider_tool_binding_cannot_target_human_approval() {
        let frag = fragment(
            "malicious",
            &[],
            &[("human_approval", tool("fake_approve", "native"))],
        );
        let result = compose_target(
            TargetId::Headless.profile(),
            base_tool_map(),
            &[frag],
            TargetId::Headless,
        );
        assert!(
            result.is_err(),
            "human_approval is safety-critical and locked unconditionally; a provider tool \
             binding must not be able to attach to it"
        );
    }

    /// A provider may still add a genuinely new capability (absent from base) and its tool.
    #[test]
    fn provider_can_add_a_new_domain_capability_and_tool() {
        let frag = fragment(
            "sample",
            &[("semantic_introspection", native_entry("mcp:sample"))],
            &[(
                "semantic_introspection",
                tool("semantic_introspect", "mcp:sample/semantic_introspect"),
            )],
        );
        let composed = compose_target(
            TargetId::Headless.profile(),
            base_tool_map(),
            &[frag],
            TargetId::Headless,
        )
        .expect("adding an absent capability + its tool should succeed");
        assert!(composed.profile.contains_key("semantic_introspection"));
        assert!(composed.tool_map.contains_key("semantic_introspection"));
    }

    /// Two providers claiming the same new capability (whether via `capabilities` or `tools`) is a
    /// loud-fail — at most one provider-source per capability key.
    #[test]
    fn two_providers_claiming_the_same_capability_is_rejected() {
        let a = fragment(
            "provider_a",
            &[("semantic_introspection", native_entry("mcp:a"))],
            &[],
        );
        let b = fragment(
            "provider_b",
            &[("semantic_introspection", native_entry("mcp:b"))],
            &[],
        );
        let result = compose_target(
            TargetId::Headless.profile(),
            base_tool_map(),
            &[a, b],
            TargetId::Headless,
        );
        assert!(
            result.is_err(),
            "two providers claiming the same capability key must be rejected"
        );
    }

    /// Regression: ownership is keyed by the loaded fragment's index, NOT its self-declared
    /// `provider` string (which is caller-suppliable). Two fragments both claiming
    /// `provider: "wren"` for the same capability, with different tool sources, must still collide
    /// and loud-fail — otherwise the second would silently overwrite the first (hijacking the tool
    /// source, load-order-dependently). Before this fix, string-keyed ownership let this through.
    #[test]
    fn same_provider_string_on_two_fragments_still_collides() {
        let legit = fragment(
            "acme",
            &[("sql_execution:read_only", native_entry("mcp:legit"))],
            &[("sql_execution:read_only", tool("query", "mcp:legit/query"))],
        );
        let spoof = fragment(
            "acme",
            &[("sql_execution:read_only", native_entry("mcp:evil"))],
            &[("sql_execution:read_only", tool("query", "mcp:evil/query"))],
        );
        let result = compose_target(
            TargetId::Headless.profile(),
            base_tool_map(),
            &[legit, spoof],
            TargetId::Headless,
        );
        assert!(
            result.is_err(),
            "two fragments sharing a spoofed provider string must still collide on a shared \
             capability key — ownership is keyed by fragment identity, not the provider string"
        );
    }

    /// Coherence, positive case: a `mcp:<server>/<tool>` source whose capability's `via` names the
    /// same server composes cleanly.
    #[test]
    fn coherent_via_and_source_compose_cleanly() {
        let frag = fragment(
            "sample",
            &[("sql_execution:read_only", native_entry("mcp:sample"))],
            &[("sql_execution:read_only", tool("query", "mcp:sample/query"))],
        );
        let composed = compose_target(
            TargetId::Headless.profile(),
            base_tool_map(),
            &[frag],
            TargetId::Headless,
        )
        .expect("via 'mcp:sample' matching source 'mcp:sample/query' should compose cleanly");
        assert!(composed.tool_map.contains_key("sql_execution:read_only"));
    }

    /// Coherence, negative case: a `mcp:<server>/<tool>` source disagreeing with the capability's
    /// `via` (different server) is a loud-fail — the resolution report and the tool binding must
    /// not name different backing servers.
    #[test]
    fn incoherent_via_and_source_is_rejected() {
        let frag = fragment(
            "sample",
            &[("sql_execution:read_only", native_entry("mcp:other"))],
            &[("sql_execution:read_only", tool("query", "mcp:sample/query"))],
        );
        let result = compose_target(
            TargetId::Headless.profile(),
            base_tool_map(),
            &[frag],
            TargetId::Headless,
        );
        assert!(
            result.is_err(),
            "a tool source naming server 'sample' with via naming 'other' must be rejected as \
             incoherent"
        );
    }

    /// An empty `source` string is not a valid bare mechanism label — it must be rejected rather
    /// than silently accepted (it contains neither `:` nor `/`, so the bare-label branch alone
    /// would otherwise let it through).
    #[test]
    fn empty_tool_source_is_rejected() {
        let frag = fragment(
            "sample",
            &[("semantic_introspection", native_entry("mcp:sample"))],
            &[("semantic_introspection", tool("semantic_introspect", ""))],
        );
        let result = compose_target(
            TargetId::Headless.profile(),
            base_tool_map(),
            &[frag],
            TargetId::Headless,
        );
        assert!(
            result.is_err(),
            "an empty tool source must be rejected as a malformed bare mechanism label"
        );
    }

    /// A `tools` entry with no corresponding profile entry (from base or this fragment) is
    /// rejected — a tool binding must always have a capability to hang off of.
    #[test]
    fn tool_binding_without_a_profile_entry_is_rejected() {
        let frag = fragment(
            "sample",
            &[],
            &[(
                "semantic_introspection",
                tool("semantic_introspect", "mcp:sample/semantic_introspect"),
            )],
        );
        let result = compose_target(
            TargetId::Headless.profile(),
            base_tool_map(),
            &[frag],
            TargetId::Headless,
        );
        assert!(
            result.is_err(),
            "a tool binding with no capability profile entry (base or provider) must be rejected"
        );
    }
}
