//! Normalize concise authoring into the existing component/mount model, before compilation.
use serde::Deserialize;
use serde_yaml::Value;
use std::collections::{HashMap, HashSet};
use warble::{ComponentFile, ProfileFile};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SimpleComponent {
    id: String,
    prompt: String,
    #[serde(default = "cheap")]
    tier: String,
    #[serde(default)]
    description: Option<String>,
}
fn cheap() -> String {
    "cheap".into()
}

pub(crate) fn parse_component(value: Value) -> Result<ComponentFile, String> {
    if value.get("prompt").is_none() {
        return serde_yaml::from_value(value).map_err(|e| e.to_string());
    }
    let simple: SimpleComponent = serde_yaml::from_value(value).map_err(|e| e.to_string())?;
    if !simple
        .id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(
            "simple component id must contain only letters, digits, underscores or hyphens".into(),
        );
    }
    if simple.id.trim().is_empty()
        || simple.prompt.trim().is_empty()
        || simple.tier.trim().is_empty()
    {
        return Err("simple component id, prompt and tier must be non-empty".into());
    }
    // No data/write tools, effects, arbitrary classification or guardrail inference in this shorthand.
    // An author needing those uses the existing full component shape, inline or extracted.
    serde_json::from_value(serde_json::json!({
        "id": simple.id, "verb": simple.id, "description": simple.description,
        "type": "analytical", "realization_kind": "skill", "binding_mode": "runtime_selected",
        "llm_steps": [{"name": "respond", "tier": simple.tier, "prompt": simple.prompt}],
        "trigger": {"kind": "one_shot"},
        "guardrails": [{"name": "read_only_execution", "locked": true}],
        "required_capabilities": [format!("llm:{}", simple.tier)],
        "effect": {"render_blocks": [], "outcome": {"kind": "none"}}
    }))
    .map_err(|e| e.to_string())
}

pub(crate) fn parse_profile(
    text: &str,
) -> Result<(ProfileFile, HashMap<String, ComponentFile>), String> {
    let mut value: Value = serde_yaml::from_str(text).map_err(|e| e.to_string())?;
    let entries = value
        .get_mut("components")
        .and_then(Value::as_sequence_mut)
        .ok_or("profile components must be a list")?;
    let mut inline = HashMap::new();
    let mut ids = HashSet::new();
    for (index, entry) in entries.iter_mut().enumerate() {
        let id = if let Some(id) = entry.get("use") {
            if entry.get("id").is_some()
                || entry.get("prompt").is_some()
                || entry.get("llm_steps").is_some()
            {
                return Err(
                    "component entry cannot combine a use mount with an inline definition".into(),
                );
            }
            id.as_str()
                .ok_or("component use must be a string")?
                .to_string()
        } else {
            for key in ["entrypoint", "bind", "config", "tier_overrides"] {
                if entry.get(key).is_some() {
                    return Err(format!("inline component cannot declare mount field '{key}'; extract it and use a mount"));
                }
            }
            let component =
                parse_component(entry.clone()).map_err(|e| format!("components[{index}]: {e}"))?;
            let id = component.id.clone();
            inline.insert(id.clone(), component);
            *entry =
                serde_yaml::to_value(serde_json::json!({"use": id})).map_err(|e| e.to_string())?;
            id
        };
        if id.trim().is_empty() || !ids.insert(id.clone()) {
            return Err(format!(
                "component id '{id}' must be non-empty and mounted only once"
            ));
        }
    }
    let profile = serde_yaml::from_value(value).map_err(|e| e.to_string())?;
    Ok((profile, inline))
}
