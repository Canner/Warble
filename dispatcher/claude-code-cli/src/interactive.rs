//! Shared, deliberately small handoff contract for native interactive CLIs.

use crate::error::DispatchError;
use crate::ir::WarbleIr;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use url::{Host, Url};

pub const LAUNCH_SPEC_VERSION: &str = "1";
pub const NATIVE_SESSION_LAUNCH_SPEC_VERSION: &str = "2";
pub const NATIVE_SESSION_MCP_LAUNCH_SPEC_VERSION: &str = "3";
pub const NATIVE_SCOPE_VERSION: &str = "1";
pub const NATIVE_MCP_DESCRIPTOR_VERSION: &str = "1";
pub const NATIVE_MCP_SERVER_NAME: &str = "genbi_session";
pub const NATIVE_MCP_CREDENTIAL_ENV_VAR: &str = "WARBLE_MCP_CONNECTION_CREDENTIAL";

const SETUP_RECOVERY_REPORT_VERSION: &str = "1";
const MAX_SAFE_SETUP_RECOVERY_SEQUENCE: u64 = 9_007_199_254_740_991;

/// The public, transport-independent input schema for the `genbi_session`
/// `report_setup_recovery` MCP tool. The host validates monotonicity against its last accepted
/// report; the schema deliberately carries neither identity nor any diagnostic text.
pub fn setup_recovery_input_schema() -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "report_setup_recovery v1 input",
        "type": "object",
        "additionalProperties": false,
        "required": ["version", "sequence", "phase", "state", "code"],
        "properties": {
            "version": { "const": SETUP_RECOVERY_REPORT_VERSION },
            "sequence": {
                "type": "integer",
                "minimum": 1,
                "maximum": MAX_SAFE_SETUP_RECOVERY_SEQUENCE,
            },
            "phase": { "enum": ["connect", "context"] },
            "state": {
                "enum": [
                    "working",
                    "needs_input",
                    "needs_decision",
                    "retryable_failure",
                    "reported_complete",
                ]
            },
            "code": {
                "enum": [
                    "in_progress",
                    "user_action_required",
                    "continue_or_stop",
                    "retryable",
                    "completion_reported",
                ]
            },
            "decision": {
                "type": "object",
                "additionalProperties": false,
                "required": ["kind", "choices"],
                "properties": {
                    "kind": { "const": "continue_or_stop" },
                    "choices": {
                        "type": "array",
                        "prefixItems": [{ "const": "continue" }, { "const": "stop" }],
                        "items": false,
                        "minItems": 2,
                        "maxItems": 2,
                    }
                }
            }
        },
        "allOf": [
            {
                "if": { "properties": { "state": { "const": "working" } }, "required": ["state"] },
                "then": { "properties": { "code": { "const": "in_progress" } }, "required": ["code"], "not": { "required": ["decision"] } }
            },
            {
                "if": { "properties": { "state": { "const": "needs_input" } }, "required": ["state"] },
                "then": { "properties": { "code": { "const": "user_action_required" } }, "required": ["code"], "not": { "required": ["decision"] } }
            },
            {
                "if": { "properties": { "state": { "const": "needs_decision" } }, "required": ["state"] },
                "then": { "properties": { "code": { "const": "continue_or_stop" } }, "required": ["code", "decision"] }
            },
            {
                "if": { "properties": { "state": { "const": "retryable_failure" } }, "required": ["state"] },
                "then": { "properties": { "code": { "const": "retryable" } }, "required": ["code"], "not": { "required": ["decision"] } }
            },
            {
                "if": { "properties": { "state": { "const": "reported_complete" } }, "required": ["state"] },
                "then": { "properties": { "code": { "const": "completion_reported" } }, "required": ["code"], "not": { "required": ["decision"] } }
            }
        ]
    })
}

/// The generated Setup-agent instruction for the v3 `genbi_session` discovery contract.
/// This is deliberately prose plus closed examples rather than a second tool configuration.
pub fn setup_recovery_instructions() -> &'static str {
    r#"## Setup recovery reporting (v1)

