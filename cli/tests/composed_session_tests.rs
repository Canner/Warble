//! Composed producer tests use actual compiled, published component anatomy. No vendor runs.
use serde_json::{json, Value};
use warble_claude_code::{
    session::{produce_session, COMPONENT_HOST_PROTOCOL, COMPOSED_EXECUTION},
    slots::SlotSupply,
};

const IR: &str = include_str!("../../examples/analysis-agent/ir.golden.json");

fn fixture() -> (Value, Value) {
    let ir: Value = serde_json::from_str(IR).unwrap();
    let mut bindings = serde_json::Map::new();
    for id in ["generate_dashboard", "answer_query"] {
        let node = ir["components"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == id)
            .unwrap();
        bindings.insert(id.to_string(), json!({
            "version": "2", "tiers": ["cheap", "strong"],
            "capabilities": {"sql_execution:read_only": {"tool": "query_read_only"},
                "semantic_introspection": {"tool": "inspect_context"}, "render_contract": {},
                "artifact_write": {}, "component_invocation": {}},
            "guardrails": node["guardrails"],
            "execution": ["ordered_steps", "isolated_step_tools", "artifact_provenance", "per_step_tiers", "bounded_repair", "render_contract"]
        }));
    }
    (
        ir,
        json!({"version": "2", "protocol": COMPONENT_HOST_PROTOCOL,
        "execution": COMPOSED_EXECUTION, "components": bindings}),
    )
}

fn produce(ir: &Value, host: &Value) -> Result<Value, warble_claude_code::DispatchError> {
    produce_session(
        &ir.to_string(),
        &host.to_string(),
        "generate_dashboard",
        &SlotSupply::new(),
    )
}

#[test]
fn real_composed_profile_retains_edges_bindings_and_per_component_authority() {
    let (ir, host) = fixture();
    let plan = produce(&ir, &host).unwrap();
    assert_eq!(plan, produce(&ir, &host).unwrap());
    assert_eq!(plan["session_plan_version"], "2");
    assert_eq!(plan["execution_status"], "not_executed");
    assert!(plan.get("steps").is_none()); // old flat consumers cannot mistake this for a runnable v1 plan
    assert_eq!(plan["components"].as_object().unwrap().len(), 2);
    let root = &plan["components"]["generate_dashboard"];
    let child = &plan["components"]["answer_query"];
    assert_eq!(root["declaration"]["binds"]["topic_default"], "overview");
    assert_eq!(root["steps"][0]["tools"], json!([]));
    assert_eq!(root["steps"][1]["tools"], json!([]));
    assert_eq!(
        root["steps"][1]["component_calls"],
        json!([{"alias":"answer", "component":"answer_query"}])
    );
    assert_eq!(child["steps"][0]["tools"], json!(["query_read_only"]));
    assert_eq!(plan["limits"]["max_steps"], 40);
    assert_eq!(plan["model_turn_hard_limit"], false);
    assert_eq!(plan["monetary_hard_limit"], false);
}

