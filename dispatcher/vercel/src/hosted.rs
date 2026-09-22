//! Explicit host-owned component execution. This produces a plan, never runtime attestation.
//!
//! Format 0.2 deliberately has no legacy `agents` field. Every executable node keeps its full
//! validated IR declaration; derived tool projections never replace the step/call authority.

use crate::classify::classify_step;
use crate::emit::validate_ir_version;
use crate::error::DispatchError;
use crate::ir::{
    ComponentNode, ComponentType, OutcomeKind, RealizationKind, TriggerKind, WarbleIr,
};
use crate::provider::{compose_target, ProviderFragment};
use crate::resolve::resolve_capabilities;
use crate::targets::{CapabilityEntry, CapabilityOutcome, Criticality, ProvidedBy, TargetId};
use crate::tools::{base_tool_map, ToolMap, ToolRef};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub const HOSTED_BUNDLE_VERSION: &str = "0.2";
pub const HOST_PROTOCOL: &str = "warble-component-host/1";
pub const REQUIRED_FEATURES: &[&str] = &[
    "immutable_step_authority",
    "isolated_component_tools",
    "fresh_child_context",
    "verified_context_preconditions",
    "component_owned_bindings",
    "exact_step_tiers",
    "exact_dataflow",
    "bounded_repair",
    "shared_admission_ledger",
    "deadline_and_descendant_cancellation",
    "normalized_child_results",
    "root_only_persistence",
    "redacted_usage_trace",
];
const MAX_BYTES: usize = 4 * 1024 * 1024;
// Schema vocabulary only. Runtime truth is re-evaluated by the host's core verifier.
const PRECONDITIONS: &[&str] = &[
    "mdl_parseable",
    "has_metric",
    "has_queryable_dimension",
    "has_time_dimension",
    "has_groupable_dimension",
    "metric_additive",
    "model_has_timestamp",
    "lineage_resolvable",
    "wren_project_exists",
    "source_introspectable",
    "raw_docs_readable",
];

/// A closed implementation declaration supplied by the consuming host. It is not a credential,
/// signature, vendor certification, or permission grant. Runtime enforcement stays with the host.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HostContract {
    protocol: String,
    bundle_version: String,
    features: Vec<String>,
    /// Complete effective authority keyed by tool name, with its exact source checked as well.
    tool_authority: BTreeMap<String, ToolAuthority>,
    /// Guardrail vocabulary the host implements, including exact emitted parameters.
    guardrails: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolAuthority {
    source: String,
    capabilities: Vec<String>,
}

fn fail(message: &str) -> DispatchError {
    DispatchError::new(format!("hosted vercel: {message} (wall-hit)"))
}

fn keys(value: &Value, allowed: &[&str]) -> Result<(), DispatchError> {
    let object = value.as_object().ok_or_else(|| fail("expected object"))?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(fail("unknown executable field"));
    }
    Ok(())
}

fn strings(value: &Value) -> Result<Vec<String>, DispatchError> {
    let values = value
        .as_array()
        .ok_or_else(|| fail("expected string array"))?;
    let mut seen = BTreeSet::new();
    values
        .iter()
        .map(|value| {
            let text = value
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| fail("invalid string array"))?;
            if !seen.insert(text) {
                return Err(fail("duplicate string"));
            }
            Ok(text.to_owned())
        })
        .collect()
}

fn identity(value: &str) -> bool {
    !matches!(value, "__proto__" | "prototype" | "constructor")
        && value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b == b'_')
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn empty(value: Option<&Value>) -> bool {
    value.is_none_or(|v| v.as_array().is_some_and(Vec::is_empty))
}

fn digest(value: &Value) -> String {
    format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("JSON value"))
    )
}

fn reject_unresolved_slots(text: &str) -> Result<(), DispatchError> {
    if text
        .split("{{")
        .skip(1)
        .any(|body| body.trim_start().starts_with("slot."))
    {
        return Err(fail("unresolved prompt slot"));
    }
    Ok(())
}