When the discovered `genbi_session` MCP server exposes `report_setup_recovery`, use that exact tool to report only an honest, redacted Setup lifecycle update. Do not create another transport or attempt to report through terminal output.

Every report has exactly these fields: `version: "1"`, a positive integer `sequence`, `phase`, `state`, and `code`. Use a strictly increasing `sequence` for each report in this native session. `phase` is exactly `connect` or `context`. The only valid state/code pairs are:

- `working` / `in_progress`
- `needs_input` / `user_action_required`
- `needs_decision` / `continue_or_stop`
- `retryable_failure` / `retryable`
- `reported_complete` / `completion_reported`

Only `needs_decision` carries `decision`, and it is exactly `{ "kind": "continue_or_stop", "choices": ["continue", "stop"] }`. Do not send `decision` for another state. Do not add fields or free text: never include identity, scope, project/session/vendor details, terminal output, paths, commands, prompts, credentials, tool arguments/results, or arbitrary options.

`reported_complete` is only this agent's report; the host independently validates completion. Never infer a report from terminal bytes, an exit status, or a tool result. If a truthful report cannot be made, omit it; silence is an honest host-lifecycle outcome, not a fabricated `needs_input` or decision.
"#
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetupRecoveryReport {
    version: String,
    sequence: u64,
    phase: String,
    state: String,
    code: String,
    #[serde(default)]
    decision: Option<SetupRecoveryDecision>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetupRecoveryDecision {
    kind: String,
    choices: Vec<String>,
}

/// Validate the producer-owned closed vocabulary without accepting or echoing a raw report.
/// Hosts additionally own per-session authorization and monotonic sequence fencing.
pub fn validate_setup_recovery_report(value: &Value) -> Result<(), DispatchError> {
    let report: SetupRecoveryReport = serde_json::from_value(value.clone())
        .map_err(|_| DispatchError("invalid report_setup_recovery v1 input".to_string()))?;
    if report.version != SETUP_RECOVERY_REPORT_VERSION
        || report.sequence == 0
        || report.sequence > MAX_SAFE_SETUP_RECOVERY_SEQUENCE
        || !matches!(report.phase.as_str(), "connect" | "context")
    {
        return Err(DispatchError(
            "invalid report_setup_recovery v1 input".to_string(),
        ));
    }
    let valid = match report.state.as_str() {
        "working" => report.code == "in_progress" && report.decision.is_none(),
        "needs_input" => report.code == "user_action_required" && report.decision.is_none(),
        "needs_decision" => {
            report.code == "continue_or_stop"
                && matches!(
                    report.decision,
                    Some(SetupRecoveryDecision { kind, choices })
                        if kind == "continue_or_stop"
                            && choices == ["continue", "stop"]
                )
        }
        "retryable_failure" => report.code == "retryable" && report.decision.is_none(),
        "reported_complete" => report.code == "completion_reported" && report.decision.is_none(),
        _ => false,
    };
    valid
        .then_some(())
        .ok_or_else(|| DispatchError("invalid report_setup_recovery v1 input".to_string()))
}

/// A server-derived launch scope. This is deliberately a small producer input rather
/// than session state: GenBI creates and authorizes it, Warble verifies its shape/canonical cwd
/// and carries its opaque binding identity into the launch artifact, and the future runtime owns
/// comparing it to its live binding generation/revision before spawning.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeSessionScope {
    pub version: String,
    pub kind: String,
    pub scope_id: String,
    pub cwd: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<NativeBinding>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeBinding {
    pub project_identity: String,
    pub generation: String,
    pub revision: String,
}

/// Exact server-derived connection material for the allowlisted native-session MCP server.
///
/// The credential is deliberately opaque to Warble. It is emitted only into the vendor discovery
/// mechanism that needs it: Claude's HTTP header or Codex's dedicated credential environment
/// variable. It never appears in the launch spec, ownership record, agent Markdown, argv, or a
/// prompt. The host resolves this credential to live session/vendor/project/revision/capability
/// state when the native client connects.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeMcpDescriptor {
    version: String,
    url: String,
    credential: String,
}

