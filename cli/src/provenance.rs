//! Local author origins. These are explanatory metadata, never a second prompt renderer or IR.
use serde::Serialize;
use std::path::Path;
use warble::{ComponentFile, ProfileComponentMount, ProfileFile, SlotDecl};

#[derive(Debug, Clone, Serialize)]
pub struct AuthorSource {
    pub component: Option<String>,
    pub file: String,
    pub field: String,
    pub role: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_variant: Option<String>,
}

fn source(
    component: Option<&str>,
    file: &Path,
    field: &str,
    role: &str,
    status: &str,
) -> AuthorSource {
    AuthorSource {
        component: component.map(str::to_string),
        file: file.display().to_string(),
        field: field.into(),
        role: role.into(),
        status: status.into(),
        slot: None,
        variant: None,
        default_variant: None,
    }
}

fn slots(
    decls: &[SlotDecl],
    component: Option<&str>,
    base: &Path,
    prefix: &str,
    out: &mut Vec<AuthorSource>,
) {
    for slot in decls {
        let mut variants: Vec<_> = slot.variants.iter().collect();
        variants.sort_by_key(|(key, _)| *key);
        for (key, reference) in variants {
            let mut item = source(
                component,
                &base.join(reference),
                &format!("{prefix}slots[{}].variants.{key}", slot.name),
                "slot variant",
                "unselected",
            );
            item.slot = Some(slot.name.clone());
            item.variant = Some(key.clone());
            item.default_variant = Some(slot.default.clone());
            out.push(item);
        }
    }
}

pub(crate) fn profile_sources(profile: &ProfileFile, file: &Path, out: &mut Vec<AuthorSource>) {
    if profile.system_prompt.is_some() {
        out.push(source(
            None,
            file,
            "system_prompt",
            "common instructions",
            "appended before effective component brief",
        ));
    }
    slots(&profile.slots, None, file.parent().unwrap(), "", out);
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn component_sources(
    profile: &ProfileFile,
    mount: &ProfileComponentMount,
    component: &ComponentFile,
    profile_path: &Path,
    component_dir: &Path,
    inline: bool,
    shorthand: bool,
    out: &mut Vec<AuthorSource>,
) {
    let index = profile
        .components
        .iter()
        .position(|m| m.use_id == mount.use_id)
        .unwrap();
    let mount_field = format!("components[{index}]");
    let component_file = if inline {
        profile_path.to_path_buf()
    } else {
        component_dir.join("component.yml")
    };
    let prefix = if inline {
        format!("{mount_field}.")
    } else {
        String::new()
    };
    let id = Some(component.id.as_str());
    // The full origin is useful even when compile fails for a field other than prompt text.
    out.push(source(
        id,
        &component_file,
        &prefix,
        "component declaration",
        "declared",
    ));
    if component.brief.is_some() {
        out.push(source(
            id,
            &component_file,
            &format!("{prefix}brief"),
            "component brief",
            if mount.brief.is_some() {
                "replaced by mount brief; not emitted"
            } else {
                "effective"
            },
        ));
    }
    if mount.brief.is_some() {
        out.push(source(
            id,
            profile_path,
            &format!("{mount_field}.brief"),
            "mount brief",
            "replaces component brief wholesale",
        ));
    }
    for (i, step) in component.llm_steps.iter().enumerate() {
        let file = step
            .prompt_ref
            .as_ref()
            .map(|p| component_dir.join(p))
            .unwrap_or_else(|| component_file.clone());
        let field = if shorthand {
            format!("{prefix}prompt")
        } else {
            format!(
                "{prefix}llm_steps[{i}].{}",
                if step.prompt_ref.is_some() {
                    "prompt_ref"
                } else {
                    "prompt"
                }
            )
        };
        out.push(source(
            id,
            &file,
            &field,
            "step prompt",
            "effective; placement belongs to target",
        ));
    }
    slots(&component.slots, id, component_dir, &prefix, out);
}

/// The author commands use a closed top-level vocabulary. YAML diagnostics expose location,
/// not the parsed scalar value; credential-like unsupported values are never echoed.
pub fn validate_profile_fields(text: &str, file: &Path) -> Result<(), String> {
    let value: serde_yaml::Value = serde_yaml::from_str(text).map_err(|e| {
        format!(
            "{}: invalid YAML at {}; fix the YAML syntax (values omitted)",
            file.display(),
            e.location()
                .map(|p| format!("line {}, column {}", p.line(), p.column()))
                .unwrap_or_else(|| "unknown location".into())
        )
    })?;
    let root = value
        .as_mapping()
        .ok_or_else(|| format!("{}: profile must be a mapping", file.display()))?;
    for key in root.keys() {
        if !matches!(
            key.as_str(),
            Some("profile" | "context" | "components" | "system_prompt" | "slots" | "config")
        ) {
            return Err(format!(
                "{}: unknown profile field {}; use the documented profile fields",
                file.display(),
                key.as_str().unwrap_or("<non-string>")
            ));
        }
    }
    if let Some(config) = value.get("config").and_then(serde_yaml::Value::as_mapping) {
        for key in config.keys() {
            if key.as_str() != Some("capability_ceiling") {
                return Err(format!(
                    "{}#config: unknown field {}; only capability_ceiling is supported",
                    file.display(),
                    key.as_str().unwrap_or("<non-string>")
                ));
            }
        }
    }
    Ok(())
}
