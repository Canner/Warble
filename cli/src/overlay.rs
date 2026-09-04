//! A patch applied to a parsed `profile.yml` before the compiler ever sees it.
//!
//! # Why this is not a compile stage
//!
//! A host that serves many accounts from one set of behaviors needs the same profile bound
//! differently per account: a different set of mounted behaviors, different values supplied to
//! them, a different charter. An overlay is that difference, expressed as a patch.
//!
//! It is applied **here**, to the deserialized [`ProfileFile`], before `warble::compile` is
//! called. That placement is what keeps the mechanism small:
//!
//! - `compile`'s signature is untouched, and the compiler holds no notion of an overlay;
//! - the compiler stays sans-IO — this module reads the patch file, as the host layer should;
//! - **every existing compile-time check applies to the patched profile for free.** In
//!   particular the capability ceiling is enforced per mount, so a patch that mounts a behavior
//!   requiring something the profile does not permit is refused without any ordering rule having
//!   to be arranged. The same holds for slot declarations, context preconditions and required
//!   binds.
//!
//! # What a patch may touch, and why so little
//!
//! Which behaviors are mounted, the values bound to them, and which charter the profile uses.
//! Nothing else — not a mounted behavior's internals, its steps, or its capabilities.
//!
//! Everything on that list is already expressible on a profile mount, so the patch adds an entry
//! point rather than new expressive power. That is deliberate: a deployment that could rewrite
//! what a behavior declares it needs would make the declaration meaningless, since the same
//! behavior would claim different requirements per deployment. Differences in what a runtime can
//! actually provide are expressed by target profiles and provider fragments instead, where an
//! unmet need surfaces as a degrade or a loud failure.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;
use warble::{ProfileComponentMount, ProfileFile};

/// The only document format version this build understands.
const SUPPORTED_OVERLAY_VERSION: u32 = 1;

/// A parsed overlay document.
///
/// `deny_unknown_fields` is load-bearing rather than tidiness: it is what makes an unsupported
/// key a loud failure instead of a patch that silently does less than it appears to. Someone
/// reasonably assuming that, say, a tier override belongs here finds out immediately.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OverlayFile {
    /// Version of this document format. Unrelated to `warble_ir_version` — an overlay adds no IR
    /// field, so it never moves the IR line and is deliberately not part of that lockstep.
    pub overlay: u32,
    /// Replaces the profile's charter wholesale.
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Behaviors to add.
    #[serde(default)]
    pub mount: Vec<OverlayMount>,
    /// Behaviors to remove, by id.
    #[serde(default)]
    pub unmount: Vec<String>,
    /// Values to change on an already-mounted behavior, keyed by its id. Merged key by key into
    /// whatever the base profile supplied, so changing one value cannot silently drop the others
    /// — including a value the component declares as required.
    #[serde(default)]
    pub bind: HashMap<String, HashMap<String, serde_yaml::Value>>,
}

/// One `mount:` entry — a behavior to add, with the values it should be bound with.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OverlayMount {
    #[serde(rename = "use")]
    pub use_id: String,
    #[serde(default)]
    pub bind: Option<HashMap<String, serde_yaml::Value>>,
}

/// Reads and parses an overlay document.
pub fn read_overlay(path: &Path) -> Result<OverlayFile, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("failed to read overlay {}: {e}", path.display()))?;
    let overlay: OverlayFile = serde_yaml::from_str(&raw)
        .map_err(|e| format!("failed to parse overlay {}: {e}", path.display()))?;
    if overlay.overlay != SUPPORTED_OVERLAY_VERSION {
        return Err(format!(
            "overlay {} declares format version {}, which this build does not understand \
             (supported: {SUPPORTED_OVERLAY_VERSION})",
            path.display(),
            overlay.overlay
        ));
    }
    Ok(overlay)
}

/// Applies an overlay to a parsed profile, in place.
///
/// Every ambiguous request is refused rather than resolved by a rule nobody asked for. Silently
/// doing something defensible is worse than refusing here, because the author of a patch is
/// typically not the author of the profile it patches: they cannot see the base to notice that
/// their intent was reinterpreted.
pub fn apply_overlay(profile: &mut ProfileFile, overlay: &OverlayFile) -> Result<(), String> {
    // Checked before anything is applied, so a contradictory patch changes nothing at all rather
    // than half of what it asked for.
    for entry in &overlay.mount {
        if overlay.unmount.contains(&entry.use_id) {
            return Err(format!(
                "overlay both mounts and unmounts '{}' — the intent is contradictory, so it is \
                 refused rather than resolved in one direction",
                entry.use_id
            ));
        }
    }
    let mut seen: Vec<&str> = Vec::with_capacity(overlay.mount.len());
    for entry in &overlay.mount {
        if seen.contains(&entry.use_id.as_str()) {
            return Err(format!(
                "overlay mounts '{}' more than once — taking the last would silently discard the \
                 other entry's bind values",
                entry.use_id
            ));
        }
        seen.push(&entry.use_id);
    }

    for id in &overlay.unmount {
        if !profile.components.iter().any(|m| &m.use_id == id) {
            return Err(format!(
                "overlay unmounts '{id}', which the profile does not mount — a typo here would \
                 otherwise remove nothing while appearing to"
            ));
        }
    }
    for id in overlay.bind.keys() {
        if !profile.components.iter().any(|m| &m.use_id == id) {
            return Err(format!(
                "overlay binds values on '{id}', which the profile does not mount — to add it, \
                 use 'mount' with its bind values"
            ));
        }
    }
    for entry in &overlay.mount {
        if profile.components.iter().any(|m| m.use_id == entry.use_id) {
            return Err(format!(
                "overlay mounts '{}', which the profile already mounts — use 'bind' to change an \
                 existing mount's values",
                entry.use_id
            ));
        }
    }

    if let Some(system_prompt) = &overlay.system_prompt {
        profile.system_prompt = Some(system_prompt.clone());
    }

    profile
        .components
        .retain(|m| !overlay.unmount.contains(&m.use_id));

    for (id, values) in &overlay.bind {
        let mount = profile
            .components
            .iter_mut()
            .find(|m| &m.use_id == id)
            .expect("presence was checked above");
        let existing = mount.bind.get_or_insert_with(HashMap::new);
        for (key, value) in values {
            existing.insert(key.clone(), value.clone());
        }
    }

    for entry in &overlay.mount {
        profile.components.push(ProfileComponentMount {
            use_id: entry.use_id.clone(),
            config: None,
            bind: entry.bind.clone(),
            tier_overrides: None,
            realization_kind: None,
            guardrails: None,
            brief: None,
        });
    }

    // Last, because the count is only final once every add and remove has been applied.
    if profile.components.is_empty() {
        return Err(
            "overlay leaves the profile with no mounted behaviors, which is not a harness that \
             can be dispatched"
                .to_string(),
        );
    }
    Ok(())
}