impl std::fmt::Debug for NativeMcpDescriptor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeMcpDescriptor")
            .field("version", &self.version)
            .field("url", &self.url)
            .field("credential", &"[REDACTED]")
            .finish()
    }
}

impl NativeMcpDescriptor {
    pub fn from_file(path: &Path) -> Result<Self, DispatchError> {
        let raw = fs::read_to_string(path).map_err(|e| {
            DispatchError(format!(
                "read native MCP descriptor {}: {e}",
                path.display()
            ))
        })?;
        serde_json::from_str(&raw).map_err(|e| {
            DispatchError(format!(
                "parse native MCP descriptor {}: {e}",
                path.display()
            ))
        })
    }

    fn validate(&self) -> Result<(), DispatchError> {
        if self.version != NATIVE_MCP_DESCRIPTOR_VERSION {
            return Err(DispatchError(format!(
                "unsupported native MCP descriptor version '{}' (expected: {NATIVE_MCP_DESCRIPTOR_VERSION})",
                self.version
            )));
        }
        // The generic descriptor has no redirect, DNS, or vendor-specific transport
        // semantics. Parse its authority before accepting it: HTTPS may use any exact
        // parsed host, while HTTP is confined to a literal loopback host on this machine.
        // The credential, not the URL, carries the bounded session binding.
        let url = Url::parse(&self.url).map_err(|_| {
            DispatchError(
                "native MCP descriptor URL must be HTTPS or exact loopback HTTP".to_string(),
            )
        })?;
        let loopback = match url.host() {
            Some(Host::Domain("localhost")) => true,
            Some(Host::Ipv4(address)) => address.is_loopback(),
            Some(Host::Ipv6(address)) => address.is_loopback(),
            _ => false,
        };
        let allowed_scheme = url.scheme() == "https" || url.scheme() == "http" && loopback;
        // `Url::scheme()` provides the case-normalized scheme. Retain an explicit `://`
        // shape check so a parsed relative/scheme-only URL can never stand in for a
        // network authority.
        let has_network_authority = self
            .url
            .split_once(':')
            .is_some_and(|(_, after_scheme)| after_scheme.starts_with("//"));
        if self.url.len() > 2048
            || url.host().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || self.url.chars().any(char::is_control)
            || self.url.chars().any(char::is_whitespace)
            || !has_network_authority
            || !allowed_scheme
        {
            return Err(DispatchError(
                "native MCP descriptor URL must be HTTPS or exact loopback HTTP".to_string(),
            ));
        }
        if self.credential.is_empty()
            || self.credential.len() > 4096
            || self.credential.chars().any(char::is_control)
            || self.credential.chars().any(char::is_whitespace)
        {
            return Err(DispatchError(
                "native MCP descriptor requires a bounded opaque credential".to_string(),
            ));
        }
        Ok(())
    }

    fn ownership_digest(&self) -> String {
        let bytes = serde_json::to_vec(&json!({
            "version": self.version,
            "url": self.url,
            "credential": self.credential,
        }))
        .expect("canonical native MCP descriptor serializes");
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    pub fn claude_discovery_config(&self) -> Result<String, DispatchError> {
        serde_json::to_string_pretty(&json!({
            "mcpServers": {
                NATIVE_MCP_SERVER_NAME: {
                    "type": "http",
                    "url": self.url,
                    "headers": { "Authorization": format!("Bearer {}", self.credential) },
                }
            }
        }))
        .map(|value| format!("{value}\n"))
        .map_err(|e| DispatchError(e.to_string()))
    }

    pub fn codex_discovery_config(&self, enable_setup_recovery_tool: bool) -> String {
        // JSON strings are valid TOML basic strings and give us a single established escaping
        // primitive for the server URL. Codex reads the credential only at native-process launch.
        let mut config = format!(
            "[mcp_servers.{NATIVE_MCP_SERVER_NAME}]\nurl = {}\nbearer_token_env_var = {}\n",
            serde_json::to_string(&self.url).expect("MCP URL serializes"),
            serde_json::to_string(NATIVE_MCP_CREDENTIAL_ENV_VAR)
                .expect("credential env name serializes"),
        );
        if enable_setup_recovery_tool {
            config.push_str("enabled_tools = [\"report_setup_recovery\"]\n");
        }
        config
    }
}

impl NativeSessionScope {
    pub fn from_file(path: &Path) -> Result<Self, DispatchError> {
        let raw = fs::read_to_string(path).map_err(|e| {
            DispatchError(format!("read native session scope {}: {e}", path.display()))
        })?;
        serde_json::from_str(&raw).map_err(|e| {
            DispatchError(format!(
                "parse native session scope {}: {e}",
                path.display()
            ))
        })
    }

