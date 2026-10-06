//! Deterministic native pi materialization coverage. Warble only writes discovery artifacts and a
//! launch spec; it never spawns `pi`.

use std::fs;
use std::process::Command;

const ANALYSIS_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/analysis-agent-uncomposed.ir.json"
);
const CANONICAL_ANALYSIS_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../examples/analysis-agent/ir.golden.json"
);

const FIRST_PROMPT: &str = "Test first turn for the analysis session.";
const CREDENTIAL: &str = "opaque-native-mcp-credential";
const MCP_URL: &str = "https://mcp.example.test/native";
const MODEL: &str = "openrouter/openai/gpt-5-mini";

fn scope_value(out: &std::path::Path, entry: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "version": "3",
        "kind": "bound_project",
        "scope_id": "opaque-bound_project-scope",
        "cwd": fs::canonicalize(out).unwrap(),
        "entry": entry,
        "binding": {
            "project_identity": "opaque-project",
            "generation": "opaque-generation",
            "revision": "opaque-revision",
        },
    })
}

fn pinned_entry(verb: &str) -> serde_json::Value {
    serde_json::json!({ "verb": verb, "prompt": FIRST_PROMPT })
}

fn mcp_value() -> serde_json::Value {
    serde_json::json!({ "version": "1", "url": MCP_URL, "credential": CREDENTIAL })
}

struct Dispatch {
    ir: &'static str,
    target: &'static str,
    purpose: Option<&'static str>,
    scope: Option<serde_json::Value>,
    mcp: Option<serde_json::Value>,
    pi_model: Option<&'static str>,
    extra: Vec<String>,
}

impl Dispatch {
    fn analysis(out: &std::path::Path) -> Self {
        Dispatch {
            ir: ANALYSIS_IR,
            target: "pi:interactive",
            purpose: Some("analysis"),
            scope: Some(scope_value(out, pinned_entry("answer_query"))),
            mcp: Some(mcp_value()),
            pi_model: Some(MODEL),
            extra: Vec::new(),
        }
    }

    fn run(self, out: &std::path::Path) -> std::process::Output {
        let scope_file = self.scope.map(|value| {
            let file = tempfile::NamedTempFile::new().unwrap();
            fs::write(file.path(), serde_json::to_string(&value).unwrap()).unwrap();
            file
        });
        let mcp_file = self.mcp.map(|value| {
            let file = tempfile::NamedTempFile::new().unwrap();
            fs::write(file.path(), serde_json::to_string(&value).unwrap()).unwrap();
            file
        });
        let mut command = Command::new(env!("CARGO_BIN_EXE_warble"));
        command.args(["dispatch", self.ir, "--target", self.target]);
        if let Some(purpose) = self.purpose {
            command.args(["--purpose", purpose]);
        }
        if let Some(file) = &scope_file {
            command.arg("--native-scope").arg(file.path());
        }
        if let Some(file) = &mcp_file {
            command.arg("--native-mcp").arg(file.path());
        }
        if let Some(model) = self.pi_model {
            command.args(["--pi-model", model]);
        }
        command.args(&self.extra);
        command
            .arg("--out")
            .arg(out)
            .output()
            .expect("warble dispatch starts")
    }
}

fn stderr(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).to_string()
}

fn launch_spec(out: &std::path::Path) -> serde_json::Value {
    serde_json::from_str(&fs::read_to_string(out.join(".warble/interactive-launch.json")).unwrap())
        .unwrap()
}

