//! Explicit host-owned execution behind a native conversation. Descriptors are implementation
//! claims, never attestations. The host must verify live identity and isolation before admission.
use crate::interactive::{NativeEntryKind, NativePurpose, NativeSessionScope};
use crate::ir::{ComponentNode, WarbleIr};
use crate::session::{produce_session, COMPONENT_HOST_PROTOCOL, MAX_INPUT_BYTES};
use crate::slots::SlotSupply;
use crate::DispatchError;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    version: String,
    protocol: String,
    vendor: String,
    session_id: String,
    auth_identity: String,
    runtime_generation: String,
    binding: crate::interactive::NativeBinding,
    /// Host-owned context snapshot digests, independently bound to every governed component.
    prepared_contexts: BTreeMap<String, String>,
    /// A format-2 direct-session host contract per admitted composed root.
    roots: BTreeMap<String, Value>,
}

#[derive(Clone, Debug)]
pub struct NativeHost {
    document: Value,
    ir: WarbleIr,
    scope_digest: String,
    target: String,
    roots: BTreeMap<String, String>,
}

fn fail(message: &str) -> DispatchError {
    DispatchError(format!("native component host: {message} (wall-hit)"))
}
fn digest(value: &Value) -> String {
    format!("sha256:{:x}", Sha256::digest(value.to_string().as_bytes()))
}
fn opaque(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.chars().any(|c| c.is_control() || c.is_whitespace())
}
fn is_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

pub fn has_calls(node: &ComponentNode) -> bool {
    node.llm_calls
        .iter()
        .any(|step| !step.component_calls.is_empty())
}

pub(crate) fn resolution_report(node: &ComponentNode) -> crate::resolve::ResolutionReport {
    node.required_capabilities.iter().map(|capability| crate::resolve::ResolvedCapability {
        capability: capability.clone(), outcome: crate::targets::CapabilityOutcome::RealizeVia,
        provided_by: crate::targets::ProvidedBy::Runtime, criticality: crate::targets::Criticality::SafetyCritical,
        note: Some("Explicit host-owned direct-session plan; runtime identity, context and isolation must be verified before execution. Emission is not readiness.".into()),
    }).collect()
}

impl NativeHost {
    /// The same immutable typed snapshot that was validated and hashed during preparation.
    /// Native emission must use this snapshot rather than reopening a mutable IR file.
    pub fn ir(&self) -> &WarbleIr {
        &self.ir
    }
    /// Prepare all admitted roots from the original bytes. No edge is removed or lowered into
    /// a native subagent; direct-session v2 preserves the complete governed closure.
    pub fn prepare(
        raw_ir: &str,
        raw_descriptor: &str,
        target: &str,
        purpose: NativePurpose,
        scope: &NativeSessionScope,
    ) -> Result<Self, DispatchError> {
        if raw_ir.len() > MAX_INPUT_BYTES || raw_descriptor.len() > MAX_INPUT_BYTES {
            return Err(fail("input exceeds size limit"));
        }
        let value = crate::session::unique_json(raw_descriptor)?;
        let descriptor: Descriptor =
            serde_json::from_value(value).map_err(|_| fail("invalid host descriptor"))?;
        let raw = crate::session::unique_json(raw_ir)?;
        let ir: WarbleIr = serde_json::from_value(raw.clone()).map_err(|_| fail("invalid IR"))?;
        let vendor = match target {
            "claude-code:interactive" => "claude",
            "codex:interactive" => "codex",
            _ => return Err(fail("requires native interactive target")),
        };
        if descriptor.version != "1"
            || descriptor.protocol != COMPONENT_HOST_PROTOCOL
            || descriptor.vendor != vendor
            || purpose != NativePurpose::Analysis
            || (vendor == "codex" && scope.entry.kind == NativeEntryKind::Scope)
        {
            return Err(fail("unsupported purpose, vendor, entry or protocol"));
        }
        for identity in [
            &descriptor.session_id,
            &descriptor.auth_identity,
            &descriptor.runtime_generation,
        ] {
            if !opaque(identity) {
                return Err(fail("missing bounded host identity"));
            }
        }
        if serde_json::to_value(&scope.binding).map_err(|_| fail("invalid scope binding"))?
            != serde_json::to_value(&descriptor.binding)
                .map_err(|_| fail("invalid host binding"))?
        {
            return Err(fail("host binding differs from native scope"));
        }
        let entries = WarbleIr {
            components: ir
                .components
                .iter()
                .filter(|n| n.entrypoint)
                .cloned()
                .collect(),
            ..ir.clone()
        };
        purpose.validate_profile(&entries, &scope.entry)?;
        for node in raw["components"]
            .as_array()
            .ok_or_else(|| fail("missing components"))?
        {
            if node["entrypoint"] == true
                && scope.entry.pinned_verb().is_none_or(|id| node["id"] == id)
                && node
                    .get("assets")
                    .is_some_and(|v| !v.as_array().is_some_and(Vec::is_empty))
            {
                return Err(fail("native host materialization does not support assets"));
            }
        }
        let selected = entries
            .components
            .iter()
            .filter(|n| scope.entry.pinned_verb().is_none_or(|id| id == n.id))
            .filter(|n| scope.entry.kind == NativeEntryKind::Agent || has_calls(n))
            .collect::<Vec<_>>();
        if selected.is_empty()
            || selected
                .iter()
                .map(|n| n.id.as_str())
                .collect::<BTreeSet<_>>()
                != descriptor
                    .roots
                    .keys()
                    .map(String::as_str)
                    .collect::<BTreeSet<_>>()
        {
            return Err(fail(
                "host roots must exactly match admitted composed entries",
            ));
        }
        let mut roots = BTreeMap::new();
        let mut plans = BTreeMap::new();
        let mut contexts = BTreeSet::new();
        for node in selected {
            if node.id != node.verb {
                return Err(fail("native root identity must match its advertised verb"));
            }
            let contract = &descriptor.roots[&node.id];
            if contract["version"] != "2" {
                return Err(fail("native composition requires direct-session format 2"));
            }
            let plan =
                produce_session(raw_ir, &contract.to_string(), &node.id, &SlotSupply::new())?;
            for id in plan["components"]
                .as_object()
                .expect("validated plan registry")
                .keys()
            {
                contexts.insert(id.clone());
            }
            let tool = format!("warble_run_{:x}", Sha256::digest(node.id.as_bytes()));
            // MCP tool identifiers are bounded; the full root remains in the immutable registry.
            roots.insert(node.id.clone(), tool[..43].to_string());
            plans.insert(node.id.clone(), plan);
        }
        if descriptor
            .prepared_contexts
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>()
            != contexts
            || descriptor.prepared_contexts.values().any(|v| !is_digest(v))
        {
            return Err(fail(
                "missing or invalid per-component prepared context identity",
            ));
        }
        let scope_digest =
            digest(&serde_json::to_value(scope).map_err(|_| fail("scope serialization"))?);
        let mut document = json!({
            "version": "1", "protocol": COMPONENT_HOST_PROTOCOL, "execution": "host_owned_steps",
            "execution_status": "not_executed", "vendor": vendor,
            "session_id": descriptor.session_id, "auth_identity": descriptor.auth_identity,
            "runtime_generation": descriptor.runtime_generation, "binding": descriptor.binding,
            "prepared_contexts": descriptor.prepared_contexts, "root_tools": roots, "plans": plans,
            "input_ir_sha256": format!("sha256:{:x}", Sha256::digest(raw_ir.as_bytes())),
            "scope_sha256": scope_digest,
            "request_schema": {"type":"object", "additionalProperties":false,
                "required":["request"], "properties":{"request":{"type":"string", "minLength":1, "maxLength":65536}}},
        });
        document["host_plan_sha256"] = json!(digest(&document));
        if document.to_string().len() > MAX_INPUT_BYTES {
            return Err(fail("native plan exceeds size limit"));
        }
        Ok(Self {
            document,
            ir,
            scope_digest,
            target: target.into(),
            roots,
        })
    }

