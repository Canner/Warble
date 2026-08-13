//! Deterministic native-TUI materialization coverage. The fake executable is a consumer-side
//! process seam: Warble only writes its launch spec and never spawns it.

use std::fs;
use std::os::unix::fs::symlink;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;

const IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../genbi-enrich-context/ir.golden.json"
);

fn dispatch(target: &str, out: &std::path::Path) -> std::process::Output {
    dispatch_ir(IR, target, out)
}

fn dispatch_ir(ir: &str, target: &str, out: &std::path::Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_warble"))
        .args(["dispatch", ir, "--target", target, "--out"])
        .arg(out)
        .output()
        .expect("warble dispatch starts")
}

fn spec(out: &std::path::Path) -> serde_json::Value {
    serde_json::from_str(&fs::read_to_string(out.join(".warble/interactive-launch.json")).unwrap())
        .unwrap()
}

/// This is deliberately a consumer-side seam. It proves the spec can launch a fixed fake native
/// executable, while the dispatcher itself remains pure artifact materialization.
fn launch_fake(spec: &serde_json::Value, root: &std::path::Path) {
    let bin = root.join("fake-bin");
    fs::create_dir_all(&bin).unwrap();
    let executable = spec["executable"].as_str().unwrap();
    let fake = bin.join(executable);
    let capture = root.join("fake-cli-capture.txt");
    fs::write(
        &fake,
        "#!/bin/sh\nprintf '%s\\n' \"$PWD\" > \"$FAKE_CAPTURE\"\nprintf '%s\\n' \"$@\" >> \"$FAKE_CAPTURE\"\n",
    )
    .unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    let status = Command::new(fake)
        .args(
            spec["argv"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap()),
        )
        .current_dir(spec["cwd"].as_str().unwrap())
        .env("FAKE_CAPTURE", &capture)
        .status()
        .unwrap();
    assert!(status.success());
    assert_eq!(
        fs::read_to_string(capture).unwrap(),
        format!("{}\n\n", spec["cwd"].as_str().unwrap())
    );
}

#[test]
fn claude_interactive_emits_read_access_gated_apply_and_a_minimal_launch_spec() {
    let out = tempfile::tempdir().unwrap();
    let result = dispatch("claude-code:interactive", out.path());
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let launch = spec(out.path());
    assert_eq!(launch.as_object().unwrap().len(), 7);
    assert_eq!(launch["version"], "1");
    assert_eq!(launch["target"], "claude-code:interactive");
    assert_eq!(launch["executable"], "claude");
    assert_eq!(launch["argv"], serde_json::json!([]));
    for forbidden in [
        "command",
        "prompt",
        "model",
        "credential",
        "provider",
        "session",
    ] {
        assert!(
            launch.get(forbidden).is_none(),
            "launch spec must not carry {forbidden}"
        );
    }
    assert!(launch["cwd"].as_str().unwrap().starts_with('/'));
    assert_eq!(launch["cwd"], launch["artifact_root"]);
    assert!(launch["handoff_path"]
        .as_str()
        .unwrap()
        .starts_with(launch["cwd"].as_str().unwrap()));
    launch_fake(&launch, out.path());
    let inspect = fs::read_to_string(out.path().join(".claude/agents/inspect_context.md")).unwrap();
    assert!(inspect.contains("Read"));
    assert!(!out
        .path()
        .join(".claude/agents/apply_enrichment.md")
        .exists());
    let run = fs::read_to_string(out.path().join("RUN.md")).unwrap();
    assert!(run.contains("claude --agent draft_enrichment"));
    assert!(run.contains(".warble/interactive-launch.json"));
    assert!(run.contains("native interactive session"));
    for forbidden in [
        "claude -p",
        "--print",
        "headless",
        "../examples/jaffle-wren",
    ] {
        assert!(
            !run.contains(forbidden),
            "interactive enrichment handoff must not contain {forbidden}"
        );
    }
}

#[test]
fn codex_interactive_emits_repo_scoped_discovery_artifacts_without_a_runtime_owner() {
    let out = tempfile::tempdir().unwrap();
    let result = dispatch("codex:interactive", out.path());
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let skill = fs::read_to_string(
        out.path()
            .join(".agents/skills/genbi-enrich-context/SKILL.md"),
    )
    .unwrap();
    let agents = fs::read_to_string(out.path().join("AGENTS.md")).unwrap();
    assert!(skill.contains("name: genbi-enrich-context"));
    assert!(skill.contains("never apply"));
    assert!(skill.contains("codex exec"));
    assert!(agents.contains("$genbi-enrich-context"));
    let launch = spec(out.path());
    assert_eq!(launch["target"], "codex:interactive");
    assert_eq!(launch["executable"], "codex");
    assert_eq!(launch["argv"], serde_json::json!([]));
    launch_fake(&launch, out.path());
}

