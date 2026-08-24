//! Shared, deliberately small handoff contract for native interactive CLIs.

use crate::error::DispatchError;
use crate::ir::WarbleIr;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use url::{Host, Url};

pub const LAUNCH_SPEC_VERSION: &str = "1";
pub const NATIVE_SESSION_LAUNCH_SPEC_VERSION: &str = "2";
/// Native Sessions v4 adds the closed, producer-authored first prompt as the
/// final vendor argv element. The host must validate the whole argv exactly;
/// it must never write a prompt through the PTY after spawning.
pub const NATIVE_SESSION_MCP_LAUNCH_SPEC_VERSION: &str = "4";
pub const NATIVE_SCOPE_VERSION: &str = "2";
pub const NATIVE_WREN_RUNTIME_VERSION: &str = "1";
pub const NATIVE_MCP_DESCRIPTOR_VERSION: &str = "1";
pub const NATIVE_MCP_SERVER_NAME: &str = "genbi_session";
pub const NATIVE_MCP_CREDENTIAL_ENV_VAR: &str = "WARBLE_MCP_CONNECTION_CREDENTIAL";
pub const NATIVE_DASHBOARD_SAVE_TOOL: &str = "save_dashboard";
pub const NATIVE_PERSIST_ANSWER_TOOL: &str = "persist_answer";
/// The only project-creation root a native Setup TUI may receive. GenBI sets
/// this after it revalidates the producer-authored v4 bootstrap_root; callers
/// and browsers never supply it.
pub const NATIVE_SETUP_BOOTSTRAP_ROOT_ENV_VAR: &str = "WARBLE_SETUP_BOOTSTRAP_ROOT";

const CODEX_WREN_PERMISSION_PROFILE: &str = "warble_native_wren";

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

/// Native analysis keeps the structured step values as private orchestration
/// material while giving the person in the terminal a useful answer. Headless
/// dispatch remains the owner of the JSON result contract.
pub fn native_analysis_terminal_presentation_instructions() -> &'static str {
    r#"## Native terminal presentation

For the final response to the person in this interactive session, write concise conversational Markdown. Lead with the grounded answer, then include only a small table or bullets when they make the result clearer. Mention verification or query provenance only when it helps the person understand the conclusion.

The structured values used to coordinate steps are internal. Do not print a JSON result, render envelope, step envelope, orchestration field name, driver/subagent transcript, or tool request/response dump in the terminal. In particular, do not expose fields such as `warble_step`, `produces`, `query_result`, `repaired_result`, `columns`, `rows`, or `definition` as an internal payload. Programmatic and headless callers retain their structured JSON contracts; this rule changes only the native interactive presentation."#
}

/// Native analysis persists the final typed answer before turning it into a
/// conversational terminal response. The host owns the stored bytes and the
/// opaque reference; the driver must never invent a second payload shape.
pub fn native_answer_persistence_instructions() -> &'static str {
    r#"## Persist the final answer before presentation

After the final step has produced and validated the answer, but before writing any conversational Markdown, call `genbi_session.persist_answer` once with the exact typed answer envelope. Its `blocks` array contains exactly one `table` block with `columns` and `rows`, and zero or one `definition` block with `sql`, `source_tables`, and `filters`. Keep `verified: true`. Do not add a summary, chart, raw result, or any other block or representation.

```json
{
  "version": "1",
  "idempotency_key": "<stable retry key for this exact computed answer>",
  "envelope": {
    "blocks": [
      {"type": "table", "columns": ["..."], "rows": [["..."]]},
      {"type": "definition", "sql": "...", "source_tables": ["..."], "filters": ["..."]}
    ],
    "verified": true
  }
}
```

The `definition` block is optional; omit it rather than substituting another shape. `idempotency_key` is only for retrying this same already-computed persistence request, never caller-asserted provenance. On success, retain the host-returned `answer_ref` for a later dashboard save; keep `answer_ref`, the digest, and `persisted_at` internal rather than printing them in the terminal.

If persistence ultimately fails, do not recompute, rerun `answer_query`, generate SQL, or ask the user to supply the payload again. Still present the already-computed answer conversationally, followed by a concise honest warning that it was not retained and cannot later be saved by reference. Do not claim that it was retained or saved."#
}

