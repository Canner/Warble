//! Separate bounded hybrid launch artifact. This does not extend native Sessions v5.
use crate::DispatchError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, path::Path};

fn fail() -> DispatchError {
    DispatchError::new("unsupported pi:hybrid IR or launch configuration")
}
fn empty(v: &Value) -> bool {
    v.as_array().is_some_and(Vec::is_empty)
}
fn identifier(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 128
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
    })
}
/// Validate the executable subset before creating any output. Runtime repeats admission.
pub fn validate_hybrid_ir(ir: &Value, entry: &str) -> Result<(), DispatchError> {
    if ir["warble_ir_version"] != "0.9"
        || ir.get("slots").is_some_and(|v| !empty(v))
        || ir
            .get("config")
            .is_some_and(|v| !v.as_object().is_some_and(|o| o.is_empty()))
    {
        return Err(fail());
    }
    let nodes = ir["components"].as_array().ok_or_else(fail)?;
    let mut ids = HashSet::new();
    for c in nodes {
        if !identifier(&c["id"]) || !ids.insert(c["id"].as_str().ok_or_else(fail)?) {
            return Err(fail());
        }
    }
    let root = nodes.iter().find(|c| c["id"] == entry).ok_or_else(fail)?;
    validate_node(root, true)?;
    let calls = root["llm_calls"][0]["component_calls"]
        .as_array()
        .ok_or_else(fail)?;
    if calls.is_empty()
        || !root["required_capabilities"]
            .as_array()
            .ok_or_else(fail)?
            .contains(&json!("component_invocation"))
    {
        return Err(fail());
    }
    let mut aliases = HashSet::new();
    for edge in calls {
        if edge.as_object().is_none_or(|o| o.len() != 2)
            || !identifier(&edge["alias"])
            || !aliases.insert(edge["alias"].as_str().ok_or_else(fail)?)
        {
            return Err(fail());
        }
        let child = nodes
            .iter()
            .find(|c| c["id"] == edge["component"])
            .ok_or_else(fail)?;
        validate_node(child, false)?;
    }
    Ok(())
}
fn validate_node(c: &Value, root: bool) -> Result<(), DispatchError> {
    if c["entrypoint"] != root
        || c["realization_kind"] != "skill"
        || c["type"] != "analytical"
        || c["trigger"]["kind"] != "one_shot"
        || c["effect"]["outcome"]["kind"] != "none"
        || !empty(&c["effect"]["render_blocks"])
        || !empty(&c["context_precondition"])
        || !empty(&c["context_requirements"])
        || !empty(&c["params"])
        || c["precondition_result"]["status"] != "pass"
        || !empty(&c["precondition_result"]["checks"])
        || c.get("slots").is_some_and(|v| !empty(v))
    {
        return Err(fail());
    }
    let guards = c["guardrails"].as_array().ok_or_else(fail)?;
    if guards.iter().any(|g| {
        g["name"] != "read_only_execution"
            || g["locked"] != true
            || g.as_object().is_none_or(|o| o.len() != 2)
    }) {
        return Err(fail());
    }
    let steps = c["llm_calls"].as_array().ok_or_else(fail)?;
    if steps.len() != 1 {
        return Err(fail());
    }
    let s = &steps[0];
    if !identifier(&s["name"])
        || !matches!(s["tier"].as_str(), Some("cheap" | "strong"))
        || !s["prompt"].is_string()
        || s["conditional"] != false
        || !s.get("when").is_some_and(Value::is_null)
        || !s.get("produces").is_some_and(Value::is_null)
        || !empty(&s["consumes"])
        || s.as_object().ok_or_else(fail)?.keys().any(|k| {
            ![
                "name",
                "tier",
                "prompt",
                "conditional",
                "when",
                "consumes",
                "produces",
                "component_calls",
            ]
            .contains(&k.as_str())
        })
        || !root && s.get("component_calls").is_some_and(|v| !empty(v))
    {
        return Err(fail());
    }
    let caps = c["required_capabilities"].as_array().ok_or_else(fail)?;
    let actions = c["borrowed_actions"].as_array().ok_or_else(fail)?;
    let llm = format!("llm:{}", s["tier"].as_str().ok_or_else(fail)?);
    if !caps.contains(&json!(llm))
        || caps.iter().any(|v| {
            v.as_str().is_none_or(|v| {
                (v.starts_with("llm:") && v != llm)
                    || (root && v != llm && v != "component_invocation")
            })
        })
        || actions.iter().any(|v| !identifier(v))
        || root && !actions.is_empty()
        || caps.iter().collect::<HashSet<_>>().len() != caps.len()
        || actions.iter().collect::<HashSet<_>>().len() != actions.len()
    {
        return Err(fail());
    }
    Ok(())
}
/// Emit a new private directory; credentials are references, never resolved by dispatch.
pub fn emit_pi_hybrid(ir_text: &str, config_text: &str, out: &Path) -> Result<(), DispatchError> {
    if ir_text.len() > 4 * 1048576 || config_text.len() > 4 * 1048576 {
        return Err(fail());
    }
    let ir: Value = serde_json::from_str(ir_text).map_err(|_| fail())?;
    let config: Value = serde_json::from_str(config_text).map_err(|_| fail())?;
    if config["format"] != "warble-pi-hybrid-config/1" {
        return Err(fail());
    }
    validate_hybrid_ir(&ir, config["entry"].as_str().ok_or_else(fail)?)?;
    validate_config(&config, &ir)?;
    let adapter = Path::new(config["adapter"]["path"].as_str().ok_or_else(fail)?);
    if !adapter.is_absolute() {
        return Err(fail());
    }
    let bytes = fs::read(adapter).map_err(|_| fail())?;
    if bytes.len() > 1048576
        || format!("{:x}", Sha256::digest(&bytes))
            != config["adapter"]["sha256"].as_str().ok_or_else(fail)?
    {
        return Err(fail());
    }
    let bundle = json!({"format":"warble-pi-hybrid/1", "runtimeVersion":env!("CARGO_PKG_VERSION"),
        "piVersion":"1.0.4", "ir":ir, "config":config});
    let bytes = serde_json::to_vec_pretty(&bundle).map_err(|_| fail())?;
    if bytes.len() > 4 * 1048576 {
        return Err(fail());
    }
    // create_dir fails on an existing directory, file or symlink. Never overwrite prior output.
    fs::create_dir(out).map_err(|_| {
        DispatchError::new("pi:hybrid requires a new output directory with an existing parent")
    })?;
    let result = (|| -> std::io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(out, fs::Permissions::from_mode(0o700))?;
        }
        fs::write(out.join("launch.json"), &bytes)?;
        fs::write(
            out.join("launch.sha256"),
            format!("{:x}\n", Sha256::digest(&bytes)),
        )?;
        fs::write(out.join("RUN.md"), "Launch with the matching @warble/pi package version:\n\nnode /absolute/path/to/dispatcher/pi/dist/cli.js launch /absolute/path/to/this-directory\n\nThis is the limited pi hybrid TUI, not stock pi InteractiveMode. Only explicitly configured credentials are read. Already-sent data cannot be recalled.\n")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(out);
        return Err(DispatchError::new("pi:hybrid output failed"));
    }
    Ok(())
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    format: String,
    entry: String,
    policy: String,
    adapter: Adapter,
    selections: std::collections::HashMap<String, Selection>,
    models: std::collections::HashMap<String, Model>,
    projects: std::collections::HashMap<String, Project>,
    defaults: Defaults,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Adapter {
    path: String,
    sha256: String,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Model {
    zone: String,
    deployment: String,
    api: String,
    model: String,
    base_url: String,
    credential_env: String,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Project {
    private_models: std::collections::HashMap<String, std::collections::HashMap<String, Model>>,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Defaults {
    policy: String,
    model: String,
    project: String,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Selection {
    metadata: Vec<Metadata>,
    approved_answers: bool,
    components: Vec<String>,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    kind: String,
    documents: Value,
}
fn validate_config(config: &Value, ir: &Value) -> Result<(), DispatchError> {
    let c: Config = serde_json::from_value(config.clone()).map_err(|_| fail())?;
    let valid_id = |s: &str| identifier(&json!(s));
    if c.format != "warble-pi-hybrid-config/1"
        || !valid_id(&c.entry)
        || c.policy.len() > 65536
        || !Path::new(&c.adapter.path).is_absolute()
        || c.adapter.sha256.len() != 64
        || !c
            .adapter
            .sha256
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || c.selections.is_empty()
        || c.models.is_empty()
        || c.projects.is_empty()
        || c.selections.len() > 64
        || c.models.len() > 64
        || c.projects.len() > 64
        || !c.selections.contains_key(&c.defaults.policy)
        || !c.models.contains_key(&c.defaults.model)
        || !c.projects.contains_key(&c.defaults.project)
    {
        return Err(fail());
    }
    for (id, s) in &c.selections {
        let _ = s.approved_answers;
        if !valid_id(id)
            || s.components.len() > 128
            || s.metadata.len() > 128
            || !s.components.iter().all(|v| valid_id(v))
        {
            return Err(fail());
        }
        for m in &s.metadata {
            if ![
                "schema.structure",
                "schema.descriptions",
                "mdl.expressions",
                "knowledge.rules",
                "knowledge.sql",
                "data.samples",
                "data.raw",
            ]
            .contains(&m.kind.as_str())
                || !(m.documents == "*"
                    || m.documents
                        .as_array()
                        .is_some_and(|a| a.len() <= 128 && a.iter().all(identifier)))
            {
                return Err(fail());
            }
        }
    }
    let model = |m: &Model, zone: &str| -> Result<(), DispatchError> {
        let url = url::Url::parse(&m.base_url).map_err(|_| fail())?;
        if m.zone != zone
            || !valid_id(&m.deployment)
            || m.model.is_empty()
            || m.model.len() > 256
            || !["openai-completions", "anthropic-messages"].contains(&m.api.as_str())
            || zone == "private" && m.api != "openai-completions"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !(url.scheme() == "https"
                || url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "[::1]")))
            || m.credential_env.is_empty()
            || m.credential_env.len() > 128
            || !m.credential_env.as_bytes()[0].is_ascii_uppercase()
            || !m
                .credential_env
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        {
            return Err(fail());
        }
        Ok(())
    };
    for (id, m) in &c.models {
        if !valid_id(id) {
            return Err(fail());
        }
        model(m, "public")?;
    }
    let nodes = ir["components"].as_array().ok_or_else(fail)?;
    let root = nodes.iter().find(|n| n["id"] == c.entry).ok_or_else(fail)?;
    let calls = root["llm_calls"][0]["component_calls"]
        .as_array()
        .ok_or_else(fail)?;
    for (id, p) in &c.projects {
        if !valid_id(id)
            || p.private_models
                .keys()
                .any(|id| !calls.iter().any(|e| e["component"] == *id))
        {
            return Err(fail());
        }
        for edge in calls {
            let child = nodes
                .iter()
                .find(|n| n["id"] == edge["component"])
                .ok_or_else(fail)?;
            let tiers = p
                .private_models
                .get(child["id"].as_str().ok_or_else(fail)?)
                .ok_or_else(fail)?;
            if tiers.len() != 1 {
                return Err(fail());
            }
            model(
                tiers
                    .get(child["llm_calls"][0]["tier"].as_str().ok_or_else(fail)?)
                    .ok_or_else(fail)?,
                "private",
            )?;
        }
    }
    Ok(())
}
