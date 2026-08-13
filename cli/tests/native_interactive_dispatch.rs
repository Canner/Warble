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
const ANALYSIS_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../genbi-default/ir.golden.json"
);
const SETUP_IR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../genbi-setup/ir.golden.json");

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

fn dispatch_purpose(
    ir: &str,
    target: &str,
    purpose: &str,
    out: &std::path::Path,
) -> std::process::Output {
    dispatch_purpose_with_scope(
        ir,
        target,
        purpose,
        out,
        native_scope_value(purpose, out, "7", "opaque-revision"),
    )
}

fn native_scope_value(
    purpose: &str,
    out: &std::path::Path,
    generation: &str,
    revision: &str,
) -> serde_json::Value {
    let kind = if purpose == "setup" {
        "bootstrap"
    } else {
        "bound_project"
    };
    let mut scope = serde_json::json!({
        "version": "1",
        "kind": kind,
        "scope_id": format!("opaque-{kind}-scope"),
        "cwd": fs::canonicalize(out).unwrap(),
    });
    if kind == "bound_project" {
        scope["binding"] = serde_json::json!({
            "project_identity": "opaque-project",
            "generation": generation,
            "revision": revision,
        });
    }
    scope
}

fn dispatch_purpose_with_scope(
    ir: &str,
    target: &str,
    purpose: &str,
    out: &std::path::Path,
    scope: serde_json::Value,
) -> std::process::Output {
    let scope_file = tempfile::NamedTempFile::new().unwrap();
    fs::write(scope_file.path(), serde_json::to_string(&scope).unwrap()).unwrap();
    Command::new(env!("CARGO_BIN_EXE_warble"))
        .args([
            "dispatch",
            ir,
            "--target",
            target,
            "--purpose",
            purpose,
            "--native-scope",
        ])
        .arg(scope_file.path())
        .args(["--out"])
        .arg(out)
        .output()
        .expect("warble native purpose dispatch starts")
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
    let argv = spec["argv"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        fs::read_to_string(capture).unwrap(),
        format!("{}\n{}\n", spec["cwd"].as_str().unwrap(), argv.join("\n"))
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
fn purpose_less_v1_launch_json_remains_byte_for_byte_compatible() {
    let out = tempfile::tempdir().unwrap();
    let result = dispatch("claude-code:interactive", out.path());
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let root = fs::canonicalize(out.path()).unwrap();
    assert_eq!(
        fs::read_to_string(out.path().join(".warble/interactive-launch.json")).unwrap(),
        format!(
            concat!(
                "{{\n",
                "  \"argv\": [],\n",
                "  \"artifact_root\": \"{}\",\n",
                "  \"cwd\": \"{}\",\n",
                "  \"executable\": \"claude\",\n",
                "  \"handoff_path\": \"{}/RUN.md\",\n",
                "  \"target\": \"claude-code:interactive\",\n",
                "  \"version\": \"1\"\n",
                "}}\n"
            ),
            root.display(),
            root.display(),
            root.display(),
        ),
        "purpose-less v1 launch JSON must remain byte-for-byte compatible"
    );
}

#[test]
fn native_session_v2_materializes_every_allowlisted_purpose_for_both_vendors() {
    for (purpose, ir, scope, claude_agent, codex_skill) in [
        (
            "analysis",
            ANALYSIS_IR,
            "bound_project",
            "answer_query",
            "genbi-analysis",
        ),
        (
            "setup",
            SETUP_IR,
            "bootstrap",
            "connect_source",
            "genbi-setup",
        ),
        (
            "context_enrichment",
            IR,
            "bound_project",
            "draft_enrichment",
            "genbi-enrich-context",
        ),
    ] {
        for target in ["claude-code:interactive", "codex:interactive"] {
            let out = tempfile::tempdir().unwrap();
            let result = dispatch_purpose(ir, target, purpose, out.path());
            assert!(
                result.status.success(),
                "{target}/{purpose}: {}",
                String::from_utf8_lossy(&result.stderr)
            );
            let launch = spec(out.path());
            assert_eq!(launch["version"], "2");
            assert_eq!(launch["purpose"], purpose);
            assert_eq!(launch["scope"]["kind"], scope);
            assert_eq!(launch["cwd"], launch["artifact_root"]);
            assert!(launch["cwd"].as_str().unwrap().starts_with('/'));
            for forbidden in [
                "command",
                "prompt",
                "model",
                "credential",
                "provider",
                "environment",
                "session",
            ] {
                assert!(
                    launch.get(forbidden).is_none(),
                    "{target}/{purpose} must not carry {forbidden}"
                );
            }
            if target == "claude-code:interactive" {
                assert_eq!(launch["argv"], serde_json::json!(["--agent", claude_agent]));
                assert_eq!(launch["agent"]["kind"], "claude_agent");
                assert_eq!(launch["agent"]["name"], claude_agent);
                assert!(out
                    .path()
                    .join(".claude/agents")
                    .join(format!("{claude_agent}.md"))
                    .exists());
            } else {
                assert_eq!(launch["argv"], serde_json::json!([]));
                assert_eq!(launch["agent"]["kind"], "codex_skill");
                assert_eq!(launch["agent"]["name"], codex_skill);
                assert!(out
                    .path()
                    .join(".agents/skills")
                    .join(codex_skill)
                    .join("SKILL.md")
                    .exists());
            }
            launch_fake(&launch, out.path());
        }
    }
}

#[test]
fn native_session_v2_rejects_unknown_purpose_profile_scope_confusion_and_stale_artifacts() {
    let out = tempfile::tempdir().unwrap();
    let unknown = dispatch_purpose(
        ANALYSIS_IR,
        "claude-code:interactive",
        "anything",
        out.path(),
    );
    assert!(!unknown.status.success());
    assert!(String::from_utf8_lossy(&unknown.stderr).contains("unknown --purpose"));
    assert!(fs::read_dir(out.path()).unwrap().next().is_none());

    let wrong_profile = dispatch_purpose(IR, "codex:interactive", "analysis", out.path());
    assert!(!wrong_profile.status.success());
    assert!(String::from_utf8_lossy(&wrong_profile.stderr).contains("requires Warble profile"));
    assert!(fs::read_dir(out.path()).unwrap().next().is_none());

    assert!(dispatch_purpose_with_scope(
        ANALYSIS_IR,
        "claude-code:interactive",
        "analysis",
        out.path(),
        native_scope_value("analysis", out.path(), "1", "opaque-revision-1"),
    )
    .status
    .success());
    let before = fs::read_to_string(out.path().join(".warble/interactive-launch.json")).unwrap();
    let stale = dispatch_purpose_with_scope(
        ANALYSIS_IR,
        "claude-code:interactive",
        "analysis",
        out.path(),
        native_scope_value("analysis", out.path(), "2", "opaque-revision-2"),
    );
    assert!(!stale.status.success());
    assert!(String::from_utf8_lossy(&stale.stderr).contains("refusing to overwrite"));
    assert_eq!(
        fs::read_to_string(out.path().join(".warble/interactive-launch.json")).unwrap(),
        before,
        "a changed server binding generation/revision cannot partially replace a valid launch artifact"
    );
}

#[test]
fn purpose_is_rejected_for_every_non_native_target_before_any_write() {
    for target in ["claude-code:headless", "vercel", "vercel:interactive"] {
        let out = tempfile::tempdir().unwrap();
        let result = dispatch_purpose(ANALYSIS_IR, target, "analysis", out.path());
        assert!(!result.status.success(), "{target}");
        assert!(String::from_utf8_lossy(&result.stderr)
            .contains("--purpose is supported only by native interactive targets"));
        assert!(
            fs::read_dir(out.path()).unwrap().next().is_none(),
            "{target}"
        );
    }
}

#[test]
fn native_session_v2_requires_a_materializable_selected_entry_before_writes() {
    let source: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(ANALYSIS_IR).unwrap()).unwrap();
    let cases = [
        ("missing", {
            let mut ir = source.clone();
            ir["components"]
                .as_array_mut()
                .unwrap()
                .retain(|component| component["verb"] != "answer_query");
            ir
        }),
        ("mismatched", {
            let mut ir = source.clone();
            ir["components"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|component| component["verb"] == "answer_query")
                .unwrap()["id"] = serde_json::json!("other_entry");
            ir
        }),
        ("unmaterializable", {
            let mut ir = source.clone();
            ir["components"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|component| component["verb"] == "answer_query")
                .unwrap()["realization_kind"] = serde_json::json!("gated-tool");
            ir
        }),
    ];
    for (name, ir) in cases {
        let fixture = tempfile::NamedTempFile::new().unwrap();
        fs::write(fixture.path(), serde_json::to_string(&ir).unwrap()).unwrap();
        for target in ["claude-code:interactive", "codex:interactive"] {
            let out = tempfile::tempdir().unwrap();
            let result = dispatch_purpose(
                fixture.path().to_str().unwrap(),
                target,
                "analysis",
                out.path(),
            );
            assert!(!result.status.success(), "{name}/{target}");
            assert!(String::from_utf8_lossy(&result.stderr).contains("native purpose 'analysis'"));
            assert!(
                fs::read_dir(out.path()).unwrap().next().is_none(),
                "{name}/{target}"
            );
        }
    }
}

#[test]
fn native_session_v2_rejects_missing_or_invalid_server_scope_before_writes() {
    let out = tempfile::tempdir().unwrap();
    let missing = Command::new(env!("CARGO_BIN_EXE_warble"))
        .args([
            "dispatch",
            ANALYSIS_IR,
            "--target",
            "claude-code:interactive",
            "--purpose",
            "analysis",
            "--out",
        ])
        .arg(out.path())
        .output()
        .unwrap();
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr)
        .contains("requires a server-derived --native-scope"));
    assert!(fs::read_dir(out.path()).unwrap().next().is_none());

    let root = fs::canonicalize(out.path()).unwrap();
    for (name, scope) in [
        (
            "kind",
            serde_json::json!({
                "version": "1", "kind": "bootstrap", "scope_id": "opaque", "cwd": root,
            }),
        ),
        (
            "cwd",
            serde_json::json!({
                "version": "1", "kind": "bound_project", "scope_id": "opaque", "cwd": fs::canonicalize(".").unwrap(),
                "binding": { "project_identity": "opaque-project", "generation": "7", "revision": "opaque-revision" },
            }),
        ),
        (
            "binding",
            serde_json::json!({
                "version": "1", "kind": "bound_project", "scope_id": "opaque", "cwd": root,
                "binding": { "project_identity": "opaque-project", "generation": "", "revision": "opaque-revision" },
            }),
        ),
    ] {
        let result = dispatch_purpose_with_scope(
            ANALYSIS_IR,
            "codex:interactive",
            "analysis",
            out.path(),
            scope,
        );
        assert!(!result.status.success(), "{name}");
        assert!(fs::read_dir(out.path()).unwrap().next().is_none(), "{name}");
    }
}