    fn validate(&self, purpose: NativePurpose, root: &Path) -> Result<(), DispatchError> {
        if self.version != NATIVE_SCOPE_VERSION {
            return Err(DispatchError(format!(
                "unsupported native session scope version '{}' (expected: {NATIVE_SCOPE_VERSION})",
                self.version
            )));
        }
        if self.kind != purpose.scope_kind() {
            return Err(DispatchError(format!(
                "native session scope kind '{}' does not match purpose '{}' ({})",
                self.kind,
                purpose.as_str(),
                purpose.scope_kind()
            )));
        }
        if self.scope_id.trim().is_empty() {
            return Err(DispatchError(
                "native session scope requires a non-empty opaque scope_id".to_string(),
            ));
        }
        if !self.cwd.is_absolute() {
            return Err(DispatchError(
                "native session scope cwd must be an absolute server-derived path".to_string(),
            ));
        }
        let scope_cwd = fs::canonicalize(&self.cwd).map_err(|e| {
            DispatchError(format!(
                "canonicalize native session scope cwd {}: {e}",
                self.cwd.display()
            ))
        })?;
        if scope_cwd != root {
            return Err(DispatchError(format!(
                "native session scope cwd {} does not match canonical output root {}",
                scope_cwd.display(),
                root.display()
            )));
        }
        match (&self.kind[..], &self.binding) {
            ("bootstrap", None) => Ok(()),
            ("bootstrap", Some(_)) => Err(DispatchError(
                "bootstrap native session scope must not carry a bound-project identity".to_string(),
            )),
            ("bound_project", Some(binding))
                if !binding.project_identity.trim().is_empty()
                    && !binding.generation.trim().is_empty()
                    && !binding.revision.trim().is_empty() =>
            {
                Ok(())
            }
            ("bound_project", _) => Err(DispatchError(
                "bound_project native session scope requires non-empty project_identity, generation, and revision"
                    .to_string(),
            )),
            _ => unreachable!("purpose mapping has a closed scope vocabulary"),
        }
    }

