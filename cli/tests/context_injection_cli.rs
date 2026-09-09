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

fn dispatch(ir: &Path, out: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_warble"))
        .args(["dispatch", "--strong", "sonnet"])
        .arg(ir)
        .arg("--out")
        .arg(out)
        .output()
        .expect("warble dispatch runs")
}

/// The bound project on disk carries a knowledge rule, and dispatch must still not embed it: the
/// CLI reads no semantic-layer knowledge at all. The fixture's rule file is what makes this
/// discriminating — re-wire a host-side knowledge read and the marker shows up here.
#[test]
fn cli_dispatch_embeds_no_project_knowledge_and_leaks_no_path() {
    let (root, ir) = prepare();
    let out = root.path().join("schema-only");

    let schema = dispatch(&ir, &out);
    assert!(
        schema.status.success(),
        "{}",
        String::from_utf8_lossy(&schema.stderr)
    );

    let agent = fs::read_to_string(out.join(".claude/agents/answer_query.md")).unwrap();
    assert!(!agent.contains("CLI_KNOWLEDGE_MARKER"));
    assert!(!agent.contains(&root.path().display().to_string()));

    let report: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(out.join("context-report.json")).unwrap())
            .unwrap();
    assert_eq!(report["mode"], "schema-only");
    assert!(report["knowledge_fingerprint"].is_null());
    assert_eq!(report["knowledge_chars"], 0);
}

/// Injection is no longer a caller's choice, so the flag is gone rather than kept with one legal
/// value. A caller still passing it is told the argument does not exist instead of having it
/// quietly accepted — which is what a `default_value` on a one-value flag would have done.
#[test]
fn the_injection_mode_is_not_a_caller_choice_and_the_flag_is_gone() {
    let (root, ir) = prepare();
    let out = root.path().join("retired");
    let result = Command::new(env!("CARGO_BIN_EXE_warble"))
        .args(["dispatch", "--context-injection", "schema+knowledge"])
        .arg(&ir)
        .arg("--out")
        .arg(&out)
        .output()
        .expect("warble dispatch runs");
    assert_eq!(result.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&result.stderr)
        .contains("unexpected argument '--context-injection'"));
    assert!(!out.exists());
}

/// An enum-shaped knob with a misspelled value must fail before anything is written.
#[test]
fn an_unknown_enum_knob_loud_fails_before_writing() {
    let (root, ir) = prepare();
    let out = root.path().join("unknown");
    let result = Command::new(env!("CARGO_BIN_EXE_warble"))
        .args(["dispatch", "--render-flavor", "guess"])
        .arg(&ir)
        .arg("--out")
        .arg(&out)
        .output()
        .expect("warble dispatch runs");
    assert_eq!(result.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&result.stderr)
        .contains("unknown --render-flavor 'guess' (expected: programmatic, prompt)"));
    assert!(!out.exists());
}

/// …including on the targets that realize the knob least. `vercel` and `codex:interactive` each
/// return early from `run_dispatch` into their own back-end, so a knob validated after either
/// branch is silently ignored there. Both are checked rather than one: validation placed *between*
/// the two branches would satisfy a single-target test while the other regressed unnoticed.
///
/// Ignoring a misspelled value is indistinguishable from honouring it, which is the whole point —
/// the caller asked for something this build cannot do either way, and should hear so.
#[test]
fn an_unknown_enum_knob_loud_fails_on_every_early_returning_target() {
    for target in ["vercel", "codex:interactive"] {
        let (root, ir) = prepare();
        let out = root.path().join("early-return-unknown");
        let result = Command::new(env!("CARGO_BIN_EXE_warble"))
            .args(["dispatch", "--target", target, "--render-flavor", "guess"])
            .arg(&ir)
            .arg("--out")
            .arg(&out)
            .output()
            .expect("warble dispatch runs");

        assert_eq!(result.status.code(), Some(1), "target {target}");
        assert!(
            String::from_utf8_lossy(&result.stderr)
                .contains("unknown --render-flavor 'guess' (expected: programmatic, prompt)"),
            "target {target}"
        );
        assert!(!out.exists(), "target {target}");
    }
}
