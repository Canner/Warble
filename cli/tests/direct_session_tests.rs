//! No model, broker, runtime or repository context is needed by the producer contract.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, process::Command};
use warble_claude_code::{session::produce_session, slots::SlotSupply};

const IR: &str = include_str!("fixtures/direct-session.ir.json");
const HOST: &str = include_str!("fixtures/direct-session.host.json");

#[test]
fn current_compiler_golden_retains_uncomposed_analysis_steps() {
    let raw = include_str!("../../examples/analysis-agent/ir.golden.json");
    let ir: Value = serde_json::from_str(raw).unwrap();
    for id in ["explore_model", "answer_query"] {
        let selected = ir["components"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .unwrap();
        let (_, mut host) = fixture();
        host["guardrails"] = selected["guardrails"].clone();
        let plan = produce_session(raw, &host.to_string(), id, &SlotSupply::new()).unwrap();
        for (input, output) in selected["llm_calls"]
            .as_array()
            .unwrap()
            .iter()
            .zip(plan["steps"].as_array().unwrap())
        {
            for key in ["name", "tier", "consumes", "produces", "when"] {
                assert_eq!(input[key], output[key], "drifted {id}.{key}");
            }
            assert_eq!(input["prompt"], output["instructions"]);
        }
    }
    // The same current IR's composed entry is deliberately not executable here.
    assert!(produce_session(raw, HOST, "generate_dashboard", &SlotSupply::new()).is_err());
}

fn fixture() -> (Value, Value) {
    (
        serde_json::from_str(IR).unwrap(),
        serde_json::from_str(HOST).unwrap(),
    )
}

fn produce(ir: &Value, host: &Value) -> Value {
    produce_session(
        &ir.to_string(),
        &host.to_string(),
        ir["components"][0]["id"].as_str().unwrap(),
        &SlotSupply::new(),
    )
    .unwrap()
}

#[test]
fn deterministic_plan_preserves_execution_boundaries_and_identity() {
    let result = produce_session(IR, HOST, "analyze", &SlotSupply::new()).unwrap();
    assert_eq!(
        result,
        produce_session(IR, HOST, "analyze", &SlotSupply::new()).unwrap()
    );
    assert_eq!(result["session_plan_version"], "1");
    assert_eq!(result["warble_ir_version"], "0.8");
    assert_eq!(result["authority"], "host_owned");
    assert_eq!(result["execution_status"], "not_executed");
    assert_eq!(
        result["instructions"]["brief"],
        "Use the bound named operations. Be precise."
    );
    assert_eq!(result["steps"][0]["tier"], "cheap");
    assert_eq!(result["steps"][1]["tier"], "strong");
    assert_eq!(result["steps"][0]["tools"], json!(["inspect_context"]));
    assert_eq!(result["steps"][1]["tools"], json!(["query_read_only"]));
    assert_eq!(result["steps"][1]["produces_exclusive"], true);
    assert_eq!(result["steps"][2]["produces"], "repaired");
    assert_eq!(result["steps"][2]["product_availability"], "if_executed");
    assert_eq!(
        result["steps"][2]["realization"],
        json!({
            "kind": "repair_fold", "fold_into": "query", "max_attempts": 1,
            "failure_input": "result", "on_exhaustion": "fail"
        })
    );
    let (ir, _) = fixture();
    assert_eq!(
        result["render_blocks"],
        ir["components"][0]["effect"]["render_blocks"]
    );
    assert_eq!(result["guardrails"], ir["components"][0]["guardrails"]);
    assert_eq!(
        result["context_precondition"],
        ir["components"][0]["context_precondition"]
    );
    assert_eq!(
        result["capability_bindings"]["sql_execution:read_only"],
        json!({"tool": "query_read_only"})
    );
    assert_eq!(
        result["input_ir_sha256"],
        format!("sha256:{:x}", Sha256::digest(IR.as_bytes()))
    );
    assert_eq!(
        result["host_contract_sha256"],
        format!("sha256:{:x}", Sha256::digest(HOST.as_bytes()))
    );
    let mut unhashed = result.clone();
    unhashed.as_object_mut().unwrap().remove("plan_sha256");
    assert_eq!(
        result["plan_sha256"],
        format!(
            "sha256:{:x}",
            Sha256::digest(unhashed.to_string().as_bytes())
        )
    );
    for key in ["mcp_servers", "env", "sandbox", "command", "credentials"] {
        assert!(result.get(key).is_none());
    }
}

#[test]
fn selection_is_by_anatomy_not_component_or_verb_name() {
    let (mut ir, host) = fixture();
    let before = produce(&ir, &host);
    ir["components"][0]["id"] = json!("renamed");
    ir["components"][0]["verb"] = json!("unfamiliar");
    let after = produce(&ir, &host);
    assert_eq!(before["steps"], after["steps"]);
    assert_ne!(before["plan_sha256"], after["plan_sha256"]);
    // Unselected executable work does not leak into the artifact or block this entry.
    ir["components"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"internal", "entrypoint":false, "type":"mutating"}));
    assert_eq!(produce(&ir, &host)["steps"], after["steps"]);
    assert!(produce_session(&ir.to_string(), HOST, "missing", &SlotSupply::new()).is_err());
}

