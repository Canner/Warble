//! Hybrid (`llm:per_step_provider`) file-target realization: LOCAL steps run on a non-Anthropic
//! provider via either an emitted Bash local-inference script or a `warble mcp-serve` MCP tool, while
//! CLOUD steps stay the driver's own `wren` work.

use super::agent::{to_yaml, AgentFrontmatter};
use super::fs_util::mkdir_all;
use super::gate::build_description;
use super::settings::wren_config;
use super::support::{
    find_guardrail, outcome_supported, realization_supported, trigger_supported, unsupported,
    ARTIFACT_WRITE_GUARDRAIL_NAME, DESTRUCTIVE_BASH_DENY_PATTERNS,
};
use crate::error::DispatchError;
use crate::ir::{LlmCall, WarbleIr};
use crate::models::{ModelConfig, Provider};
use std::fs;
use std::path::Path;

/// Emit Claude Code agent runtime files for a resolved IR into `out_dir`, using the default tier →
/// model binding (`strong→opus`, `cheap→haiku`, orchestrator `sonnet`). See
/// [`emit_claude_code_with_models`] to override the mapping at dispatch.
/// True if any step in the IR binds to a non-Anthropic provider (i.e. the binding is hybrid). The
/// dispatch takes the bash-script path in that case (only valid once the provider gate has passed).
pub(super) fn any_local_provider(
    ir: &WarbleIr,
    models: &ModelConfig,
) -> Result<bool, DispatchError> {
    for node in &ir.components {
        for call in &node.llm_calls {
            if models.binding(&call.tier)?.provider != Provider::Anthropic {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// The generic local-inference helper the emitted bash-script scripts call (OpenAI-compatible chat,
/// e.g. ollama). Pure stdlib (urllib) so it runs under any python3; no deps to install.
const LOCAL_INFER_PY: &str = r#"#!/usr/bin/env python3
# Emitted by `warble dispatch` for the hybrid (bash-script) file target. Calls an OpenAI-compatible
# chat endpoint (e.g. ollama) for ONE step that a binding routed to a local provider. On success it
# appends a per-step line to --trace (JSONL) so a run is self-evidencing: which steps actually ran on
# which local model. (Cloud steps run inside `claude`, not here, so they are not in this trace.)
import argparse, json, sys, time, urllib.request
p = argparse.ArgumentParser()
p.add_argument("--step", default="")
p.add_argument("--endpoint", required=True)
p.add_argument("--model", required=True)
p.add_argument("--system-file", required=True)
p.add_argument("--trace", default="")
p.add_argument("--user", required=True)
a = p.parse_args()
system = open(a.system_file, encoding="utf-8").read()
body = json.dumps({
    "model": a.model,
    "messages": [{"role": "system", "content": system}, {"role": "user", "content": a.user}],
    "stream": False, "temperature": 0,
}).encode()
req = urllib.request.Request(a.endpoint.rstrip("/") + "/chat/completions", data=body,
                            headers={"content-type": "application/json"})
try:
    resp = json.load(urllib.request.urlopen(req, timeout=120))
    content = resp["choices"][0]["message"]["content"]
except Exception as e:  # loud-fail so the orchestrator sees it, never a silent empty step
    sys.stderr.write("local_infer error: %s\n" % e)
    sys.exit(1)
sys.stdout.write(content)
if a.trace:
    try:
        with open(a.trace, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "step": a.step,
                "provider": "openai_compat", "model": a.model, "endpoint": a.endpoint,
                "input_chars": len(a.user), "output_chars": len(content),
            }) + "\n")
    except Exception:
        pass  # trace is best-effort; never fail the step over it
"#;

/// Emit the hybrid (bash-script) realization of `llm:per_step_provider` for the file target: the LOCAL
/// step(s) become an emitted local-inference script the driver runs via Bash; the CLOUD steps stay the
/// driver's own `wren` work at its (strong) tier. POC scope: render-none analytical one_shot components
/// (answer_query), with a single cloud tier hosting the driver. Anything else loud-fails.
pub(super) fn emit_hybrid_file_target(
    ir: &WarbleIr,
    out_dir: &Path,
    target_id: &str,
    models: &ModelConfig,
) -> Result<(), DispatchError> {
    let claude_dir = out_dir.join(".claude");
    let agents_dir = claude_dir.join("agents");
    let scripts_dir = out_dir.join("scripts");
    let wren_dir = out_dir.join(".wren");
    mkdir_all(&agents_dir)?;
    mkdir_all(&scripts_dir)?;
    mkdir_all(&wren_dir)?;
    fs::write(scripts_dir.join("local_infer.py"), LOCAL_INFER_PY)
        .map_err(|e| DispatchError(format!("write local_infer.py: {e}")))?;
    let scripts_abs = fs::canonicalize(&scripts_dir)
        .map_err(|e| DispatchError(format!("canonicalize scripts dir: {e}")))?;

    for node in &ir.components {
        if !realization_supported(node.realization_kind) {
            return Err(unsupported(
                "realization_kind",
                node.realization_kind.as_str(),
            ));
        }
        if !trigger_supported(node.trigger.kind) {
            return Err(unsupported("trigger.kind", node.trigger.kind.as_str()));
        }
        if !outcome_supported(node.effect.outcome.kind) {
            return Err(unsupported(
                "outcome.kind",
                node.effect.outcome.kind.as_str(),
            ));
        }
        if !node.effect.render_blocks.is_empty()
            && find_guardrail(&node.guardrails, ARTIFACT_WRITE_GUARDRAIL_NAME).is_some()
        {
            return Err(DispatchError(format!(
                "hybrid bash-script file target does not yet realize a render gate for '{}' \
(wall-hit); POC covers render-none components like answer_query",
                node.verb
            )));
        }

        let cloud_calls: Vec<LlmCall> = node
            .llm_calls
            .iter()
            .filter(|c| {
                models
                    .binding(&c.tier)
                    .map(|b| b.provider == Provider::Anthropic)
                    .unwrap_or(false)
            })
            .cloned()
            .collect();
        if cloud_calls.is_empty() {
            return Err(DispatchError(format!(
                "hybrid file target needs at least one cloud (Anthropic) step to host the driver, \
but every step of '{}' is bound to a local provider",
                node.verb
            )));
        }
        let driver_model = models.collapsed_model(&cloud_calls)?.to_string();

        // Emit a wrapper + system-prompt file for each LOCAL step.
        let mut step_lines: Vec<String> = Vec::new();
        for (i, call) in node.llm_calls.iter().enumerate() {
            let n = i + 1;
            let binding = models.binding(&call.tier)?;
            let consumes_note = if call.consumes.is_empty() {
                String::new()
            } else {
                format!(
                    " It needs {} from the earlier step(s).",
                    call.consumes.join(", ")
                )
            };
            let produces_note = call
                .produces
                .as_ref()
                .map(|p| format!(" Its output is `{p}`."))
                .unwrap_or_default();
            if binding.provider != Provider::Anthropic {
                let endpoint = binding.endpoint.as_deref().ok_or_else(|| {
                    DispatchError(format!("local step '{}' has no endpoint", call.name))
                })?;
                let base = format!("{}__{}", node.verb, call.name);
                fs::write(scripts_dir.join(format!("{base}.system.txt")), &call.prompt)
                    .map_err(|e| DispatchError(format!("write system file: {e}")))?;
                let wrapper = format!(
                    r#"#!/usr/bin/env bash
# LOCAL step '{name}' (tier '{tier}', provider {provider}). $1 = the marshaled input text.
here="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$here/local_infer.py" \
  --step '{name}' --endpoint '{endpoint}' --model '{model}' \
  --system-file "$here/{base}.system.txt" \
  --trace "$here/../hybrid-trace.jsonl" --user "$1"
"#,
                    name = call.name,
                    tier = call.tier,
                    provider = binding.provider.as_str(),
                    endpoint = endpoint,
                    model = binding.model,
                    base = base
                );
                let wrapper_path = scripts_dir.join(format!("{base}.sh"));
                fs::write(&wrapper_path, wrapper)
                    .map_err(|e| DispatchError(format!("write wrapper: {e}")))?;
                step_lines.push(format!(
                    "{n}. `{}` — runs on a LOCAL model.{consumes_note} Execute exactly (substituting \
the marshaled input for INPUT):\n   `bash {}/{base}.sh \"INPUT\"`\n   Capture its stdout.{produces_note}",
                    call.name,
                    scripts_abs.display()
                ));
            } else {
                let cond = if call.conditional {
                    " (only if the previous step's result failed validation and needs repair)"
                } else {
                    ""
                };
                step_lines.push(format!(
                    "{n}. `{}` — you do this yourself on your own (cloud) model{cond}.{consumes_note} \
Use the `wren` CLI to write and run the SQL.{produces_note}",
                    call.name
                ));
            }
        }

        let frontmatter = AgentFrontmatter {
            name: node.verb.clone(),
            description: format!(
                "{} (hybrid: local step(s) via bash-script script, cloud step(s) on {})",
                build_description(node),
                driver_model
            ),
            tools: vec!["Read".to_string(), "Bash".to_string()],
            model: driver_model.clone(),
        };
        let body = [
            format!(
                "You are bound to the wren project at `{}`. All DATA access goes through the `wren` \
CLI (never raw SQL clients).",
                node.context_binding.project
            ),
            String::new(),
            "This component runs HYBRID: one or more steps run on a LOCAL model via an emitted script \
(run it through Bash and use its stdout); the rest you do yourself. Follow the steps IN ORDER, \
marshaling each step's output into the next exactly as noted."
                .to_string(),
            String::new(),
            "Steps, in order:".to_string(),
            String::new(),
            step_lines.join("\n"),
            String::new(),
            "Before you answer you MUST verify: actually execute the SQL through `wren`, then validate \
the result set (non-empty where a value is expected, types/units sane, grain matches). If it cannot \
be validated, REFUSE — do not fabricate. Your FINAL message MUST be a single JSON object \
`{\"columns\":[...],\"rows\":[[...]]}` with the answer (numbers as numbers), and nothing else."
                .to_string(),
        ]
        .join("\n");
        let markdown = format!("---\n{}\n---\n\n{}\n", to_yaml(&frontmatter), body);
        fs::write(agents_dir.join(format!("{}.md", node.verb)), markdown)
            .map_err(|e| DispatchError(format!("write agent md: {e}")))?;
    }

    // Settings: read-only data access + the local-inference scripts. NOTE (guardrail trade-off): the
    // bash-script realization must allow `bash` so the driver can run the emitted local-infer wrapper —
    // a wider trusted-command surface than the all-cloud path. An MCP-tool realization would avoid this
    // (the tool is a separate gate, not the Bash allowlist); see capability-model.md §7.2.
    let settings = serde_json::json!({
        "$comment": "Hybrid (bash-script) file target: DATA read-only via wren strict_mode; `bash` is \
    allowed ONLY to run the emitted local-inference scripts (a wider surface than all-cloud — an MCP \
    realization would not need it).",
        "permissions": {
            "allow": ["Read", "Bash(wren:*)", "Bash(bash:*)"],
            "deny": DESTRUCTIVE_BASH_DENY_PATTERNS
        }
    });
    fs::write(
        claude_dir.join("settings.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&settings).expect("settings serialize")
        ),
    )
    .map_err(|e| DispatchError(format!("write settings: {e}")))?;
    fs::write(
        wren_dir.join("config.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&wren_config()).expect("wren config serialize")
        ),
    )
    .map_err(|e| DispatchError(format!("write wren config: {e}")))?;
    let _ = target_id;
    Ok(())
}

/// Emit the hybrid (mcp-server) realization: a `.mcp.json` registering `warble mcp-serve` (stdio) +
/// an `mcp-steps.json` (local step → endpoint/model/system) + a driver that calls the `local_infer`
/// MCP tool for LOCAL steps and does the CLOUD steps itself via `wren`. Cleaner than bash-script: the
/// local call is an MCP tool (its own permission gate), so the read-only agent needs NO `bash`.
pub(super) fn emit_hybrid_file_target_mcp(
    ir: &WarbleIr,
    out_dir: &Path,
    target_id: &str,
    models: &ModelConfig,
) -> Result<(), DispatchError> {
    let claude_dir = out_dir.join(".claude");
    let agents_dir = claude_dir.join("agents");
    mkdir_all(&agents_dir)?;
    mkdir_all(&out_dir.join(".wren"))?;

    // The warble binary that will serve MCP (the one running now); absolute so `claude` can spawn it.
    let warble_bin = std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(str::to_string))
        .unwrap_or_else(|| "warble".to_string());

    let mut mcp_steps = serde_json::Map::new();
    let mut step_lines: Vec<String> = Vec::new();
    for node in &ir.components {
        if !realization_supported(node.realization_kind) {
            return Err(unsupported(
                "realization_kind",
                node.realization_kind.as_str(),
            ));
        }
        if !trigger_supported(node.trigger.kind) {
            return Err(unsupported("trigger.kind", node.trigger.kind.as_str()));
        }
        if !outcome_supported(node.effect.outcome.kind) {
            return Err(unsupported(
                "outcome.kind",
                node.effect.outcome.kind.as_str(),
            ));
        }
        if !node.effect.render_blocks.is_empty()
            && find_guardrail(&node.guardrails, ARTIFACT_WRITE_GUARDRAIL_NAME).is_some()
        {
            return Err(DispatchError(format!(
                "hybrid mcp-server file target does not yet realize a render gate for '{}' \
(wall-hit); POC covers render-none components like answer_query",
                node.verb
            )));
        }

        let cloud_calls: Vec<LlmCall> = node
            .llm_calls
            .iter()
            .filter(|c| {
                models
                    .binding(&c.tier)
                    .map(|b| b.provider == Provider::Anthropic)
                    .unwrap_or(false)
            })
            .cloned()
            .collect();
        if cloud_calls.is_empty() {
            return Err(DispatchError(format!(
                "hybrid file target needs at least one cloud (Anthropic) step to host the driver, \
but every step of '{}' is bound to a local provider",
                node.verb
            )));
        }
        let driver_model = models.collapsed_model(&cloud_calls)?.to_string();

        for (i, call) in node.llm_calls.iter().enumerate() {
            let n = i + 1;
            let binding = models.binding(&call.tier)?;
            let consumes_note = if call.consumes.is_empty() {
                String::new()
            } else {
                format!(
                    " It needs {} from the earlier step(s).",
                    call.consumes.join(", ")
                )
            };
            let produces_note = call
                .produces
                .as_ref()
                .map(|p| format!(" Use its returned text as `{p}`."))
                .unwrap_or_default();
            if binding.provider != Provider::Anthropic {
                let endpoint = binding.endpoint.as_deref().ok_or_else(|| {
                    DispatchError(format!("local step '{}' has no endpoint", call.name))
                })?;
                mcp_steps.insert(
                    call.name.clone(),
                    serde_json::json!({
                        "endpoint": endpoint,
                        "model": binding.model,
                        "system": call.prompt,
                    }),
                );
                step_lines.push(format!(
                    "{n}. `{}` — runs on a LOCAL model.{consumes_note} Call the `local_infer` MCP tool \
with `step`=\"{}\" and `input` set to the marshaled input text.{produces_note}",
                    call.name, call.name
                ));
            } else {
                let cond = if call.conditional {
                    " (only if the previous step's result failed validation and needs repair)"
                } else {
                    ""
                };
                step_lines.push(format!(
                    "{n}. `{}` — you do this yourself on your own (cloud) model{cond}.{consumes_note} \
Use the `wren` CLI to write and run the SQL.{produces_note}",
                    call.name
                ));
            }
        }

        let frontmatter = AgentFrontmatter {
            name: node.verb.clone(),
            description: format!(
                "{} (hybrid: local step(s) via the local_infer MCP tool, cloud step(s) on {})",
                build_description(node),
                driver_model
            ),
            tools: vec![
                "Read".to_string(),
                "Bash(wren:*)".to_string(),
                "mcp__warble__local_infer".to_string(),
            ],
            model: driver_model.clone(),
        };
        let body = [
            format!(
                "You are bound to the wren project at `{}`. All DATA access goes through the `wren` \
CLI (never raw SQL clients).",
                node.context_binding.project
            ),
            String::new(),
            "This component runs HYBRID: one or more steps run on a LOCAL model, which you reach by \
calling the `local_infer` MCP tool; the rest you do yourself with `wren`. Follow the steps IN ORDER, \
marshaling each step's output into the next exactly as noted."
                .to_string(),
            String::new(),
            "Steps, in order:".to_string(),
            String::new(),
            step_lines.join("\n"),
            String::new(),
            "Before you answer you MUST verify: actually execute the SQL through `wren`, then validate \
the result set (non-empty where a value is expected, types/units sane, grain matches). If it cannot \
be validated, REFUSE — do not fabricate. Your FINAL message MUST be a single JSON object \
`{\"columns\":[...],\"rows\":[[...]]}` with the answer (numbers as numbers), and nothing else."
                .to_string(),
        ]
        .join("\n");
        let markdown = format!("---\n{}\n---\n\n{}\n", to_yaml(&frontmatter), body);
        fs::write(agents_dir.join(format!("{}.md", node.verb)), markdown)
            .map_err(|e| DispatchError(format!("write agent md: {e}")))?;
    }

    // mcp-steps.json (binding stays here, not in the driver prompt) + its absolute path for .mcp.json.
    let steps_doc = serde_json::json!({ "steps": serde_json::Value::Object(mcp_steps) });
    fs::write(
        out_dir.join("mcp-steps.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&steps_doc).expect("steps serialize")
        ),
    )
    .map_err(|e| DispatchError(format!("write mcp-steps.json: {e}")))?;
    let steps_abs = fs::canonicalize(out_dir.join("mcp-steps.json"))
        .map_err(|e| DispatchError(format!("canonicalize mcp-steps.json: {e}")))?;

    let mcp_config = serde_json::json!({
        "mcpServers": {
            "warble": {
                "command": warble_bin,
                "args": ["mcp-serve", "--steps", steps_abs.to_string_lossy()]
            }
        }
    });
    fs::write(
        out_dir.join(".mcp.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&mcp_config).expect("mcp config serialize")
        ),
    )
    .map_err(|e| DispatchError(format!("write .mcp.json: {e}")))?;

    // Read-only DATA access + the MCP tool. NOTE: unlike bash-script, NO `bash` widening — the local
    // call is the `mcp__warble__local_infer` tool, gated separately from the Bash allowlist (§7.2).
    let settings = serde_json::json!({
        "$comment": "Hybrid (mcp-server) file target: DATA read-only via wren strict_mode; the LOCAL \
    step is the mcp__warble__local_infer tool (a separate gate — no bash widening).",
        "permissions": {
            "allow": ["Read", "Bash(wren:*)", "mcp__warble__local_infer"],
            "deny": DESTRUCTIVE_BASH_DENY_PATTERNS
        }
    });
    fs::write(
        claude_dir.join("settings.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&settings).expect("settings serialize")
        ),
    )
    .map_err(|e| DispatchError(format!("write settings: {e}")))?;
    fs::write(
        out_dir.join(".wren").join("config.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&wren_config()).expect("wren config serialize")
        ),
    )
    .map_err(|e| DispatchError(format!("write wren config: {e}")))?;
    let _ = target_id;
    Ok(())
}
