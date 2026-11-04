use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, process::Command};
use tempfile::TempDir;

fn fixture() -> (TempDir, std::path::PathBuf, std::path::PathBuf) {
    let dir = TempDir::new().unwrap();
    let ir = dir.path().join("ir.json");
    fs::write(
        &ir,
        include_str!("../../examples/hybrid-chat/ir.golden.json"),
    )
    .unwrap();
    let adapter = dir.path().join("adapter.mjs");
    fs::write(
        &adapter,
        "export async function loadProject() { return {}; }",
    )
    .unwrap();
    let config = dir.path().join("config.json");
    let model = json!({"zone":"public","deployment":"cloud","api":"openai-completions","model":"fixture",
        "baseUrl":"http://127.0.0.1:1/v1","credentialEnv":"PUBLIC_KEY"});
    let mut private = model.clone();
    private["zone"] = json!("private");
    private["deployment"] = json!("local");
    fs::write(&config, serde_json::to_vec(&json!({"format":"warble-pi-hybrid-config/1", "entry":"caller",
        "policy":"permit(principal, action, resource);",
        "selections":{"blind":{"metadata":[],"components":["callee"],"approvedAnswers":true}},
        "models":{"public":model},"projects":{"demo":{"privateModels":{"callee":{"cheap":private}}}},
        "defaults":{"policy":"blind","model":"public","project":"demo"},
        "adapter":{"path":adapter, "sha256":format!("{:x}",Sha256::digest(fs::read(&adapter).unwrap()))}})).unwrap()).unwrap();
    (dir, ir, config)
}
#[test]
fn parser_emits_separate_contract_and_never_overwrites_output() {
    let (dir, ir, config) = fixture();
    let out = dir.path().join("launch");
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_warble"))
            .args([
                "dispatch",
                ir.to_str().unwrap(),
                "--target",
                "pi:hybrid",
                "--hybrid-config",
                config.to_str().unwrap(),
                "--out",
                out.to_str().unwrap(),
            ])
            .output()
            .unwrap()
    };
    assert!(run().status.success());
    let bundle: Value =
        serde_json::from_slice(&fs::read(out.join("launch.json")).unwrap()).unwrap();
    assert_eq!(bundle["format"], "warble-pi-hybrid/1");
    assert_eq!(bundle["ir"]["warble_ir_version"], "0.9");
    let before = fs::read(out.join("launch.json")).unwrap();
    assert!(!run().status.success());
    assert_eq!(before, fs::read(out.join("launch.json")).unwrap());
}
#[test]
fn unsupported_shapes_fail_before_output() {
    for kind in ["render", "steps", "guardrail", "nested", "version"] {
        let (dir, path, config) = fixture();
        let mut ir: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        match kind {
            "render" => ir["components"][1]["effect"]["outcome"]["kind"] = json!("artifact"),
            "steps" => {
                let step = ir["components"][1]["llm_calls"][0].clone();
                ir["components"][1]["llm_calls"]
                    .as_array_mut()
                    .unwrap()
                    .push(step);
            }
            "guardrail" => {
                ir["components"][1]["guardrails"] = json!([{"name":"human_approval","locked":true}])
            }
            "nested" => {
                ir["components"][1]["llm_calls"][0]["component_calls"] =
                    json!([{"alias":"x","component":"caller"}])
            }
            _ => ir["warble_ir_version"] = json!("0.10"),
        }
        fs::write(&path, serde_json::to_vec(&ir).unwrap()).unwrap();
        let out = dir.path().join("launch");
        let result = Command::new(env!("CARGO_BIN_EXE_warble"))
            .args([
                "dispatch",
                path.to_str().unwrap(),
                "--target",
                "pi:hybrid",
                "--hybrid-config",
                config.to_str().unwrap(),
                "--out",
                out.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(!result.status.success(), "{kind}");
        assert!(!out.exists(), "{kind}");
    }
}
#[test]
fn foreign_flags_and_missing_config_refuse() {
    let (dir, ir, config) = fixture();
    for extra in [
        vec![],
        vec![
            "--hybrid-config",
            config.to_str().unwrap(),
            "--pi-model",
            "openai/x",
        ],
        vec![
            "--hybrid-config",
            config.to_str().unwrap(),
            "--strong",
            "other",
        ],
        vec![
            "--hybrid-config",
            config.to_str().unwrap(),
            "--purpose",
            "analysis",
        ],
    ] {
        let out = dir.path().join("launch");
        let result = Command::new(env!("CARGO_BIN_EXE_warble"))
            .args([
                "dispatch",
                ir.to_str().unwrap(),
                "--target",
                "pi:hybrid",
                "--out",
                out.to_str().unwrap(),
            ])
            .args(extra)
            .output()
            .unwrap();
        assert!(!result.status.success());
        assert!(!out.exists());
    }
    let result = Command::new(env!("CARGO_BIN_EXE_warble"))
        .args([
            "dispatch",
            ir.to_str().unwrap(),
            "--out",
            dir.path().join("other").to_str().unwrap(),
            "--hybrid-config",
            config.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!result.status.success());
}

#[test]
fn credential_literals_and_incomplete_binding_never_land_on_disk() {
    for field in ["apiKey", "missing"] {
        let (dir, ir, path) = fixture();
        let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        if field == "apiKey" {
            config["models"]["public"]["apiKey"] = json!("SECRET_CANARY");
        } else {
            config["projects"]["demo"]["privateModels"] = json!({});
        }
        fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
        let out = dir.path().join("launch");
        let result = Command::new(env!("CARGO_BIN_EXE_warble"))
            .args([
                "dispatch",
                ir.to_str().unwrap(),
                "--target",
                "pi:hybrid",
                "--hybrid-config",
                path.to_str().unwrap(),
                "--out",
                out.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(!result.status.success());
        assert!(!out.exists());
        assert!(!String::from_utf8_lossy(&result.stderr).contains("SECRET_CANARY"));
    }
}