fn expected_argv(root: &std::path::Path, mode: &str, prompt: Option<&str>) -> serde_json::Value {
    let mut argv = vec![
        "--mode".to_string(),
        mode.to_string(),
        "--no-session".into(),
        "--no-extensions".into(),
        "--no-skills".into(),
        "--no-prompt-templates".into(),
        "--no-themes".into(),
        "--no-context-files".into(),
        "--no-approve".into(),
        "-e".into(),
        "builtin:mcp".into(),
        "--tools".into(),
        "mcp__genbi_session__persist_answer,mcp__genbi_session__query,mcp__genbi_session__save_dashboard".into(),
        "--system-prompt".into(),
        root.join(".warble/pi/SYSTEM.md")
            .to_string_lossy()
            .to_string(),
        "--provider".into(),
        "openrouter".into(),
        "--model".into(),
        "openai/gpt-5-mini".into(),
    ];
    if let Some(prompt) = prompt {
        argv.push("--".into());
        argv.push(prompt.into());
    }
    serde_json::json!(argv)
}

#[test]
fn pi_interactive_materializes_a_closed_rpc_launch_and_a_server_owned_agent_dir() {
    let out = tempfile::tempdir().unwrap();
    let result = Dispatch::analysis(out.path()).run(out.path());
    assert!(result.status.success(), "{}", stderr(&result));
    let root = fs::canonicalize(out.path()).unwrap();

    let launch = launch_spec(out.path());
    assert_eq!(launch["version"], "4");
    assert_eq!(launch["target"], "pi:interactive");
    assert_eq!(launch["executable"], "pi");
    assert_eq!(launch["purpose"], "analysis");
    assert_eq!(launch["argv"], expected_argv(&root, "rpc", None));
    assert_eq!(
        launch["agent"],
        serde_json::json!({ "kind": "pi_system_prompt", "name": "answer_query" })
    );
    assert_eq!(
        launch["mcp"],
        serde_json::json!({
            "server_name": "genbi_session",
            "credential_env_var": "WARBLE_MCP_CONNECTION_CREDENTIAL",
        })
    );
    assert_eq!(launch["cwd"], serde_json::json!(root));
    assert!(
        launch.get("scope").is_none(),
        "v4 must not expose a bound identity"
    );

    let pi = &launch["pi"];
    assert_eq!(pi["minimum_version"], "1.0.4");
    assert_eq!(
        pi["agent_dir"],
        serde_json::json!(root.join(".warble/pi/agent"))
    );
    assert_eq!(
        pi["system_prompt"],
        serde_json::json!(root.join(".warble/pi/SYSTEM.md"))
    );
    assert_eq!(
        pi["tools"],
        serde_json::json!([
            "mcp__genbi_session__persist_answer",
            "mcp__genbi_session__query",
            "mcp__genbi_session__save_dashboard"
        ])
    );
    assert_eq!(pi["first_prompt"], FIRST_PROMPT);
    assert_eq!(
        pi["json_argv"],
        expected_argv(&root, "json", Some(FIRST_PROMPT))
    );
    assert_eq!(
        pi["required_env"],
        serde_json::json!({
            "PI_CODING_AGENT_DIR": root.join(".warble/pi/agent"),
            "PI_OFFLINE": "1",
            "PI_SKIP_VERSION_CHECK": "1",
            "PI_TELEMETRY": "0",
        })
    );
    // The contract never uses the flags that would also drop the MCP tools.
    for forbidden in ["--no-tools", "--approve", "--api-key"] {
        for argv in [&launch["argv"], &pi["json_argv"]] {
            assert!(
                !argv.as_array().unwrap().iter().any(|a| a == forbidden),
                "argv must not carry {forbidden}"
            );
        }
    }

    let settings: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(root.join(".warble/pi/agent/settings.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        settings,
        serde_json::json!({
            "defaultProjectTrust": "never",
            "defaultTools": [],
            "enableAnalytics": false,
            "enableInstallTelemetry": false,
            "quietStartup": true,
            "retry": { "enabled": false },
        })
    );
    let mcp_raw = fs::read_to_string(root.join(".warble/pi/agent/mcp.json")).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&mcp_raw).unwrap(),
        serde_json::json!({
            "autoEnableCodemode": false,
            "mcpServers": { "genbi_session": {
                "url": MCP_URL,
                "headers": { "Authorization": "Bearer ${WARBLE_MCP_CONNECTION_CREDENTIAL}" },
                "exposure": "direct",
            }}
        })
    );
    assert!(
        !mcp_raw.contains(CREDENTIAL),
        "mcp.json must reference the env var, never the credential"
    );

    let system_prompt = fs::read_to_string(root.join(".warble/pi/SYSTEM.md")).unwrap();
    assert!(system_prompt.contains("<!-- warble-interactive-artifact target=pi:interactive"));
    assert!(system_prompt.contains("# GenBI analysis"));
    assert!(system_prompt.contains("Operate only within the server-bound project scope."));
    assert!(system_prompt.contains("You have no shell, file, or network tools."));

    let ownership = fs::read_to_string(root.join(".warble/interactive-ownership.json")).unwrap();
    for owned in [
        ".warble/pi/SYSTEM.md",
        ".warble/pi/agent/settings.json",
        ".warble/pi/agent/mcp.json",
        "RUN.md",
    ] {
        assert!(
            ownership.contains(owned),
            "ownership record must list {owned}"
        );
    }
    assert!(ownership.contains("mcp_digest=sha256:"));

    for path in [
        ".warble/interactive-launch.json",
        ".warble/interactive-ownership.json",
        ".warble/pi/SYSTEM.md",
        ".warble/pi/agent/settings.json",
        "RUN.md",
    ] {
        let content = fs::read_to_string(root.join(path)).unwrap();
        for forbidden in [
            "opaque-project",
            "opaque-generation",
            "opaque-revision",
            CREDENTIAL,
            "mcp.example.test",
        ] {
            assert!(!content.contains(forbidden), "{path} leaked {forbidden}");
        }
    }
}