    fn ownership_digest(&self, canonical_cwd: &Path) -> String {
        // This is a collision identifier only, not a signature or provenance proof. GenBI owns
        // invocation authorization; the digest merely keeps opaque caller values out of Markdown
        // ownership markers while ensuring a changed descriptor cannot reuse an old artifact set.
        let canonical = json!({
            "version": self.version,
            "kind": self.kind,
            "scope_id": self.scope_id,
            "cwd": canonical_cwd,
            "binding": self.binding,
        });
        let bytes = serde_json::to_vec(&canonical).expect("canonical native scope serializes");
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    fn launch_value(&self) -> serde_json::Value {
        json!({
            "kind": self.kind,
            "scope_id": self.scope_id,
            "binding": self.binding,
        })
    }
}

/// The only product purposes that may opt into the native Sessions launch contract.
///
/// This enum is intentionally closed: a caller cannot use the launch artifact to select an
/// arbitrary profile, agent, cwd, or command. The GenBI runtime chooses a purpose and vendor,
/// then materializes the corresponding Warble profile in a server-owned scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativePurpose {
    Analysis,
    Setup,
    ContextEnrichment,
}

impl NativePurpose {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "analysis" => Some(Self::Analysis),
            "setup" => Some(Self::Setup),
            "context_enrichment" => Some(Self::ContextEnrichment),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Analysis => "analysis",
            Self::Setup => "setup",
            Self::ContextEnrichment => "context_enrichment",
        }
    }

    fn expected_profile(self) -> &'static str {
        match self {
            Self::Analysis => "genbi-default",
            Self::Setup => "genbi-setup",
            Self::ContextEnrichment => "genbi-enrich-context",
        }
    }

    fn scope_kind(self) -> &'static str {
        match self {
            Self::Setup => "bootstrap",
            Self::Analysis | Self::ContextEnrichment => "bound_project",
        }
    }

    pub fn claude_agent(self) -> &'static str {
        match self {
            // These are the entry-point agents from their corresponding, allowlisted profiles.
            // The profile's other materialized agents remain available as vendor-native support
            // artifacts; callers never choose them through the launch spec.
            Self::Analysis => "answer_query",
            Self::Setup => "connect_source",
            Self::ContextEnrichment => "draft_enrichment",
        }
    }

    pub fn codex_skill(self) -> &'static str {
        match self {
            Self::Analysis => "genbi-analysis",
            Self::Setup => "genbi-setup",
            Self::ContextEnrichment => "genbi-enrich-context",
        }
    }

    pub fn codex_description(self) -> &'static str {
        match self {
            Self::Analysis => "Analyze the server-bound semantic project using the GenBI analysis behavior.",
            Self::Setup => "Connect a source and build a semantic context only in the server-created bootstrap scope.",
            Self::ContextEnrichment => "Inspect a pinned project and draft read-only enrichment proposals; never apply an enrichment.",
        }
    }

    pub fn validate_profile(self, ir: &WarbleIr) -> Result<(), DispatchError> {
        if ir.profile != self.expected_profile() {
            return Err(DispatchError(format!(
                "native purpose '{}' requires Warble profile '{}', not '{}'",
                self.as_str(),
                self.expected_profile(),
                ir.profile
            )));
        }
        let entries = ir
            .components
            .iter()
            .filter(|node| node.verb == self.claude_agent())
            .collect::<Vec<_>>();
        let [entry] = entries.as_slice() else {
            return Err(DispatchError(format!(
                "native purpose '{}' requires exactly one materializable entry verb '{}'",
                self.as_str(),
                self.claude_agent()
            )));
        };
        if entry.id != self.claude_agent()
            || entry.realization_kind != crate::ir::RealizationKind::Skill
            || entry.trigger.kind != crate::ir::TriggerKind::OneShot
            || entry.effect.outcome.kind != crate::ir::OutcomeKind::None
            || entry
                .required_capabilities
                .iter()
                .any(|capability| capability == "enrichment_apply:deterministic")
        {
            return Err(DispatchError(format!(
                "native purpose '{}' entry '{}' is not materializable as a native interactive agent",
                self.as_str(),
                self.claude_agent()
            )));
        }
        Ok(())
    }
}

pub struct InteractiveOutput {
    pub root: PathBuf,
    pub launch_path: PathBuf,
    pub handoff_path: PathBuf,
    ownership_path: PathBuf,
    owned_paths: Vec<String>,
    marker: String,
    target: String,
    executable: String,
    purpose: Option<NativePurpose>,
    native_scope: Option<NativeSessionScope>,
    native_mcp: Option<NativeMcpDescriptor>,
}