/// Native analysis reuses the programmatic component IR for its data-work
/// instructions, but its final terminal response is deliberately not a JSON
/// transport. Keep this narrowly scoped to the authored final-output mandate:
/// the structured per-step contracts still coordinate the native workflow.
pub fn native_analysis_prompt_fragment(prompt: &str) -> String {
    prompt.replace(
        r#"FINAL message must be a single JSON object of the form
  `{"columns": ["model"], "rows": [["<model_name>"], ...]}` listing every model in the layer
  (one row per model), so coverage can be checked deterministically. You may add a short prose
  summary after the JSON."#,
        "final response should concisely summarize the semantic coverage in conversational Markdown.",
    )
}

/// Native Context Enrichment retains the proposal data model for the host, but
/// it is not a JSON transport for the person using a terminal.  Keep this
/// target-specific override at the emitter seam: the profile and its headless
/// consumers continue to own the canonical proposal contract.
pub fn native_context_enrichment_terminal_presentation_instructions() -> &'static str {
    r#"## Native context-enrichment presentation

For the final response to the person in this interactive session, write concise conversational Markdown, never JSON. Explain the proposed change in plain language, then cover its evidence and confidence, impact/risk, and destination in the semantic context. End with a clear choice: **accept**, **edit**, or **skip**.

In Grill mode, present only the one change currently awaiting a choice. If the proposal must pause because a prerequisite is missing or the destination is ambiguous, say that it is paused, explain the missing prerequisite or ambiguity and its risk, and ask what the person wants to clarify. Do not fabricate a draft to avoid a pause.

The proposal's structured values are internal host-coordination material. Do not print an `enrichment_proposal` JSON object, YAML payload, step envelope, orchestration field name, host/session/provider detail, tool request/response dump, or raw context material. In particular, do not expose labels such as `recommended_yaml`, `relative_sink`, `requires_approval`, `autopilot_eligible`, `project_revision`, or `produces` as a machine payload. Programmatic and headless callers retain their canonical structured proposal contracts; this rule changes only the native interactive presentation."#
}

/// Remove the profile's headless-only JSON-final requirement from an emitted
/// native Context Enrichment artifact.  Earlier prompt constraints remain the
/// source of truth for how a proposal is reasoned about; this only changes how
/// the completed proposal is presented in the terminal.
pub fn native_context_enrichment_prompt_fragment(prompt: &str) -> String {
    const HEADLESS_JSON_FINAL_MANDATE: &str = r#"Produce `enrichment_proposal`; approval, canonical hashes/digests, and application are deterministic
host responsibilities. Your FINAL message must be one JSON object only. Do not include prose or
Markdown fences. The top level is `{ "enrichment_proposal": { ... } }`; for Grill it contains the
supplied `project_revision`, exactly one operation with `relative_sink` and `recommended_yaml`,
confidence/evidence locators, `impact: "high"`, `requires_approval: true`,
`autopilot_eligible: false`, and one decision whose allowed responses are exactly
`["accept", "edit", "skip"]`."#;

    prompt.replace(
        HEADLESS_JSON_FINAL_MANDATE,
        "Prepare the same safe, read-only proposal internally, then give the person a concise conversational Markdown summary. Explain the proposed change, evidence and confidence, impact/risk, and destination without exposing the proposal's JSON or field names. In Grill mode, ask for exactly one of: accept, edit, or skip. If a prerequisite is missing or the destination is ambiguous, explain that the proposal is paused instead of inventing a draft.",
    )
}

/// The host owns persistence for a native dashboard session. This instruction
/// is emitted only when the server supplied the allowlisted session MCP.
pub fn native_dashboard_save_instructions() -> &'static str {
    r#"## Save a GenBI dashboard

When the user asks to create or save a dashboard from a prior answer, call `genbi_session.save_dashboard` exactly for that persistence action. When the retained `answer_ref` is still available in this conversation, prefer the exact reference:

```json
{
  "version": "1",
  "name": "<concise dashboard name>",
  "answer_ref": "<answer_ref returned by persist_answer>",
  "idempotency_key": "<stable key for this same dashboard request>"
}
```

If the user asks to save this or the most recent answer and the opaque `answer_ref` is no longer available in the conversation, use the host-owned session selector instead of refusing or recomputing:

```json
{
  "version": "1",
  "name": "<concise dashboard name>",
  "answer_selection": "latest",
  "idempotency_key": "<stable key for this same dashboard request>"
}
```