#[test]
fn ir_rejection_matrix_has_a_successful_control_for_each_mutation() {
    let cases = [
        ("/warble_ir_version", json!("0.6")),
        ("/config", json!({"network": true})),
        ("/config", json!({"capability_ceiling": ["llm:cheap"]})),
        ("/components/0/type", json!("mutating")),
        ("/components/0/entrypoint", json!(false)),
        ("/components/0/realization_kind", json!("tool")),
        ("/components/0/trigger", json!({"kind":"scheduled"})),
        ("/components/0/effect/outcome", json!({"kind":"mutation"})),
        (
            "/components/0/params",
            json!([{"name":"secret","bind":"runtime"}]),
        ),
        ("/components/0/context_binding/project", json!("other")),
        ("/components/0/precondition_result/status", json!("fail")),
        (
            "/components/0/precondition_result/checks/0/outcome",
            json!("fail"),
        ),
        ("/components/0/guardrails/0/locked", json!(false)),
        ("/components/0/guardrails/1/threshold", json!(101)),
        (
            "/components/0/required_capabilities",
            json!(["shell", "llm:cheap"]),
        ),
        (
            "/components/0/llm_calls/1/capabilities",
            json!(["data_write"]),
        ),
        ("/components/0/llm_calls/1/capabilities", Value::Null),
        ("/components/0/llm_calls/1/consumes", json!(["unknown"])),
        ("/components/0/llm_calls/1/produces", json!("intent")),
        ("/components/0/llm_calls/1/produces", Value::Null),
        ("/components/0/llm_calls/1/name", json!("inspect")),
        ("/components/0/llm_calls/1/tier", json!("other")),
        ("/components/0/llm_calls/2/when/guard", json!("on_missing")),
        ("/components/0/llm_calls/2/when/target", json!("inspect")),
        ("/components/0/llm_calls/2/conditional", json!(false)),
        ("/components/0/llm_calls/2/when", Value::Null),
        ("/components/0/llm_calls/2/consumes", json!(["intent"])),
        ("/components/0/llm_calls/2/produces", json!("result")),
        ("/components/0/brief", json!("{{ slot.unknown }}")),
    ];
    for (path, value) in cases {
        let (mut ir, host) = fixture();
        produce(&ir, &host);
        *ir.pointer_mut(path).unwrap() = value;
        assert!(
            produce_session(
                &ir.to_string(),
                &host.to_string(),
                "analyze",
                &SlotSupply::new()
            )
            .is_err(),
            "accepted {path}"
        );
    }
}