fn validate_context_records(raw: &Value, node: &ComponentNode) -> Result<(), DispatchError> {
    keys(&raw["precondition_result"], &["status", "checks"])?;
    if node.precondition_result.status != "pass"
        || node.precondition_result.checks.len() != node.context_precondition.len()
    {
        return Err(fail("incomplete or failing compiled context checks"));
    }
    for (index, precondition) in node.context_precondition.iter().enumerate() {
        let condition = &raw["context_precondition"][index];
        keys(condition, &["predicate", "args"])?;
        if !PRECONDITIONS.contains(&precondition.predicate.as_str()) {
            return Err(fail("unknown context predicate"));
        }
        if let Some(args) = condition.get("args") {
            let args = args
                .as_object()
                .ok_or_else(|| fail("predicate args must be an object"))?;
            let selector = match precondition.predicate.as_str() {
                "metric_additive" => Some("metric"),
                "model_has_timestamp" => Some("model"),
                _ => None,
            };
            for (key, value) in args {
                if value.as_str().is_some_and(|v| v.starts_with("$param:")) {
                    return Err(fail("predicate args must be resolved"));
                }
                if selector == Some(key.as_str())
                    && value.as_str().is_none_or(|v| v.trim().is_empty())
                {
                    return Err(fail("predicate selector must be a name"));
                }
            }
        }
        let check = &raw["precondition_result"]["checks"][index];
        keys(check, &["predicate", "outcome"])?;
        if check["predicate"] != precondition.predicate || check["outcome"] != "pass" {
            return Err(fail("mismatched or failing compiled context check"));
        }
    }
    Ok(())
}