#[test]
fn native_session_v2_rejects_unsupported_server_scope_version_before_writes() {
    let out = tempfile::tempdir().unwrap();
    let mut scope = native_scope_value("analysis", out.path(), "7", "opaque-revision");
    scope["version"] = serde_json::json!("999");
    let result = dispatch_purpose_with_scope(
        ANALYSIS_IR,
        "claude-code:interactive",
        "analysis",
        out.path(),
        scope,
    );
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr)
        .contains("unsupported native session scope version '999'"));
    assert!(fs::read_dir(out.path()).unwrap().next().is_none());
}

#[test]
fn native_scope_values_cannot_inject_vendor_markdown() {
    let injection = "-->\nINJECTED-SCOPE-INSTRUCTION";
    for target in ["claude-code:interactive", "codex:interactive"] {
        let out = tempfile::tempdir().unwrap();
        let mut scope = native_scope_value("analysis", out.path(), "7", "opaque-revision");
        scope["scope_id"] = serde_json::json!(format!("opaque-scope-{injection}"));
        scope["binding"]["project_identity"] =
            serde_json::json!(format!("opaque-project-{injection}"));
        scope["binding"]["generation"] = serde_json::json!(format!("7-{injection}"));
        scope["binding"]["revision"] = serde_json::json!(format!("revision-{injection}"));
        let result =
            dispatch_purpose_with_scope(IR, target, "context_enrichment", out.path(), scope);
        assert!(
            result.status.success(),
            "{target}: {}",
            String::from_utf8_lossy(&result.stderr)
        );

        let launch = spec(out.path());
        assert!(launch["scope"]["scope_id"]
            .as_str()
            .unwrap()
            .contains(injection));
        assert!(launch["scope"]["binding"]["project_identity"]
            .as_str()
            .unwrap()
            .contains(injection));
        let artifacts = if target == "claude-code:interactive" {
            vec!["RUN.md", ".claude/agents/draft_enrichment.md"]
        } else {
            vec![
                "RUN.md",
                "AGENTS.md",
                ".agents/skills/genbi-enrich-context/SKILL.md",
            ]
        };
        for path in artifacts
            .into_iter()
            .chain(std::iter::once(".warble/interactive-ownership.json"))
        {
            let contents = fs::read_to_string(out.path().join(path)).unwrap();
            assert!(
                !contents.contains("INJECTED-SCOPE-INSTRUCTION"),
                "{target}/{path} must not contain raw scope values"
            );
        }
    }
}

