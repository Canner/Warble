//! Dispatch-target (back-end/runtime) identity for the eval runner.
//!
//! Today's runner has exactly one runtime hard-coded into it: `claude -p --agent <agent>
//! --allowedTools Read Bash(wren:*)`. But Warble ships several back-ends (`dispatcher/<name>`), each
//! with a different launch mechanism, question-passing convention, and capability envelope. [`Backend`]
//! is the eval dimension that says *which one this run measured* — a concept distinct from the
//! per-back-end `TargetId` capability target (`claude-code:headless` / `claude-code:interactive`)
//! already defined in `dispatcher/claude-code-cli` and `dispatcher/vercel`: that enum picks a
//! capability posture *within* one back-end, this one picks *which back-end ran at all*. Naming it
//! `Backend` (not `Target`) keeps the two concepts from colliding at the type or CLI-flag level.
//!
//! The value domain is aligned with the `dispatcher/<name>` directories, so every real back-end has a
//! recognized spelling — but recognizing the spelling and being able to actually run it are two
//! different things: `resolve_adapter` (crate-private) is the loud-fail boundary that only lets
//! through back-ends with a real [`BackendAdapter`] wired up, naming the supported subset on
//! anything else.

use std::path::Path;
use std::process::Command;

/// Which back-end/runtime a case was (or should be) run against. Value domain matches the
/// `dispatcher/<name>` directory names exactly, so `clap`'s own unknown-value error already lists
/// every back-end this crate knows the *name* of — but knowing the name is not the same as having an
/// adapter for it; see `resolve_adapter` (crate-private) below.
///
/// Defaults to [`Backend::ClaudeCodeCli`] so an eval invocation that never mentions `--backend` keeps
/// measuring exactly what it always measured (binding decision: never silently change what an
/// existing invocation reports).
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Default,
    serde::Serialize,
    serde::Deserialize,
    clap::ValueEnum,
)]
#[serde(rename_all = "kebab-case")]
#[clap(rename_all = "kebab-case")]
pub enum Backend {
    #[default]
    ClaudeCodeCli,
    ClaudeAgentSdk,
    CodexLocal,
    Vercel,
    ConformanceFixtures,
}

impl Backend {
    /// The spelling shared by CLI/serde and the cache-key element — identical to the back-end's
    /// `dispatcher/<name>` directory name.
    pub fn as_str(&self) -> &'static str {
        match self {
            Backend::ClaudeCodeCli => "claude-code-cli",
            Backend::ClaudeAgentSdk => "claude-agent-sdk",
            Backend::CodexLocal => "codex-local",
            Backend::Vercel => "vercel",
            Backend::ConformanceFixtures => "conformance-fixtures",
        }
    }
}

impl std::fmt::Display for Backend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What a [`BackendAdapter`] invocation actually measured. Every field a back-end genuinely cannot
/// supply must come back `None`, never a defaulted `0.0`/`0` — a metric a back-end can't report is
/// missing, not free (see [`crate::CaseResult::cost`] and friends for where this flows to).
pub struct AdapterResult {
    pub ok: bool,
    pub raw: String,
    pub latency_ms: Option<u64>,
    pub cost: Option<f64>,
    pub turns: Option<u64>,
}

/// One back-end's launch mechanism: how the question is passed, how the run is invoked, and how the
/// trace/metadata come back. This is the seam that replaces the old hard-coded `Command::new("claude")`
/// call in `run_case` — the target decides how it runs, not the eval loop.
pub trait BackendAdapter: Sync {
    /// Run one sample of one case's `question` against the already-installed agent under `project`,
    /// returning the raw final output plus whatever cost/latency/turns metadata this back-end can
    /// supply. `model_override` is `Some` on the whole-run path (a `--model` binding), `None` on the
    /// ablation/frontmatter path (the tier→model binding is baked into the emitted agent).
    fn invoke(
        &self,
        project: &Path,
        agent: &str,
        path_env: &str,
        question: &str,
        model_override: Option<&str>,
    ) -> AdapterResult;
}