#[allow(clippy::too_many_arguments)]
pub fn prepare_interactive_output(
    out_dir: &Path,
    target: &str,
    executable: &str,
    profile_signature: &str,
    owned_paths: &[PathBuf],
    purpose: Option<NativePurpose>,
    native_scope: Option<NativeSessionScope>,
    native_mcp: Option<NativeMcpDescriptor>,
) -> Result<InteractiveOutput, DispatchError> {
    if !out_dir.is_dir() {
        return Err(DispatchError(format!(
            "interactive dispatch output must be an existing directory so it can become the canonical launch cwd: {}",
            out_dir.display()
        )));
    }
    let root = fs::canonicalize(out_dir).map_err(|e| {
        DispatchError(format!(
            "canonicalize interactive output {}: {e}",
            out_dir.display()
        ))
    })?;
    match (purpose, native_scope.as_ref()) {
        (Some(purpose), Some(scope)) => scope.validate(purpose, &root)?,
        (Some(_), None) => {
            return Err(DispatchError(
                "native Sessions purpose requires a server-derived --native-scope descriptor"
                    .to_string(),
            ))
        }
        (None, Some(_)) => {
            return Err(DispatchError(
                "--native-scope requires a native Sessions --purpose".to_string(),
            ))
        }
        (None, None) => {}
    }
    match (purpose, native_mcp.as_ref()) {
        (Some(_), Some(descriptor)) => descriptor.validate()?,
        (Some(_), None) | (None, None) => {}
        (None, Some(_)) => {
            return Err(DispatchError(
                "--native-mcp requires a native Sessions --purpose".to_string(),
            ))
        }
    }
    let handoff_path = root.join("RUN.md");
    let launch_path = root.join(".warble/interactive-launch.json");
    ensure_inside(&root, &handoff_path)?;
    ensure_inside(&root, &launch_path)?;
    ensure_safe_path(&root, Path::new(".warble/interactive-launch.json"))?;
    ensure_safe_path(&root, Path::new(".warble/interactive-ownership.json"))?;
    let marker = format!(
        "<!-- warble-interactive-artifact target={target} profile={profile_signature}{}{} -->",
        native_scope
            .as_ref()
            .map(|scope| format!(" scope_digest={}", scope.ownership_digest(&root)))
            .unwrap_or_default(),
        native_mcp
            .as_ref()
            .map(|descriptor| format!(" mcp_digest={}", descriptor.ownership_digest()))
            .unwrap_or_default(),
    );

    let mut planned = owned_paths
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    planned.sort();
    planned.dedup();
    let ownership_path = root.join(".warble/interactive-ownership.json");
    ensure_inside(&root, &ownership_path)?;
    for relative in owned_paths {
        ensure_safe_path(&root, relative)?;
    }
    let any_existing = planned.iter().any(|relative| root.join(relative).exists())
        || launch_path.exists()
        || ownership_path.exists();
    if any_existing {
        let existing = fs::read_to_string(&ownership_path).map_err(|_| {
            DispatchError(format!(
                "refusing to overwrite existing interactive artifacts: {} is missing",
                ownership_path.display()
            ))
        })?;
        verify_ownership(&existing, &marker, &planned, &root)?;
    }
    for relative in owned_paths {
        let path = root.join(relative);
        if path.exists()
            && matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some("RUN.md" | "AGENTS.md" | "SKILL.md")
            )
        {
            let contents = fs::read_to_string(&path).map_err(|e| {
                DispatchError(format!(
                    "read existing interactive artifact {}: {e}",
                    path.display()
                ))
            })?;
            if !contents.contains(&marker) {
                return Err(DispatchError(format!(
                    "refusing to overwrite user-owned interactive artifact {}; it lacks the expected Warble ownership marker",
                    path.display()
                )));
            }
        }
    }
    if launch_path.exists() {
        let existing = fs::read_to_string(&launch_path).map_err(|e| {
            DispatchError(format!(
                "read existing launch spec {}: {e}",
                launch_path.display()
            ))
        })?;
        if existing
            != render_launch_spec(
                target,
                executable,
                &root,
                &handoff_path,
                purpose,
                native_scope.as_ref(),
                native_mcp.as_ref(),
            )?
        {
            return Err(DispatchError(format!(
                "refusing to overwrite user-owned or mismatched launch spec {}",
                launch_path.display()
            )));
        }
    }
    Ok(InteractiveOutput {
        root,
        launch_path,
        handoff_path,
        ownership_path,
        owned_paths: planned,
        marker,
        target: target.into(),
        executable: executable.into(),
        purpose,
        native_scope,
        native_mcp,
    })
}