#[test]
fn unsupported_additive_facets_and_conditional_artifact_consumers_fail_closed() {
    for (field, value) in [
        ("assets", json!([{"path":"run.sh"}])),
        ("binds", json!({"question":"injected"})),
        ("unknown_policy", json!(true)),
    ] {
        let (mut ir, host) = fixture();
        ir["components"][0][field] = value;
        assert!(produce_session(
            &ir.to_string(),
            &host.to_string(),
            "analyze",
            &SlotSupply::new()
        )
        .is_err());
    }
    let (mut ir, host) = fixture();
    ir["components"][0]["llm_calls"][0]["component_calls"] =
        json!([{"alias":"child","component":"x"}]);
    assert!(produce_session(&ir.to_string(), HOST, "analyze", &SlotSupply::new()).is_err());
    let (mut ir, _) = fixture();
    let mut next = ir["components"][0]["llm_calls"][0].clone();
    next["name"] = json!("later");
    next["produces"] = json!("final");
    next["consumes"] = json!(["repaired"]);
    ir["components"][0]["llm_calls"]
        .as_array_mut()
        .unwrap()
        .push(next);
    assert!(produce_session(&ir.to_string(), HOST, "analyze", &SlotSupply::new()).is_err());
    ir["components"][0]["llm_calls"][3]["consumes"] = json!(["result"]);
    produce(&ir, &host);
}

#[test]
fn host_claims_are_closed_exact_and_non_aliasing() {
    for (path, value) in [
        ("/version", json!("2")),
        ("/tiers", json!(["cheap"])),
        ("/tiers", json!(["cheap", "strong", "strong"])),
        ("/execution", json!(["ordered_steps"])),
        ("/guardrails/1/threshold", json!(0)),
        ("/guardrails/1/threshold", json!("100")),
        (
            "/capabilities/semantic_introspection/tool",
            json!("query_read_only"),
        ),
        (
            "/capabilities/semantic_introspection/tool",
            json!("/bin/sh"),
        ),
        (
            "/capabilities/semantic_introspection/tool",
            json!("read;exec"),
        ),
        ("/capabilities/render_contract", json!({"tool":"render"})),
    ] {
        let (ir, mut host) = fixture();
        produce(&ir, &host);
        *host.pointer_mut(path).unwrap() = value;
        assert!(
            produce_session(IR, &host.to_string(), "analyze", &SlotSupply::new()).is_err(),
            "accepted {path}"
        );
    }
    for (field, value) in [
        ("env", json!({"TOKEN":"secret"})),
        ("mcp_servers", json!({})),
        ("network", json!(true)),
    ] {
        let (_, mut host) = fixture();
        host[field] = value;
        assert!(produce_session(IR, &host.to_string(), "analyze", &SlotSupply::new()).is_err());
    }
    let (_, mut host) = fixture();
    host["capabilities"]["render_contract"].take();
    assert!(produce_session(IR, &host.to_string(), "analyze", &SlotSupply::new()).is_err());
}

#[test]
fn duplicate_json_keys_and_size_limits_are_not_silently_accepted() {
    for raw in [
        IR.replacen("\"profile\":", "\"profile\":\"ignored\",\"profile\":", 1),
        IR.replacen("\"locked\": true", "\"locked\":false,\"locked\":true", 1),
    ] {
        assert!(produce_session(&raw, HOST, "analyze", &SlotSupply::new()).is_err());
    }
    let duplicate_host = HOST.replace(
        "\"tool\": \"inspect_context\"",
        "\"tool\":\"other\",\"tool\":\"inspect_context\"",
    );
    assert!(produce_session(IR, &duplicate_host, "analyze", &SlotSupply::new()).is_err());
    let huge = " ".repeat(warble_claude_code::session::MAX_INPUT_BYTES + 1);
    for (ir, host) in [(huge.as_str(), HOST), (IR, huge.as_str())] {
        assert!(produce_session(ir, host, "analyze", &SlotSupply::new()).is_err());
    }
}