Provide exactly one of `answer_ref` or `answer_selection`. Reuse the same idempotency key when retrying the same request; choose a new key only for a materially new dashboard request. The host reuses the exact stored bytes for the selected answer and resolves `latest` only within this native session. Do not use `latest` when the user explicitly identifies an older answer whose reference is unavailable; explain that the older reference cannot be recovered. Do not rerun `answer_query`, generate SQL, repair SQL, or otherwise recompute; do not re-supply or reconstruct the payload. If the host reports that no persisted answer is available, say that reference saving is unavailable rather than claiming a save or attempting recomputation. The saved dashboard appears on the **GenBI Artifacts page**. Do not substitute a vendor-hosted Artifact feature, artifact URL, share URL, or any external vendor-hosted link for `genbi_session.save_dashboard`. Do not claim it was saved unless that tool succeeds."#
}

/// Shared vendor-neutral instruction for Setup's two-root launch contract.
/// The private materialization cwd contains only dispatcher artifacts; the
/// explicit server-owned environment value is the sole creation authority.
pub fn setup_bootstrap_authority_instructions() -> String {
    format!(
        r#"## Setup bootstrap write authority

`{NATIVE_SETUP_BOOTSTRAP_ROOT_ENV_VAR}` is set by the host to the only server-authorized project-creation root for this Setup session. Create or modify project files only below that exact root. Do not write into the current working directory (it contains private launch artifacts), do not change cwd to broaden authority, and do not write outside the configured bootstrap root. Treat a missing, relative, or unexpected value as a host-configuration failure: do not guess a path or accept one from the user.
"#
    )
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
    /// Setup alone carries this separately authorized project-creation root.
    /// `cwd` remains the native materialization root and must equal `--out`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bootstrap_root: Option<PathBuf>,
    /// Optional to preserve the existing cross-vendor native scope contract. Native Codex
    /// materialization requires this exact server-resolved launcher and Python runtime closure;
    /// it is never derived from the browser, environment, or PATH by the dispatcher.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wren_runtime: Option<NativeWrenRuntime>,
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

/// A closed, server-derived Wren launcher chain. The Codex sandbox's `read` filesystem grant
/// includes execution permission, so its rendered entries must be the minimum transitive closure:
/// the PATH shim, the generated console-script launcher, the venv Python symlink, both runtime
/// library roots, and the server-pinned editable Wren source root that the venv's closed `.pth`
/// resolver names.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeWrenRuntime {
    pub version: String,
    pub shim: PathBuf,
    pub launcher: PathBuf,
    pub venv_python: PathBuf,
    pub tool_root: PathBuf,
    pub site_packages: PathBuf,
    pub source_root: PathBuf,
    pub interpreter: PathBuf,
    pub interpreter_root: PathBuf,
}

struct CanonicalWrenRuntime {
    shim: PathBuf,
    shim_parent: PathBuf,
    launcher: PathBuf,
    venv_python: PathBuf,
    tool_bin: PathBuf,
    tool_pyvenv: PathBuf,
    site_packages: PathBuf,
    interpreter: PathBuf,
    interpreter_bin: PathBuf,
    interpreter_lib: PathBuf,
    source_root: PathBuf,
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