fn validate_node(
    raw: &Value,
    node: &ComponentNode,
    host: &HostContract,
) -> Result<(), DispatchError> {
    keys(
        raw,
        &[
            "id",
            "entrypoint",
            "verb",
            "type",
            "realization_kind",
            "context_binding",
            "precondition_result",
            "prompt_fragment",
            "llm_calls",
            "guardrails",
            "trigger",
            "required_capabilities",
            "borrowed_actions",
            "eval_ref",
            "effect",
            "context_requirements",
            "context_precondition",
            "params",
            "binds",
            "eval",
            "brief",
            "description",
            "examples",
            "assets",
            "slots",
        ],
    )?;
    if node.component_type != ComponentType::Analytical
        || node.realization_kind != RealizationKind::Skill
        || node.trigger.kind != TriggerKind::OneShot
        || node.effect.outcome.kind != OutcomeKind::None
    {
        return Err(fail(
            "host protocol supports analytical one-shot skills with no outcome only",
        ));
    }
    if !empty(raw.get("assets")) || !empty(raw.get("slots")) {
        return Err(fail("assets/slots are unsupported"));
    }
    validate_context_records(raw, node)?;
    reject_unresolved_slots(&node.prompt_fragment)?;
    if let Some(brief) = &node.brief {
        reject_unresolved_slots(brief)?;
    }
    keys(&raw["trigger"], &["kind"])?;
    keys(&raw["effect"], &["outcome", "render_blocks"])?;
    keys(&raw["effect"]["outcome"], &["kind"])?;
    for block in raw["effect"]
        .get("render_blocks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        keys(block, &["type", "fields"])?;
    }
    keys(
        &raw["context_binding"],
        &["project", "binding_mode", "resolved"],
    )?;
    if !matches!(
        node.context_binding.binding_mode.as_str(),
        "pinned" | "runtime_selected"
    ) {
        return Err(fail("invalid context binding mode"));
    }
    if let Some(params) = raw.get("params") {
        let mut names = BTreeSet::new();
        for param in params
            .as_array()
            .ok_or_else(|| fail("invalid parameters"))?
        {
            keys(param, &["name", "bind", "default"])?;
            let name = param["name"]
                .as_str()
                .filter(|v| identity(v))
                .ok_or_else(|| fail("invalid parameter name"))?;
            if !names.insert(name)
                || !matches!(param["bind"].as_str(), Some("optional" | "required"))
            {
                return Err(fail("unsupported parameter declaration"));
            }
            if raw.get("binds").and_then(|b| b.get(name)).is_none() {
                return Err(fail("parameter has no compiled binding"));
            }
        }
        if let Some(binds) = raw.get("binds") {
            if binds
                .as_object()
                .ok_or_else(|| fail("invalid bindings"))?
                .keys()
                .any(|key| !names.contains(key.as_str()))
            {
                return Err(fail("unknown parameter binding"));
            }
        }
    } else if raw.get("binds").is_some() {
        return Err(fail("bindings without parameters"));
    }
    let required = strings(raw.get("required_capabilities").unwrap_or(&json!([])))?;
    let safe = [
        "semantic_introspection",
        "sql_execution:read_only",
        "render_contract",
        "structured_output_capture",
        "artifact_write",
        "component_invocation",
        "llm:per_step_tier",
    ];
    if required
        .iter()
        .any(|cap| !safe.contains(&cap.as_str()) && !cap.starts_with("llm:"))
    {
        return Err(fail("unsupported component authority"));
    }
    let mut guards = BTreeSet::new();
    for guard in raw["guardrails"]
        .as_array()
        .ok_or_else(|| fail("invalid guardrails"))?
    {
        keys(guard, &["name", "locked", "scope", "threshold"])?;
        let name = guard["name"]
            .as_str()
            .ok_or_else(|| fail("invalid guardrail"))?;
        if !guards.insert(name) || !host.guardrails.iter().any(|item| item == name) {
            return Err(fail("duplicate or unimplemented host guardrail"));
        }
        match name {
            "read_only_execution" | "deterministic_gate" | "additivity_guard" => {
                if guard.get("scope").is_some() || guard.get("threshold").is_some() {
                    return Err(fail("unexpected guardrail parameter"));
                }
            }
            "row_limit" | "statement_timeout" | "drill_depth_limit" => {
                if guard["threshold"].as_u64().is_none_or(|n| n == 0)
                    || guard.get("scope").is_some()
                {
                    return Err(fail("invalid guardrail threshold"));
                }
            }
            "artifact_write" => {
                let scope = guard["scope"]
                    .as_str()
                    .ok_or_else(|| fail("missing artifact scope"))?;
                if scope.is_empty()
                    || scope.starts_with('/')
                    || scope.contains('\\')
                    || scope.chars().any(char::is_control)
                    || scope.split('/').any(|p| p.is_empty() || p == "..")
                    || guard.get("threshold").is_some()
                    || guard["locked"] != true
                {
                    return Err(fail("invalid artifact scope"));
                }
            }
            _ => return Err(fail("unsupported guardrail")),
        }
    }
    if !node
        .guardrails
        .iter()
        .any(|g| g.name == "read_only_execution" && g.locked)
    {
        return Err(fail("locked read-only enforcement is required"));
    }
    if required.iter().any(|cap| cap == "artifact_write") && !guards.contains("artifact_write") {
        return Err(fail("artifact capability needs scoped enforcement"));
    }
    if node.llm_calls.is_empty() || node.llm_calls.len() > 128 {
        return Err(fail("invalid step count"));
    }
    let mut names = BTreeSet::new();
    let mut products = BTreeMap::new();
    for (index, call) in node.llm_calls.iter().enumerate() {
        let step = &raw["llm_calls"][index];
        keys(
            step,
            &[
                "name",
                "tier",
                "consumes",
                "produces",
                "produces_exclusive",
                "prompt",
                "conditional",
                "when",
                "capabilities",
                "component_calls",
            ],
        )?;
        if !identity(&call.name) || !names.insert(&call.name) {
            return Err(fail("invalid/duplicate step identity"));
        }
        if call.tier.trim().is_empty()
            || call.tier.len() > 128
            || call.tier.chars().any(char::is_control)
        {
            return Err(fail("step tier must be a nonempty bounded name"));
        }
        if !required.contains(&format!("llm:{}", call.tier)) {
            return Err(fail("step tier is absent from component requirements"));
        }
        if call.prompt.trim().is_empty() {
            return Err(fail("empty step prompt"));
        }
        reject_unresolved_slots(&call.prompt)?;
        if let Some(consumes) = step.get("consumes") {
            strings(consumes)?;
        }
        if let Some(exclusive) = step.get("produces_exclusive") {
            if !exclusive.is_boolean() || (exclusive == true && call.produces.is_none()) {
                return Err(fail("invalid exclusive product"));
            }
        }
        if call.conditional != call.when.is_some() {
            return Err(fail("conditional/when mismatch"));
        }
        if let Some(when) = &call.when {
            keys(&step["when"], &["guard", "target"])?;
            if index == 0
                || call.produces.is_none()
                || when.guard != "on_failure"
                || when.target != node.llm_calls[index - 1].name
                || node.llm_calls[index - 1].conditional
                || node.llm_calls[index - 1]
                    .produces
                    .as_ref()
                    .is_none_or(|p| !call.consumes.contains(p))
            {
                return Err(fail(
                    "only adjacent failure repair with exact failure input is supported",
                ));
            }
        }
        for input in &call.consumes {
            if products.get(input) != Some(&false) {
                return Err(fail("missing or conditional-only input product"));
            }
        }
        if let Some(product) = &call.produces {
            if !identity(product) || products.insert(product.clone(), call.conditional).is_some() {
                return Err(fail("invalid/duplicate product"));
            }
        }
        let effective = match step.get("capabilities") {
            Some(value) => strings(value)?,
            None => required.clone(),
        };
        if effective.iter().any(|cap| !required.contains(cap)) {
            return Err(fail("step capability widening"));
        }
        if !call.component_calls.is_empty()
            && !effective.iter().any(|cap| cap == "component_invocation")
        {
            return Err(fail("missing effective component_invocation capability"));
        }
        let mut aliases = BTreeSet::new();
        for (edge_index, edge) in call.component_calls.iter().enumerate() {
            keys(
                &step["component_calls"][edge_index],
                &["alias", "component"],
            )?;
            if !identity(&edge.alias) || !aliases.insert(&edge.alias) {
                return Err(fail("invalid/duplicate call alias"));
            }
        }
    }
    Ok(())
}

