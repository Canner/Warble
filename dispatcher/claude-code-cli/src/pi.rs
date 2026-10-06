//! Native pi session materialization. This emits discovery artifacts only; it never starts pi.
//!
//! pi (the `pi` coding-agent CLI) has no permission system of its own, so this target's whole
//! job is to author a launch contract that leaves the session nothing but the host-owned MCP
//! tools: every built-in tool is disabled through an explicit `--tools` allowlist, discovery of
//! project files, skills, extensions and prompt templates is switched off, the agent directory
//! is a server-owned directory this target writes, and the first prompt is authored here rather
//! than injected after spawn. The host owns the process, the transport and the credential.

use crate::codex::{is_dashboard_component, is_persisted_answer_component};
use crate::error::DispatchError;
use crate::interactive::{
    native_analysis_prompt_fragment, native_analysis_terminal_presentation_instructions,
    native_answer_persistence_instructions, native_dashboard_save_instructions,
    prepare_interactive_output_with_host, NativeEntryKind, NativeMcpDescriptor, NativePurpose,
    NativeSessionScope, PiLaunch, NATIVE_DASHBOARD_SAVE_TOOL, NATIVE_MCP_SERVER_NAME,
    NATIVE_PERSIST_ANSWER_TOOL, NATIVE_QUERY_TOOL,
};
use crate::ir::{
    reject_unsupported_component_composition, validate_ir_version, OutcomeKind, RealizationKind,
    TriggerKind, WarbleIr,
};
use crate::resolve::resolve_capabilities;
use crate::targets::TargetId;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

/// Where the authored system prompt lands, relative to the materialization root. pi receives it
/// through `--system-prompt <path>`, which replaces its default prompt.
pub const PI_SYSTEM_PROMPT_PATH: &str = ".warble/pi/SYSTEM.md";
/// The server-owned pi agent directory (`PI_CODING_AGENT_DIR`). pi needs it writable: it creates
/// an empty credential store and a trust lock there on first start.
pub const PI_AGENT_DIR_PATH: &str = ".warble/pi/agent";
pub const PI_SETTINGS_PATH: &str = ".warble/pi/agent/settings.json";
pub const PI_MCP_CONFIG_PATH: &str = ".warble/pi/agent/mcp.json";
/// The oldest pi release whose `--tools` allowlist keeps MCP tools when it names them. Older
/// releases drop every MCP tool under `--tools`, which would leave the session with no tools.
pub const PI_MINIMUM_VERSION: &str = "1.0.4";

/// The one session model a native pi session runs on, as pi names it: the provider id and the
/// exact model id inside that provider's catalog (built in, or supplied by the host's
/// `models.json` in the agent directory). Step tiers are not realized here — see the target's
/// capability profile — so one model is the whole binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiModel {
    pub provider: String,
    pub model: String,
}

impl PiModel {
    /// Parse `<provider>/<model-id>`. The provider id is the part before the first `/`; a model id
    /// may itself contain `/` (OpenRouter-style ids do).
    pub fn parse(value: &str) -> Result<Self, DispatchError> {
        let invalid = || {
            DispatchError(format!(
                "--pi-model must be `<provider>/<model-id>` with a non-empty provider id of \
                 letters, digits, `.`, `_` or `-` and a non-empty model id without whitespace \
                 or control characters, got {value:?}"
            ))
        };
        if value.len() > 256 {
            return Err(invalid());
        }
        let (provider, model) = value.split_once('/').ok_or_else(invalid)?;
        if provider.is_empty()
            || model.is_empty()
            || !provider
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
            || model.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(invalid());
        }
        Ok(PiModel {
            provider: provider.to_string(),
            model: model.to_string(),
        })
    }
}

pub fn emit_pi_interactive(
    ir: &WarbleIr,
    out_dir: &Path,
    purpose: Option<NativePurpose>,
    native_scope: Option<NativeSessionScope>,
    native_mcp: Option<NativeMcpDescriptor>,
    model: &PiModel,
) -> Result<(), DispatchError> {
    emit_pi_interactive_with_host(ir, out_dir, purpose, native_scope, native_mcp, None, model)
}

