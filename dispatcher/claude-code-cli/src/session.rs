//! Pure producer for host-owned sessions. Compatibility is not execution authority.
//!
//! This format preserves step boundaries; it neither launches a vendor nor flattens a
//! component into a conversational prompt. A host must implement every emitted requirement.

use crate::ir::{
    ComponentNode, ComponentType, OutcomeKind, RealizationKind, TriggerKind, SUPPORTED_IR_VERSION,
};
use crate::slots::{assert_no_slot_references, resolve_ir_json, SlotSupply};
use crate::DispatchError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// Producer format version, independent of the IR and package versions.
pub const SESSION_PLAN_VERSION: &str = "1";
/// Explicit composed plan format. Legacy hosts must not execute it.
pub const COMPOSED_SESSION_PLAN_VERSION: &str = "2";
pub const COMPONENT_HOST_PROTOCOL: &str = "warble-component-host/1";
pub const COMPOSED_EXECUTION: &[&str] = &[
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
/// Maximum size of either input and the compact output, in bytes.
pub const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HostContract {
    version: String,
    tiers: Vec<String>,
    capabilities: BTreeMap<String, HostCapability>,
    guardrails: Vec<Guardrail>,
    execution: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HostCapability {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Guardrail {
    name: String,
    locked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    threshold: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct When {
    guard: String,
    target: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Step {
    name: String,
    tier: String,
    consumes: Vec<String>,
    produces: Option<String>,
    prompt: String,
    conditional: bool,
    when: Option<When>,
    #[serde(default)]
    capabilities: Option<Vec<String>>,
    #[serde(default)]
    produces_exclusive: bool,
    #[serde(default)]
    component_calls: Vec<Value>,
}

fn fail(message: &str) -> DispatchError {
    DispatchError::new(format!("direct-session producer: {message} (wall-hit)"))
}

fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, DispatchError> {
    serde_json::from_value(value).map_err(|_| fail("malformed or unsupported contract fields"))
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

pub(crate) fn unique_json(raw: &str) -> Result<Value, DispatchError> {
    serde_json::from_str::<UniqueJson>(raw)
        .map(|v| v.0)
        .map_err(|_| fail("invalid JSON or duplicate object key"))
}

fn validate_slots(raw: &Value, selected: &Value, supply: &SlotSupply) -> Result<(), DispatchError> {
    let mut names = BTreeSet::new();
    let mut largest_variant = 0;
    for owner in [raw, selected] {
        if let Some(declarations) = owner.get("slots") {
            let declarations = declarations
                .as_array()
                .ok_or_else(|| fail("invalid slots"))?;
            if declarations.len() > 128 {
                return Err(fail("too many slots"));
            }
            for slot in declarations {
                keys(slot, &["name", "default", "variants", "present_when"])?;
                let name = slot["name"]
                    .as_str()
                    .ok_or_else(|| fail("invalid slot name"))?;
                if name.is_empty()
                    || !name
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                    || name.as_bytes()[0].is_ascii_digit()
                    || !names.insert(name)
                {
                    return Err(fail("invalid or duplicate slot name"));
                }
                let variants = slot["variants"]
                    .as_object()
                    .ok_or_else(|| fail("invalid variants"))?;
                for text in variants.values() {
                    let text = text.as_str().ok_or_else(|| fail("invalid variant text"))?;
                    largest_variant = largest_variant.max(text.len());
                    // No recursive expansion: a bounded input must not expand exponentially.
                    assert_no_slot_references(text, "nested slot variant")?;
                }
            }
        }
    }
    if supply.keys().any(|name| !names.contains(name.as_str())) {
        return Err(fail("supplied slot is not in selected scope"));
    }
    let serialized = selected.to_string();
    let references = serialized.matches("{{").count();
    if references
        .saturating_mul(largest_variant)
        .saturating_add(serialized.len())
        > MAX_INPUT_BYTES
    {
        return Err(fail("slot expansion exceeds size limit"));
    }
    Ok(())
}

fn keys(value: &Value, allowed: &[&str]) -> Result<(), DispatchError> {
    let object = value
        .as_object()
        .ok_or_else(|| fail("expected an object"))?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(fail("unknown IR field; cannot silently discard semantics"));
    }
    Ok(())
}

fn unique(values: &[String]) -> bool {
    values.iter().all(|v| !v.trim().is_empty())
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}

fn tool_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        && value.as_bytes()[0].is_ascii_alphabetic()
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn capability_kind(capability: &str) -> Option<bool> {
    match capability {
        "semantic_introspection" | "sql_execution:read_only" | "artifact_write" => Some(true),
        "render_contract" | "structured_output_capture" => Some(false),
        _ => None,
    }
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

fn validate_compiled_parameters(node: &Value) -> Result<(), DispatchError> {
    let mut names = BTreeSet::new();
    if let Some(params) = node.get("params") {
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
                || node.get("binds").and_then(|b| b.get(name)).is_none()
            {
                return Err(fail("parameter must have a compiled binding"));
            }
        }
    }
    if let Some(binds) = node.get("binds") {
        if binds.is_null() && names.is_empty() {
            return Ok(());
        }
        if binds
            .as_object()
            .ok_or_else(|| fail("invalid bindings"))?
            .keys()
            .any(|key| !names.contains(key.as_str()))
        {
            return Err(fail("unknown parameter binding"));
        }
    }
    Ok(())
}

fn validate_composed_context(node: &Value) -> Result<(), DispatchError> {
    let empty = vec![];
    let conditions = match node.get("context_precondition") {
        Some(v) => v
            .as_array()
            .ok_or_else(|| fail("invalid context predicates"))?,
        None => &empty,
    };
    let checks = node["precondition_result"]["checks"]
        .as_array()
        .ok_or_else(|| fail("missing compiled context checks"))?;
    if checks.len() != conditions.len() {
        return Err(fail("incomplete compiled context checks"));
    }
    for (condition, check) in conditions.iter().zip(checks) {
        let predicate = condition["predicate"]
            .as_str()
            .ok_or_else(|| fail("invalid predicate"))?;
        if ![
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
        ]
        .contains(&predicate)
            || check["predicate"] != predicate
            || check["outcome"] != "pass"
        {
            return Err(fail("unknown or mismatched context check"));
        }
        if let Some(args) = condition.get("args") {
            for (name, value) in args
                .as_object()
                .ok_or_else(|| fail("invalid predicate arguments"))?
            {
                if value.as_str().is_some_and(|v| v.starts_with("$param:")) {
                    return Err(fail("unresolved predicate argument"));
                }
                if matches!(
                    (predicate, name.as_str()),
                    ("metric_additive", "metric") | ("model_has_timestamp", "model")
                ) && value.as_str().is_none_or(|v| v.trim().is_empty())
                {
                    return Err(fail("invalid predicate selector"));
                }
            }
        }
    }
    Ok(())
}

fn validate_calls(
    calls: &[Value],
    caps: &[String],
    tools: &BTreeSet<&String>,
) -> Result<(), DispatchError> {
    if !calls.is_empty() && !caps.iter().any(|cap| cap == "component_invocation") {
        return Err(fail("step lacks component invocation authority"));
    }
    let mut aliases = BTreeSet::new();
    for edge in calls {
        keys(edge, &["alias", "component"])?;
        let alias = edge["alias"]
            .as_str()
            .filter(|v| identity(v))
            .ok_or_else(|| fail("invalid call alias"))?;
        if !aliases.insert(alias)
            || tools.iter().any(|tool| tool.as_str() == alias)
            || edge["component"].as_str().is_none_or(|v| !identity(v))
        {
            return Err(fail("invalid call target or ambiguous alias"));
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ComposedHost {
    version: String,
    protocol: String,
    execution: Vec<String>,
    /// Independently selected binding and exact guardrail requirements for each reachable node.
    components: BTreeMap<String, HostContract>,
}

fn visit_composed<'a>(
    id: &'a str,
    nodes: &BTreeMap<&'a str, &'a Value>,
    active: &mut Vec<&'a str>,
    reachable: &mut BTreeSet<&'a str>,
    heights: &mut BTreeMap<&'a str, usize>,
) -> Result<usize, DispatchError> {
    if active.contains(&id) {
        return Err(fail("cyclic component invocation"));
    }
    if let Some(height) = heights.get(id) {
        if active.len() + height > 8 {
            return Err(fail("component depth exceeds limit"));
        }
        return Ok(*height);
    }
    if active.len() > 8 {
        return Err(fail("component depth exceeds limit"));
    }
    let node = nodes
        .get(id)
        .ok_or_else(|| fail("missing mounted callee"))?;
    active.push(id);
    let mut height = 0;
    for step in node["llm_calls"]
        .as_array()
        .ok_or_else(|| fail("invalid steps"))?
    {
        if let Some(calls) = step.get("component_calls") {
            for call in calls
                .as_array()
                .ok_or_else(|| fail("invalid component calls"))?
            {
                let child = call["component"]
                    .as_str()
                    .ok_or_else(|| fail("invalid callee"))?;
                height = height.max(1 + visit_composed(child, nodes, active, reachable, heights)?);
            }
        }
    }
    active.pop();
    reachable.insert(id);
    heights.insert(id, height);
    Ok(height)
}

fn produce_composed_session(
    raw_ir: &str,
    raw_host: &str,
    component: &str,
    slots: &SlotSupply,
) -> Result<Value, DispatchError> {
    // Slots across multiple components require a namespaced supply contract. Never silently
    // apply one component's supplied wording to another component's instructions.
    if !slots.is_empty() {
        return Err(fail("composed plans do not support slot supply"));
    }
    let host: ComposedHost = parse(unique_json(raw_host)?)?;
    if host.version != COMPOSED_SESSION_PLAN_VERSION
        || host.protocol != COMPONENT_HOST_PROTOCOL
        || host.execution
            != COMPOSED_EXECUTION
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
    {
        return Err(fail(
            "unsupported composed host protocol or execution requirements",
        ));
    }
    let raw = unique_json(raw_ir)?;
    let mut nodes = BTreeMap::new();
    let components = raw["components"]
        .as_array()
        .ok_or_else(|| fail("invalid component inventory"))?;
    if components.len() > 128 {
        return Err(fail("component inventory exceeds limit"));
    }
    for node in components {
        let id = node["id"]
            .as_str()
            .filter(|v| identity(v))
            .ok_or_else(|| fail("invalid component identity"))?;
        if nodes.insert(id, node).is_some() {
            return Err(fail("duplicate component identity"));
        }
    }
    if nodes
        .get(component)
        .is_none_or(|node| node["entrypoint"] != true)
    {
        return Err(fail("root must be an advertised entry"));
    }
    let mut reachable = BTreeSet::new();
    visit_composed(
        component,
        &nodes,
        &mut vec![],
        &mut reachable,
        &mut BTreeMap::new(),
    )?;
    if host
        .components
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>()
        != reachable
    {
        return Err(fail(
            "host bindings must exactly match the selected closure",
        ));
    }
    let mut plans = BTreeMap::new();
    for id in reachable {
        let node = nodes[id];
        for owner in [&raw, node] {
            if owner
                .get("slots")
                .is_some_and(|v| !v.as_array().is_some_and(Vec::is_empty))
            {
                return Err(fail("composed slots are unsupported"));
            }
        }
        let plan = produce_component(
            raw_ir,
            &serde_json::to_string(&host.components[id]).map_err(|_| fail("host serialization"))?,
            id,
            slots,
            true,
        )?;
        if id != component
            && (!plan["borrowed_actions"]
                .as_array()
                .is_some_and(Vec::is_empty)
                || plan["required_capabilities"]
                    .as_array()
                    .is_some_and(|caps| caps.iter().any(|cap| cap == "artifact_write"))
                || plan["guardrails"]
                    .as_array()
                    .is_some_and(|guards| guards.iter().any(|g| g["name"] == "artifact_write")))
        {
            return Err(fail("callee persistence/action authority is unsupported"));
        }
        plans.insert(id, plan);
    }
    let mut plan = json!({
        "session_plan_version": COMPOSED_SESSION_PLAN_VERSION, "producer_version": env!("CARGO_PKG_VERSION"),
        "warble_ir_version": SUPPORTED_IR_VERSION, "protocol": COMPONENT_HOST_PROTOCOL,
        "authority": "host_owned", "execution_status": "not_executed",
        "input_ir_sha256": digest(raw_ir.as_bytes()), "host_contract_sha256": digest(raw_host.as_bytes()),
        "profile": raw["profile"], "entry": component, "components": plans,
        "context_binding": raw["context_binding"], "system_prompt": raw.get("system_prompt"),
        "required_execution": host.execution,
        "limits": {"max_depth": 8, "max_attempts": 32, "max_steps": 40, "max_steps_per_child": 12,
            "max_in_flight": 1, "max_request_bytes": 65536, "max_result_bytes": 1048576, "timeout_ms": 120000},
        "model_turn_hard_limit": false, "monetary_hard_limit": false,
    });
    plan["plan_sha256"] = json!(digest(plan.to_string().as_bytes()));
    if plan.to_string().len() > MAX_INPUT_BYTES {
        return Err(fail("output exceeds size limit"));
    }
    Ok(plan)
}

fn validate_guardrail(guard: &Guardrail, composed: bool) -> Result<(), DispatchError> {
    let valid = match guard.name.as_str() {
        "additivity_guard" if composed => guard.scope.is_none() && guard.threshold.is_none(),
        "read_only_execution" | "deterministic_gate" => {
            guard.scope.is_none() && guard.threshold.is_none()
        }
        "row_limit" | "statement_timeout" | "drill_depth_limit" => {
            if guard.name == "drill_depth_limit" && !composed {
                return Err(fail("unsupported guardrail"));
            }
            guard.scope.is_none()
                && guard
                    .threshold
                    .as_ref()
                    .and_then(Value::as_u64)
                    .is_some_and(|n| n > 0)
        }
        // A logical artifact scope, not a vendor filesystem grant.
        "artifact_write" => {
            guard.threshold.is_none()
                && guard.scope.as_deref().is_some_and(|s| {
                    !s.is_empty()
                        && !s.starts_with('/')
                        && !s.contains('\\')
                        && s.split('/').all(|part| !part.is_empty() && part != "..")
                        && !s.chars().any(char::is_control)
                })
        }
        _ => false,
    };
    if !valid {
        return Err(fail("unsupported guardrail or threshold/scope shape"));
    }
    Ok(())
}

fn validate_host(host: &HostContract, composed: bool) -> Result<(), DispatchError> {
    if host.version
        != if composed {
            COMPOSED_SESSION_PLAN_VERSION
        } else {
            SESSION_PLAN_VERSION
        }
        || !unique(&host.tiers)
        || !unique(&host.execution)
    {
        return Err(fail(
            "unsupported host version or duplicate/empty declarations",
        ));
    }
    let features = [
        "ordered_steps",
        "isolated_step_tools",
        "artifact_provenance",
        "per_step_tiers",
        "bounded_repair",
        "render_contract",
    ];
    if host
        .execution
        .iter()
        .any(|s| !features.contains(&s.as_str()))
    {
        return Err(fail("unknown host execution feature"));
    }
    let mut tools = BTreeSet::new();
    for (capability, binding) in &host.capabilities {
        let kind = if composed
            && matches!(
                capability.as_str(),
                "artifact_write" | "component_invocation"
            ) {
            Some(false)
        } else {
            capability_kind(capability)
        };
        match (kind, binding.tool.as_deref()) {
            (Some(true), Some(name)) if tool_name(name) && tools.insert(name) => {}
            (Some(false), None) => {}
            _ => {
                return Err(fail(
                    "unsupported capability/tool binding or aliased tool authority",
                ))
            }
        }
    }
    let mut guards = BTreeSet::new();
    for guard in &host.guardrails {
        validate_guardrail(guard, composed)?;
        if !guards.insert(&guard.name) {
            return Err(fail("duplicate host guardrail"));
        }
    }
    Ok(())
}

/// Produce a bounded, deterministic JSON artifact using only caller-supplied bytes.
///
/// The host contract is an explicit implementation claim, NOT proof of runtime support,
/// permission, readiness or certification. No files, network, environment or credentials
/// are accessed. Unknown executable facets and unsupported component anatomy are rejected.
pub fn produce_session(
    raw_ir: &str,
    raw_host: &str,
    component: &str,
    slots: &SlotSupply,
) -> Result<Value, DispatchError> {
    if raw_ir.len() > MAX_INPUT_BYTES || raw_host.len() > MAX_INPUT_BYTES {
        return Err(fail("input exceeds size limit"));
    }
    let host_value = unique_json(raw_host)?;
    if host_value["version"] == COMPOSED_SESSION_PLAN_VERSION {
        return produce_composed_session(raw_ir, raw_host, component, slots);
    }
    produce_component(raw_ir, raw_host, component, slots, false)
}

fn produce_component(
    raw_ir: &str,
    raw_host: &str,
    component: &str,
    slots: &SlotSupply,
    composed: bool,
) -> Result<Value, DispatchError> {
    let host: HostContract = parse(unique_json(raw_host)?)?;
    validate_host(&host, composed)?;
    let raw = unique_json(raw_ir)?;
    let mut allowed = vec![
        "warble_ir_version",
        "profile",
        "config",
        "context_binding",
        "slots",
        "components",
    ];
    if composed {
        allowed.extend(["system_prompt", "assets"]);
    }
    keys(&raw, &allowed)?;
    if composed {
        if raw
            .get("assets")
            .is_some_and(|v| !v.as_array().is_some_and(Vec::is_empty))
        {
            return Err(fail("profile assets are unsupported"));
        }
        if let Some(prompt) = raw.get("system_prompt") {
            assert_no_slot_references(
                prompt
                    .as_str()
                    .ok_or_else(|| fail("invalid system prompt"))?,
                "system prompt",
            )?;
        }
    }
    if raw["warble_ir_version"] != SUPPORTED_IR_VERSION {
        return Err(fail("unsupported IR version"));
    }
    let profile = raw["profile"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| fail("missing profile"))?;
    keys(&raw["config"], &["capability_ceiling"])?;
    keys(
        &raw["context_binding"],
        &["project", "binding_mode", "resolved"],
    )?;
    let components = raw["components"]
        .as_array()
        .ok_or_else(|| fail("missing components"))?;
    let mut ids = BTreeSet::new();
    for node in components {
        let id = node["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| fail("missing component identity"))?;
        if !ids.insert(id) {
            return Err(fail("duplicate component identity"));
        }
    }
    let selected = components
        .iter()
        .find(|node| node["id"] == component)
        .ok_or_else(|| fail("unknown component"))?;
    keys(
        selected,
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
            "context_requirements",
            "context_precondition",
            "params",
            "eval",
            "brief",
            "description",
            "examples",
            "slots",
            "assets",
            "binds",
            "effect",
        ],
    )?;
    for field in if composed {
        vec!["assets"]
    } else {
        vec!["assets", "params"]
    } {
        if let Some(value) = selected.get(field) {
            if !value.as_array().is_some_and(Vec::is_empty) {
                return Err(fail("assets and runtime/bound params are not supported"));
            }
        }
    }
    if !composed
        && selected
            .get("binds")
            .is_some_and(|v| !v.as_object().is_some_and(serde_json::Map::is_empty))
    {
        return Err(fail("bound parameter values are not supported"));
    }
    if composed {
        validate_compiled_parameters(selected)?;
    }
    keys(&selected["trigger"], &["kind"])?;
    keys(&selected["effect"], &["outcome", "render_blocks"])?;
    keys(&selected["effect"]["outcome"], &["kind"])?;
    keys(
        &selected["context_binding"],
        &["project", "binding_mode", "resolved"],
    )?;
    // The compiler carries resolved metadata at profile level, not on every mount.
    if selected["context_binding"]["project"] != raw["context_binding"]["project"]
        || selected["context_binding"]["binding_mode"] != raw["context_binding"]["binding_mode"]
        || selected["context_binding"]
            .get("resolved")
            .is_some_and(|v| v != &raw["context_binding"]["resolved"])
    {
        return Err(fail("component context differs from profile"));
    }
    // Resolve slots only for the selected entry, not unrelated executable work.
    validate_slots(&raw, selected, slots)?;
    let mut projected = raw.clone();
    projected["components"] = json!([selected]);
    let resolved = resolve_ir_json(&projected.to_string(), slots)?;
    if resolved.len() > MAX_INPUT_BYTES {
        return Err(fail("resolved input exceeds size limit"));
    }
    let resolved: Value =
        serde_json::from_str(&resolved).map_err(|_| fail("slot resolution failed"))?;
    let selected = &resolved["components"][0];
    let node: ComponentNode = parse(selected.clone())?;
    if node.context_binding.project.is_empty()
        || !["runtime_selected", "pinned"].contains(&node.context_binding.binding_mode.as_str())
    {
        return Err(fail("unsupported context binding"));
    }
    if !composed && !node.entrypoint {
        return Err(fail("internal component is not a session entry"));
    }
    match (
        node.realization_kind,
        node.trigger.kind,
        node.effect.outcome.kind,
        node.component_type,
    ) {
        (
            RealizationKind::Skill,
            TriggerKind::OneShot,
            OutcomeKind::None,
            ComponentType::Analytical,
        ) => {}
        _ => return Err(fail("unsupported component anatomy")),
    }
    if composed {
        validate_composed_context(selected)?;
    }
    keys(&selected["precondition_result"], &["status", "checks"])?;
    if node.precondition_result.status != "pass"
        || node
            .precondition_result
            .checks
            .iter()
            .any(|c| c.outcome != "pass")
    {
        return Err(fail("context precondition did not pass"));
    }
    for check in selected["precondition_result"]["checks"]
        .as_array()
        .into_iter()
        .flatten()
    {
        keys(check, &["predicate", "outcome"])?;
    }
    for check in selected["context_precondition"]
        .as_array()
        .into_iter()
        .flatten()
    {
        keys(check, &["predicate", "args"])?;
    }
    for block in selected["effect"]["render_blocks"]
        .as_array()
        .into_iter()
        .flatten()
    {
        keys(block, &["type", "fields"])?;
    }
    assert_no_slot_references(&node.prompt_fragment, "component fragment")?;
    if let Some(brief) = &node.brief {
        assert_no_slot_references(brief, "component brief")?;
    }
    let guards: Vec<Guardrail> = parse(selected["guardrails"].clone())?;
    let mut guard_names = BTreeSet::new();
    for guard in &guards {
        validate_guardrail(guard, composed)?;
        if !guard_names.insert(&guard.name) || !host.guardrails.contains(guard) {
            return Err(fail("missing exact host guardrail agreement"));
        }
    }
    if !guards
        .iter()
        .any(|g| g.name == "read_only_execution" && g.locked)
    {
        return Err(fail("a locked read-only boundary is required"));
    }
    if host.guardrails.len() != guards.len() {
        return Err(fail(
            "host guardrails must exactly match selected requirements",
        ));
    }
    if !unique(&node.required_capabilities) {
        return Err(fail("duplicate or empty capability"));
    }
    if let Some(ceiling) = raw["config"].get("capability_ceiling") {
        let ceiling: Vec<String> = parse(ceiling.clone())?;
        if !unique(&ceiling)
            || node
                .required_capabilities
                .iter()
                .any(|c| !ceiling.contains(c))
        {
            return Err(fail("capability ceiling violated"));
        }
    }
    for cap in &node.required_capabilities {
        if cap == "llm:per_step_tier" {
            continue;
        }
        if let Some(tier) = cap.strip_prefix("llm:") {
            if !host.tiers.iter().any(|t| t == tier) {
                return Err(fail("unavailable model tier"));
            }
        } else if (capability_kind(cap).is_none() && !(composed && cap == "component_invocation"))
            || !host.capabilities.contains_key(cap)
        {
            return Err(fail("unavailable or unsupported capability"));
        }
    }
    if node
        .required_capabilities
        .iter()
        .any(|c| c == "artifact_write")
        && !guards
            .iter()
            .any(|g| g.name == "artifact_write" && g.locked)
    {
        return Err(fail("artifact writing requires a locked scope"));
    }
    let mut required_host: BTreeSet<_> = node
        .required_capabilities
        .iter()
        .filter(|c| !c.starts_with("llm:"))
        .cloned()
        .collect();
    let steps: Vec<Step> = parse(selected["llm_calls"].clone())?;
    if steps.is_empty() || steps.len() > 128 {
        return Err(fail("invalid step count"));
    }
    let mut names = BTreeSet::new();
    let mut products = BTreeSet::new();
    let mut conditional_products = BTreeSet::new();
    let mut requirements = BTreeSet::from([
        "ordered_steps",
        "isolated_step_tools",
        "artifact_provenance",
        "per_step_tiers",
    ]);
    if !node.effect.render_blocks.is_empty() {
        requirements.insert("render_contract");
        required_host.insert("render_contract".to_string());
        if !host.capabilities.contains_key("render_contract") {
            return Err(fail("render contract capability missing"));
        }
    }
    let mut output_steps = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        if selected["llm_calls"][index]
            .get("capabilities")
            .is_some_and(Value::is_null)
        {
            return Err(fail("step capabilities cannot be null"));
        }
        if step.name.is_empty()
            || !names.insert(&step.name)
            || step.prompt.is_empty()
            || !unique(&step.consumes)
        {
            return Err(fail("invalid step identity, prompt or consumes"));
        }
        if !composed && !step.component_calls.is_empty() {
            return Err(fail("component invocation is not supported"));
        }
        if step.produces_exclusive && step.produces.is_none() {
            return Err(fail("exclusive provenance needs a product"));
        }
        if !host.tiers.contains(&step.tier)
            || !node
                .required_capabilities
                .contains(&format!("llm:{}", step.tier))
        {
            return Err(fail("step tier is not declared and supported"));
        }
        assert_no_slot_references(&step.prompt, "step prompt")?;
        let effective = step
            .capabilities
            .as_ref()
            .unwrap_or(&node.required_capabilities);
        if !unique(effective)
            || effective
                .iter()
                .any(|c| !node.required_capabilities.contains(c))
        {
            return Err(fail("step capability widens component authority"));
        }
        let tools: BTreeSet<_> = effective
            .iter()
            .filter_map(|c| host.capabilities.get(c)?.tool.as_ref())
            .collect();
        if composed {
            validate_calls(&step.component_calls, effective, &tools)?;
        }
        let realization = match (&step.when, step.conditional) {
            (None, false) => json!({"kind": "independent"}),
            (Some(when), true)
                if index > 0
                    && when.guard == "on_failure"
                    && when.target == steps[index - 1].name
                    && !steps[index - 1].conditional =>
            {
                if step.produces.is_none()
                    || steps[index - 1].produces.is_none()
                    || !step
                        .consumes
                        .contains(steps[index - 1].produces.as_ref().unwrap())
                {
                    return Err(fail(
                        "repair must consume the failed attempt and declare its own product",
                    ));
                }
                requirements.insert("bounded_repair");
                json!({"kind": "repair_fold", "fold_into": when.target, "max_attempts": 1,
                    "failure_input": steps[index - 1].produces, "on_exhaustion": "fail"})
            }
            _ => return Err(fail("unsupported conditional/guard shape")),
        };
        for consumed in &step.consumes {
            // A repair receives the failed attempt's typed result/error, not an invented product.
            if conditional_products.contains(consumed) {
                return Err(fail(
                    "conditional-only artifact consumption is not supported",
                ));
            }
            if !products.contains(consumed) {
                return Err(fail("consumed artifact has no upstream producer"));
            }
        }
        if let Some(product) = &step.produces {
            if product.is_empty() || !products.insert(product.clone()) {
                return Err(fail("invalid or duplicate artifact producer"));
            }
            if step.conditional {
                conditional_products.insert(product.clone());
            }
        }
        let mut emitted = json!({
            "name": step.name, "tier": step.tier, "consumes": step.consumes,
            "produces": step.produces, "produces_exclusive": step.produces_exclusive,
            "instructions": step.prompt, "capabilities": effective, "tools": tools,
            "when": step.when, "realization": realization,
            "product_availability": if step.conditional { "if_executed" } else { "after_attempt" },
        });
        if composed {
            emitted["component_calls"] = json!(step.component_calls);
        }
        output_steps.push(emitted);
    }
    if requirements
        .iter()
        .any(|f| !host.execution.iter().any(|s| s == f))
    {
        return Err(fail("host does not implement required execution semantics"));
    }
    let mut result = json!({
        "session_plan_version": if composed { COMPOSED_SESSION_PLAN_VERSION } else { SESSION_PLAN_VERSION },
        "producer_version": env!("CARGO_PKG_VERSION"), "warble_ir_version": SUPPORTED_IR_VERSION,
        "input_ir_sha256": digest(raw_ir.as_bytes()), "host_contract_sha256": digest(raw_host.as_bytes()),
        "profile": profile, "component": node.id,
        "context_identity_sha256": digest(raw["context_binding"].to_string().as_bytes()),
        "instructions": {"brief": node.brief}, "steps": output_steps,
        "slot_supply": slots,
        "capability_bindings": host.capabilities.iter().filter(|(c, _)| required_host.contains(*c)).collect::<BTreeMap<_, _>>(),
        "required_host_capabilities": required_host,
        "required_capabilities": node.required_capabilities, "guardrails": guards,
        "borrowed_actions": node.borrowed_actions, "context_requirements": node.context_requirements,
        "context_precondition": selected.get("context_precondition").cloned().unwrap_or_else(|| json!([])),
        "precondition_result": selected["precondition_result"],
        "render_blocks": selected["effect"].get("render_blocks").cloned().unwrap_or_else(|| json!([])),
        "required_execution": requirements,
        "authority": "host_owned", "execution_status": "not_executed",
    });
    if composed {
        result["declaration"] = selected.clone();
    }
    result["plan_sha256"] = json!(digest(result.to_string().as_bytes()));
    if result.to_string().len() > MAX_INPUT_BYTES {
        return Err(fail("output exceeds size limit"));
    }
    Ok(result)
}
