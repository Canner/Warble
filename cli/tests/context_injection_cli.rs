use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fixture_ir() -> serde_json::Value {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/driftwood-agent/ir.golden.json");
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn prepare() -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let ir_dir = root.path().join("agent");
    let project = root.path().join("project");
    fs::create_dir_all(project.join("knowledge/rules")).unwrap();
    fs::create_dir_all(&ir_dir).unwrap();
    fs::write(
        project.join("knowledge/rules/rule.md"),
        "# CLI_KNOWLEDGE_MARKER\n\nUse the canonical rule.",
    )
    .unwrap();
    let mut ir = fixture_ir();
    ir["context_binding"]["project"] = serde_json::json!("../project");
    for node in ir["components"].as_array_mut().unwrap() {
        node["context_binding"]["project"] = serde_json::json!("../project");
    }
    let ir_path = ir_dir.join("ir.json");
    fs::write(&ir_path, serde_json::to_string_pretty(&ir).unwrap()).unwrap();
    (root, ir_path)
}

fn dispatch(ir: &Path, out: &Path, mode: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_warble"))
        .args([
            "dispatch",
            "--context-injection",
            mode,
            "--strong",
            "sonnet",
        ])
        .arg(ir)
        .arg("--out")
        .arg(out)
        .output()
        .expect("warble dispatch runs")
}

#[test]
fn cli_dispatches_both_modes_from_one_bound_project_without_path_leakage() {
    let (root, ir) = prepare();
    let mdl_out = root.path().join("mdl-only");
    let knowledge_out = root.path().join("mdl-knowledge");

    let mdl = dispatch(&ir, &mdl_out, "mdl-only");
    assert!(
        mdl.status.success(),
        "{}",
        String::from_utf8_lossy(&mdl.stderr)
    );
    let with_knowledge = dispatch(&ir, &knowledge_out, "mdl+knowledge");
    assert!(
        with_knowledge.status.success(),
        "{}",
        String::from_utf8_lossy(&with_knowledge.stderr)
    );

    let mdl_agent = fs::read_to_string(mdl_out.join(".claude/agents/answer_query.md")).unwrap();
    let knowledge_agent =
        fs::read_to_string(knowledge_out.join(".claude/agents/answer_query.md")).unwrap();
    assert!(!mdl_agent.contains("CLI_KNOWLEDGE_MARKER"));
    assert!(knowledge_agent.contains("CLI_KNOWLEDGE_MARKER"));
    assert!(!mdl_agent.contains(&root.path().display().to_string()));
    assert!(!knowledge_agent.contains(&root.path().display().to_string()));

    let report: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(knowledge_out.join("context-report.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(report["mode"], "mdl+knowledge");
    assert!(report["knowledge_fingerprint"].as_str().is_some());
    assert!(!report.to_string().contains("CLI_KNOWLEDGE_MARKER"));
}

#[test]
fn unknown_context_injection_loud_fails_before_writing() {
    let (root, ir) = prepare();
    let out = root.path().join("unknown");
    let result = dispatch(&ir, &out, "guess");
    assert_eq!(result.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&result.stderr)
        .contains("unknown --context-injection 'guess' (expected: mdl-only, mdl+knowledge)"));
    assert!(!out.exists());
}

#[test]
fn unknown_context_injection_loud_fails_on_vercel_instead_of_being_ignored() {
    let (root, ir) = prepare();
    let out = root.path().join("vercel-unknown");
    let result = Command::new(env!("CARGO_BIN_EXE_warble"))
        .args([
            "dispatch",
            "--target",
            "vercel",
            "--context-injection",
            "guess",
        ])
        .arg(&ir)
        .arg("--out")
        .arg(&out)
        .output()
        .expect("warble dispatch runs");

    assert_eq!(result.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&result.stderr)
        .contains("unknown --context-injection 'guess' (expected: mdl-only, mdl+knowledge)"));
    assert!(!out.exists());
}