/// Explicit host-owned composition, requiring a v5-aware consumer.
pub fn emit_pi_interactive_with_host(
    ir: &WarbleIr,
    out_dir: &Path,
    purpose: Option<NativePurpose>,
    native_scope: Option<NativeSessionScope>,
    native_mcp: Option<NativeMcpDescriptor>,
    native_host: Option<crate::native_host::NativeHost>,
    model: &PiModel,
) -> Result<(), DispatchError> {
    validate_ir_version(ir)?;
    let target = TargetId::PiInteractive.as_str();
    // pi has no purpose-less (v1) launch contract and realizes only analysis today: setup needs
    // the bootstrap authority channel and context enrichment needs a human-approval apply gate,
    // neither of which a pi session carries. Name the arm rather than pick a nearby one.
    let purpose = match purpose {
        Some(NativePurpose::Analysis) => NativePurpose::Analysis,
        Some(other) => {
            return Err(DispatchError(format!(
                "{target} realizes only --purpose analysis; purpose '{}' is not materializable on this target (wall-hit)",
                other.as_str()
            )))
        }
        None => {
            return Err(DispatchError(format!(
                "{target} requires --purpose analysis with --native-scope and --native-mcp; it has no purpose-less launch contract"
            )))
        }
    };
    let scope = native_scope.ok_or_else(|| {
        DispatchError(
            "native Sessions purpose requires a server-derived native scope descriptor".to_string(),
        )
    })?;
    let descriptor = native_mcp.ok_or_else(|| {
        DispatchError(format!(
            "{target} requires --native-mcp: a pi session has no tools other than the host-owned MCP server"
        ))
    })?;
    if let Some(host) = &native_host {
        host.validate(ir, target, Some(purpose), Some(&scope), true)?;
    }
    let mut entry_ir = WarbleIr {
        components: ir
            .components
            .iter()
            .filter(|node| node.entrypoint)
            .cloned()
            .collect(),
        ..ir.clone()
    };
    // Validate the declared verb against all entries before projection can hide ambiguity.
    purpose.validate_profile(&entry_ir, &scope.entry)?;
    // The system prompt is built from exactly one component, so the session must be pinned: a
    // scope entry would ask pi to choose among entries it has no agent mechanism to choose with.
    let verb = match (scope.entry.kind, scope.entry.pinned_verb()) {
        (NativeEntryKind::Agent, Some(verb)) => verb.to_string(),
        _ => {
            return Err(DispatchError(format!(
                "native pi sessions pin one component through the scope entry verb and do not support scope entry ({target})"
            )))
        }
    };
    entry_ir.components.retain(|node| node.id == verb);
    let ir = &entry_ir;
    if native_host.is_none() {
        reject_unsupported_component_composition(ir, target)?;
    }
    let node = ir.components.first().ok_or_else(|| {
        DispatchError(format!(
            "{target}: the pinned entry '{verb}' is not an entry component of this profile"
        ))
    })?;
    if !matches!(node.trigger.kind, TriggerKind::OneShot)
        || !matches!(node.realization_kind, RealizationKind::Skill)
        || !matches!(node.effect.outcome.kind, OutcomeKind::None)
    {
        return Err(DispatchError(format!(
            "{target} cannot materialize component '{}' shape: only a one-shot skill with no outcome is realized on this target (wall-hit)",
            node.id
        )));
    }
    if native_host
        .as_ref()
        .is_none_or(|host| host.tool(&node.id).is_none())
    {
        resolve_capabilities(node, target, &TargetId::PiInteractive.profile())?;
    }
    // The tool allowlist is derived from component shape exactly the way the Codex discovery
    // config is: a host plan names its governed root tool; otherwise the persisted-answer shape
    // gets the persistence and query tools, and the persisted-answer and dashboard shapes both get
    // the dashboard save tool, matching what Codex enables for the same shapes.
    let include_persist_answer = is_persisted_answer_component(node);
    let include_dashboard_save = is_dashboard_component(node) || include_persist_answer;
    let mut tools: Vec<String> = match &native_host {
        Some(host) => {
            let mut names = host
                .tool_names()
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>();
            names.sort();
            names
        }
        None => {
            let mut names = Vec::new();
            if include_persist_answer {
                names.push(NATIVE_PERSIST_ANSWER_TOOL.to_string());
                names.push(NATIVE_QUERY_TOOL.to_string());
            }
            if include_dashboard_save {
                names.push(NATIVE_DASHBOARD_SAVE_TOOL.to_string());
            }
            names
        }
    };
    tools.dedup();
    if tools.is_empty() {
        return Err(DispatchError(format!(
            "{target} cannot materialize component '{}': no host MCP tool serves its shape, so the session would have no tools at all (wall-hit)",
            node.id
        )));
    }
    let signature = node.id.clone();
    let system_prompt_relative = PathBuf::from(PI_SYSTEM_PROMPT_PATH);
    let settings_relative = PathBuf::from(PI_SETTINGS_PATH);
    let mcp_relative = PathBuf::from(PI_MCP_CONFIG_PATH);
    let run_relative = PathBuf::from("RUN.md");
    let mut owned_paths = vec![
        system_prompt_relative.clone(),
        settings_relative.clone(),
        mcp_relative.clone(),
        run_relative.clone(),
    ];
    if native_host.is_some() {
        owned_paths.push(PathBuf::from(".warble/component-plans.json"));
    }
    let launch = PiLaunch {
        provider: model.provider.clone(),
        model: model.model.clone(),
        tools: tools
            .iter()
            .map(|tool| format!("mcp__{NATIVE_MCP_SERVER_NAME}__{tool}"))
            .collect(),
        system_prompt: system_prompt_relative.clone(),
        agent_dir: PathBuf::from(PI_AGENT_DIR_PATH),
    };
    let output = prepare_interactive_output_with_host(
        out_dir,
        target,
        "pi",
        &signature,
        &ir.profile,
        &owned_paths,
        Some(purpose),
        Some(scope.clone()),
        Some(descriptor.clone()),
        native_host.clone(),
        Some(launch),
    )?;

    let system_prompt = match &native_host {
        Some(host) => format!(
            "{}\n\n# GenBI analysis\n\n{}\n",
            output.marker(),
            host.instructions(node)
        ),
        None => build_system_prompt(
            node,
            output.marker(),
            include_persist_answer,
            include_dashboard_save,
        ),
    };
    let run = build_run(output.marker(), &node.id);
    let agent_dir = output.root.join(PI_AGENT_DIR_PATH);
    fs::create_dir_all(&agent_dir)
        .map_err(|e| DispatchError(format!("create pi agent dir: {e}")))?;
    fs::write(output.root.join(&system_prompt_relative), system_prompt)
        .map_err(|e| DispatchError(format!("write pi system prompt: {e}")))?;
    fs::write(output.root.join(&settings_relative), pi_settings())
        .map_err(|e| DispatchError(format!("write pi settings: {e}")))?;
    fs::write(
        output.root.join(&mcp_relative),
        descriptor.pi_discovery_config()?,
    )
    .map_err(|e| DispatchError(format!("write pi MCP discovery config: {e}")))?;
    fs::write(output.root.join(&run_relative), run)
        .map_err(|e| DispatchError(format!("write RUN.md: {e}")))?;
    output.write_ownership()?;
    output.write_launch_spec()
}