#[test]
fn pi_interactive_repeats_byte_for_byte_for_identical_inputs() {
    let out = tempfile::tempdir().unwrap();
    let first = Dispatch::analysis(out.path()).run(out.path());
    assert!(first.status.success(), "{}", stderr(&first));
    let launch_before =
        fs::read_to_string(out.path().join(".warble/interactive-launch.json")).unwrap();
    let second = Dispatch::analysis(out.path()).run(out.path());
    assert!(
        second.status.success(),
        "repeat dispatch: {}",
        stderr(&second)
    );
    let launch_after =
        fs::read_to_string(out.path().join(".warble/interactive-launch.json")).unwrap();
    assert_eq!(launch_before, launch_after);
}

#[test]
fn pi_interactive_realizes_only_the_analysis_purpose() {
    let out = tempfile::tempdir().unwrap();
    let mut dispatch = Dispatch::analysis(out.path());
    dispatch.purpose = Some("context_enrichment");
    let result = dispatch.run(out.path());
    assert!(!result.status.success());
    let message = stderr(&result);
    assert!(
        message.contains("pi:interactive realizes only --purpose analysis"),
        "{message}"
    );
    assert!(message.contains("context_enrichment"), "{message}");
    assert!(message.contains("wall-hit"), "{message}");

    let out = tempfile::tempdir().unwrap();
    let mut dispatch = Dispatch::analysis(out.path());
    dispatch.purpose = None;
    dispatch.scope = None;
    dispatch.mcp = None;
    let result = dispatch.run(out.path());
    assert!(!result.status.success());
    assert!(
        stderr(&result).contains("pi:interactive requires --purpose analysis"),
        "{}",
        stderr(&result)
    );
    assert!(
        fs::read_dir(out.path()).unwrap().next().is_none(),
        "nothing may be written"
    );
}

#[test]
fn pi_interactive_requires_the_host_mcp_descriptor() {
    let out = tempfile::tempdir().unwrap();
    let mut dispatch = Dispatch::analysis(out.path());
    dispatch.mcp = None;
    let result = dispatch.run(out.path());
    assert!(!result.status.success());
    assert!(
        stderr(&result).contains("pi:interactive requires --native-mcp"),
        "{}",
        stderr(&result)
    );
    assert!(
        fs::read_dir(out.path()).unwrap().next().is_none(),
        "nothing may be written"
    );
}

