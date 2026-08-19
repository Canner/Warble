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

/// The model binding a [`BackendAdapter::invoke`] call was asked to run with. `Flat` is the
/// pre-existing whole-run override (one model pinned to every tier — what `--models` has always
/// produced); `Tiered` is a differentiated per-tier binding (`--strong`/`--cheap`/`--orchestrator`
/// or `--models-config`, each a genuinely distinct model). `run_eval` validates up front (see
/// `validate_tier_binding_backend`) that only [`Backend::ClaudeAgentSdk`] ever receives `Tiered` —
/// the other back-ends have no differentiated-tier knob at all, so their `invoke` only ever sees
/// `None` or `Flat`, and treat a `Tiered` they should never receive as an internal-error fallback
/// rather than silently flattening it.
#[derive(Debug, Clone, Copy)]
pub enum ModelOverride<'a> {
    Flat(&'a str),
    Tiered {
        strong: &'a str,
        cheap: &'a str,
        orchestrator: &'a str,
    },
}

/// One back-end's launch mechanism: how the question is passed, how the run is invoked, and how the
/// trace/metadata come back. This is the seam that replaces the old hard-coded `Command::new("claude")`
/// call in `run_case` — the target decides how it runs, not the eval loop.
pub trait BackendAdapter: Sync {
    /// Run one sample of one case's `question` against the already-installed agent under `project`,
    /// returning the raw final output plus whatever cost/latency/turns metadata this back-end can
    /// supply. `model_override` is `Some(Flat(_))` on the whole-run `--models` sweep path, or
    /// `Some(Tiered { .. })` on a differentiated `--strong`/`--cheap`/`--orchestrator` (or
    /// `--models-config`) binding, or `None` on the ablation/frontmatter path (the tier→model
    /// binding is baked into the emitted agent). `max_turns` is the `--max-turns` cap this run was
    /// invoked with (`None` = the back-end's own default). `run_eval` validates up front that only
    /// [`Backend::ClaudeAgentSdk`] ever receives a `Some` for `max_turns`, or a `Tiered` binding for
    /// `model_override` (see `validate_max_turns_backend` / `validate_tier_binding_backend`), so the
    /// other implementors only ever need to handle `None`/`Flat`.
    fn invoke(
        &self,
        project: &Path,
        agent: &str,
        path_env: &str,
        question: &str,
        model_override: Option<ModelOverride<'_>>,
        max_turns: Option<u32>,
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
        model_override: Option<ModelOverride<'_>>,
        // `claude -p` has no turn-budget flag at all; `run_eval`'s upfront validation guarantees
        // this is always `None` for this back-end (see `validate_max_turns_backend`), so it is
        // accepted only for trait uniformity and otherwise unused here.
        _max_turns: Option<u32>,
    ) -> AdapterResult {
        // `claude -p` takes a single `--model` flag — no differentiated-tier knob exists.
        // `run_eval`'s upfront `validate_tier_binding_backend` guarantees a `Tiered` binding never
        // reaches this back-end at all, so this arm is unreachable in practice; it stays a loud,
        // non-panicking failure rather than silently flattening to one of the three models.
        let model: Option<&str> = match model_override {
            None => None,
            Some(ModelOverride::Flat(model)) => Some(model),
            Some(ModelOverride::Tiered { .. }) => {
                return AdapterResult {
                    ok: false,
                    raw: "internal error: backend 'claude-code-cli' received a differentiated \
tier binding, which validate_tier_binding_backend should have rejected before any process was \
spawned"
                        .to_string(),
                    latency_ms: None,
                    cost: None,
                    turns: None,
                };
            }
        };
        let mut args: Vec<String> = vec![
            "-p".to_string(),
            question.to_string(),
            "--agent".to_string(),
            agent.to_string(),
        ];
        if let Some(model) = model {
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
        model_override: Option<ModelOverride<'_>>,
        max_turns: Option<u32>,
    ) -> AdapterResult {
        // Carry a reason on every failure path. `dispatch`'s own CLI writes `error: <message>` to
        // stderr before exiting non-zero, and the runner surfaces an adapter's first output line in
        // the case's failure reason — discarding it here would render every failure of this
        // back-end as the bare generic string, with the diagnostic thrown away.
        let fail = |reason: String| AdapterResult {
            ok: false,
            raw: reason,
            latency_ms: None,
            cost: None,
            turns: None,
        };

        let out_dir = match tempfile::tempdir() {
            Ok(dir) => dir,
            Err(e) => {
                return fail(format!(
                    "could not create a temporary output directory: {e}"
                ))
            }
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
        // `Flat` mirrors `ClaudeCodeCliAdapter`'s `--model` override: pin every tier to the same
        // model, regardless of the frontmatter/IR's own per-step tier binding. `Tiered` passes
        // three genuinely distinct values through to `dispatch`'s own `--strong`/`--cheap`/
        // `--orchestrator` flags, so this back-end's behaviour no longer depends on `cli.ts`'s
        // hardcoded defaults for a differentiated binding. `None` (the ablation/frontmatter path)
        // leaves the CLI's own tier defaults in place.
        match model_override {
            None => {}
            Some(ModelOverride::Flat(model)) => {
                args.extend([
                    "--strong".to_string(),
                    model.to_string(),
                    "--cheap".to_string(),
                    model.to_string(),
                    "--orchestrator".to_string(),
                    model.to_string(),
                ]);
            }
            Some(ModelOverride::Tiered {
                strong,
                cheap,
                orchestrator,
            }) => {
                args.extend([
                    "--strong".to_string(),
                    strong.to_string(),
                    "--cheap".to_string(),
                    cheap.to_string(),
                    "--orchestrator".to_string(),
                    orchestrator.to_string(),
                ]);
            }
        }
        // The dispatch CLI's own `--max-turns N` flag (see `dispatcher/claude-agent-sdk/src/cli.ts`).
        // `None` leaves the SDK's own default turn budget in place, same convention as
        // `model_override`'s `None` above.
        if let Some(n) = max_turns {
            args.push("--max-turns".to_string());
            args.push(n.to_string());
        }

        let output = Command::new("node")
            .arg(claude_agent_sdk_cli_js())
            .args(&args)
            .current_dir(claude_agent_sdk_dir())
            .env("PATH", path_env)
            .output();

        let o = match output {
            Ok(o) => o,
            Err(e) => return fail(format!("could not run the dispatch CLI via node: {e}")),
        };
        if !o.status.success() {
            let stderr = String::from_utf8_lossy(&o.stderr);
            let detail = stderr
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or("no stderr output");
            return fail(format!("dispatch CLI failed ({}): {detail}", o.status));
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

/// This checkout's own `codex-local` back-end package — a fixed sibling of the `eval/runner` crate's
/// manifest dir, same convention as [`claude_agent_sdk_dir`].
fn codex_local_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("dispatcher")
        .join("codex-local")
}

/// The built CLI entry point (`just build-codex-ts`, i.e. `npm run build` in `dispatcher/codex-local`,
/// emits this via `tsup`). Same role as [`claude_agent_sdk_cli_js`]: checked by `resolve_adapter`
/// before ever reaching a `Report`/`CaseKey`/`Trace`.
fn codex_local_cli_js() -> PathBuf {
    codex_local_dir().join("dist").join("cli.js")
}

fn absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    }
}

/// A worked example of [`CodexLocalDispatchSpec`]'s JSON shape, inlined into every parse-failure
/// message below so the fix is visible without leaving the terminal.
const CODEX_LOCAL_SPEC_SHAPE: &str = concat!(
    r#"{"ir_path": "<path to a compiled IR>", "component": "<component id in that IR, e.g. "#,
    r#""build_context">", "mcp": {"command": "<path to an MCP server executable>", "args": [], "#,
    r#""source_tools": [], "context_tools": ["<tool name>"]}}"#
);

/// Where the full write-up (every field, a runnable example, the `warble eval run` invocation)
/// lives — named in every parse-failure message rather than left to the doc comments on
/// [`CodexLocalDispatchSpec`] alone, which a CLI user never sees.
const CODEX_LOCAL_SPEC_DOC_POINTER: &str =
    "see the \"codex-local\" section of docs/site/docs/guides/evaluating.md for the full shape and a worked example";

/// Whether `spec_text` looks like a compiled IR (a `warble_ir_version` key present) rather than a
/// codex-local dispatch spec. This is the exact confusion a user hits by pointing `--ir` at their
/// compiled IR the same way they would for [`ClaudeAgentSdkAdapter`] — without this check, the
/// resulting `serde_json` error reads as "your IR is missing a field named `ir_path`", which
/// describes the file's own shape as broken rather than naming the real problem (this back-end
/// wants a different artifact under `--ir`).
fn looks_like_compiled_ir(spec_text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(spec_text)
        .ok()
        .is_some_and(|v| v.get("warble_ir_version").is_some())
}

/// Turn a [`CodexLocalDispatchSpec`] parse failure into a message a user who just followed
/// `--ir`'s own `--help` text can act on, instead of a bare `serde_json::Error` quoted against a
/// file it was never meant to describe. See [`looks_like_compiled_ir`] for why the compiled-IR
/// case gets its own wording.
fn describe_spec_parse_failure(
    spec_path: &Path,
    spec_text: &str,
    cause: &serde_json::Error,
) -> String {
    if looks_like_compiled_ir(spec_text) {
        format!(
            "{} looks like a compiled IR (it has a `warble_ir_version` field), not a codex-local \
dispatch spec. Unlike `claude-agent-sdk`, backend 'codex-local' does not take the compiled IR \
directly via --ir — point --ir at a small JSON dispatch spec that names this IR (plus the \
component and MCP server to dispatch it with) instead: {CODEX_LOCAL_SPEC_SHAPE}. \
{CODEX_LOCAL_SPEC_DOC_POINTER}.",
            spec_path.display()
        )
    } else {
        format!(
            "could not parse {} as a codex-local dispatch spec ({cause}). Backend 'codex-local' \
needs a small JSON dispatch spec: {CODEX_LOCAL_SPEC_SHAPE}. {CODEX_LOCAL_SPEC_DOC_POINTER}.",
            spec_path.display()
        )
    }
}

/// One MCP server binding for a `codex-local dispatch`: mirrors that CLI's own `--server-command` /
/// `--server-arg` / `--source-tool` / `--context-tool` flags (`dispatcher/codex-local/src/prepare.ts`'s
/// `McpServerConfig`). `command` and any relative `ir_path` alongside it in
/// [`CodexLocalDispatchSpec`] are resolved relative to the spec file's own directory, not the
/// process cwd — the spec is meant to travel with (and point at) its sibling artifacts.
#[derive(Debug, serde::Deserialize)]
struct CodexLocalMcp {
    #[serde(default = "CodexLocalMcp::default_name")]
    name: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    source_tools: Vec<String>,
    #[serde(default)]
    context_tools: Vec<String>,
}

impl CodexLocalMcp {
    fn default_name() -> String {
        "setup".to_string()
    }
}

/// Everything one `codex-local dispatch` needs beyond the question/model the [`BackendAdapter`] trait
/// already carries.
///
/// `claude-agent-sdk`'s `dispatch` subcommand takes only an IR path (see [`ClaudeAgentSdkAdapter`]'s
/// doc comment) because it maps the question over every component in the fed IR. `codex-local`'s
/// `dispatch` is shaped differently: it REQUIRES `--component` (`dispatcher/codex-local`'s
/// `prepareSetup` looks up exactly one named component, and only accepts the setup-shaped family —
/// `connect_source`/`build_context`, per `validateSetupShape`) and an external MCP server binding
/// that realizes that component's `source_connect`/`context_build` capability. Warble ships no real
/// source/context MCP server itself — that tool is supplied by whatever consumes this back-end — so
/// neither piece is a constant this adapter could hard-code. `BackendAdapter::invoke`'s fixed
/// 5-argument signature has no channel for either, so `agent` for this back-end is repurposed once
/// more: not an IR path, but the path to this small JSON spec that names one, alongside the
/// component to dispatch and the MCP server that backs it.
#[derive(Debug, serde::Deserialize)]
struct CodexLocalDispatchSpec {
    ir_path: String,
    component: String,
    mcp: CodexLocalMcp,
}

/// Build the `codex-local dispatch` argv for one invocation. Pure (no I/O, no process spawn) so
/// the flag wiring — which is the part most likely to drift as `dispatcher/codex-local`'s own CLI
/// grows flags — is unit-testable without a built `dist/cli.js` or a live `codex` call. Callers
/// resolve `ir_path`/`server_command`/`project_abs` to absolute paths first (see `invoke`); this
/// function only assembles the argument list from already-resolved pieces.
fn build_dispatch_args(
    spec: &CodexLocalDispatchSpec,
    ir_path: &Path,
    server_command: &Path,
    project_abs: &Path,
    question: &str,
    model_override: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "dispatch".to_string(),
        ir_path.display().to_string(),
        question.to_string(),
        "--component".to_string(),
        spec.component.clone(),
        "--server".to_string(),
        spec.mcp.name.clone(),
        "--server-command".to_string(),
        server_command.display().to_string(),
    ];
    for server_arg in &spec.mcp.args {
        args.push("--server-arg".to_string());
        args.push(server_arg.clone());
    }
    for tool in &spec.mcp.source_tools {
        args.push("--source-tool".to_string());
        args.push(tool.clone());
    }
    for tool in &spec.mcp.context_tools {
        args.push("--context-tool".to_string());
        args.push(tool.clone());
    }
    args.push("--project".to_string());
    args.push(project_abs.display().to_string());
    // Mirrors the other adapters' `--model` override: `None` (the ablation/frontmatter path)
    // leaves the CLI's own default (`gpt-5.4`) in place.
    if let Some(model) = model_override {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    args
}

/// First non-blank line of a process's stderr, or a fallback when stderr was empty (or all
/// whitespace) — the diagnostic every failure path here surfaces alongside the exit status, so a
/// case's failure reason is never just the bare generic string.
fn first_stderr_line(stderr: &str) -> &str {
    stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no stderr output")
}

/// The `codex-local` back-end: drives `dispatcher/codex-local`'s own `dispatch <ir.json> "<question>"
/// --component <id> --server-command <path> …` CLI subcommand — a sandboxed, single-turn `codex exec`
/// call (see `dispatcher/codex-local/src/config.ts`'s `buildCodexArgs`: `--sandbox read-only`,
/// `--ignore-user-config`, shell/web/browser/apps disabled) restricted to one allowlisted MCP tool.
/// See [`CodexLocalDispatchSpec`] for why `agent` means something different here than it does for
/// [`ClaudeAgentSdkAdapter`].
pub(crate) struct CodexLocalAdapter;

impl BackendAdapter for CodexLocalAdapter {
    fn invoke(
        &self,
        project: &Path,
        agent: &str,
        path_env: &str,
        question: &str,
        model_override: Option<ModelOverride<'_>>,
        // Already sandboxed to a single turn (see the struct doc above) with no turn-budget knob
        // of its own; `run_eval`'s upfront validation guarantees this is always `None` for this
        // back-end (see `validate_max_turns_backend`), so it is accepted only for trait uniformity.
        _max_turns: Option<u32>,
    ) -> AdapterResult {
        // Carry a reason on every failure path — same rationale as `ClaudeAgentSdkAdapter::invoke`:
        // discarding it would render every failure of this back-end as the bare generic string.
        let fail = |reason: String| AdapterResult {
            ok: false,
            raw: reason,
            latency_ms: None,
            cost: None,
            turns: None,
        };

        // `codex-local` has no differentiated-tier knob (a single `--model` flag only).
        // `run_eval`'s upfront `validate_tier_binding_backend` guarantees a `Tiered` binding never
        // reaches this back-end, so this arm is unreachable in practice; it stays a loud,
        // non-panicking failure rather than silently flattening to one of the three models.
        let model: Option<&str> = match model_override {
            None => None,
            Some(ModelOverride::Flat(model)) => Some(model),
            Some(ModelOverride::Tiered { .. }) => {
                return fail(
                    "internal error: backend 'codex-local' received a differentiated tier \
binding, which validate_tier_binding_backend should have rejected before any process was spawned"
                        .to_string(),
                );
            }
        };

        let spec_path = absolute_path(Path::new(agent));
        let spec_text = match std::fs::read_to_string(&spec_path) {
            Ok(text) => text,
            Err(e) => {
                return fail(format!(
                    "could not read codex-local dispatch spec {}: {e}",
                    spec_path.display()
                ))
            }
        };
        let spec: CodexLocalDispatchSpec = match serde_json::from_str(&spec_text) {
            Ok(spec) => spec,
            Err(e) => return fail(describe_spec_parse_failure(&spec_path, &spec_text, &e)),
        };
        let spec_dir = spec_path.parent().unwrap_or_else(|| Path::new("."));
        let ir_path = absolute_path(&spec_dir.join(&spec.ir_path));
        let server_command = absolute_path(&spec_dir.join(&spec.mcp.command));
        let project_abs = absolute_path(project);

        let args = build_dispatch_args(
            &spec,
            &ir_path,
            &server_command,
            &project_abs,
            question,
            model,
        );

        let output = Command::new("node")
            .arg(codex_local_cli_js())
            .args(&args)
            .current_dir(codex_local_dir())
            .env("PATH", path_env)
            .output();

        let o = match output {
            Ok(o) => o,
            Err(e) => {
                return fail(format!(
                    "could not run the codex-local dispatch CLI via node: {e}"
                ))
            }
        };
        if !o.status.success() {
            let stderr = String::from_utf8_lossy(&o.stderr);
            let detail = first_stderr_line(&stderr);
            return fail(format!(
                "codex-local dispatch CLI failed ({}): {detail}",
                o.status
            ));
        }

        // `dispatch` (non-`--stream-json`) writes only the final answer text to stdout — no
        // cost/latency/turn metadata anywhere (unlike `claude-agent-sdk`'s `trace.json`), so all
        // three are genuinely unavailable here, never a defaulted `0`/`0.0`.
        let raw = String::from_utf8_lossy(&o.stdout).trim_end().to_string();
        AdapterResult {
            ok: true,
            raw,
            latency_ms: None,
            cost: None,
            turns: None,
        }
    }
}

/// Resolve `backend` to a runner adapter, or fail loudly naming the supported subset. Recognizing a
/// back-end's *name* (every `dispatcher/<name>` directory, via `clap::ValueEnum`) is not the same as
/// having a real adapter wired up for it — this is the boundary that keeps the eval runner from ever
/// silently pretending to support a back-end it doesn't.
pub(crate) fn resolve_adapter(backend: Backend) -> Result<Box<dyn BackendAdapter>, String> {
    let supported = format!(
        "{}, {}, {}",
        Backend::ClaudeCodeCli.as_str(),
        Backend::ClaudeAgentSdk.as_str(),
        Backend::CodexLocal.as_str()
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
        Backend::CodexLocal => {
            let cli_js = codex_local_cli_js();
            if !cli_js.exists() {
                return Err(format!(
                    "backend 'codex-local' has no built CLI at {} — run `just build-codex-ts` first",
                    cli_js.display()
                ));
            }
            Ok(Box::new(CodexLocalAdapter))
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
    fn resolve_adapter_supports_claude_code_cli_claude_agent_sdk_and_codex_local() {
        assert!(resolve_adapter(Backend::ClaudeCodeCli).is_ok());
        // `claude-agent-sdk` and `codex-local` resolve only once their own TS build step has
        // produced `dist/cli.js` — true in CI/dev after `just build-ts` / `just build-codex-ts`,
        // but this unit test must not assume either artifact exists, so it only asserts the
        // *shape* of whichever outcome occurs, and that a missing build names its own fix.
        for (backend, build_fix) in [
            (Backend::ClaudeAgentSdk, "just build-ts"),
            (Backend::CodexLocal, "just build-codex-ts"),
        ] {
            match resolve_adapter(backend) {
                Ok(_) => {}
                Err(e) => assert!(
                    e.contains(build_fix),
                    "missing-build error for {backend:?} names the fix: {e}"
                ),
            }
        }
        // `.expect_err` would require `Box<dyn BackendAdapter>: Debug`, which it isn't (and
        // shouldn't be) — match manually instead.
        let err = match resolve_adapter(Backend::Vercel) {
            Err(e) => e,
            Ok(_) => panic!("no adapter yet for this backend"),
        };
        assert!(
            err.contains("claude-code-cli")
                && err.contains("claude-agent-sdk")
                && err.contains("codex-local"),
            "error names the supported subset: {err}"
        );
    }

    #[test]
    fn serde_roundtrip_is_kebab_case() {
        let json = serde_json::to_string(&Backend::ClaudeAgentSdk).unwrap();
        assert_eq!(json, "\"claude-agent-sdk\"");
        let back: Backend = serde_json::from_str(&json).unwrap();
        assert_eq!(back, Backend::ClaudeAgentSdk);
    }

    // --- codex-local dispatch-spec parse diagnostics -----------------------------------------
    //
    // A user who points `--ir` at a compiled IR for `codex-local` the same way they would for
    // `claude-agent-sdk` must not see "missing field `ir_path`" against a file that was never
    // meant to have one — these guard the actionable-error fix for that regression.

    #[test]
    fn spec_parse_failure_on_a_compiled_ir_names_the_real_problem() {
        let spec_path = Path::new("compiled-ir.json");
        let ir_text = r#"{"warble_ir_version": "0.5", "components": []}"#;
        let cause = serde_json::from_str::<CodexLocalDispatchSpec>(ir_text).unwrap_err();
        let msg = describe_spec_parse_failure(spec_path, ir_text, &cause);
        assert!(
            msg.contains("looks like a compiled IR"),
            "names the real shape mismatch: {msg}"
        );
        assert!(
            msg.contains("ir_path") && msg.contains("component") && msg.contains("mcp"),
            "shows the expected sidecar shape inline: {msg}"
        );
        assert!(
            msg.contains("evaluating.md"),
            "points at the documented shape: {msg}"
        );
        assert!(
            !msg.contains("missing field"),
            "must not just echo the raw serde error against the IR's own fields: {msg}"
        );
    }

    #[test]
    fn spec_parse_failure_on_garbage_names_the_expected_shape() {
        let spec_path = Path::new("not-a-spec.json");
        let garbage = "not json at all";
        let cause = serde_json::from_str::<CodexLocalDispatchSpec>(garbage).unwrap_err();
        let msg = describe_spec_parse_failure(spec_path, garbage, &cause);
        assert!(!msg.contains("looks like a compiled IR"));
        assert!(msg.contains("ir_path") && msg.contains("component") && msg.contains("mcp"));
        assert!(msg.contains("evaluating.md"));
    }

    #[test]
    fn spec_parse_failure_on_valid_json_missing_a_field_names_the_expected_shape() {
        // Valid JSON, not IR-shaped, just missing a required sidecar field — the generic branch,
        // not the compiled-IR-specific one.
        let spec_path = Path::new("almost-a-spec.json");
        let almost = r#"{"component": "build_context", "mcp": {"command": "./x"}}"#;
        let cause = serde_json::from_str::<CodexLocalDispatchSpec>(almost).unwrap_err();
        let msg = describe_spec_parse_failure(spec_path, almost, &cause);
        assert!(!msg.contains("looks like a compiled IR"));
        assert!(msg.contains("ir_path") && msg.contains("mcp"));
    }

    // --- codex-local dispatch argv building ---------------------------------------------------

    fn sample_mcp() -> CodexLocalMcp {
        CodexLocalMcp {
            name: "setup".to_string(),
            command: "fake-mcp.mjs".to_string(),
            args: vec!["--flag".to_string()],
            source_tools: vec!["probe_source".to_string()],
            context_tools: vec!["probe_setup".to_string()],
        }
    }

    #[test]
    fn dispatch_args_include_component_server_and_tool_flags_in_order() {
        let spec = CodexLocalDispatchSpec {
            ir_path: "ir.json".to_string(),
            component: "build_context".to_string(),
            mcp: sample_mcp(),
        };
        let args = build_dispatch_args(
            &spec,
            Path::new("/abs/ir.json"),
            Path::new("/abs/fake-mcp.mjs"),
            Path::new("/abs/project"),
            "what tables exist?",
            Some("gpt-5.4-mini"),
        );
        assert_eq!(
            args,
            vec![
                "dispatch",
                "/abs/ir.json",
                "what tables exist?",
                "--component",
                "build_context",
                "--server",
                "setup",
                "--server-command",
                "/abs/fake-mcp.mjs",
                "--server-arg",
                "--flag",
                "--source-tool",
                "probe_source",
                "--context-tool",
                "probe_setup",
                "--project",
                "/abs/project",
                "--model",
                "gpt-5.4-mini",
            ]
        );
    }

    #[test]
    fn dispatch_args_omit_model_flag_when_no_override() {
        let spec = CodexLocalDispatchSpec {
            ir_path: "ir.json".to_string(),
            component: "connect_source".to_string(),
            mcp: CodexLocalMcp {
                name: CodexLocalMcp::default_name(),
                command: "fake-mcp.mjs".to_string(),
                args: vec![],
                source_tools: vec![],
                context_tools: vec![],
            },
        };
        let args = build_dispatch_args(
            &spec,
            Path::new("/abs/ir.json"),
            Path::new("/abs/fake-mcp.mjs"),
            Path::new("/abs/project"),
            "q",
            None,
        );
        assert!(!args.contains(&"--model".to_string()));
        assert!(!args.contains(&"--server-arg".to_string()));
    }

    // --- diagnostic extraction -----------------------------------------------------------------

    #[test]
    fn first_stderr_line_skips_blank_lines() {
        assert_eq!(
            first_stderr_line("\n\n  real error  \nmore\n"),
            "real error"
        );
    }

    #[test]
    fn first_stderr_line_falls_back_when_all_blank() {
        assert_eq!(first_stderr_line("   \n\n"), "no stderr output");
        assert_eq!(first_stderr_line(""), "no stderr output");
    }

    // --- CodexLocalAdapter::invoke failure paths (no process spawn, no live call) -------------

    #[test]
    fn invoke_reports_a_missing_spec_file_with_its_own_path() {
        let result = CodexLocalAdapter.invoke(
            Path::new("/nonexistent-project"),
            "/nonexistent-codex-local-spec.json",
            "",
            "question",
            None,
            None,
        );
        assert!(!result.ok);
        assert!(result.raw.contains("/nonexistent-codex-local-spec.json"));
        assert_eq!(result.cost, None);
        assert_eq!(result.latency_ms, None);
        assert_eq!(result.turns, None);
    }

    // --- differentiated tier binding is rejected defensively, not flattened -------------------
    //
    // `run_eval`'s `validate_tier_binding_backend` is the real guard (checked before any process
    // spawns, so these adapters never see a `Tiered` binding in practice) — these tests only pin
    // down that if one ever did slip through, the back-end fails loudly instead of silently
    // collapsing three distinct models into one, which would misreport what actually ran.

    #[test]
    fn codex_local_invoke_rejects_a_tiered_binding_before_touching_the_spec_file() {
        let result = CodexLocalAdapter.invoke(
            Path::new("/nonexistent-project"),
            "/nonexistent-codex-local-spec.json",
            "",
            "question",
            Some(ModelOverride::Tiered {
                strong: "sonnet",
                cheap: "haiku",
                orchestrator: "sonnet",
            }),
            None,
        );
        assert!(!result.ok);
        assert!(
            result.raw.contains("differentiated tier binding"),
            "names the real problem: {}",
            result.raw
        );
        // Rejected before ever reading the (nonexistent) spec file — the error is the internal
        // guard message, not a file-not-found error.
        assert!(!result.raw.contains("/nonexistent-codex-local-spec.json"));
    }

    #[test]
    fn claude_code_cli_invoke_rejects_a_tiered_binding() {
        let result = ClaudeCodeCliAdapter.invoke(
            Path::new("/nonexistent-project"),
            "some-agent",
            "",
            "question",
            Some(ModelOverride::Tiered {
                strong: "sonnet",
                cheap: "haiku",
                orchestrator: "sonnet",
            }),
            None,
        );
        assert!(!result.ok);
        assert!(
            result.raw.contains("differentiated tier binding"),
            "names the real problem: {}",
            result.raw
        );
    }
}