fn step_tools(
    caps: &[String],
    map: &ToolMap,
    host: &HostContract,
) -> Result<Vec<ToolRef>, DispatchError> {
    let mut names = BTreeSet::new();
    let mut tools = Vec::new();
    for cap in caps {
        // Persistence is a validated root terminal action, never a model/child tool.
        if cap == "artifact_write" {
            continue;
        }
        if matches!(
            cap.as_str(),
            "semantic_introspection" | "sql_execution:read_only"
        ) && !map.contains_key(cap)
        {
            return Err(fail("callable capability has no tool binding"));
        }
        if let Some(binding) = map.get(cap) {
            let authority = host
                .tool_authority
                .get(binding.name.as_ref())
                .ok_or_else(|| fail("missing tool authority declaration"))?;
            if authority.source != binding.source
                || !authority.capabilities.contains(cap)
                || authority
                    .capabilities
                    .iter()
                    .any(|granted| !caps.contains(granted))
            {
                return Err(fail("tool realization exceeds active step authority"));
            }
            if !names.insert(binding.name.to_string()) {
                return Err(fail("ambiguous tool name"));
            }
            tools.push(ToolRef {
                name: binding.name.to_string(),
                source: binding.source.to_string(),
            });
        }
    }
    Ok(tools)
}

fn visit(
    id: &str,
    nodes: &BTreeMap<String, &ComponentNode>,
    active: &mut Vec<String>,
    done: &mut BTreeSet<String>,
    callees: &mut BTreeSet<String>,
    heights: &mut BTreeMap<String, usize>,
) -> Result<usize, DispatchError> {
    if active.iter().any(|item| item == id) {
        return Err(fail("cyclic component-call graph"));
    }
    if let Some(height) = heights.get(id) {
        if active.len() + height > 8 {
            return Err(fail("component-call depth exceeds protocol limit"));
        }
        return Ok(*height);
    }
    let node = nodes
        .get(id)
        .ok_or_else(|| fail("missing mounted callee"))?;
    if active.len() > 8 {
        return Err(fail("component-call depth exceeds protocol limit"));
    }
    active.push(id.to_owned());
    let mut height = 0;
    for call in &node.llm_calls {
        for edge in &call.component_calls {
            callees.insert(edge.component.clone());
            height = height.max(1 + visit(&edge.component, nodes, active, done, callees, heights)?);
        }
    }
    active.pop();
    done.insert(id.to_owned());
    heights.insert(id.to_owned(), height);
    Ok(height)
}