/// The reference back-end: shells out to the `claude` CLI exactly as `run_case` always has. The
/// capability envelope (which tools the agent may use) is no longer passed on this command line —
/// `claude-code-cli`'s own dispatch already wrote a per-component `.claude/settings.json` with the
/// computed `permissions.allow` list, and `install_agents` copies it into the project before this is
/// ever invoked, so the installed settings are the envelope now.
pub(crate) struct ClaudeCodeCliAdapter;

impl BackendAdapter for ClaudeCodeCliAdapter {
    fn invoke(
        &self,
        project: &Path,
        agent: &str,
        path_env: &str,
        question: &str,
        model_override: Option<&str>,
    ) -> AdapterResult {
        let mut args: Vec<&str> = vec!["-p", question, "--agent", agent];
        if let Some(model) = model_override {
            args.extend_from_slice(&["--model", model]);
        }
        args.extend_from_slice(&["--output-format", "json"]);

        let output = Command::new("claude")
            .args(&args)
            .current_dir(project)
            .env("PATH", path_env)
            .output();

        let raw = match output {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
            _ => {
                return AdapterResult {
                    ok: false,
                    raw: String::new(),
                    latency_ms: None,
                    cost: None,
                    turns: None,
                }
            }
        };

        let meta: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
        let result_text = meta
            .get("result")
            .and_then(|v| v.as_str())
            .unwrap_or(&raw)
            .to_string();
        let latency_ms = meta.get("duration_ms").and_then(|v| v.as_u64());
        let cost = meta.get("total_cost_usd").and_then(|v| v.as_f64());
        let turns = meta.get("num_turns").and_then(|v| v.as_u64());

        AdapterResult {
            ok: true,
            raw: result_text,
            latency_ms,
            cost,
            turns,
        }
    }
}

/// Resolve `backend` to a runner adapter, or fail loudly naming the supported subset. Recognizing a
/// back-end's *name* (every `dispatcher/<name>` directory, via `clap::ValueEnum`) is not the same as
/// having a real adapter wired up for it — this is the boundary that keeps the eval runner from ever
/// silently pretending to support a back-end it doesn't.
pub(crate) fn resolve_adapter(backend: Backend) -> Result<Box<dyn BackendAdapter>, String> {
    match backend {
        Backend::ClaudeCodeCli => Ok(Box::new(ClaudeCodeCliAdapter)),
        other => Err(format!(
            "backend '{other}' has no eval runner adapter yet — supported: {}",
            Backend::ClaudeCodeCli.as_str()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_backend_is_claude_code_cli() {
        assert_eq!(Backend::default(), Backend::ClaudeCodeCli);
    }

    #[test]
    fn as_str_matches_dispatcher_directory_names() {
        assert_eq!(Backend::ClaudeCodeCli.as_str(), "claude-code-cli");
        assert_eq!(Backend::ClaudeAgentSdk.as_str(), "claude-agent-sdk");
        assert_eq!(Backend::CodexLocal.as_str(), "codex-local");
        assert_eq!(Backend::Vercel.as_str(), "vercel");
        assert_eq!(
            Backend::ConformanceFixtures.as_str(),
            "conformance-fixtures"
        );
    }

    #[test]
    fn resolve_adapter_only_supports_claude_code_cli_today() {
        assert!(resolve_adapter(Backend::ClaudeCodeCli).is_ok());
        for other in [
            Backend::ClaudeAgentSdk,
            Backend::CodexLocal,
            Backend::Vercel,
            Backend::ConformanceFixtures,
        ] {
            // `.expect_err` would require `Box<dyn BackendAdapter>: Debug`, which it isn't (and
            // shouldn't be) — match manually instead.
            let err = match resolve_adapter(other) {
                Err(e) => e,
                Ok(_) => panic!("no adapter yet for this backend"),
            };
            assert!(
                err.contains("claude-code-cli"),
                "error names the supported subset: {err}"
            );
        }
    }

    #[test]
    fn serde_roundtrip_is_kebab_case() {
        let json = serde_json::to_string(&Backend::ClaudeAgentSdk).unwrap();
        assert_eq!(json, "\"claude-agent-sdk\"");
        let back: Backend = serde_json::from_str(&json).unwrap();
        assert_eq!(back, Backend::ClaudeAgentSdk);
    }
}