impl InteractiveOutput {
    pub fn marker(&self) -> &str {
        &self.marker
    }
    pub fn write_launch_spec(&self) -> Result<(), DispatchError> {
        let parent = self.launch_path.parent().expect(".warble parent");
        fs::create_dir_all(parent)
            .map_err(|e| DispatchError(format!("create {}: {e}", parent.display())))?;
        fs::write(
            &self.launch_path,
            render_launch_spec(
                &self.target,
                &self.executable,
                &self.root,
                &self.handoff_path,
                self.purpose,
                self.native_scope.as_ref(),
                self.native_mcp.as_ref(),
            )?,
        )
        .map_err(|e| {
            DispatchError(format!(
                "write launch spec {}: {e}",
                self.launch_path.display()
            ))
        })
    }
    pub fn write_ownership(&self) -> Result<(), DispatchError> {
        let parent = self.ownership_path.parent().expect(".warble parent");
        fs::create_dir_all(parent)
            .map_err(|e| DispatchError(format!("create {}: {e}", parent.display())))?;
        fs::write(
            &self.ownership_path,
            ownership_document(&self.marker, &self.owned_paths, &self.root)?,
        )
        .map_err(|e| {
            DispatchError(format!(
                "write ownership record {}: {e}",
                self.ownership_path.display()
            ))
        })
    }
}

fn ensure_inside(root: &Path, path: &Path) -> Result<(), DispatchError> {
    if !path.starts_with(root) {
        return Err(DispatchError(format!(
            "interactive artifact path escapes canonical output root: {}",
            path.display()
        )));
    }
    Ok(())
}

/// Reject unsafe existing path components before any output write. A lexical `starts_with` check
/// is not a containment proof when `.claude`, `.agents`, or `.warble` can redirect writes
/// elsewhere, and a regular-file parent would make creation order-dependent.
fn ensure_safe_path(root: &Path, relative: &Path) -> Result<(), DispatchError> {
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(DispatchError(format!(
            "interactive artifact path escapes canonical output root: {}",
            relative.display()
        )));
    }
    let components = relative.components().collect::<Vec<_>>();
    let mut cursor = root.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        cursor.push(component.as_os_str());
        if let Ok(metadata) = fs::symlink_metadata(&cursor) {
            if metadata.file_type().is_symlink() {
                return Err(DispatchError(format!(
                    "refusing interactive artifact path with symlink component: {}",
                    cursor.display()
                )));
            }
            if index + 1 < components.len() && !metadata.file_type().is_dir() {
                return Err(DispatchError(format!(
                    "refusing interactive artifact path with non-directory ancestor component: {}",
                    cursor.display()
                )));
            }
        }
    }
    Ok(())
}

fn render_launch_spec(
    target: &str,
    executable: &str,
    root: &Path,
    handoff: &Path,
    purpose: Option<NativePurpose>,
    native_scope: Option<&NativeSessionScope>,
    native_mcp: Option<&NativeMcpDescriptor>,
) -> Result<String, DispatchError> {
    ensure_inside(root, handoff)?;
    // This is intentionally the entire schema: no command string, prompt/model material, auth,
    // provider state, or session identity can be represented here.
    let document = match (purpose, native_mcp) {
        // TASK-379 v1 remains byte-for-byte schema-compatible for its enrichment consumer.
        (None, None) => json!({
            "version": LAUNCH_SPEC_VERSION,
            "target": target,
            "executable": executable,
            "argv": [],
            "cwd": root,
            "artifact_root": root,
            "handoff_path": handoff,
        }),
        (Some(purpose), None) => json!({
            "version": NATIVE_SESSION_LAUNCH_SPEC_VERSION,
            "target": target,
            "purpose": purpose.as_str(),
            "executable": executable,
            // Claude needs an explicit native agent selection; Codex loads the named skill from
            // its repository-scoped discovery artifacts. Both values are dispatcher-authored.
            "argv": if target == "claude-code:interactive" {
                json!(["--agent", purpose.claude_agent()])
            } else {
                json!([])
            },
            "agent": if target == "claude-code:interactive" {
                json!({ "kind": "claude_agent", "name": purpose.claude_agent() })
            } else {
                json!({ "kind": "codex_skill", "name": purpose.codex_skill() })
            },
            "scope": native_scope.expect("v2 native scope preflighted").launch_value(),
            "cwd": root,
            "artifact_root": root,
            "handoff_path": handoff,
        }),
        (Some(purpose), Some(_)) => json!({
            "version": NATIVE_SESSION_MCP_LAUNCH_SPEC_VERSION,
            "target": target,
            "purpose": purpose.as_str(),
            "executable": executable,
            "argv": if target == "claude-code:interactive" {
                json!(["--agent", purpose.claude_agent()])
            } else {
                json!([])
            },
            "agent": if target == "claude-code:interactive" {
                json!({ "kind": "claude_agent", "name": purpose.claude_agent() })
            } else {
                json!({ "kind": "codex_skill", "name": purpose.codex_skill() })
            },
            "mcp": {
                "server_name": NATIVE_MCP_SERVER_NAME,
                "credential_env_var": NATIVE_MCP_CREDENTIAL_ENV_VAR,
            },
            "cwd": root,
            "artifact_root": root,
            "handoff_path": handoff,
        }),
        (None, Some(_)) => {
            return Err(DispatchError(
                "--native-mcp requires a native Sessions --purpose".to_string(),
            ))
        }
    };
    serde_json::to_string_pretty(&document)
        .map(|v| format!("{v}\n"))
        .map_err(|e| DispatchError(e.to_string()))
}