/// Build a format 0.2 bundle without I/O. Full declarations are retained and hashed; these hashes
/// detect drift only. The host must prepare, verify and authorize the selected closure at runtime.
pub fn prepare_hosted_vercel(
    raw: &str,
    host_json: &str,
    target: TargetId,
    providers: &[ProviderFragment],
) -> Result<Value, DispatchError> {
    if raw.len() > MAX_BYTES || host_json.len() > MAX_BYTES {
        return Err(fail("input exceeds size limit"));
    }
    let input = unique_json(raw)?;
    let host_value = unique_json(host_json)?;
    let host: HostContract =
        serde_json::from_value(host_value.clone()).map_err(|_| fail("invalid host contract"))?;
    if host.protocol != HOST_PROTOCOL
        || host.bundle_version != HOSTED_BUNDLE_VERSION
        || host.features
            != REQUIRED_FEATURES
                .iter()
                .map(|v| v.to_string())
                .collect::<Vec<_>>()
    {
        return Err(fail(
            "unsupported host protocol, bundle version or enforcement features",
        ));
    }
    strings(&host_value["guardrails"])?;
    for authority in host_value["tool_authority"]
        .as_object()
        .ok_or_else(|| fail("invalid tool authority"))?
        .values()
    {
        strings(&authority["capabilities"])?;
    }
    keys(
        &input,
        &[
            "warble_ir_version",
            "profile",
            "context_binding",
            "config",
            "components",
            "assets",
            "slots",
            "system_prompt",
        ],
    )?;
    if !empty(input.get("assets")) || !empty(input.get("slots")) {
        return Err(fail("profile assets/slots are unsupported"));
    }
    keys(&input["config"], &[])?;
    if input.get("system_prompt").is_some_and(|p| !p.is_string()) {
        return Err(fail("invalid system prompt"));
    }
    if let Some(prompt) = input.get("system_prompt").and_then(Value::as_str) {
        reject_unresolved_slots(prompt)?;
    }
    keys(
        &input["context_binding"],
        &["project", "binding_mode", "resolved"],
    )?;
    let ir: WarbleIr = serde_json::from_value(input.clone()).map_err(|_| fail("malformed IR"))?;
    validate_ir_version(&ir)?;
    if ir.components.len() > 128 {
        return Err(fail("component inventory exceeds limit"));
    }
    let mut by_id = BTreeMap::new();
    for node in &ir.components {
        if !identity(&node.id) || by_id.insert(node.id.clone(), node).is_some() {
            return Err(fail("invalid/duplicate mounted identity"));
        }
    }
    let entries: Vec<_> = ir
        .components
        .iter()
        .filter(|n| n.entrypoint)
        .map(|n| n.id.clone())
        .collect();
    if entries.is_empty() {
        return Err(fail("no eligible entry"));
    }
    let mut reachable = BTreeSet::new();
    let mut callees = BTreeSet::new();
    let mut heights = BTreeMap::new();
    for id in &entries {
        visit(
            id,
            &by_id,
            &mut Vec::new(),
            &mut reachable,
            &mut callees,
            &mut heights,
        )?;
    }
    let mut composed = compose_target(target.profile(), base_tool_map(), providers, target)?;
    composed.profile.insert(
        "component_invocation".to_owned(),
        CapabilityEntry {
            outcome: CapabilityOutcome::RealizeVia,
            via: Some(Cow::Borrowed(HOST_PROTOCOL)),
            provided_by: ProvidedBy::Runtime,
            criticality: Criticality::Required,
            note: Some(Cow::Borrowed(
                "requires host runtime enforcement; emitted plan is not executed",
            )),
        },
    );
    let mut components = BTreeMap::new();
    for (index, node) in ir
        .components
        .iter()
        .enumerate()
        .filter(|(_, n)| reachable.contains(&n.id))
    {
        let declaration = &input["components"][index];
        validate_node(declaration, node, &host)?;
        if callees.contains(&node.id)
            && (!node.borrowed_actions.is_empty()
                || node
                    .required_capabilities
                    .iter()
                    .any(|cap| cap == "artifact_write")
                || node.guardrails.iter().any(|g| g.name == "artifact_write"))
        {
            return Err(fail("callee write/action authority is unsupported"));
        }
        let report = resolve_capabilities(node, target.as_str(), &composed.profile)?;
        let mut steps = Vec::new();
        for (step_index, call) in node.llm_calls.iter().enumerate() {
            let effective = match declaration["llm_calls"][step_index].get("capabilities") {
                Some(value) => strings(value)?,
                None => node.required_capabilities.clone(),
            };
            let tools = step_tools(&effective, &composed.tool_map, &host)?;
            if call
                .component_calls
                .iter()
                .any(|edge| tools.iter().any(|tool| tool.name == edge.alias))
            {
                return Err(fail("call alias collides with tool name"));
            }
            steps.push(
                json!({"name": call.name, "effective_capabilities": effective,
                "tools": tools, "realization": classify_step(node, step_index)}),
            );
        }
        components.insert(
            node.id.clone(),
            json!({"declaration": declaration, "steps": steps, "capabilities": report}),
        );
    }
    let mut bundle = json!({
        "vercel_bundle_version": HOSTED_BUNDLE_VERSION, "warble_ir_version": ir.warble_ir_version,
        "protocol": HOST_PROTOCOL, "execution_status": "not_executed", "profile": ir.profile,
        "target": target.as_str(), "entries": entries, "components": components,
        "context_binding": input["context_binding"], "system_prompt": input.get("system_prompt"),
        "required_host": host_value, "input_ir_sha256": digest(&input),
        "limits": {"max_depth": 8, "max_attempts": 32, "max_steps": 40, "max_steps_per_child": 12,
            "max_in_flight": 1, "max_request_bytes": 65536, "max_result_bytes": 1048576, "timeout_ms": 120000},
        "model_turn_hard_limit": false, "monetary_hard_limit": false,
    });
    bundle["bundle_sha256"] = json!(digest(&bundle));
    if serde_json::to_vec(&bundle)
        .map_err(|_| fail("serialization failed"))?
        .len()
        > MAX_BYTES
    {
        return Err(fail("bundle exceeds size limit"));
    }
    Ok(bundle)
}