#[test]
fn composed_admission_refuses_untrusted_or_incomplete_execution_semantics() {
    let (ir, host) = fixture();
    produce(&ir, &host).unwrap();
    let dashboard = ir["components"]
        .as_array()
        .unwrap()
        .iter()
        .position(|n| n["id"] == "generate_dashboard")
        .unwrap();
    let answer = ir["components"]
        .as_array()
        .unwrap()
        .iter()
        .position(|n| n["id"] == "answer_query")
        .unwrap();
    let mut cases = vec![];
    let mut x = ir.clone();
    x["components"][dashboard]["llm_calls"][1]["component_calls"][0]["component"] =
        json!("missing");
    cases.push(x);
    let mut x = ir.clone();
    x["components"][dashboard]["llm_calls"][1]["component_calls"][0]["component"] =
        json!("generate_dashboard");
    cases.push(x);
    let mut x = ir.clone();
    x["components"][dashboard]["llm_calls"][1]["capabilities"] = json!([]);
    cases.push(x);
    let mut x = ir.clone();
    x["components"][dashboard]["entrypoint"] = json!(false);
    cases.push(x);
    let mut x = ir.clone();
    x["components"][answer]["borrowed_actions"] = json!(["write"]);
    cases.push(x);
    let mut x = ir.clone();
    x["components"][answer]["precondition_result"]["checks"] = json!([]);
    cases.push(x);
    let mut x = ir.clone();
    x["components"][answer]["context_precondition"][0]["predicate"] = json!("unknown");
    cases.push(x);
    let mut x = ir.clone();
    x["components"][dashboard]["llm_calls"][1]["component_calls"][0]["authority"] = json!("all");
    cases.push(x);
    for (i, bad) in cases.iter().enumerate() {
        assert!(produce(bad, &host).is_err(), "IR mutation {i}");
    }
    for mutation in ["protocol", "execution", "components", "extra"] {
        let mut bad = host.clone();
        bad[mutation] = json!(null);
        assert!(produce(&ir, &bad).is_err(), "host mutation {mutation}");
    }
    let mut bad = host.clone();
    bad["components"]["generate_dashboard"]["capabilities"]["artifact_write"] =
        json!({"tool": "save"});
    assert!(produce(&ir, &bad).is_err());
    let mut bad = host.clone();
    bad["components"]["answer_query"]["capabilities"]["semantic_introspection"] =
        json!({"tool": "query_read_only"});
    assert!(produce(&ir, &bad).is_err());
}

#[test]
fn legacy_host_never_gains_component_call_support_by_omission() {
    let (ir, host) = fixture();
    let mut legacy = host["components"]["generate_dashboard"].clone();
    legacy["version"] = json!("1");
    assert!(produce(&ir, &legacy).is_err());
    let mut slots = SlotSupply::new();
    slots.insert("phrase".into(), Some("verbose".into()));
    assert!(produce_session(
        &ir.to_string(),
        &host.to_string(),
        "generate_dashboard",
        &slots
    )
    .is_err());
}

#[test]
fn null_bindings_are_empty_only_when_no_parameters_are_declared() {
    let (mut ir, host) = fixture();
    let nodes = ir["components"].as_array_mut().unwrap();
    nodes
        .iter_mut()
        .find(|n| n["id"] == "answer_query")
        .unwrap()["binds"] = Value::Null;
    produce(&ir, &host).unwrap();
    let nodes = ir["components"].as_array_mut().unwrap();
    nodes
        .iter_mut()
        .find(|n| n["id"] == "generate_dashboard")
        .unwrap()["binds"] = Value::Null;
    assert!(produce(&ir, &host).is_err());
}

fn native_fixture(root: &std::path::Path, vendor: &str, scope_entry: bool) -> (Value, Value) {
    let (_, contract) = fixture();
    let scope = json!({"version":"3", "kind":"bound_project", "scope_id":"scope-test", "cwd":root,
        "entry":if scope_entry {json!({"kind":"scope", "prompt":"Build a dashboard"})} else {
            json!({"kind":"agent", "verb":"generate_dashboard", "prompt":"Build a dashboard"})},
        "binding":{"project_identity":"project-test", "generation":"1", "revision":"rev-test"}});
    let host = json!({"version":"1", "protocol":COMPONENT_HOST_PROTOCOL, "vendor":vendor,
        "session_id":"session-test", "auth_identity":"approved-account-reference", "runtime_generation":"runtime-test",
        "binding":scope["binding"], "prepared_contexts":{
            "generate_dashboard":format!("sha256:{}", "1".repeat(64)), "answer_query":format!("sha256:{}", "2".repeat(64))},
        "roots":{"generate_dashboard":contract}});
    (scope, host)
}