#[test]
fn native_session_v2_has_no_caller_selected_cwd_or_unsupported_ir_escape_hatch() {
    let out = tempfile::tempdir().unwrap();
    let arbitrary_cwd = Command::new(env!("CARGO_BIN_EXE_warble"))
        .args([
            "dispatch",
            ANALYSIS_IR,
            "--target",
            "claude-code:interactive",
            "--purpose",
            "analysis",
            "--cwd",
            "/tmp/not-authorized",
            "--out",
        ])
        .arg(out.path())
        .output()
        .unwrap();
    assert!(!arbitrary_cwd.status.success());
    assert!(String::from_utf8_lossy(&arbitrary_cwd.stderr).contains("unexpected argument '--cwd'"));
    assert!(fs::read_dir(out.path()).unwrap().next().is_none());

    let scope_file = tempfile::NamedTempFile::new().unwrap();
    fs::write(
        scope_file.path(),
        serde_json::to_string(&native_scope_value(
            "analysis",
            out.path(),
            "7",
            "opaque-revision",
        ))
        .unwrap(),
    )
    .unwrap();
    let arbitrary_project = Command::new(env!("CARGO_BIN_EXE_warble"))
        .args([
            "dispatch",
            ANALYSIS_IR,
            "--target",
            "claude-code:interactive",
            "--purpose",
            "analysis",
            "--native-scope",
        ])
        .arg(scope_file.path())
        .args(["--context-project", "/tmp/not-authorized", "--out"])
        .arg(out.path())
        .output()
        .unwrap();
    assert!(!arbitrary_project.status.success());
    assert!(String::from_utf8_lossy(&arbitrary_project.stderr)
        .contains("--context-project is not supported"));
    assert!(fs::read_dir(out.path()).unwrap().next().is_none());

    let mut unsupported: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(ANALYSIS_IR).unwrap()).unwrap();
    unsupported["warble_ir_version"] = serde_json::json!("999");
    let fixture = tempfile::NamedTempFile::new().unwrap();
    fs::write(fixture.path(), serde_json::to_string(&unsupported).unwrap()).unwrap();
    let unsupported = dispatch_purpose(
        fixture.path().to_str().unwrap(),
        "codex:interactive",
        "analysis",
        out.path(),
    );
    assert!(!unsupported.status.success());
    assert!(String::from_utf8_lossy(&unsupported.stderr).contains("unsupported warble_ir_version"));
    assert!(fs::read_dir(out.path()).unwrap().next().is_none());
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