#[test]
fn hostile_native_config_collision_fails_before_any_partial_claude_output() {
    let out = tempfile::tempdir().unwrap();
    fs::create_dir_all(out.path().join(".claude")).unwrap();
    fs::write(out.path().join(".claude/settings.json"), "user-owned").unwrap();
    let result = dispatch("claude-code:interactive", out.path());
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("refusing to overwrite"));
    assert!(
        !out.path().join("context-report.json").exists(),
        "preflight must fail before first emission write"
    );
    assert_eq!(
        fs::read_to_string(out.path().join(".claude/settings.json")).unwrap(),
        "user-owned"
    );
}

#[test]
fn hostile_codex_agents_collision_fails_before_any_partial_skill_output() {
    let out = tempfile::tempdir().unwrap();
    fs::write(out.path().join("AGENTS.md"), "user-owned").unwrap();
    let result = dispatch("codex:interactive", out.path());
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("refusing to overwrite"));
    assert!(!out
        .path()
        .join(".agents/skills/genbi-enrich-context/SKILL.md")
        .exists());
    assert_eq!(
        fs::read_to_string(out.path().join("AGENTS.md")).unwrap(),
        "user-owned"
    );
}

#[test]
fn rerun_refuses_an_owned_artifact_edited_by_the_user_before_any_write() {
    let out = tempfile::tempdir().unwrap();
    assert!(dispatch("claude-code:interactive", out.path())
        .status
        .success());
    let agent = out.path().join(".claude/agents/inspect_context.md");
    fs::write(&agent, "user edit").unwrap();
    let result = dispatch("claude-code:interactive", out.path());
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("modified owned artifact"));
    assert_eq!(fs::read_to_string(agent).unwrap(), "user edit");
}

#[test]
fn symlinked_output_parent_is_rejected_before_any_write() {
    for (target, parent) in [
        ("claude-code:interactive", ".claude"),
        ("codex:interactive", ".agents"),
        ("codex:interactive", ".warble"),
    ] {
        let out = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), out.path().join(parent)).unwrap();
        let result = dispatch(target, out.path());
        assert!(!result.status.success(), "{target} with {parent}");
        assert!(String::from_utf8_lossy(&result.stderr).contains("symlink component"));
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    }
}

#[test]
fn regular_file_output_parent_is_rejected_before_any_write() {
    for (target, parent) in [
        ("claude-code:interactive", ".claude"),
        ("codex:interactive", ".agents"),
        ("codex:interactive", ".warble"),
    ] {
        let out = tempfile::tempdir().unwrap();
        fs::write(out.path().join(parent), "user-owned").unwrap();
        let result = dispatch(target, out.path());
        assert!(!result.status.success(), "{target} with {parent}");
        assert!(
            String::from_utf8_lossy(&result.stderr).contains("non-directory ancestor component")
        );
        assert_eq!(
            fs::read_dir(out.path()).unwrap().count(),
            1,
            "preflight must fail before writing any artifact for {target} with {parent}"
        );
        assert_eq!(
            fs::read_to_string(out.path().join(parent)).unwrap(),
            "user-owned"
        );
    }
}

#[test]
fn apply_only_ir_loud_fails_without_writing_native_handoff() {
    let source: serde_json::Value = serde_json::from_str(&fs::read_to_string(IR).unwrap()).unwrap();
    let apply = source["components"]
        .as_array()
        .unwrap()
        .iter()
        .find(|component| component["id"] == "apply_enrichment")
        .unwrap()
        .clone();
    let mut only_apply = source;
    only_apply["components"] = serde_json::json!([apply]);
    let fixture = tempfile::NamedTempFile::new().unwrap();
    fs::write(fixture.path(), serde_json::to_string(&only_apply).unwrap()).unwrap();
    for target in ["claude-code:interactive", "codex:interactive"] {
        let out = tempfile::tempdir().unwrap();
        let result = dispatch_ir(fixture.path().to_str().unwrap(), target, out.path());
        assert!(!result.status.success(), "{target}");
        assert!(String::from_utf8_lossy(&result.stderr)
            .contains("apply_enrichment cannot be dispatched"));
        assert!(
            fs::read_dir(out.path()).unwrap().next().is_none(),
            "{target} must fail before writing artifacts"
        );
    }
}