fn native_dispatch(
    temp: &std::path::Path,
    out: &std::path::Path,
    target: &str,
    scope: &Value,
    host: &Value,
) -> std::process::Output {
    use std::fs;
    fs::write(temp.join("ir.json"), IR).unwrap();
    fs::write(temp.join("scope.json"), scope.to_string()).unwrap();
    fs::write(temp.join("host.json"), host.to_string()).unwrap();
    fs::write(temp.join("mcp.json"), json!({"version":"1", "url":"http://127.0.0.1:18991/native", "credential":"synthetic-test-credential"}).to_string()).unwrap();
    std::process::Command::new(env!("CARGO_BIN_EXE_warble"))
        .arg("dispatch")
        .arg(temp.join("ir.json"))
        .args(["--target", target, "--purpose", "analysis", "--out"])
        .arg(out)
        .arg("--native-scope")
        .arg(temp.join("scope.json"))
        .arg("--native-mcp")
        .arg(temp.join("mcp.json"))
        .arg("--native-host")
        .arg(temp.join("host.json"))
        .output()
        .unwrap()
}

#[test]
fn native_v5_retains_fixed_root_plan_and_vendor_selection_without_step_execution() {
    use std::fs;
    for (vendor, target, scoped) in [
        ("claude", "claude-code:interactive", true),
        ("claude", "claude-code:interactive", false),
        ("codex", "codex:interactive", false),
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let canonical = fs::canonicalize(tmp.path()).unwrap();
        let out = canonical.join("native");
        let (scope, host) = native_fixture(&out, vendor, scoped);
        let output = native_dispatch(&canonical, &out, target, &scope, &host);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let launch: Value =
            serde_json::from_slice(&fs::read(out.join(".warble/interactive-launch.json")).unwrap())
                .unwrap();
        let plans: Value =
            serde_json::from_slice(&fs::read(out.join(".warble/component-plans.json")).unwrap())
                .unwrap();
        assert_eq!(launch["version"], "5");
        assert_eq!(launch["component_host"]["execution"], "host_owned_steps");
        assert_eq!(
            launch["component_host"]["host_plan_sha256"],
            plans["host_plan_sha256"]
        );
        assert_eq!(
            plans["plans"]["generate_dashboard"]["components"]["generate_dashboard"]["steps"][1]
                ["component_calls"][0]["component"],
            "answer_query"
        );
        assert_eq!(
            launch["argv"].as_array().unwrap().last().unwrap(),
            "Build a dashboard"
        );
        let tool = plans["root_tools"]["generate_dashboard"].as_str().unwrap();
        if vendor == "claude" {
            let wrapper =
                fs::read_to_string(out.join(".claude/agents/generate_dashboard.md")).unwrap();
            assert!(wrapper.contains(&format!("tools: mcp__genbi_session__{tool}")));
            assert!(!wrapper.contains("Bash("));
            assert!(!out
                .join(".claude/agents/generate_dashboard__compose_layout.md")
                .exists());
            assert_eq!(
                launch["agent"]["kind"],
                if scoped {
                    "claude_scope"
                } else {
                    "claude_agent"
                }
            );
            if scoped {
                let settings = fs::read_to_string(out.join(".claude/settings.json")).unwrap();
                assert!(
                    settings.contains("Bash(wren"),
                    "scope must retain native union grants"
                );
            }
        } else {
            let config = fs::read_to_string(out.join(".codex/config.toml")).unwrap();
            assert!(config.contains(tool));
            assert!(config.contains("enabled = false"));
            assert!(!config.contains("save_dashboard"));
            assert!(!config.contains("wren-native"));
        }
        assert!(!launch.to_string().contains("synthetic-test-credential"));
        assert!(!plans.to_string().contains("synthetic-test-credential"));
        // Exact repeat is allowed; altered live identity cannot overwrite the original artifacts.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                out.join(".warble/component-plans.json"),
                fs::Permissions::from_mode(0o644),
            )
            .unwrap();
        }
        assert!(native_dispatch(&canonical, &out, target, &scope, &host)
            .status
            .success());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(out.join(".warble/component-plans.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let before = fs::read(out.join(".warble/interactive-launch.json")).unwrap();
        let mut changed = host.clone();
        changed["auth_identity"] = json!("other-account");
        assert!(!native_dispatch(&canonical, &out, target, &scope, &changed)
            .status
            .success());
        assert_eq!(
            fs::read(out.join(".warble/interactive-launch.json")).unwrap(),
            before
        );
    }
}

