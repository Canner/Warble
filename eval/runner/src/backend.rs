//! Dispatch-target (back-end/runtime) identity for the eval runner.
//!
//! Warble ships several back-ends (`dispatcher/<name>`), each with a different launch mechanism,
//! question-passing convention, and capability envelope — the eval runner never hard-codes a
//! runtime's tool grant itself (see [`ClaudeCodeCliAdapter`]'s doc comment for the one case this
//! bit us). [`Backend`]
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

use std::path::{Path, PathBuf};
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
/// capability envelope (which tools the agent may use) is never a literal in this crate —
/// `claude-code-cli`'s own dispatch already computed it as a per-component `.claude/settings.json`,
/// and `install_agents` copies that file into the project before this is ever invoked. But `claude
/// -p` only *auto-discovers* `.claude/settings.json` when the project directory has prior workspace
/// trust recorded in `~/.claude.json` — a directory it has never seen before (every fresh CI runner
/// checkout, and every non-interactive fixture directory) silently drops the file's
/// `permissions.allow` entirely and runs with no grant, which is what turned into a near-total
/// accuracy collapse in CI (confirmed by reproducing the same collapse locally against a
/// newly-created, never-trusted directory, while the identical run against this trusted worktree
/// passes). Passing the already-installed file's own content inline via `--settings <json>` bypasses
/// file *discovery* — and therefore the trust gate — while still sourcing the envelope from the
/// same computed file, not a hard-coded literal here.
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
        let mut args: Vec<String> = vec![
            "-p".to_string(),
            question.to_string(),
            "--agent".to_string(),
            agent.to_string(),
        ];
        if let Some(model) = model_override {
            args.push("--model".to_string());
            args.push(model.to_string());
        }
        // Same file `install_agents` just copied to `project/.claude/settings.json` — read back and
        // handed to `claude` inline so it applies regardless of this directory's trust history.
        //
        // Absent and unreadable are deliberately NOT the same case. `install_agents` treats
        // settings.json as optional (an agent dir may legitimately ship none), so a missing file
        // keeps the pre-existing behaviour: run without an envelope override. A file that exists
        // but cannot be read is the dangerous case — proceeding would silently drop both the
        // computed `permissions.allow` grant and the `deny` list (destructive-bash denials), which
        // is exactly the silent envelope loss this whole code path exists to prevent. Fail loudly
        // rather than run unprotected.
        let settings_path = project.join(".claude/settings.json");
        match std::fs::read_to_string(&settings_path) {
            Ok(settings_json) => {
                args.push("--settings".to_string());
                args.push(settings_json);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return AdapterResult {
                    ok: false,
                    raw: format!(
                        ".claude/settings.json exists but could not be read ({e}); refusing to run \
without its capability envelope"
                    ),
                    latency_ms: None,
                    cost: None,
                    turns: None,
                };
            }
        }
        args.push("--output-format".to_string());
        args.push("json".to_string());

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

/// This checkout's own `claude-agent-sdk` back-end package — a fixed sibling of the `eval/runner`
/// crate's manifest dir, known at compile time (`CARGO_MANIFEST_DIR`), never discovered by walking
/// the filesystem at runtime. Mirrors the precedent set by `cli::in_repo_hub_dir` for locating an
/// in-repo sibling package the same way.
fn claude_agent_sdk_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("dispatcher")
        .join("claude-agent-sdk")
}

/// The built CLI entry point (`npm run build`, i.e. `just build-ts`, emits this via `tsup`). Kept as
/// its own function so `resolve_adapter` can check it exists (and fail loudly with a build
/// instruction) before ever reaching a `Report`/`CaseKey`/`Trace`, rather than discovering it missing
/// deep inside a per-case `invoke`.
fn claude_agent_sdk_cli_js() -> PathBuf {
    claude_agent_sdk_dir().join("dist").join("cli.js")
}

/// The `claude-agent-sdk` back-end: drives `dispatcher/claude-agent-sdk`'s own `dispatch <ir.json>
/// "<question>" --out <dir>` CLI subcommand — the SDK's `query()` loop run headlessly, one question
/// at a time, exactly like `ClaudeCodeCliAdapter` drives `claude -p`. Unlike `claude-code-cli` (which
/// installs static per-component agent files ahead of time), this back-end has no pre-installed
/// "dispatched agent dir" to point at — it dispatches directly from the compiled IR at invocation
/// time. So for this adapter the `agent` parameter (otherwise a frontmatter agent name) is
/// repurposed to carry the path to the compiled `ir.json` instead; see `run_eval`'s backend branch
/// for where that path comes from. The `BackendAdapter` trait signature itself is unchanged — only
/// the *meaning* of one already-generic string parameter is generalized per back-end.
pub(crate) struct ClaudeAgentSdkAdapter;