fn ownership_document(
    marker: &str,
    paths: &[String],
    root: &Path,
) -> Result<String, DispatchError> {
    let artifacts = paths
        .iter()
        .map(|path| {
            let bytes = fs::read(root.join(path))
                .map_err(|e| DispatchError(format!("read owned artifact {path}: {e}")))?;
            Ok(json!({ "path": path, "sha256": format!("{:x}", Sha256::digest(bytes)) }))
        })
        .collect::<Result<Vec<_>, DispatchError>>()?;
    serde_json::to_string_pretty(&json!({ "marker": marker, "artifacts": artifacts }))
        .map(|v| format!("{v}\n"))
        .map_err(|e| DispatchError(e.to_string()))
}

fn verify_ownership(
    existing: &str,
    marker: &str,
    paths: &[String],
    root: &Path,
) -> Result<(), DispatchError> {
    let value: serde_json::Value = serde_json::from_str(existing).map_err(|_| {
        DispatchError("refusing to overwrite malformed interactive ownership record".to_string())
    })?;
    if value.get("marker").and_then(serde_json::Value::as_str) != Some(marker) {
        return Err(DispatchError("refusing to overwrite artifacts not owned by this exact Warble interactive emission plan".to_string()));
    }
    let artifacts = value
        .get("artifacts")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            DispatchError(
                "refusing to overwrite ownership record without per-artifact digests".to_string(),
            )
        })?;
    if artifacts.len() != paths.len() {
        return Err(DispatchError(
            "refusing to overwrite ownership record with a different artifact plan".to_string(),
        ));
    }
    for (artifact, path) in artifacts.iter().zip(paths) {
        if artifact.get("path").and_then(serde_json::Value::as_str) != Some(path.as_str()) {
            return Err(DispatchError(
                "refusing to overwrite ownership record with a different artifact plan".to_string(),
            ));
        }
        let bytes = fs::read(root.join(path)).map_err(|_| {
            DispatchError(format!(
                "refusing to overwrite missing owned artifact {path}"
            ))
        })?;
        let digest = format!("{:x}", Sha256::digest(bytes));
        if artifact.get("sha256").and_then(serde_json::Value::as_str) != Some(digest.as_str()) {
            return Err(DispatchError(format!(
                "refusing to overwrite modified owned artifact {path}"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::NativeMcpDescriptor;

    #[test]
    fn native_mcp_descriptor_debug_redacts_the_opaque_credential() {
        let descriptor = NativeMcpDescriptor {
            version: "1".to_string(),
            url: "https://mcp.example.test/native".to_string(),
            credential: "sentinel-opaque-native-mcp-credential".to_string(),
        };

        let rendered = format!("{descriptor:?}");
        assert!(rendered.contains("NativeMcpDescriptor"));
        assert!(rendered.contains("version: \"1\""));
        assert!(rendered.contains("url: \"https://mcp.example.test/native\""));
        assert!(rendered.contains("credential: \"[REDACTED]\""));
        assert!(!rendered.contains("sentinel-opaque-native-mcp-credential"));
    }
}