#[test]
fn slots_affect_identity_and_require_explicit_conditions() {
    let base = produce_session(IR, HOST, "analyze", &SlotSupply::new()).unwrap();
    let supply = SlotSupply::from([("tone".into(), Some("terse".into()))]);
    let terse = produce_session(IR, HOST, "analyze", &supply).unwrap();
    assert_ne!(base["plan_sha256"], terse["plan_sha256"]);
    assert_eq!(
        terse["instructions"]["brief"],
        "Use the bound named operations. Be brief."
    );
    let (mut ir, _) = fixture();
    ir["slots"][0]["present_when"] = json!({"host":"condition"});
    assert!(produce_session(&ir.to_string(), HOST, "analyze", &SlotSupply::new()).is_err());
    let omitted = produce_session(
        &ir.to_string(),
        HOST,
        "analyze",
        &SlotSupply::from([("tone".into(), None)]),
    )
    .unwrap();
    assert_eq!(
        omitted["instructions"]["brief"],
        "Use the bound named operations. "
    );
    ir["slots"][0]["variants"]["base"] = json!("{{ slot.tone }}");
    assert!(produce_session(&ir.to_string(), HOST, "analyze", &supply).is_err());
    for supply in [
        SlotSupply::from([("unknown".into(), None)]),
        SlotSupply::from([("tone".into(), Some("unknown".into()))]),
    ] {
        assert!(produce_session(IR, HOST, "analyze", &supply).is_err());
    }
}

#[test]
fn expansion_and_duplicate_scope_are_rejected_before_resolution() {
    let (mut ir, _) = fixture();
    ir["components"][0]["slots"] = ir["slots"].clone();
    assert!(produce_session(&ir.to_string(), HOST, "analyze", &SlotSupply::new()).is_err());
    ir["components"][0].as_object_mut().unwrap().remove("slots");
    ir["slots"][0]["variants"]["base"] = json!("x".repeat(4096));
    ir["components"][0]["brief"] = json!("{{ slot.tone }}".repeat(2048));
    assert!(produce_session(&ir.to_string(), HOST, "analyze", &SlotSupply::new()).is_err());
}

#[test]
fn optional_empty_facets_are_normalized_and_omitted_step_capabilities_inherit() {
    let (mut ir, host) = fixture();
    let node = &mut ir["components"][0];
    node.as_object_mut().unwrap().remove("context_precondition");
    node["effect"]
        .as_object_mut()
        .unwrap()
        .remove("render_blocks");
    node["llm_calls"][0]
        .as_object_mut()
        .unwrap()
        .remove("capabilities");
    let plan = produce(&ir, &host);
    assert_eq!(plan["context_precondition"], json!([]));
    assert_eq!(plan["render_blocks"], json!([]));
    assert_eq!(
        plan["steps"][0]["tools"],
        json!(["inspect_context", "query_read_only"])
    );
    assert!(plan["capability_bindings"].get("render_contract").is_none());
}

#[test]
fn artifact_scope_and_empty_step_tools_are_preserved_without_authority_widening() {
    let (mut ir, mut host) = fixture();
    ir["components"][0]["required_capabilities"]
        .as_array_mut()
        .unwrap()
        .push(json!("artifact_write"));
    host["capabilities"]["artifact_write"] = json!({"tool":"save_artifact"});
    assert!(produce_session(
        &ir.to_string(),
        &host.to_string(),
        "analyze",
        &SlotSupply::new()
    )
    .is_err());
    ir["components"][0]["guardrails"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name":"artifact_write","locked":true,"scope":"reports"}));
    host["guardrails"] = ir["components"][0]["guardrails"].clone();
    ir["components"][0]["llm_calls"][0]["capabilities"] = json!([]);
    let output = produce(&ir, &host);
    assert_eq!(output["steps"][0]["tools"], json!([]));
    assert_eq!(
        output["capability_bindings"]["artifact_write"]["tool"],
        "save_artifact"
    );
    for scope in ["/tmp", "../other", "a/../other", "C:\\other"] {
        ir["components"][0]["guardrails"][4]["scope"] = json!(scope);
        host["guardrails"] = ir["components"][0]["guardrails"].clone();
        assert!(produce_session(
            &ir.to_string(),
            &host.to_string(),
            "analyze",
            &SlotSupply::new()
        )
        .is_err());
    }
}

fn install() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("node_modules/.bin");
    fs::create_dir_all(&bin).unwrap();
    fs::copy(env!("CARGO_BIN_EXE_warble"), bin.join("warble")).unwrap();
    fs::write(dir.path().join("ir.json"), IR).unwrap();
    fs::write(dir.path().join("host.json"), HOST).unwrap();
    dir
}