impl ClaudeAgentSdkAdapter {
    /// `dispatch.ts`'s `prepareDispatch` maps the same question over every component in the fed
    /// IR (no `--component` filter exists on `dispatch`, unlike `chat`) — so the IR path handed to
    /// this adapter must itself be single-component, same as `eval/answer-agent`'s compiled
    /// `answer-ir.json` used for the claude-code-cli golden run.
    fn absolute(path: &Path) -> PathBuf {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir().unwrap_or_default().join(path)
        }
    }
}

impl BackendAdapter for ClaudeAgentSdkAdapter {
    fn invoke(
        &self,
        project: &Path,
        agent: &str,
        path_env: &str,
        question: &str,
        model_override: Option<&str>,
    ) -> AdapterResult {
        let fail = || AdapterResult {
            ok: false,
            raw: String::new(),
            latency_ms: None,
            cost: None,
            turns: None,
        };

        let Ok(out_dir) = tempfile::tempdir() else {
            return fail();
        };
        let ir_path = Self::absolute(Path::new(agent));
        let project_abs = Self::absolute(project);

        let mut args: Vec<String> = vec![
            "dispatch".to_string(),
            ir_path.display().to_string(),
            question.to_string(),
            "--out".to_string(),
            out_dir.path().display().to_string(),
            "--project".to_string(),
            project_abs.display().to_string(),
        ];
        // Mirrors `ClaudeCodeCliAdapter`'s `--model` override: pin every tier to the same model,
        // regardless of the frontmatter/IR's own per-step tier binding. `None` (the
        // ablation/frontmatter path) leaves the CLI's own tier defaults in place.
        if let Some(model) = model_override {
            args.extend([
                "--strong".to_string(),
                model.to_string(),
                "--cheap".to_string(),
                model.to_string(),
                "--orchestrator".to_string(),
                model.to_string(),
            ]);
        }

        let output = Command::new("node")
            .arg(claude_agent_sdk_cli_js())
            .args(&args)
            .current_dir(claude_agent_sdk_dir())
            .env("PATH", path_env)
            .output();

        let Ok(o) = output else {
            return fail();
        };
        if !o.status.success() {
            return fail();
        }

        let raw = std::fs::read_to_string(out_dir.path().join("result.txt")).unwrap_or_default();
        let trace: serde_json::Value = std::fs::read_to_string(out_dir.path().join("trace.json"))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(serde_json::Value::Null);
        // `trace.json`'s `run` field is `{...} | null` — `null` exactly when the SDK's result
        // message never arrived, which naturally yields `None` for all three below rather than a
        // defaulted `0`/`0.0`.
        let run = trace.get("run");
        let latency_ms = run
            .and_then(|r| r.get("duration_ms"))
            .and_then(|v| v.as_u64());
        let cost = run
            .and_then(|r| r.get("total_cost_usd"))
            .and_then(|v| v.as_f64());
        let turns = run
            .and_then(|r| r.get("num_turns"))
            .and_then(|v| v.as_u64());

        AdapterResult {
            ok: true,
            raw,
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
    let supported = format!(
        "{}, {}",
        Backend::ClaudeCodeCli.as_str(),
        Backend::ClaudeAgentSdk.as_str()
    );
    match backend {
        Backend::ClaudeCodeCli => Ok(Box::new(ClaudeCodeCliAdapter)),
        Backend::ClaudeAgentSdk => {
            let cli_js = claude_agent_sdk_cli_js();
            if !cli_js.exists() {
                return Err(format!(
                    "backend 'claude-agent-sdk' has no built CLI at {} — run `just build-ts` first",
                    cli_js.display()
                ));
            }
            Ok(Box::new(ClaudeAgentSdkAdapter))
        }
        other => Err(format!(
            "backend '{other}' has no eval runner adapter yet — supported: {supported}"
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
    }

    #[test]
    fn resolve_adapter_supports_claude_code_cli_and_claude_agent_sdk() {
        assert!(resolve_adapter(Backend::ClaudeCodeCli).is_ok());
        // `claude-agent-sdk` resolves only when `just build-ts` has produced `dist/cli.js` — true
        // in CI/dev after the TS build step, but this unit test must not assume that artifact
        // exists, so it only asserts the *shape* of whichever outcome occurs.
        match resolve_adapter(Backend::ClaudeAgentSdk) {
            Ok(_) => {}
            Err(e) => assert!(
                e.contains("just build-ts"),
                "missing-build error names the fix: {e}"
            ),
        }
        for other in [Backend::CodexLocal, Backend::Vercel] {
            // `.expect_err` would require `Box<dyn BackendAdapter>: Debug`, which it isn't (and
            // shouldn't be) — match manually instead.
            let err = match resolve_adapter(other) {
                Err(e) => e,
                Ok(_) => panic!("no adapter yet for this backend"),
            };
            assert!(
                err.contains("claude-code-cli") && err.contains("claude-agent-sdk"),
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