/// Validate the whole bundle before creating output, then write it once. No vendor/configuration,
/// assets, verifier or model is launched. The consumer must not use output from a failed command.
pub fn emit_hosted_vercel(
    raw: &str,
    host_json: &str,
    target: TargetId,
    out: &Path,
    providers: &[ProviderFragment],
) -> Result<Value, DispatchError> {
    let bundle = prepare_hosted_vercel(raw, host_json, target, providers)?;
    let bytes = serde_json::to_vec_pretty(&bundle).map_err(|_| fail("serialization failed"))?;
    std::fs::create_dir_all(out).map_err(|_| fail("cannot create output directory"))?;
    std::fs::write(out.join("bundle.json"), bytes).map_err(|_| fail("cannot write bundle"))?;
    Ok(bundle)
}

// Value normally accepts duplicate keys. Check recursively *before* projecting away
// unselected components or deserializing a map so authority cannot depend on parser order.
struct UniqueJson(Value);

impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = UniqueJson;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON with unique object keys")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> Result<Self::Value, M::Error> {
                let mut object = serde_json::Map::new();
                while let Some((key, value)) = map.next_entry::<String, UniqueJson>()? {
                    if object.insert(key, value.0).is_some() {
                        return Err(serde::de::Error::custom("duplicate JSON key"));
                    }
                }
                Ok(UniqueJson(Value::Object(object)))
            }
            fn visit_seq<S: serde::de::SeqAccess<'de>>(
                self,
                mut seq: S,
            ) -> Result<Self::Value, S::Error> {
                let mut values = Vec::new();
                while let Some(value) = seq.next_element::<UniqueJson>()? {
                    values.push(value.0);
                }
                Ok(UniqueJson(Value::Array(values)))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(UniqueJson(json!(v)))
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Self::Value, E> {
                Ok(UniqueJson(json!(v)))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(UniqueJson(json!(v)))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(UniqueJson(json!(v)))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Self::Value, E> {
                Ok(UniqueJson(json!(v)))
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Null))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}

fn unique_json(raw: &str) -> Result<Value, DispatchError> {
    serde_json::from_str::<UniqueJson>(raw)
        .map(|v| v.0)
        .map_err(|_| fail("invalid JSON or duplicate object key"))
}