fn command(dir: &tempfile::TempDir) -> Command {
    let mut cmd = Command::new(dir.path().join("node_modules/.bin/warble"));
    cmd.current_dir(dir.path())
        .env_clear()
        .env("PATH", dir.path().join("no-runtime"))
        .env("HOME", dir.path().join("no-home"))
        .args([
            "produce-session",
            "ir.json",
            "--component",
            "analyze",
            "--host-contract",
            "host.json",
            "--out",
            "plan.json",
        ]);
    cmd
}

#[test]
fn relocated_binary_only_needs_explicit_inputs_and_creates_one_plan() {
    let dir = install();
    let output = output_after_install(&mut command(&dir));
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    let plan: Value =
        serde_json::from_slice(&fs::read(dir.path().join("plan.json")).unwrap()).unwrap();
    assert_eq!(
        plan,
        produce_session(IR, HOST, "analyze", &SlotSupply::new()).unwrap()
    );
    for absent in [
        ".codex",
        ".claude",
        "no-runtime",
        "no-home",
        "not-installed",
        "node_modules/examples",
    ] {
        assert!(!dir.path().join(absent).exists(), "unexpected {absent}");
    }
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 4);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(dir.path().join("plan.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn installed_bin_is_resolvable_with_only_its_own_directory_on_path() {
    let dir = install();
    let output = output_after_install(
        Command::new("warble")
            .current_dir(dir.path())
            .env_clear()
            .env("PATH", dir.path().join("node_modules/.bin"))
            .args([
                "produce-session",
                "ir.json",
                "--component",
                "analyze",
                "--host-contract",
                "host.json",
                "--out",
                "plan.json",
            ]),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(dir.path().join("plan.json").is_file());
}

#[test]
fn cli_refuses_invalid_input_and_vendor_flags_before_output() {
    for args in [
        vec!["--target", "codex:interactive"],
        vec!["--native-mcp", "auto"],
        vec!["--slot", "tone=terse", "--slot", "tone=base"],
    ] {
        let dir = install();
        let result = output_after_install(command(&dir).args(args));
        assert!(!result.status.success());
        assert!(!dir.path().join("plan.json").exists());
    }
    let dir = install();
    fs::write(dir.path().join("ir.json"), IR.replace("\"0.8\"", "\"0.6\"")).unwrap();
    assert!(!output_after_install(&mut command(&dir)).status.success());
    assert!(!dir.path().join("plan.json").exists());
}

#[test]
fn output_file_and_symlink_are_never_overwritten() {
    let dir = install();
    fs::write(dir.path().join("plan.json"), "canary").unwrap();
    assert!(!output_after_install(&mut command(&dir)).status.success());
    assert_eq!(
        fs::read_to_string(dir.path().join("plan.json")).unwrap(),
        "canary"
    );
    #[cfg(unix)]
    {
        fs::remove_file(dir.path().join("plan.json")).unwrap();
        std::os::unix::fs::symlink("host.json", dir.path().join("plan.json")).unwrap();
        assert!(!output_after_install(&mut command(&dir)).status.success());
        assert_eq!(
            fs::read_to_string(dir.path().join("host.json")).unwrap(),
            HOST
        );
    }
}

// Parallel test spawns may inherit a just-copied executable's writable file
// descriptor until exec closes it. Match the native-launch test handling:
// retry only ETXTBSY, never a process failure or a different spawn error.
fn output_after_install(command: &mut Command) -> std::process::Output {
    for _ in 0..100 {
        match command.output() {
            Ok(output) => return output,
            Err(error) if error.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(error) => panic!("installed executable did not launch: {error}"),
        }
    }
    panic!("installed executable remained write-open across all retries");
}