    pub fn codex_discovery_config(
        &self,
        enable_setup_recovery_tool: bool,
        enable_dashboard_save_tool: bool,
        enable_persist_answer_tool: bool,
    ) -> String {
        // JSON strings are valid TOML basic strings and give us a single established escaping
        // primitive for the server URL. Codex reads the credential only at native-process launch.
        let mut config = format!(
            "[mcp_servers.{NATIVE_MCP_SERVER_NAME}]\nurl = {}\nbearer_token_env_var = {}\n",
            serde_json::to_string(&self.url).expect("MCP URL serializes"),
            serde_json::to_string(NATIVE_MCP_CREDENTIAL_ENV_VAR)
                .expect("credential env name serializes"),
        );
        let mut enabled_tools = Vec::new();
        if enable_setup_recovery_tool {
            enabled_tools.push("report_setup_recovery");
        }
        if enable_dashboard_save_tool {
            enabled_tools.push(NATIVE_DASHBOARD_SAVE_TOOL);
        }
        if enable_persist_answer_tool {
            enabled_tools.push(NATIVE_PERSIST_ANSWER_TOOL);
        }
        if !enabled_tools.is_empty() {
            config.push_str(&format!(
                "enabled_tools = {}\n",
                serde_json::to_string(&enabled_tools).expect("MCP tool names serialize"),
            ));
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

    fn validate_preflight(&self, purpose: NativePurpose) -> Result<(), DispatchError> {
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
        match (&self.kind[..], &self.binding, &self.bootstrap_root) {
            ("bootstrap", None, Some(bootstrap_root)) => {
                if !bootstrap_root.is_absolute() {
                    return Err(DispatchError(
                        "bootstrap native session scope root must be an absolute server-derived path".to_string(),
                    ));
                }
                let canonical_bootstrap_root = fs::canonicalize(bootstrap_root).map_err(|e| {
                    DispatchError(format!(
                        "canonicalize bootstrap native session scope root {}: {e}",
                        bootstrap_root.display()
                    ))
                })?;
                if *bootstrap_root != canonical_bootstrap_root {
                    return Err(DispatchError(
                        "bootstrap native session scope root must already be canonical".to_string(),
                    ));
                }
                Ok(())
            }
            ("bootstrap", None, None) => Err(DispatchError(
                "bootstrap native session scope requires a separately authorized bootstrap_root"
                    .to_string(),
            )),
            ("bootstrap", Some(_), _) => Err(DispatchError(
                "bootstrap native session scope must not carry a bound-project identity".to_string(),
            )),
            ("bound_project", Some(binding), None)
                if !binding.project_identity.trim().is_empty()
                    && !binding.generation.trim().is_empty()
                    && !binding.revision.trim().is_empty() =>
            {
                Ok(())
            }
            ("bound_project", _, Some(_)) => Err(DispatchError(
                "bound_project native session scope must not carry a bootstrap_root".to_string(),
            )),
            ("bound_project", _, None) => Err(DispatchError(
                "bound_project native session scope requires non-empty project_identity, generation, and revision"
                    .to_string(),
            )),
            _ => unreachable!("purpose mapping has a closed scope vocabulary"),
        }
    }

    fn validate(&self, purpose: NativePurpose, root: &Path) -> Result<(), DispatchError> {
        self.validate_preflight(purpose)?;
        let scope_cwd = match fs::canonicalize(&self.cwd) {
            Ok(canonical) => {
                if self.cwd != canonical {
                    return Err(DispatchError(
                        "native session scope cwd must already be canonical".to_string(),
                    ));
                }
                canonical
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && self.cwd == root => {
                root.to_path_buf()
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(DispatchError(format!(
                    "native session scope cwd {} does not match canonical output root {}",
                    self.cwd.display(),
                    root.display()
                )))
            }
            Err(error) => {
                return Err(DispatchError(format!(
                    "canonicalize native session scope cwd {}: {error}",
                    self.cwd.display()
                )))
            }
        };
        if scope_cwd != root {
            return Err(DispatchError(format!(
                "native session scope cwd {} does not match canonical output root {}",
                scope_cwd.display(),
                root.display()
            )));
        }
        if let Some(bootstrap_root) = &self.bootstrap_root {
            let canonical_bootstrap_root = fs::canonicalize(bootstrap_root).map_err(|e| {
                DispatchError(format!(
                    "canonicalize bootstrap native session scope root {}: {e}",
                    bootstrap_root.display()
                ))
            })?;
            if canonical_bootstrap_root == root {
                return Err(DispatchError(
                    "bootstrap native session scope root must be distinct from the canonical output root"
                        .to_string(),
                ));
            }
        }
        Ok(())
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
            "bootstrap_root": self.bootstrap_root.as_ref().map(|root| {
                fs::canonicalize(root).expect("validated bootstrap root remains canonicalizable")
            }),
            "wren_runtime": self.wren_runtime,
            "binding": self.binding,
        });
        let bytes = serde_json::to_vec(&canonical).expect("canonical native scope serializes");
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    fn launch_value(&self) -> serde_json::Value {
        json!({
            "kind": self.kind,
            "scope_id": self.scope_id,
            "bootstrap_root": self.bootstrap_root.as_ref().map(|root| {
                fs::canonicalize(root).expect("validated bootstrap root remains canonicalizable")
            }),
            "binding": self.binding,
        })
    }

    /// Render the complete, server-selected Codex permission profile. It deliberately has no
    /// caller-selected filesystem, executable, PATH, browser, credential, or network input.
    pub fn codex_permission_profile(&self) -> Result<String, DispatchError> {
        let mut config = self
            .wren_runtime
            .as_ref()
            .ok_or_else(|| {
                DispatchError(
                    "native Codex purpose requires a server-derived wren_runtime closure"
                        .to_string(),
                )
            })?
            .codex_permission_profile()?;
        config.push_str(&format!(
            "\n[permissions.{CODEX_WREN_PERMISSION_PROFILE}.filesystem.\":workspace_roots\"]\n"
        ));
        if self.kind == "bootstrap" {
            let bootstrap_root = self.bootstrap_root.as_ref().ok_or_else(|| {
                DispatchError(
                    "bootstrap native session scope requires a separately authorized bootstrap_root"
                        .to_string(),
                )
            })?;
            let canonical_bootstrap_root = fs::canonicalize(bootstrap_root).map_err(|_| {
                DispatchError("bootstrap native session scope root is unavailable".to_string())
            })?;
            if *bootstrap_root != canonical_bootstrap_root {
                return Err(DispatchError(
                    "bootstrap native session scope root must already be canonical".to_string(),
                ));
            }
            // The native cwd is a private artifact root: readable for discovery, never writable
            // by Setup. Only the separately authorized bootstrap root receives write authority.
            config.push_str("\".\" = \"read\"\n");
            config.push_str(&format!(
                "{} = \"write\"\n",
                serde_json::to_string(&canonical_bootstrap_root.to_string_lossy())
                    .expect("bootstrap root serializes")
            ));
        } else {
            config.push_str("\".\" = \"write\"\n");
        }
        Ok(config)
    }

    /// Claude's permission grammar carries the same server-selected Setup
    /// root as its only Edit/Write scope. The string is generated only after
    /// NativeSessionScope::validate has canonicalized the sealed descriptor.
    pub fn claude_setup_write_permissions(&self) -> Result<[String; 2], DispatchError> {
        let bootstrap_root = self.bootstrap_root.as_ref().ok_or_else(|| {
            DispatchError(
                "bootstrap native session scope requires a separately authorized bootstrap_root"
                    .to_string(),
            )
        })?;
        let canonical_bootstrap_root = fs::canonicalize(bootstrap_root).map_err(|_| {
            DispatchError("bootstrap native session scope root is unavailable".to_string())
        })?;
        if self.kind != "bootstrap" || *bootstrap_root != canonical_bootstrap_root {
            return Err(DispatchError(
                "bootstrap native session scope root is incompatible".to_string(),
            ));
        }
        let recursive = canonical_bootstrap_root
            .join("**")
            .to_string_lossy()
            .to_string();
        Ok([format!("Edit({recursive})"), format!("Write({recursive})")])
    }
}

impl NativeWrenRuntime {
    fn validate(&self) -> Result<CanonicalWrenRuntime, DispatchError> {
        if self.version != NATIVE_WREN_RUNTIME_VERSION {
            return Err(DispatchError(format!(
                "unsupported native Wren runtime version '{}' (expected: {NATIVE_WREN_RUNTIME_VERSION})",
                self.version
            )));
        }

        let tool_root = canonical_directory(&self.tool_root, "tool_root")?;
        let interpreter_root = canonical_directory(&self.interpreter_root, "interpreter_root")?;
        let site_packages = canonical_directory(&self.site_packages, "site_packages")?;
        let source_root = canonical_directory(&self.source_root, "source_root")?;
        let launcher = canonical_regular_file(&self.launcher, "launcher")?;
        let interpreter = canonical_regular_file(&self.interpreter, "interpreter")?;
        let shim = canonical_regular_file(&self.shim, "shim")?;
        let venv_python = canonical_regular_file(&self.venv_python, "venv_python")?;
        let shim_parent = canonical_directory(
            self.shim.parent().ok_or_else(|| {
                DispatchError("native Wren runtime shim must have a parent directory".to_string())
            })?,
            "shim parent",
        )?;

        let tool_bin = tool_root.join("bin");
        let interpreter_bin = interpreter_root.join("bin");
        let tool_pyvenv = tool_root.join("pyvenv.cfg");
        let tool_lib = tool_root.join("lib");
        let interpreter_lib = interpreter_root.join("lib");
        for (path, label) in [
            (&tool_bin, "tool_root/bin"),
            (&interpreter_bin, "interpreter_root/bin"),
            (&interpreter_lib, "interpreter_root/lib"),
        ] {
            if !path.is_dir() {
                return Err(DispatchError(format!(
                    "native Wren runtime {label} must be an existing directory"
                )));
            }
        }
        if !tool_pyvenv.is_file() {
            return Err(DispatchError(
                "native Wren runtime tool_root/pyvenv.cfg must be an existing regular file"
                    .to_string(),
            ));
        }
        if !site_packages.starts_with(&tool_lib) {
            return Err(DispatchError(
                "native Wren runtime site_packages must be inside tool_root/lib".to_string(),
            ));
        }
        let editable_pth = site_packages.join("_editable_impl_wrenai.pth");
        let editable_source = fs::read_to_string(&editable_pth)
            .ok()
            .and_then(|contents| {
                let paths = contents
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .collect::<Vec<_>>();
                let [path] = paths.as_slice() else {
                    return None;
                };
                Path::new(path).is_absolute().then(|| PathBuf::from(path))
            })
            .and_then(|path| fs::canonicalize(path).ok());
        if editable_source.as_deref() != Some(source_root.as_path())
            || !source_root.join("wren/__init__.py").is_file()
        {
            return Err(DispatchError(
                "native Wren runtime editable source must exactly match the server-approved .pth closure"
                    .to_string(),
            ));
        }

        // The launcher and venv-Python names are fixed contract points rather than flexible
        // command inputs. A server must resolve the real chain before handing it to Warble.
        if self.launcher != tool_bin.join("wren") || self.venv_python != tool_bin.join("python") {
            return Err(DispatchError(
                "native Wren runtime launcher chain must use tool_root/bin/wren and tool_root/bin/python"
                    .to_string(),
            ));
        }
        if !fs::symlink_metadata(&self.shim)
            .map_err(|e| {
                DispatchError(format!(
                    "inspect native Wren runtime shim {}: {e}",
                    self.shim.display()
                ))
            })?
            .file_type()
            .is_symlink()
        {
            return Err(DispatchError(
                "native Wren runtime shim must be a symlink to the server-approved launcher"
                    .to_string(),
            ));
        }
        if !fs::symlink_metadata(&self.venv_python)
            .map_err(|e| {
                DispatchError(format!(
                    "inspect native Wren runtime venv_python {}: {e}",
                    self.venv_python.display()
                ))
            })?
            .file_type()
            .is_symlink()
        {
            return Err(DispatchError(
                "native Wren runtime tool_root/bin/python must be a symlink to the server-approved interpreter"
                    .to_string(),
            ));
        }
        if shim != launcher
            || venv_python != interpreter
            || !interpreter.starts_with(&interpreter_bin)
        {
            return Err(DispatchError(
                "native Wren runtime shim/interpreter chain does not resolve to the declared closure"
                    .to_string(),
            ));
        }
        if !is_executable(&launcher) || !is_executable(&interpreter) {
            return Err(DispatchError(
                "native Wren runtime launcher and interpreter must be executable regular files"
                    .to_string(),
            ));
        }
        let shebang = fs::read_to_string(&launcher)
            .map_err(|e| {
                DispatchError(format!(
                    "read native Wren launcher {}: {e}",
                    launcher.display()
                ))
            })?
            .lines()
            .next()
            .and_then(|line| line.strip_prefix("#!"))
            .filter(|path| !path.is_empty() && !path.contains(char::is_whitespace))
            .map(PathBuf::from)
            .ok_or_else(|| {
                DispatchError(
                    "native Wren runtime launcher must start with an absolute interpreter shebang"
                        .to_string(),
                )
            })?;
        if !shebang.is_absolute() || shebang != self.venv_python {
            return Err(DispatchError(
                "native Wren runtime launcher shebang must exactly name tool_root/bin/python"
                    .to_string(),
            ));
        }

        Ok(CanonicalWrenRuntime {
            shim: self.shim.clone(),
            shim_parent,
            launcher: self.launcher.clone(),
            venv_python: self.venv_python.clone(),
            tool_bin,
            tool_pyvenv,
            site_packages: self.site_packages.clone(),
            interpreter: self.interpreter.clone(),
            interpreter_bin,
            interpreter_lib,
            source_root: self.source_root.clone(),
        })
    }

    fn codex_permission_profile(&self) -> Result<String, DispatchError> {
        let paths = self.validate()?;
        let entry = |path: &Path| {
            format!(
                "{} = \"read\"\n",
                serde_json::to_string(&path.to_string_lossy()).expect("runtime path serializes")
            )
        };
        let mut config = format!(
            "# Server-owned native Wren runtime closure. `read` is Codex's read-and-execute\n# filesystem grant; no PATH, browser, credential, or caller filesystem input is accepted.\ndefault_permissions = \"{CODEX_WREN_PERMISSION_PROFILE}\"\n\n[permissions.{CODEX_WREN_PERMISSION_PROFILE}]\ndescription = \"Warble native session workspace plus exact Wren runtime closure\"\n\n[permissions.{CODEX_WREN_PERMISSION_PROFILE}.filesystem]\n\":minimal\" = \"read\"\n"
        );
        for path in [
            &paths.shim,
            &paths.shim_parent,
            &paths.tool_bin,
            &paths.launcher,
            &paths.venv_python,
            &paths.tool_pyvenv,
            &paths.site_packages,
            &paths.interpreter,
            &paths.interpreter_bin,
            &paths.interpreter_lib,
            &paths.source_root,
        ] {
            config.push_str(&entry(path));
        }
        Ok(config)
    }
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, DispatchError> {
    if !path.is_absolute() {
        return Err(DispatchError(format!(
            "native Wren runtime {label} must be an absolute server-derived path"
        )));
    }
    let canonical = fs::canonicalize(path).map_err(|e| {
        DispatchError(format!(
            "canonicalize native Wren runtime {label} {}: {e}",
            path.display()
        ))
    })?;
    canonical.is_dir().then_some(canonical).ok_or_else(|| {
        DispatchError(format!(
            "native Wren runtime {label} must be an existing directory"
        ))
    })
}

fn canonical_regular_file(path: &Path, label: &str) -> Result<PathBuf, DispatchError> {
    if !path.is_absolute() {
        return Err(DispatchError(format!(
            "native Wren runtime {label} must be an absolute server-derived path"
        )));
    }
    let canonical = fs::canonicalize(path).map_err(|e| {
        DispatchError(format!(
            "canonicalize native Wren runtime {label} {}: {e}",
            path.display()
        ))
    })?;
    canonical.is_file().then_some(canonical).ok_or_else(|| {
        DispatchError(format!(
            "native Wren runtime {label} must be an existing regular file"
        ))
    })
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
    false
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

    /// The one initial interactive prompt for this closed native purpose.
    ///
    /// This is deliberately data owned by the producer's purpose enum, rather
    /// than a browser value or terminal write. Both vendor CLIs accept one
    /// positional prompt while staying interactive, so it is passed as a
    /// single argv element without invoking a shell.
    pub fn welcome_prompt(self) -> &'static str {
        match self {
            Self::Setup => "Help me set up this GenBI project. Start by explaining the next setup step and ask what data source I want to connect.",
            Self::Analysis => "Help me analyze this data. Ask me what question I want to answer about the server-bound project.",
            Self::ContextEnrichment => "Help me inspect this project's context and draft a read-only enrichment proposal. Do not apply changes; ask what context I want to review.",
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

enum ResolvedInteractiveOutput {
    Existing(PathBuf),
    Missing(PathBuf),
}

fn resolve_interactive_output(path: &Path) -> Result<ResolvedInteractiveOutput, DispatchError> {
    let mut resolved = if path.is_absolute() {
        PathBuf::new()
    } else {
        let current = std::env::current_dir()
            .map_err(|e| DispatchError(format!("resolve current directory: {e}")))?;
        fs::canonicalize(&current).map_err(|e| {
            DispatchError(format!(
                "canonicalize current directory {}: {e}",
                current.display()
            ))
        })?
    };
    let mut missing = false;
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if missing {
                    return Err(DispatchError(format!(
                        "interactive output cannot traverse '..' after a missing component: {}",
                        path.display()
                    )));
                }
                let parent = resolved.parent().unwrap_or(resolved.as_path());
                resolved = fs::canonicalize(parent).map_err(|e| {
                    DispatchError(format!(
                        "resolve interactive output parent {}: {e}",
                        parent.display()
                    ))
                })?;
            }
            Component::Prefix(_) | Component::RootDir => {
                resolved.push(component.as_os_str());
            }
            Component::Normal(name) if missing => resolved.push(name),
            Component::Normal(name) => {
                if !resolved.as_os_str().is_empty() {
                    let metadata = fs::metadata(&resolved).map_err(|e| {
                        DispatchError(format!(
                            "inspect interactive output ancestor {}: {e}",
                            resolved.display()
                        ))
                    })?;
                    if !metadata.is_dir() {
                        return Err(DispatchError(format!(
                            "interactive dispatch output has a non-directory ancestor: {}",
                            resolved.display()
                        )));
                    }
                }
                let next = resolved.join(name);
                match fs::symlink_metadata(&next) {
                    Ok(_) => {
                        resolved = fs::canonicalize(&next).map_err(|e| {
                            DispatchError(format!(
                                "resolve interactive output component {}: {e}",
                                next.display()
                            ))
                        })?;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        resolved = next;
                        missing = true;
                    }
                    Err(error) => {
                        return Err(DispatchError(format!(
                            "inspect interactive output component {}: {error}",
                            next.display()
                        )))
                    }
                }
            }
        }
    }

    if missing {
        Ok(ResolvedInteractiveOutput::Missing(resolved))
    } else if fs::metadata(&resolved)
        .map_err(|e| {
            DispatchError(format!(
                "inspect interactive dispatch output {}: {e}",
                path.display()
            ))
        })?
        .is_dir()
    {
        Ok(ResolvedInteractiveOutput::Existing(resolved))
    } else {
        Err(DispatchError(format!(
            "interactive dispatch output exists but is not a directory: {}",
            path.display()
        )))
    }
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
    match (purpose, native_scope.as_ref()) {
        (Some(purpose), Some(scope)) => scope.validate_preflight(purpose)?,
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
    let (prospective_root, create_root) = match resolve_interactive_output(out_dir)? {
        ResolvedInteractiveOutput::Existing(root) => (root, false),
        ResolvedInteractiveOutput::Missing(root) => (root, true),
    };
    if let (Some(purpose), Some(scope)) = (purpose, native_scope.as_ref()) {
        scope.validate(purpose, &prospective_root)?;
    }
    if create_root {
        fs::create_dir_all(out_dir).map_err(|e| {
            DispatchError(format!(
                "create interactive output directory {}: {e}",
                out_dir.display()
            ))
        })?;
    }
    let root = fs::canonicalize(out_dir).map_err(|e| {
        DispatchError(format!(
            "canonicalize interactive output {}: {e}",
            out_dir.display()
        ))
    })?;
    if root != prospective_root {
        return Err(DispatchError(format!(
            "interactive output canonical path changed during creation: expected {}, got {}",
            prospective_root.display(),
            root.display()
        )));
    }
    if let (Some(purpose), Some(scope)) = (purpose, native_scope.as_ref()) {
        scope.validate(purpose, &root)?;
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
                Some("RUN.md" | "AGENTS.md" | "SKILL.md" | "CLAUDE.md")
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
        // v1 remains byte-for-byte schema-compatible for its enrichment consumer.
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
        (Some(purpose), Some(_)) => {
            let mut document = json!({
                "version": NATIVE_SESSION_MCP_LAUNCH_SPEC_VERSION,
                "target": target,
                "purpose": purpose.as_str(),
                "executable": executable,
            // Both interactive CLIs accept one positional prompt. Keeping it
            // in this closed argv contract makes the first turn exactly-once
            // without a shell or post-spawn PTY input injection.
                "argv": if target == "claude-code:interactive" {
                    json!(["--agent", purpose.claude_agent(), purpose.welcome_prompt()])
                } else {
                    json!([purpose.welcome_prompt()])
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
            });
            if purpose == NativePurpose::Setup {
                document
                    .as_object_mut()
                    .expect("launch spec is an object")
                    .insert(
                        "bootstrap_root".to_string(),
                        serde_json::to_value(
                            native_scope
                                .expect("v4 Setup native scope preflighted")
                                .bootstrap_root
                                .as_ref()
                                .map(|root| {
                                    fs::canonicalize(root)
                                        .expect("validated bootstrap root remains canonicalizable")
                                }),
                        )
                        .expect("bootstrap root serializes"),
                    );
            }
            document
        }
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