#[test]
fn invalid_native_host_claims_create_no_artifacts() {
    let tmp = tempfile::tempdir().unwrap();
    let canonical = std::fs::canonicalize(tmp.path()).unwrap();
    let out = canonical.join("native");
    let (scope, host) = native_fixture(&out, "claude", true);
    for field in [
        "vendor",
        "session_id",
        "auth_identity",
        "runtime_generation",
        "binding",
        "prepared_contexts",
        "roots",
        "extra",
    ] {
        let mut bad = host.clone();
        bad[field] = json!(null);
        assert!(
            !native_dispatch(&canonical, &out, "claude-code:interactive", &scope, &bad)
                .status
                .success(),
            "{field}"
        );
        assert!(!out.exists(), "{field}");
    }
    let (scope, host) = native_fixture(&out, "codex", true);
    assert!(
        !native_dispatch(&canonical, &out, "codex:interactive", &scope, &host)
            .status
            .success()
    );
    assert!(!out.exists());
}

#[cfg(unix)]
#[test]
fn native_emission_uses_the_prepared_snapshot_when_source_is_replaced() {
    use std::{
        fs,
        io::Write,
        process::{Command, Stdio},
    };
    let tmp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(tmp.path()).unwrap();
    let out = root.join("native");
    let (scope, host) = native_fixture(&out, "claude", false);
    let ir_path = root.join("ir.json");
    let scope_path = root.join("scope.json");
    let host_path = root.join("host.json");
    let mcp_path = root.join("mcp.json");
    fs::write(&ir_path, IR).unwrap();
    fs::write(&scope_path, scope.to_string()).unwrap();
    fs::write(
        &mcp_path,
        json!({"version":"1", "url":"http://127.0.0.1:18991/native", "credential":"fixture"})
            .to_string(),
    )
    .unwrap();
    assert!(Command::new("mkfifo")
        .arg(&host_path)
        .status()
        .unwrap()
        .success());
    let mut child = Command::new(env!("CARGO_BIN_EXE_warble"))
        .arg("dispatch")
        .arg(&ir_path)
        .args([
            "--target",
            "claude-code:interactive",
            "--purpose",
            "analysis",
            "--out",
        ])
        .arg(&out)
        .arg("--native-scope")
        .arg(&scope_path)
        .arg("--native-mcp")
        .arg(&mcp_path)
        .arg("--native-host")
        .arg(&host_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Nonblocking open bounds a broken preflight instead of leaving the test on a blocking FIFO.
    use std::os::unix::fs::OpenOptionsExt;
    #[cfg(target_os = "macos")]
    const NONBLOCK: i32 = 4;
    #[cfg(not(target_os = "macos"))]
    const NONBLOCK: i32 = 2048;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut writer = loop {
        if let Ok(file) = fs::OpenOptions::new()
            .write(true)
            .custom_flags(NONBLOCK)
            .open(&host_path)
        {
            break file;
        }
        if child.try_wait().unwrap().is_some() || std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("CLI did not reach descriptor read");
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    // Descriptor read occurs after IR read. Replace executable semantics while CLI waits there.
    let mut changed: Value = serde_json::from_str(IR).unwrap();
    for node in changed["components"].as_array_mut().unwrap() {
        node["description"] = json!("REPLACEMENT MUST NOT BE EMITTED");
    }
    fs::write(&ir_path, changed.to_string()).unwrap();
    writer.write_all(host.to_string().as_bytes()).unwrap();
    drop(writer);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let wrapper = fs::read_to_string(out.join(".claude/agents/generate_dashboard.md")).unwrap();
    assert!(!wrapper.contains("REPLACEMENT MUST NOT BE EMITTED"));
    let plan: Value =
        serde_json::from_slice(&fs::read(out.join(".warble/component-plans.json")).unwrap())
            .unwrap();
    use sha2::{Digest, Sha256};
    assert_eq!(
        plan["input_ir_sha256"],
        format!("sha256:{:x}", Sha256::digest(IR.as_bytes()))
    );
}