#[test]
fn pi_interactive_rejects_provider_fragments_and_a_missing_or_malformed_model() {
    let fragment = tempfile::NamedTempFile::new().unwrap();
    let out = tempfile::tempdir().unwrap();
    let mut dispatch = Dispatch::analysis(out.path());
    dispatch.extra = vec![
        "--provider".to_string(),
        fragment.path().to_string_lossy().to_string(),
    ];
    let result = dispatch.run(out.path());
    assert!(!result.status.success());
    assert!(
        stderr(&result).contains("--provider is not supported for the pi:interactive target"),
        "{}",
        stderr(&result)
    );

    let out = tempfile::tempdir().unwrap();
    let mut dispatch = Dispatch::analysis(out.path());
    dispatch.pi_model = None;
    let result = dispatch.run(out.path());
    assert!(!result.status.success());
    assert!(
        stderr(&result).contains("pi:interactive requires --pi-model"),
        "{}",
        stderr(&result)
    );

    for malformed in [
        "no-delimiter",
        "/gpt",
        "openrouter/",
        "open router/gpt",
        "openrouter/gpt 5",
    ] {
        let out = tempfile::tempdir().unwrap();
        let mut dispatch = Dispatch::analysis(out.path());
        dispatch.pi_model = Some(Box::leak(malformed.to_string().into_boxed_str()));
        let result = dispatch.run(out.path());
        assert!(!result.status.success(), "{malformed} must be rejected");
        assert!(
            stderr(&result).contains("--pi-model must be `<provider>/<model-id>`"),
            "{malformed}: {}",
            stderr(&result)
        );
        assert!(fs::read_dir(out.path()).unwrap().next().is_none());
    }

    let out = tempfile::tempdir().unwrap();
    let mut dispatch = Dispatch::analysis(out.path());
    dispatch.target = "codex:interactive";
    let result = dispatch.run(out.path());
    assert!(!result.status.success());
    assert!(
        stderr(&result).contains("--pi-model is supported only by the pi:interactive target"),
        "{}",
        stderr(&result)
    );
}

#[test]
fn pi_interactive_refuses_scope_entry() {
    let out = tempfile::tempdir().unwrap();
    let mut dispatch = Dispatch::analysis(out.path());
    dispatch.scope = Some(scope_value(
        out.path(),
        serde_json::json!({ "kind": "scope", "prompt": FIRST_PROMPT }),
    ));
    let result = dispatch.run(out.path());
    assert!(!result.status.success());
    assert!(
        stderr(&result).contains("do not support scope entry"),
        "{}",
        stderr(&result)
    );
    assert!(
        fs::read_dir(out.path()).unwrap().next().is_none(),
        "nothing may be written"
    );
}

#[test]
fn pi_interactive_wall_hits_canonical_composition_before_writing_output() {
    let out = tempfile::tempdir().unwrap();
    let mut dispatch = Dispatch::analysis(out.path());
    dispatch.ir = CANONICAL_ANALYSIS_IR;
    let result = dispatch.run(out.path());
    assert!(!result.status.success());
    let message = stderr(&result);
    assert!(message.contains("wall-hit"), "{message}");
    assert!(message.contains("pi:interactive"), "{message}");
    assert!(
        fs::read_dir(out.path()).unwrap().next().is_none(),
        "nothing may be written"
    );
}

#[test]
fn pi_interactive_wall_hits_an_entry_whose_shape_no_host_tool_serves() {
    let out = tempfile::tempdir().unwrap();
    let mut dispatch = Dispatch::analysis(out.path());
    dispatch.scope = Some(scope_value(out.path(), pinned_entry("explore_model")));
    let result = dispatch.run(out.path());
    assert!(!result.status.success());
    let message = stderr(&result);
    assert!(message.contains("semantic_introspection"), "{message}");
    assert!(message.contains("pi:interactive"), "{message}");
    assert!(
        fs::read_dir(out.path()).unwrap().next().is_none(),
        "nothing may be written"
    );
}