/// The server-owned `settings.json`. Trust is refused outright so a project `.pi/` directory can
/// never widen the tool surface; `defaultTools: []` is a second layer under the `--tools`
/// allowlist in the launch spec, never the first. Retries are the host's to decide, so pi's own
/// are off and a provider failure surfaces on the first event instead of after silent retries.
fn pi_settings() -> String {
    let settings = json!({
        "defaultProjectTrust": "never",
        "defaultTools": [],
        "enableAnalytics": false,
        "enableInstallTelemetry": false,
        "quietStartup": true,
        "retry": { "enabled": false },
    });
    format!(
        "{}\n",
        serde_json::to_string_pretty(&settings).expect("settings serialize")
    )
}

fn build_system_prompt(
    node: &crate::ir::ComponentNode,
    marker: &str,
    include_persist_answer: bool,
    include_dashboard_save: bool,
) -> String {
    let fragment = native_analysis_prompt_fragment(&node.prompt_fragment);
    let body = match &node.brief {
        Some(brief) => format!("{brief}\n\n{fragment}"),
        None => fragment,
    };
    let mut prompt = format!(
        "{marker}\n\n# GenBI analysis\n\n\
         Operate only within the server-bound project scope. Do not change cwd or follow a \
         caller-supplied project path.\n\n{body}\n\n\
         You have no shell, file, or network tools. The only tools available are the \
         `{NATIVE_MCP_SERVER_NAME}` MCP tools the host advertised. Do not read credentials or \
         expose raw material, and do not report a result you did not obtain through those tools.\n"
    );
    if include_persist_answer {
        prompt.push('\n');
        prompt.push_str(native_answer_persistence_instructions());
    }
    prompt.push('\n');
    prompt.push_str(native_analysis_terminal_presentation_instructions());
    if include_dashboard_save {
        prompt.push('\n');
        prompt.push_str(native_dashboard_save_instructions());
    }
    prompt
}

fn build_run(marker: &str, verb: &str) -> String {
    format!(
        "{marker}\n# Native pi analysis session\n\n\
         Read `.warble/interactive-launch.json`, then start `pi` in its canonical cwd with exactly \
         its `argv` (an RPC session) or exactly `pi.json_argv` (one JSON-mode turn), with \
         `PI_CODING_AGENT_DIR` set to `pi.agent_dir` and the MCP credential supplied in the \
         `mcp.credential_env_var` environment variable. Over RPC the caller sends `pi.first_prompt` \
         as the first `prompt` command. pi's built-in tools are disabled; the session is pinned to \
         the `{verb}` component and may use only the `pi.tools` MCP tools. The caller owns the \
         process, transport, transcript, and session lifecycle, and judges success from the event \
         stream, never from the exit code.\n"
    )
}