    pub(crate) fn validate(
        &self,
        ir: &WarbleIr,
        target: &str,
        purpose: Option<NativePurpose>,
        scope: Option<&NativeSessionScope>,
        has_mcp: bool,
    ) -> Result<(), DispatchError> {
        if self.target != target
            || purpose != Some(NativePurpose::Analysis)
            || !has_mcp
            || ir != &self.ir
            || scope.map(|s| digest(&serde_json::to_value(s).expect("scope serializes")))
                != Some(self.scope_digest.clone())
        {
            return Err(fail("host plan does not match native launch inputs"));
        }
        Ok(())
    }
    pub(crate) fn tool(&self, id: &str) -> Option<&str> {
        self.roots.get(id).map(String::as_str)
    }
    pub(crate) fn tool_names(&self) -> Vec<&str> {
        self.roots.values().map(String::as_str).collect()
    }
    pub(crate) fn document(&self) -> &Value {
        &self.document
    }
    pub(crate) fn launch_value(&self) -> Value {
        json!({"protocol": COMPONENT_HOST_PROTOCOL, "execution": "host_owned_steps",
            "plan_path": ".warble/component-plans.json", "host_plan_sha256": self.document["host_plan_sha256"],
            "vendor": self.document["vendor"], "auth_identity": self.document["auth_identity"],
            "session_id": self.document["session_id"], "runtime_generation": self.document["runtime_generation"],
            "binding": self.document["binding"], "root_tools": self.roots})
    }
    pub(crate) fn instructions(&self, node: &ComponentNode) -> String {
        let tool = self.tool(&node.id).expect("governed root");
        format!("Run the requested work through `genbi_session.{tool}` with only `request`, the user's request as text. This is admission to this fixed root; the host owns every step, child, context, tool and artifact. Do not execute these steps locally, supply step/child identity, run SQL, or reconstruct a result. Report only the correlated host result in readable prose. A refusal is not a successful artifact. The terminal's existing conversation is retained, but governed steps execute in fresh host-managed contexts using the same approved vendor/account.")
    }
    pub(crate) fn claude_wrapper(&self, node: &ComponentNode) -> String {
        // Serialize scalar values as JSON (valid YAML) to prevent frontmatter injection.
        let description = serde_json::to_string(node.description.as_deref().unwrap_or(&node.verb))
            .expect("string");
        format!(
            "---\nname: {}\ndescription: {}\ntools: mcp__genbi_session__{}\n---\n\n{}\n",
            node.id,
            description,
            self.tool(&node.id).expect("governed root"),
            self.instructions(node)
        )
    }
}
