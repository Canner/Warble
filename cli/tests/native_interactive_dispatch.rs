//! Deterministic native-TUI materialization coverage. The fake executable is a consumer-side
//! process seam: Warble only writes its launch spec and never spawns it.

use std::fs;
use std::io::Write;
use std::os::unix::fs::symlink;
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use url::{Host, Url};
use warble_claude_code::{setup_recovery_input_schema, validate_setup_recovery_report};

const IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../examples/propose-apply-agent/ir.golden.json"
);
const ANALYSIS_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../examples/analysis-agent/ir.golden.json"
);
/// One native-eligible component — the case where pinning is strictly better than scope entry.
const SINGLE_ENTRY_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../examples/driftwood-agent/ir.golden.json"
);
const MONITOR_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../examples/monitor-agent/ir.golden.json"
);
const SETUP_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../examples/provision-agent/ir.golden.json"
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
    // The entry the caller declares. Since the dispatcher no longer keeps a table of which verb
    // belongs to which purpose, every scope in these tests has to say so — which is the point of
    // the contract, and is why a wrong or absent declaration is now a test case of its own.
    let entry_verb = match purpose {
        "setup" => "attach_source",
        "context_enrichment" => "propose_changes",
        _ => "answer_query",
    };
    let mut scope = serde_json::json!({
        "version": "3",
        "kind": kind,
        "scope_id": format!("opaque-{kind}-scope"),
        "cwd": fs::canonicalize(out).unwrap(),
        "entry": {
            "verb": entry_verb,
            "prompt": format!("Test first turn for the {purpose} session."),
        },
        "wren_runtime": native_wren_runtime_value(),
    });
    if kind == "bound_project" {
        scope["binding"] = serde_json::json!({
            "project_identity": "opaque-project",
            "generation": generation,
            "revision": revision,
        });
    } else {
        scope["bootstrap_root"] =
            serde_json::json!(fs::canonicalize(out.parent().unwrap()).unwrap());
    }
    scope
}

#[test]
fn setup_scope_requires_a_distinct_canonical_bootstrap_root_while_cwd_matches_out() {
    for target in ["claude-code:interactive", "codex:interactive"] {
        let out = tempfile::tempdir().unwrap();
        let bootstrap = tempfile::tempdir().unwrap();
        let mut scope = native_scope_value("setup", out.path(), "7", "opaque-revision");
        scope["bootstrap_root"] = serde_json::json!(fs::canonicalize(bootstrap.path()).unwrap());
        let result = dispatch_purpose_with_scope(SETUP_IR, target, "setup", out.path(), scope);
        assert!(
            result.status.success(),
            "{target}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        let launch = spec(out.path());
        assert_eq!(
            launch["cwd"],
            serde_json::json!(fs::canonicalize(out.path()).unwrap())
        );
        assert_eq!(
            launch["scope"]["bootstrap_root"],
            serde_json::json!(fs::canonicalize(bootstrap.path()).unwrap())
        );

        for name in ["missing", "out", "relative"] {
            let isolated_out = tempfile::tempdir().unwrap();
            let mut invalid =
                native_scope_value("setup", isolated_out.path(), "7", "opaque-revision");
            match name {
                "missing" => {
                    invalid.as_object_mut().unwrap().remove("bootstrap_root");
                }
                "out" => {
                    invalid["bootstrap_root"] =
                        serde_json::json!(fs::canonicalize(isolated_out.path()).unwrap());
                }
                "relative" => {
                    invalid["bootstrap_root"] = serde_json::json!("relative-bootstrap-root");
                }
                _ => unreachable!(),
            }
            let rejected = dispatch_purpose_with_scope(
                SETUP_IR,
                target,
                "setup",
                isolated_out.path(),
                invalid,
            );
            assert!(!rejected.status.success(), "{target}/{name}");
            assert!(
                fs::read_dir(isolated_out.path()).unwrap().next().is_none(),
                "{target}/{name}"
            );
        }
    }
}

#[test]
fn repeated_setup_mcp_materialization_uses_distinct_roots_without_touching_bootstrap_files() {
    for target in ["claude-code:interactive", "codex:interactive"] {
        let bootstrap = tempfile::tempdir().unwrap();
        fs::write(
            bootstrap.path().join("AGENTS.md"),
            "user-owned bootstrap instructions",
        )
        .unwrap();
        let first_out = tempfile::tempdir().unwrap();
        let second_out = tempfile::tempdir().unwrap();
        for (index, out) in [first_out.path(), second_out.path()]
            .into_iter()
            .enumerate()
        {
            let mut scope =
                native_scope_value("setup", out, &format!("scope-{index}"), "opaque-revision");
            scope["scope_id"] = serde_json::json!(format!("opaque-bootstrap-scope-{index}"));
            scope["bootstrap_root"] =
                serde_json::json!(fs::canonicalize(bootstrap.path()).unwrap());
            let mut mcp = native_mcp_value();
            mcp["credential"] = serde_json::json!(format!("opaque-credential-{index}"));
            let result = dispatch_purpose_with_scope_and_mcp(
                SETUP_IR,
                target,
                "setup",
                out,
                scope,
                Some(mcp),
            );
            assert!(
                result.status.success(),
                "{target}/{index}: {}",
                String::from_utf8_lossy(&result.stderr)
            );
            let launch = spec(out);
            assert_eq!(launch["version"], "4");
            assert_eq!(
                launch["cwd"],
                serde_json::json!(fs::canonicalize(out).unwrap())
            );
            assert_eq!(
                launch["bootstrap_root"],
                serde_json::json!(fs::canonicalize(bootstrap.path()).unwrap())
            );
        }
        assert_eq!(
            fs::read_to_string(bootstrap.path().join("AGENTS.md")).unwrap(),
            "user-owned bootstrap instructions"
        );
        assert!(!bootstrap.path().join(".warble").exists());
    }
}

#[test]
fn setup_bootstrap_authority_is_explicit_for_both_vendors_while_artifacts_stay_private() {
    for target in ["claude-code:interactive", "codex:interactive"] {
        let bootstrap = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let mut scope = native_scope_value("setup", out.path(), "7", "opaque-revision");
        let canonical_bootstrap = fs::canonicalize(bootstrap.path()).unwrap();
        scope["bootstrap_root"] = serde_json::json!(&canonical_bootstrap);
        let result = dispatch_purpose_with_scope_and_mcp(
            SETUP_IR,
            target,
            "setup",
            out.path(),
            scope,
            Some(native_mcp_value()),
        );
        assert!(
            result.status.success(),
            "{target}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        let launch = spec(out.path());
        assert_eq!(launch["version"], "4");
        assert_eq!(
            launch["cwd"],
            serde_json::json!(fs::canonicalize(out.path()).unwrap())
        );
        assert_eq!(
            launch["bootstrap_root"],
            serde_json::json!(&canonical_bootstrap)
        );

        let instruction = if target == "claude-code:interactive" {
            let settings: serde_json::Value = serde_json::from_str(
                &fs::read_to_string(out.path().join(".claude/settings.json")).unwrap(),
            )
            .unwrap();
            let allow = settings["permissions"]["allow"].as_array().unwrap();
            let recursive = canonical_bootstrap.join("**").to_string_lossy().to_string();
            assert!(allow.contains(&serde_json::json!(format!("Edit({recursive})"))));
            assert!(allow.contains(&serde_json::json!(format!("Write({recursive})"))));
            assert!(!allow.contains(&serde_json::json!("Edit")));
            assert!(!allow.contains(&serde_json::json!("Write")));
            assert!(settings["$comment"]
                .as_str()
                .unwrap()
                .contains("WARBLE_SETUP_BOOTSTRAP_ROOT"));
            fs::read_to_string(out.path().join(".claude/agents/attach_source.md")).unwrap()
        } else {
            let config = fs::read_to_string(out.path().join(".codex/config.toml")).unwrap();
            let bootstrap_entry = format!(
                "{} = \"write\"",
                serde_json::to_string(&canonical_bootstrap.to_string_lossy()).unwrap()
            );
            let outside_entry = format!(
                "{} = \"write\"",
                serde_json::to_string(&fs::canonicalize(outside.path()).unwrap().to_string_lossy())
                    .unwrap()
            );
            assert!(config.contains("\".\" = \"read\""));
            assert!(config.contains(&bootstrap_entry));
            assert!(!config.contains("\".\" = \"write\""));
            assert!(!config.contains(&outside_entry));
            fs::read_to_string(out.path().join(".agents/skills/genbi-setup/SKILL.md")).unwrap()
        };
        assert!(instruction.contains("Setup bootstrap write authority"));
        assert!(instruction.contains("WARBLE_SETUP_BOOTSTRAP_ROOT"));
        assert!(!instruction.contains(canonical_bootstrap.to_string_lossy().as_ref()));
        assert!(!instruction.contains(
            fs::canonicalize(out.path())
                .unwrap()
                .to_string_lossy()
                .as_ref()
        ));
    }
}

#[test]
fn native_setup_context_isolation_keeps_session_writes_server_sealed() {
    let out = tempfile::tempdir().unwrap();
    let bootstrap = tempfile::tempdir().unwrap();
    let canonical_bootstrap = fs::canonicalize(bootstrap.path()).unwrap();

    // Exercise the otherwise-latent Setup x context-isolation branch without changing a shipped
    // profile: the synthesized IR exists only for this dispatch.
    let mut ir: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(SETUP_IR).unwrap()).unwrap();
    ir["components"][0]["required_capabilities"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!("context_isolation"));
    let ir_file = tempfile::NamedTempFile::new().unwrap();
    fs::write(ir_file.path(), serde_json::to_vec_pretty(&ir).unwrap()).unwrap();

    let mut scope = native_scope_value("setup", out.path(), "7", "opaque-revision");
    scope["bootstrap_root"] = serde_json::json!(&canonical_bootstrap);
    let result = dispatch_purpose_with_scope(
        ir_file.path().to_str().unwrap(),
        "claude-code:interactive",
        "setup",
        out.path(),
        scope,
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(
        out.path()
            .join(".claude/agents/attach_source__isolated.md")
            .is_file(),
        "the synthesized component must take the context-isolation branch"
    );

    let settings: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(out.path().join(".claude/settings.json")).unwrap(),
    )
    .unwrap();
    let write_authority = settings["permissions"]["allow"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(serde_json::Value::as_str)
        .filter(|entry| {
            *entry == "Edit"
                || *entry == "Write"
                || entry.starts_with("Edit(")
                || entry.starts_with("Write(")
        })
        .map(str::to_string)
        .collect::<Vec<_>>();
    let recursive = canonical_bootstrap.join("**").to_string_lossy().to_string();
    assert_eq!(
        write_authority,
        vec![format!("Edit({recursive})"), format!("Write({recursive})")],
        "the session must expose only the server-sealed bootstrap write paths"
    );
    assert!(settings["$comment"]
        .as_str()
        .unwrap()
        .contains("Setup write authority is server-sealed"));
}

fn native_wren_runtime_value() -> serde_json::Value {
    static RUNTIME: OnceLock<serde_json::Value> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            let root = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!(
                    "warble-native-wren-runtime-test-{}",
                    std::process::id()
                ));
            let tool_root = root.join("tool");
            let interpreter_root = root.join("python");
            let tool_bin = tool_root.join("bin");
            let interpreter = interpreter_root.join("bin/python3.11");
            let venv_python = tool_bin.join("python");
            let launcher = tool_bin.join("wren");
            let shim = root.join("shim/wren");
            let site_packages = tool_root.join("lib/python3.11/site-packages");
            let source_root = root.join("source");
            fs::create_dir_all(&tool_bin).unwrap();
            fs::create_dir_all(interpreter.parent().unwrap()).unwrap();
            fs::create_dir_all(&site_packages).unwrap();
            fs::create_dir_all(interpreter_root.join("lib")).unwrap();
            fs::create_dir_all(shim.parent().unwrap()).unwrap();
            fs::create_dir_all(source_root.join("wren")).unwrap();
            fs::write(tool_root.join("pyvenv.cfg"), "home = test\n").unwrap();
            fs::write(source_root.join("wren/__init__.py"), "").unwrap();
            fs::write(
                site_packages.join("_editable_impl_wrenai.pth"),
                format!("{}\n", source_root.display()),
            )
            .unwrap();
            fs::write(&interpreter, "#!/bin/sh\nexit 0\n").unwrap();
            fs::set_permissions(&interpreter, fs::Permissions::from_mode(0o755)).unwrap();
            if !venv_python.exists() {
                symlink(&interpreter, &venv_python).unwrap();
            }
            fs::write(&launcher, format!("#!{}\n", venv_python.display())).unwrap();
            fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
            if !shim.exists() {
                symlink(&launcher, &shim).unwrap();
            }
            serde_json::json!({
                "version": "1",
                "shim": shim,
                "launcher": launcher,
                "venv_python": venv_python,
                "tool_root": tool_root,
                "site_packages": site_packages,
                "source_root": source_root,
                "interpreter": interpreter,
                "interpreter_root": interpreter_root,
            })
        })
        .clone()
}

fn expected_codex_config(
    enable_setup_recovery_tool: bool,
    enable_dashboard_save_tool: bool,
    enable_persist_answer_tool: bool,
    setup_bootstrap_root: Option<&std::path::Path>,
) -> String {
    let runtime = native_wren_runtime_value();
    let path = |key: &str| serde_json::to_string(runtime[key].as_str().unwrap()).unwrap();
    let shim_parent = runtime["shim"]
        .as_str()
        .unwrap()
        .rsplit_once('/')
        .unwrap()
        .0;
    let tool_root = runtime["tool_root"].as_str().unwrap();
    let interpreter_root = runtime["interpreter_root"].as_str().unwrap();
    let mut config = concat!(
        "# Server-owned native Wren runtime closure. `read` is Codex's read-and-execute\n",
        "# filesystem grant; no PATH, browser, credential, or caller filesystem input is accepted.\n",
        "default_permissions = \"warble_native_wren\"\n\n",
        "[permissions.warble_native_wren]\n",
        "description = \"Warble native session workspace plus exact Wren runtime closure\"\n\n",
        "[permissions.warble_native_wren.filesystem]\n",
        "\":minimal\" = \"read\"\n",
    )
    .to_string();
    for value in [
        path("shim"),
        serde_json::to_string(shim_parent).unwrap(),
        serde_json::to_string(&format!("{tool_root}/bin")).unwrap(),
        path("launcher"),
        path("venv_python"),
        serde_json::to_string(&format!("{tool_root}/pyvenv.cfg")).unwrap(),
        path("site_packages"),
        path("interpreter"),
        serde_json::to_string(&format!("{interpreter_root}/bin")).unwrap(),
        serde_json::to_string(&format!("{interpreter_root}/lib")).unwrap(),
        path("source_root"),
    ] {
        config.push_str(&format!("{value} = \"read\"\n"));
    }
    config.push_str("\n[permissions.warble_native_wren.filesystem.\":workspace_roots\"]\n");
    if let Some(root) = setup_bootstrap_root {
        config.push_str("\".\" = \"read\"\n");
        config.push_str(&format!(
            "{} = \"write\"\n",
            serde_json::to_string(&fs::canonicalize(root).unwrap().to_string_lossy()).unwrap()
        ));
    } else {
        config.push_str("\".\" = \"write\"\n");
    }
    config.push_str(concat!(
        "\n[mcp_servers.genbi_session]\n",
        "url = \"https://mcp.example.test/native\"\n",
        "bearer_token_env_var = \"WARBLE_MCP_CONNECTION_CREDENTIAL\"\n",
    ));
    let mut enabled_tools = Vec::new();
    if enable_setup_recovery_tool {
        enabled_tools.push("report_setup_recovery");
    }
    if enable_dashboard_save_tool {
        enabled_tools.push("save_dashboard");
    }
    if enable_persist_answer_tool {
        enabled_tools.push("persist_answer");
    }
    if !enabled_tools.is_empty() {
        config.push_str(&format!(
            "enabled_tools = {}\n",
            serde_json::to_string(&enabled_tools).unwrap()
        ));
    }
    config
}

fn dispatch_purpose_with_scope(
    ir: &str,
    target: &str,
    purpose: &str,
    out: &std::path::Path,
    scope: serde_json::Value,
) -> std::process::Output {
    dispatch_purpose_with_scope_and_mcp(ir, target, purpose, out, scope, None)
}

fn native_mcp_value() -> serde_json::Value {
    native_mcp_value_with_url("https://mcp.example.test/native")
}

fn native_mcp_value_with_url(url: &str) -> serde_json::Value {
    serde_json::json!({
        "version": "1",
        "url": url,
        "credential": "opaque-native-mcp-credential",
    })
}

fn dispatch_purpose_with_scope_and_mcp(
    ir: &str,
    target: &str,
    purpose: &str,
    out: &std::path::Path,
    scope: serde_json::Value,
    mcp: Option<serde_json::Value>,
) -> std::process::Output {
    let scope_file = tempfile::NamedTempFile::new().unwrap();
    fs::write(scope_file.path(), serde_json::to_string(&scope).unwrap()).unwrap();
    let mcp_file = mcp.map(|value| {
        let file = tempfile::NamedTempFile::new().unwrap();
        fs::write(file.path(), serde_json::to_string(&value).unwrap()).unwrap();
        file
    });
    let mut command = Command::new(env!("CARGO_BIN_EXE_warble"));
    command
        .args([
            "dispatch",
            ir,
            "--target",
            target,
            "--purpose",
            purpose,
            "--native-scope",
        ])
        .arg(scope_file.path());
    if let Some(file) = &mcp_file {
        command.args(["--native-mcp"]).arg(file.path());
    }
    command
        .args(["--out"])
        .arg(out)
        .output()
        .expect("warble native purpose dispatch starts")
}

fn spec(out: &std::path::Path) -> serde_json::Value {
    serde_json::from_str(&fs::read_to_string(out.join(".warble/interactive-launch.json")).unwrap())
        .unwrap()
}

/// Cargo runs these tests as parallel threads of one process, so another thread's dispatch spawn
/// can fork while this script is still open for writing and hold that inherited handle until its
/// own exec closes it. Executing the script in that window fails with `ETXTBSY`, which says
/// nothing about the launch spec under test, so wait the window out instead of failing the test.
fn status_once_the_script_is_no_longer_write_open(
    command: &mut Command,
) -> std::process::ExitStatus {
    for _ in 0..100 {
        match command.status() {
            Ok(status) => return status,
            Err(error) if error.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            Err(error) => panic!("fake native executable did not launch: {error}"),
        }
    }
    panic!("fake native executable stayed write-open across every retry");
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
    let mut command = Command::new(fake);
    command
        .args(
            spec["argv"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap()),
        )
        .current_dir(spec["cwd"].as_str().unwrap())
        .env("FAKE_CAPTURE", &capture);
    let status = status_once_the_script_is_no_longer_write_open(&mut command);
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
fn missing_interactive_output_is_created_and_canonicalized_for_both_vendors() {
    for (target, vendor_artifact) in [
        (
            "claude-code:interactive",
            ".claude/agents/survey_context.md",
        ),
        (
            "codex:interactive",
            ".agents/skills/genbi-enrich-context/SKILL.md",
        ),
    ] {
        let parent = tempfile::tempdir().unwrap();
        let out = parent.path().join(target.replace(':', "-"));
        assert!(!out.exists(), "test precondition for {target}");

        let result = dispatch(target, &out);
        assert!(
            result.status.success(),
            "{target}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(out.is_dir(), "{target} must create its missing output root");
        assert!(out.join(vendor_artifact).is_file(), "{target}");
        assert!(out.join("RUN.md").is_file(), "{target}");

        let canonical = fs::canonicalize(&out).unwrap();
        let launch = spec(&out);
        assert_eq!(launch["target"], target);
        assert_eq!(launch["cwd"], serde_json::json!(canonical));
        assert_eq!(launch["artifact_root"], launch["cwd"]);
    }
}

#[test]
fn existing_non_directory_interactive_output_is_rejected() {
    for target in ["claude-code:interactive", "codex:interactive"] {
        let parent = tempfile::tempdir().unwrap();
        let out = parent.path().join("output-file");
        fs::write(&out, "user-owned").unwrap();

        let result = dispatch(target, &out);
        assert!(!result.status.success(), "{target}");
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            stderr.contains("interactive dispatch output exists but is not a directory"),
            "{target}: {stderr}"
        );
        assert_eq!(fs::read_to_string(&out).unwrap(), "user-owned");
    }
}

#[test]
fn interactive_output_directory_creation_failure_reports_the_path_and_cause() {
    let parent = tempfile::tempdir().unwrap();
    let original_permissions = fs::metadata(parent.path()).unwrap().permissions();
    fs::set_permissions(parent.path(), fs::Permissions::from_mode(0o555)).unwrap();
    let out = parent.path().join("new-output");

    let result = dispatch("codex:interactive", &out);
    fs::set_permissions(parent.path(), original_permissions).unwrap();
    assert!(!result.status.success());
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(
        stderr.contains("create interactive output directory"),
        "{stderr}"
    );
    assert!(stderr.contains(&out.display().to_string()), "{stderr}");
    assert!(stderr.contains("Permission denied"), "{stderr}");
    assert!(!out.exists());
}

#[test]
fn invalid_codex_component_shape_does_not_create_a_missing_output_root() {
    let parent = tempfile::tempdir().unwrap();
    let out = parent.path().join("must-remain-missing");

    let result = dispatch_ir(MONITOR_IR, "codex:interactive", &out);
    assert!(!result.status.success());
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(
        stderr.contains(
            "cannot materialize component 'monitor_freshness' shape on codex:interactive"
        ),
        "{stderr}"
    );
    assert!(
        !out.exists(),
        "Codex shape preflight must fail before creating --out"
    );
}

#[test]
fn invalid_native_scope_does_not_create_a_missing_output_root() {
    for target in ["claude-code:interactive", "codex:interactive"] {
        let parent = tempfile::tempdir().unwrap();
        let different_existing = tempfile::tempdir().unwrap();
        for (name, cwd) in [
            (
                "different-existing",
                fs::canonicalize(different_existing.path()).unwrap(),
            ),
            (
                "different-missing",
                parent.path().join("other-missing-root"),
            ),
        ] {
            let out = parent
                .path()
                .join(format!("{}-{name}", target.replace(':', "-")));
            let mut scope = native_scope_value("analysis", different_existing.path(), "7", "rev");
            scope["cwd"] = serde_json::json!(cwd);

            let result = dispatch_purpose_with_scope(ANALYSIS_IR, target, "analysis", &out, scope);
            assert!(!result.status.success(), "{target}/{name}");
            let stderr = String::from_utf8_lossy(&result.stderr);
            assert!(
                stderr.contains("does not match canonical output root"),
                "{target}/{name}: {stderr}"
            );
            assert!(
                !out.exists(),
                "{target}/{name} must fail before creating --out"
            );
        }
    }
}

#[test]
fn missing_output_resolves_existing_symlinks_before_parent_components() {
    for target in ["claude-code:interactive", "codex:interactive"] {
        let lexical_parent = tempfile::tempdir().unwrap();
        let physical_parent = tempfile::tempdir().unwrap();
        let linked_subdir = physical_parent.path().join("subdir");
        fs::create_dir(&linked_subdir).unwrap();
        symlink(&linked_subdir, lexical_parent.path().join("link")).unwrap();
        let out = lexical_parent.path().join("link/../agent");
        let physical_out = physical_parent.path().join("agent");
        let lexical_out = lexical_parent.path().join("agent");

        let result = dispatch(target, &out);
        assert!(
            result.status.success(),
            "{target}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        let canonical = fs::canonicalize(&physical_out).unwrap();
        let launch = spec(&out);
        assert_eq!(launch["cwd"], serde_json::json!(canonical));
        assert_eq!(launch["artifact_root"], launch["cwd"]);
        assert!(out.join("RUN.md").is_file(), "{target}");
        assert!(
            !lexical_out.exists(),
            "{target} must use the physical parent"
        );
    }
}

#[test]
fn lexical_scope_alias_for_symlink_parent_output_fails_before_creation() {
    for target in ["claude-code:interactive", "codex:interactive"] {
        let lexical_parent = tempfile::tempdir().unwrap();
        let physical_parent = tempfile::tempdir().unwrap();
        let linked_subdir = physical_parent.path().join("subdir");
        fs::create_dir(&linked_subdir).unwrap();
        symlink(&linked_subdir, lexical_parent.path().join("link")).unwrap();
        let out = lexical_parent.path().join("link/../agent");
        let physical_out = physical_parent.path().join("agent");
        let lexical_out = lexical_parent.path().join("agent");
        let mut scope = native_scope_value("analysis", lexical_parent.path(), "7", "rev");
        scope["cwd"] = serde_json::json!(lexical_out);

        let result = dispatch_purpose_with_scope(ANALYSIS_IR, target, "analysis", &out, scope);
        assert!(!result.status.success(), "{target}");
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            stderr.contains("does not match canonical output root"),
            "{target}: {stderr}"
        );
        assert!(!physical_out.exists(), "{target}");
        assert!(!lexical_out.exists(), "{target}");
    }
}

#[test]
fn parent_traversal_after_a_missing_component_fails_before_creation() {
    for target in ["claude-code:interactive", "codex:interactive"] {
        let parent = tempfile::tempdir().unwrap();
        let out = parent.path().join("missing/../agent");

        let result = dispatch(target, &out);
        assert!(!result.status.success(), "{target}");
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            stderr.contains("cannot traverse '..' after a missing component"),
            "{target}: {stderr}"
        );
        assert!(!parent.path().join("missing").exists(), "{target}");
        assert!(!parent.path().join("agent").exists(), "{target}");
    }
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
    let inspect = fs::read_to_string(out.path().join(".claude/agents/survey_context.md")).unwrap();
    assert!(inspect.contains("Read"));
    assert!(!out.path().join(".claude/agents/apply_changes.md").exists());
    let run = fs::read_to_string(out.path().join("RUN.md")).unwrap();
    // RUN.md documents the profile, and its launch command must agree with the launch spec it tells
    // the caller to read: a purpose-less v1 spec carries `argv: []`, so the handoff selects no agent
    // and names the materialized ones as what that single session has available instead.
    assert!(run.contains("# Running `propose-apply-agent` interactively"));
    assert!(
        run.contains("```sh\nclaude\n```"),
        "the documented launch must be the bare one the spec carries"
    );
    // A plain session has the agents on disk but none of them in charge, so the handoff says so and
    // offers the explicit per-component selection instead of promising the session will delegate.
    assert!(run.contains("none of them in charge"));
    assert!(run.contains("claude --agent survey_context"));
    assert!(run.contains("claude --agent propose_changes"));
    assert!(
        !run.contains("apply_changes"),
        "RUN.md must not offer an agent this target refused to materialize"
    );
    assert!(run.contains(".warble/interactive-launch.json"));
    assert!(run.contains("native interactive session"));
    for forbidden in ["claude -p", "--print", "headless", "../jaffle-wren"] {
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
            "attach_source",
            "genbi-setup",
        ),
        (
            "context_enrichment",
            IR,
            "bound_project",
            "propose_changes",
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
                let agent_path = out
                    .path()
                    .join(".claude/agents")
                    .join(format!("{claude_agent}.md"));
                assert!(agent_path.exists());
                // The handoff documents exactly the agent the launch spec selects — the profile's
                // entry agent for this purpose — never a component of the emitter's own choosing.
                let run = fs::read_to_string(out.path().join("RUN.md")).unwrap();
                assert!(
                    run.contains(&format!("```sh\nclaude --agent {claude_agent}\n```")),
                    "{target}/{purpose}: RUN.md must show the launch spec's own argv"
                );
                assert!(
                    run.contains(&format!("`{claude_agent}` (entry)")),
                    "{target}/{purpose}: RUN.md must mark the entry agent in the profile's agent list"
                );
                if purpose == "setup" {
                    assert!(
                        !fs::read_to_string(agent_path)
                            .unwrap()
                            .contains("report_setup_recovery"),
                        "v2 Setup must not acquire the v3 MCP instruction"
                    );
                }
            } else {
                assert_eq!(launch["argv"], serde_json::json!([]));
                assert_eq!(launch["agent"]["kind"], "codex_skill");
                assert_eq!(launch["agent"]["name"], codex_skill);
                let skill_path = out
                    .path()
                    .join(".agents/skills")
                    .join(codex_skill)
                    .join("SKILL.md");
                assert!(skill_path.exists());
                if purpose == "setup" {
                    assert!(
                        !fs::read_to_string(skill_path)
                            .unwrap()
                            .contains("report_setup_recovery"),
                        "v2 Setup must not acquire the v3 MCP instruction"
                    );
                }
                let config = fs::read_to_string(out.path().join(".codex/config.toml")).unwrap();
                let expected = expected_codex_config(
                    false,
                    false,
                    false,
                    (purpose == "setup").then(|| out.path().parent().unwrap()),
                );
                let permission_profile = expected
                    .split("\n[mcp_servers.genbi_session]\n")
                    .next()
                    .unwrap();
                assert_eq!(config, format!("{permission_profile}\n"));
            }
            launch_fake(&launch, out.path());
        }
    }
}

#[test]
fn native_session_v4_materializes_vendor_owned_mcp_discovery_with_a_closed_welcome_prompt() {
    for target in ["claude-code:interactive", "codex:interactive"] {
        let out = tempfile::tempdir().unwrap();
        let result = dispatch_purpose_with_scope_and_mcp(
            ANALYSIS_IR,
            target,
            "analysis",
            out.path(),
            native_scope_value(
                "analysis",
                out.path(),
                "opaque-generation",
                "opaque-revision",
            ),
            Some(native_mcp_value()),
        );
        assert!(
            result.status.success(),
            "{target}: {}",
            String::from_utf8_lossy(&result.stderr)
        );

        let launch = spec(out.path());
        assert_eq!(launch["version"], "4");
        // The prompt is whatever the caller declared in the scope this test passed in; the point
        // here is that MCP discovery does not disturb the closed argv, not who wrote the text.
        let welcome = format!("Test first turn for the {} session.", "analysis");
        let expected_argv = if target == "claude-code:interactive" {
            serde_json::json!(["--agent", "answer_query", welcome])
        } else {
            serde_json::json!([welcome])
        };
        assert_eq!(launch["argv"], expected_argv);
        assert_eq!(
            launch["mcp"],
            serde_json::json!({
                "server_name": "genbi_session",
                "credential_env_var": "WARBLE_MCP_CONNECTION_CREDENTIAL",
            })
        );
        assert!(
            launch.get("scope").is_none(),
            "v4 must not expose a bound identity"
        );
        for forbidden in [
            "opaque-project",
            "opaque-generation",
            "opaque-revision",
            "opaque-native-mcp-credential",
            "mcp.example.test",
        ] {
            assert!(
                !fs::read_to_string(out.path().join(".warble/interactive-launch.json"))
                    .unwrap()
                    .contains(forbidden),
                "{target} launch spec leaked {forbidden}"
            );
        }

        let ownership =
            fs::read_to_string(out.path().join(".warble/interactive-ownership.json")).unwrap();
        assert!(ownership.contains("mcp_digest=sha256:"));
        assert!(!ownership.contains("opaque-native-mcp-credential"));
        let non_discovery_artifacts = if target == "claude-code:interactive" {
            vec![
                ".claude/agents/answer_query.md",
                ".claude/CLAUDE.md",
                ".claude/settings.json",
                ".wren/config.json",
                "RUN.md",
                "context-report.json",
                "capability-report.json",
                ".warble/interactive-launch.json",
                ".warble/interactive-ownership.json",
            ]
        } else {
            vec![
                ".agents/skills/genbi-analysis/SKILL.md",
                "AGENTS.md",
                "RUN.md",
                ".warble/interactive-launch.json",
                ".warble/interactive-ownership.json",
            ]
        };
        for path in non_discovery_artifacts {
            let content = fs::read_to_string(out.path().join(path)).unwrap();
            for forbidden in [
                "opaque-project",
                "opaque-generation",
                "opaque-revision",
                "opaque-native-mcp-credential",
                "mcp.example.test",
            ] {
                assert!(
                    !content.contains(forbidden),
                    "{target}/{path} leaked {forbidden} outside vendor discovery"
                );
            }
        }
        if target == "claude-code:interactive" {
            let config = fs::read_to_string(out.path().join(".mcp.json")).unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&config).unwrap(),
                serde_json::json!({"mcpServers": {"genbi_session": {
                    "type": "http",
                    "url": "https://mcp.example.test/native",
                    "headers": {"Authorization": "Bearer opaque-native-mcp-credential"},
                }}})
            );
            assert!(ownership.contains(".mcp.json"));
        } else {
            let config = fs::read_to_string(out.path().join(".codex/config.toml")).unwrap();
            assert_eq!(config, expected_codex_config(false, true, true, None));
            assert!(!config.contains("opaque-native-mcp-credential"));
            assert!(ownership.contains(".codex/config.toml"));
        }

        // Consumer fixture compatibility: the only executable/cwd/argv fields still launch a
        // fixed fake binary; v3 has not added a producer-controlled invocation escape hatch.
        launch_fake(&launch, out.path());
    }
}

#[test]
fn native_analysis_realization_persists_before_human_presentation_and_saves_by_reference() {
    for target in ["claude-code:interactive", "codex:interactive"] {
        let out = tempfile::tempdir().unwrap();
        let result = dispatch_purpose_with_scope_and_mcp(
            ANALYSIS_IR,
            target,
            "analysis",
            out.path(),
            native_scope_value(
                "analysis",
                out.path(),
                "opaque-generation",
                "opaque-revision",
            ),
            Some(native_mcp_value()),
        );
        assert!(
            result.status.success(),
            "{target}: {}",
            String::from_utf8_lossy(&result.stderr)
        );

        let (analysis, dashboard) = if target == "claude-code:interactive" {
            (
                fs::read_to_string(out.path().join(".claude/agents/answer_query.md")).unwrap(),
                fs::read_to_string(out.path().join(".claude/agents/generate_dashboard.md"))
                    .unwrap(),
            )
        } else {
            let skill =
                fs::read_to_string(out.path().join(".agents/skills/genbi-analysis/SKILL.md"))
                    .unwrap();
            (skill.clone(), skill)
        };

        for required in [
            "## Persist the final answer before presentation",
            "`genbi_session.persist_answer`",
            "exactly one `table` block",
            "zero or one `definition` block",
            "Do not add a summary, chart, raw result, or any other block or representation.",
            "idempotency_key` is only for retrying this same already-computed persistence request, never caller-asserted provenance",
            "retain the host-returned `answer_ref`",
            "If persistence ultimately fails, do not recompute, rerun `answer_query`, generate SQL, or ask the user to supply the payload again.",
            "Still present the already-computed answer conversationally",
            "was not retained and cannot later be saved by reference",
            "## Save a GenBI dashboard",
            "`genbi_session.save_dashboard`",
            "\"answer_ref\": \"<answer_ref returned by persist_answer>\"",
            "\"answer_selection\": \"latest\"",
            "## Native terminal presentation",
            "concise conversational Markdown",
            "Do not print a JSON result, render envelope, step envelope",
            "`query_result`, `repaired_result`, `columns`, `rows`, or `definition`",
            "Programmatic and headless callers retain their structured JSON contracts",
        ] {
            assert!(analysis.contains(required), "{target} missing {required}");
        }
        for required in [
            "## Save a GenBI dashboard",
            "`genbi_session.save_dashboard`",
            "\"version\": \"1\"",
            "\"name\": \"<concise dashboard name>\"",
            "\"answer_ref\": \"<answer_ref returned by persist_answer>\"",
            "\"answer_selection\": \"latest\"",
            "\"idempotency_key\": \"<stable key for this same dashboard request>\"",
            "Provide exactly one of `answer_ref` or `answer_selection`.",
            "resolves `latest` only within this native session",
            "Do not rerun `answer_query`, generate SQL, repair SQL, or otherwise recompute",
            "do not re-supply or reconstruct the payload",
            "**GenBI Artifacts page**",
            "Do not substitute a vendor-hosted Artifact feature, artifact URL, share URL",
        ] {
            assert!(dashboard.contains(required), "{target} missing {required}");
        }
        let persistence_payload = analysis
            .split("```json\n")
            .nth(1)
            .and_then(|section| section.split("\n```").next())
            .expect("answer persistence instructions include a JSON payload");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(persistence_payload).unwrap(),
            serde_json::json!({
                "version": "1",
                "envelope": {
                    "blocks": [
                        {"type": "table", "columns": ["..."], "rows": [["..."]]},
                        {"type": "definition", "sql": "...", "source_tables": ["..."], "filters": ["..."]},
                    ],
                    "verified": true,
                },
                "idempotency_key": "<stable retry key for this exact computed answer>",
            }),
            "{target} emits the BFF persist_answer input shape"
        );
        let dashboard_payload = dashboard
            .split("## Save a GenBI dashboard")
            .nth(1)
            .expect("dashboard save instructions are present")
            .split("```json\n")
            .nth(1)
            .and_then(|section| section.split("\n```").next())
            .expect("dashboard save instructions include a JSON payload");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(dashboard_payload).unwrap(),
            serde_json::json!({
                "version": "1",
                "name": "<concise dashboard name>",
                "answer_ref": "<answer_ref returned by persist_answer>",
                "idempotency_key": "<stable key for this same dashboard request>",
            }),
            "{target} emits the BFF reference save_dashboard input shape"
        );
        let latest_dashboard_payload = dashboard
            .split("## Save a GenBI dashboard")
            .nth(1)
            .expect("dashboard save instructions are present")
            .split("```json\n")
            .nth(2)
            .and_then(|section| section.split("\n```").next())
            .expect("dashboard save instructions include a latest-answer payload");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(latest_dashboard_payload).unwrap(),
            serde_json::json!({
                "version": "1",
                "name": "<concise dashboard name>",
                "answer_selection": "latest",
                "idempotency_key": "<stable key for this same dashboard request>",
            }),
            "{target} emits the BFF latest-answer save_dashboard input shape"
        );
        assert!(
            analysis.find("## Persist the final answer before presentation").unwrap()
                < analysis.find("## Native terminal presentation").unwrap(),
            "{target} persistence instructions must deterministically precede terminal presentation"
        );

        if target == "claude-code:interactive" {
            assert!(dashboard.contains("mcp__genbi_session__save_dashboard"));
            assert!(analysis.contains("mcp__genbi_session__persist_answer"));
            assert!(analysis.contains("mcp__genbi_session__save_dashboard"));
            for step in ["resolve_intent", "generate_sql", "repair_sql"] {
                let subagent = fs::read_to_string(
                    out.path()
                        .join(format!(".claude/agents/answer_query__{step}.md")),
                )
                .unwrap();
                assert!(
                    !subagent.contains("mcp__genbi_session__persist_answer"),
                    "{target}/{step} must not receive persist_answer"
                );
                assert!(
                    !subagent.contains("mcp__genbi_session__save_dashboard"),
                    "{target}/{step} must not receive save_dashboard"
                );
            }
            let settings = fs::read_to_string(out.path().join(".claude/settings.json")).unwrap();
            assert!(settings.contains("mcp__genbi_session__save_dashboard"));
            assert!(settings.contains("mcp__genbi_session__persist_answer"));
        } else {
            let config = fs::read_to_string(out.path().join(".codex/config.toml")).unwrap();
            assert!(config.contains("enabled_tools = [\"save_dashboard\",\"persist_answer\"]"));
            assert!(!config.contains("report_setup_recovery"));
        }

        let native_artifacts = if target == "claude-code:interactive" {
            fs::read_dir(out.path().join(".claude/agents"))
                .unwrap()
                .map(|entry| fs::read_to_string(entry.unwrap().path()).unwrap())
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            analysis.clone()
        };
        let native_artifacts_lower = native_artifacts.to_ascii_lowercase();
        for forbidden in [
            "your final message must",
            "final message must be a single json object",
            "do not format the answer as prose or markdown",
        ] {
            assert!(
                !native_artifacts_lower.contains(forbidden),
                "{target} retains native JSON-final mandate: {forbidden}"
            );
        }
    }
}

#[test]
fn headless_analysis_keeps_the_programmatic_json_final_contract() {
    let out = tempfile::tempdir().unwrap();
    let result = dispatch_ir(ANALYSIS_IR, "claude-code:headless", out.path());
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let answer = fs::read_to_string(out.path().join(".claude/agents/answer_query.md")).unwrap();
    assert!(answer
        .contains("Your FINAL message MUST be the terminal step's structured output verbatim"));
    let explore = fs::read_to_string(out.path().join(".claude/agents/explore_model.md")).unwrap();
    assert!(explore.contains("FINAL message must be a single JSON object"));
    let dashboard =
        fs::read_to_string(out.path().join(".claude/agents/generate_dashboard.md")).unwrap();
    assert!(dashboard
        .contains("Do NOT write any files and do NOT format the answer as prose or markdown"));
    assert!(dashboard.contains("FINAL message must be a SINGLE JSON object"));
}

#[test]
fn native_context_enrichment_presents_grill_and_paused_proposals_conversationally() {
    for target in ["claude-code:interactive", "codex:interactive"] {
        let out = tempfile::tempdir().unwrap();
        let result = dispatch_purpose_with_scope_and_mcp(
            IR,
            target,
            "context_enrichment",
            out.path(),
            native_scope_value(
                "context_enrichment",
                out.path(),
                "opaque-generation",
                "opaque-revision",
            ),
            Some(native_mcp_value()),
        );
        assert!(
            result.status.success(),
            "{target}: {}",
            String::from_utf8_lossy(&result.stderr)
        );

        let artifact = if target == "claude-code:interactive" {
            out.path().join(".claude/agents/propose_changes.md")
        } else {
            out.path()
                .join(".agents/skills/genbi-enrich-context/SKILL.md")
        };
        let native = fs::read_to_string(artifact).unwrap();
        for required in [
            "## Native context-enrichment presentation",
            "concise conversational Markdown, never JSON",
            "evidence and confidence, impact/risk, and destination",
            "**accept**, **edit**, or **skip**",
            "In Grill mode, present only the one change currently awaiting a choice",
            "proposal is paused",
            "Do not fabricate a draft to avoid a pause",
            "Programmatic and headless callers retain their canonical structured proposal contracts",
        ] {
            assert!(native.contains(required), "{target} missing {required}");
        }
        let lower = native.to_ascii_lowercase();
        for forbidden in [
            "your final message must be one json object only",
            "do not include prose or markdown fences",
            "the top level is `{ \"enrichment_proposal\": { ... } }`",
        ] {
            assert!(
                !lower.contains(forbidden),
                "{target} retains headless JSON-final mandate: {forbidden}"
            );
        }
        if target == "claude-code:interactive" {
            assert!(
                !out.path().join(".claude/agents/apply_changes.md").exists(),
                "{target} must not materialize the unapproved apply component"
            );
        } else {
            assert!(
                native.contains("Do not invoke or simulate `apply_enrichment`"),
                "{target} must retain the native approval/apply wall"
            );
        }
    }
}

#[test]
fn headless_context_enrichment_keeps_the_exact_canonical_proposal_contract() {
    let canonical_prompt = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../examples/propose-apply-agent/components/propose_changes/steps/propose.md"
    ))
    .unwrap();
    let out = tempfile::tempdir().unwrap();
    let mut draft_only: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(IR).unwrap()).unwrap();
    draft_only["components"]
        .as_array_mut()
        .unwrap()
        .retain(|component| component["id"] == "propose_changes");
    let draft_ir = out.path().join("draft-enrichment-only.json");
    fs::write(&draft_ir, serde_json::to_vec_pretty(&draft_only).unwrap()).unwrap();
    let result = dispatch_ir(
        draft_ir.to_str().unwrap(),
        "claude-code:headless",
        out.path(),
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let headless =
        fs::read_to_string(out.path().join(".claude/agents/propose_changes.md")).unwrap();
    assert!(
        headless.contains(&canonical_prompt),
        "headless output must retain the canonical proposal prompt byte-for-byte"
    );
    assert!(headless.contains("Your FINAL message must be one JSON object only"));
    assert!(headless.contains("`recommended_yaml`"));
    assert!(headless.contains("`[\"accept\", \"edit\", \"skip\"]`"));
}

#[test]
fn native_session_v4_argv_reproduces_the_declared_entry_exactly_for_every_purpose_and_vendor() {
    // The closed-argv property is unchanged: one positional prompt, delivered in argv, never
    // written through the PTY after spawn. What changed is where its content comes from. The
    // dispatcher used to author both the agent name and the welcome text from a built-in table,
    // so this test could hard-code the expected strings. Now the caller declares them, and the
    // property worth asserting is stronger: argv must reproduce the declaration EXACTLY, adding
    // nothing and substituting nothing of the dispatcher's own.
    for (purpose, ir) in [
        ("setup", SETUP_IR),
        ("analysis", ANALYSIS_IR),
        ("context_enrichment", IR),
    ] {
        for target in ["claude-code:interactive", "codex:interactive"] {
            let out = tempfile::tempdir().unwrap();
            let scope =
                native_scope_value(purpose, out.path(), "opaque-generation", "opaque-revision");
            let declared_verb = scope["entry"]["verb"].as_str().unwrap().to_string();
            let declared_prompt = scope["entry"]["prompt"].as_str().unwrap().to_string();
            let result = dispatch_purpose_with_scope_and_mcp(
                ir,
                target,
                purpose,
                out.path(),
                scope,
                Some(native_mcp_value()),
            );
            assert!(
                result.status.success(),
                "{target}/{purpose}: {}",
                String::from_utf8_lossy(&result.stderr)
            );
            let launch = spec(out.path());
            assert_eq!(launch["version"], "4");
            let expected = if target == "claude-code:interactive" {
                serde_json::json!(["--agent", declared_verb, declared_prompt])
            } else {
                serde_json::json!([declared_prompt])
            };
            assert_eq!(launch["argv"], expected, "{target}/{purpose}");
        }
    }
}

#[test]
fn native_session_v4_scope_entry_drops_the_agent_flag_and_keeps_the_prompt() {
    // The whole difference a scope entry makes to argv: `--agent <verb>` disappears, the
    // positional prompt does not. The prompt is how the first turn is delivered exactly once
    // without touching the PTY after spawn, so losing it here would silently produce a session
    // that starts idle rather than one that starts differently.
    let out = tempfile::tempdir().unwrap();
    let mut scope = native_scope_value(
        "analysis",
        out.path(),
        "opaque-generation",
        "opaque-revision",
    );
    let declared_prompt = scope["entry"]["prompt"].as_str().unwrap().to_string();
    scope["entry"] = serde_json::json!({ "kind": "scope", "prompt": declared_prompt });
    let result = dispatch_purpose_with_scope_and_mcp(
        ANALYSIS_IR,
        "claude-code:interactive",
        "analysis",
        out.path(),
        scope,
        Some(native_mcp_value()),
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let launch = spec(out.path());
    assert_eq!(launch["argv"], serde_json::json!([declared_prompt]));
    // A scope entry names the profile it entered, not a component. The consuming host validates
    // this pair exactly, so `kind` alone would be rejected as an incompatible launch spec.
    let profile =
        serde_json::from_str::<serde_json::Value>(&fs::read_to_string(ANALYSIS_IR).unwrap())
            .unwrap()["profile"]
            .as_str()
            .unwrap()
            .to_string();
    assert_eq!(
        launch["agent"],
        serde_json::json!({ "kind": "claude_scope", "name": profile })
    );

    // Every component stays materialized: scope entry changes which agent is in charge at the
    // top, never which agents exist to delegate to.
    for verb in ["answer_query", "generate_dashboard"] {
        assert!(
            out.path()
                .join(format!(".claude/agents/{verb}.md"))
                .exists(),
            "{verb} was not materialized for a scope entry"
        );
    }
    let run = fs::read_to_string(out.path().join("RUN.md")).unwrap();
    assert!(run.contains("at the scope document"), "RUN.md: {run}");
    // The remedy list belongs to a purposeless unselected session, not to this one.
    assert!(
        !run.contains("none of them in charge"),
        "scope entry inherited the unselected-session warning: {run}"
    );
}

#[test]
fn native_session_v4_pinned_entry_is_unchanged_and_stays_the_default() {
    // Guards the compatibility half: a descriptor that names a verb and says nothing about `kind`
    // must still pin, because scope entry is the wider form and must never be reached by omission.
    let out = tempfile::tempdir().unwrap();
    let scope = native_scope_value(
        "analysis",
        out.path(),
        "opaque-generation",
        "opaque-revision",
    );
    assert!(
        scope["entry"].get("kind").is_none(),
        "fixture must exercise the absent-kind default"
    );
    let declared_verb = scope["entry"]["verb"].as_str().unwrap().to_string();
    let declared_prompt = scope["entry"]["prompt"].as_str().unwrap().to_string();
    let result = dispatch_purpose_with_scope_and_mcp(
        ANALYSIS_IR,
        "claude-code:interactive",
        "analysis",
        out.path(),
        scope,
        Some(native_mcp_value()),
    );
    assert!(result.status.success());
    let launch = spec(out.path());
    assert_eq!(
        launch["argv"],
        serde_json::json!(["--agent", declared_verb, declared_prompt])
    );
    assert_eq!(
        launch["agent"],
        serde_json::json!({ "kind": "claude_agent", "name": declared_verb })
    );
}

#[test]
fn native_session_scope_entry_is_refused_when_the_profile_has_nothing_to_choose_between() {
    // Scope entry only makes sense when the session has alternatives. With one eligible component
    // the same behavior is reachable by pinning, and pinning additionally gives the top-level
    // session that agent's declared `tools:` instead of the vendor default surface — so accepting
    // scope entry here would widen the session for nothing. With none, the scope is inert and a
    // session with nothing to delegate to would do the work itself outside any component.
    //
    // Both counts are asserted through the message, not just the exit status: the guard is a
    // threshold, and a test that only checks "refused" cannot tell a correct threshold from one
    // that refuses everything.
    for (label, ir, expected_count) in [
        ("exactly one eligible component", SINGLE_ENTRY_IR, 1),
        ("no eligible component", MONITOR_IR, 0),
    ] {
        let out = tempfile::tempdir().unwrap();
        let mut scope = native_scope_value(
            "analysis",
            out.path(),
            "opaque-generation",
            "opaque-revision",
        );
        let prompt = scope["entry"]["prompt"].as_str().unwrap().to_string();
        scope["entry"] = serde_json::json!({ "kind": "scope", "prompt": prompt });
        let result = dispatch_purpose_with_scope_and_mcp(
            ir,
            "claude-code:interactive",
            "analysis",
            out.path(),
            scope,
            Some(native_mcp_value()),
        );
        assert!(!result.status.success(), "{label}: launch was not refused");
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            stderr.contains("declared scope entry")
                && stderr.contains(&format!("materializes {expected_count} native-eligible")),
            "{label}: stderr was {stderr}"
        );
    }
}

#[test]
fn native_session_scope_entry_is_refused_when_it_would_be_incoherent() {
    // Three ways a scope entry must fail closed rather than launch something wider than asked.
    for (label, entry, target, ir, needle) in [
        (
            "a verb alongside scope entry is a contradiction",
            serde_json::json!({ "kind": "scope", "verb": "answer_query", "prompt": "Help me." }),
            "claude-code:interactive",
            ANALYSIS_IR,
            "must not name a verb",
        ),
        (
            "agent entry with no verb has nothing to pin",
            serde_json::json!({ "kind": "agent", "prompt": "Help me." }),
            "claude-code:interactive",
            ANALYSIS_IR,
            "requires the component verb it pins",
        ),
        (
            "codex enters through its skill and has no scope form",
            serde_json::json!({ "kind": "scope", "prompt": "Help me." }),
            "codex:interactive",
            ANALYSIS_IR,
            "do not support",
        ),
    ] {
        let out = tempfile::tempdir().unwrap();
        let mut scope = native_scope_value(
            "analysis",
            out.path(),
            "opaque-generation",
            "opaque-revision",
        );
        scope["entry"] = entry;
        let result = dispatch_purpose_with_scope_and_mcp(
            ir,
            target,
            "analysis",
            out.path(),
            scope,
            Some(native_mcp_value()),
        );
        assert!(!result.status.success(), "{label}: launch was not refused");
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(stderr.contains(needle), "{label}: stderr was {stderr}");
    }
}

#[test]
fn native_setup_v3_materializes_the_same_typed_recovery_instruction_for_both_vendors() {
    for target in ["claude-code:interactive", "codex:interactive"] {
        let out = tempfile::tempdir().unwrap();
        let result = dispatch_purpose_with_scope_and_mcp(
            SETUP_IR,
            target,
            "setup",
            out.path(),
            native_scope_value("setup", out.path(), "unused", "unused"),
            Some(native_mcp_value()),
        );
        assert!(
            result.status.success(),
            "{target}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        let artifact = if target == "claude-code:interactive" {
            out.path().join(".claude/agents/attach_source.md")
        } else {
            out.path().join(".agents/skills/genbi-setup/SKILL.md")
        };
        let content = fs::read_to_string(artifact).unwrap();
        for required in [
            "Setup recovery reporting (v1)",
            "`genbi_session` MCP server exposes `report_setup_recovery`",
            "`reported_complete` is only this agent's report",
            "silence is an honest host-lifecycle outcome",
        ] {
            assert!(content.contains(required), "{target} missing {required}");
        }
        for forbidden in [
            "opaque-bootstrap-scope",
            "opaque-native-mcp-credential",
            "mcp.example.test",
        ] {
            assert!(
                !content.contains(forbidden),
                "{target} recovery instruction leaked {forbidden}"
            );
        }
        if target == "claude-code:interactive" {
            assert!(content.contains("mcp__genbi_session__report_setup_recovery"));
            let settings: serde_json::Value = serde_json::from_str(
                &fs::read_to_string(out.path().join(".claude/settings.json")).unwrap(),
            )
            .unwrap();
            assert!(settings["permissions"]["allow"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!(
                    "mcp__genbi_session__report_setup_recovery"
                )));
        } else {
            assert_eq!(
                fs::read_to_string(out.path().join(".codex/config.toml")).unwrap(),
                expected_codex_config(true, false, false, Some(out.path().parent().unwrap()))
            );
        }
    }
}

#[test]
fn native_codex_v3_emits_the_exact_server_owned_wren_permission_profile_for_every_purpose() {
    for (ir, purpose, setup_recovery) in [
        (ANALYSIS_IR, "analysis", false),
        (SETUP_IR, "setup", true),
        (IR, "context_enrichment", false),
    ] {
        let out = tempfile::tempdir().unwrap();
        let result = dispatch_purpose_with_scope_and_mcp(
            ir,
            "codex:interactive",
            purpose,
            out.path(),
            native_scope_value(purpose, out.path(), "7", "opaque-revision"),
            Some(native_mcp_value()),
        );
        assert!(
            result.status.success(),
            "{purpose}: {}",
            String::from_utf8_lossy(&result.stderr)
        );

        let config = fs::read_to_string(out.path().join(".codex/config.toml")).unwrap();
        assert_eq!(
            config,
            expected_codex_config(
                setup_recovery,
                purpose == "analysis",
                purpose == "analysis",
                (purpose == "setup").then(|| out.path().parent().unwrap()),
            ),
            "{purpose}"
        );
        assert!(config.contains("default_permissions = \"warble_native_wren\""));
        assert!(config.contains("\":minimal\" = \"read\""));
        assert!(config.contains("[permissions.warble_native_wren.filesystem.\":workspace_roots\"]"));
        if purpose == "setup" {
            assert!(config.contains("\".\" = \"read\""));
            assert!(!config.contains("\".\" = \"write\""));
        } else {
            assert!(config.contains("\".\" = \"write\""));
        }
        for forbidden in [
            "danger-full-access",
            "workspace-write",
            "PATH =",
            "\"*\" =",
            "\":workspace\"",
            "\":tmpdir\" = \"write\"",
            "[permissions.warble_native_wren.network]",
        ] {
            assert!(!config.contains(forbidden), "{purpose} leaked {forbidden}");
        }
        let hooks: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(out.path().join(".codex/hooks.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            hooks["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"],
            "/bin/sh .warble/capture-codex-thread.sh"
        );
        let capture = out.path().join(".warble/capture-codex-thread.sh");
        assert_eq!(
            fs::metadata(&capture).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let thread_id = "019ff602-3d80-7de2-bd41-8cc46545595d";
        let mut capture_child = Command::new("/bin/sh")
            .arg(".warble/capture-codex-thread.sh")
            .current_dir(out.path())
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        capture_child
            .stdin
            .take()
            .unwrap()
            .write_all(
                format!(r#"{{"session_id":"{thread_id}","turn_id":"turn","prompt":"hello"}}"#)
                    .as_bytes(),
            )
            .unwrap();
        assert!(capture_child.wait().unwrap().success());
        assert_eq!(
            fs::read_to_string(out.path().join(".warble/codex-thread-id")).unwrap(),
            format!("{thread_id}\n")
        );
        assert_eq!(
            fs::metadata(out.path().join(".warble/codex-thread-id"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        fs::remove_file(out.path().join(".warble/codex-thread-id")).unwrap();
        let mut forged_child = Command::new("/bin/sh")
            .arg(".warble/capture-codex-thread.sh")
            .current_dir(out.path())
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        forged_child
            .stdin
            .take()
            .unwrap()
            .write_all(
                format!(
                    r#"{{"prompt":"\\\"session_id\\\":\\\"{thread_id}\\\"","turn_id":"turn"}}"#
                )
                .as_bytes(),
            )
            .unwrap();
        assert!(!forged_child.wait().unwrap().success());
        assert!(!out.path().join(".warble/codex-thread-id").exists());
        for path in [
            "RUN.md",
            "AGENTS.md",
            ".agents/skills",
            ".warble/interactive-launch.json",
            ".warble/interactive-ownership.json",
        ] {
            let content = if path == ".agents/skills" {
                fs::read_to_string(
                    out.path()
                        .join(path)
                        .join(match purpose {
                            "analysis" => "genbi-analysis",
                            "setup" => "genbi-setup",
                            _ => "genbi-enrich-context",
                        })
                        .join("SKILL.md"),
                )
                .unwrap()
            } else {
                fs::read_to_string(out.path().join(path)).unwrap()
            };
            assert!(
                !content.contains("warble-native-wren-runtime-test"),
                "{purpose}/{path} exposed runtime closure"
            );
        }
    }
}

#[test]
fn native_wren_runtime_rejects_path_injection_and_broken_chain_before_any_write() {
    let out = tempfile::tempdir().unwrap();
    let mut cases = Vec::new();

    let mut bad_version = native_scope_value("analysis", out.path(), "7", "opaque-revision");
    bad_version["wren_runtime"]["version"] = serde_json::json!("999");
    cases.push(("version", bad_version));

    let mut browser_input = native_scope_value("analysis", out.path(), "7", "opaque-revision");
    browser_input["wren_runtime"]["browser_path"] = serde_json::json!("/browser-selected");
    cases.push(("browser-input", browser_input));

    let mut permission_input = native_scope_value("analysis", out.path(), "7", "opaque-revision");
    permission_input["wren_runtime"]["permissions"] = serde_json::json!(["danger-full-access"]);
    cases.push(("permission-input", permission_input));

    let mut path_input = native_scope_value("analysis", out.path(), "7", "opaque-revision");
    path_input["wren_runtime"]["path"] = serde_json::json!("/caller-selected/bin");
    cases.push(("path-input", path_input));

    let mut no_shim = native_scope_value("analysis", out.path(), "7", "opaque-revision");
    no_shim["wren_runtime"]["shim"] = no_shim["wren_runtime"]["launcher"].clone();
    cases.push(("shim-is-launcher", no_shim));

    let mut wrong_interpreter_root =
        native_scope_value("analysis", out.path(), "7", "opaque-revision");
    wrong_interpreter_root["wren_runtime"]["interpreter_root"] =
        wrong_interpreter_root["wren_runtime"]["tool_root"].clone();
    cases.push(("wrong-interpreter-root", wrong_interpreter_root));

    let mut wrong_editable_source =
        native_scope_value("analysis", out.path(), "7", "opaque-revision");
    wrong_editable_source["wren_runtime"]["source_root"] =
        wrong_editable_source["wren_runtime"]["tool_root"].clone();
    cases.push(("editable-source-not-pth-pinned", wrong_editable_source));

    let mut injected_shebang = native_scope_value("analysis", out.path(), "7", "opaque-revision");
    injected_shebang["wren_runtime"]["venv_python"] = serde_json::json!("/tmp/evil-python");
    cases.push(("caller-selected-interpreter", injected_shebang));

    for (name, scope) in cases {
        let result = dispatch_purpose_with_scope_and_mcp(
            ANALYSIS_IR,
            "codex:interactive",
            "analysis",
            out.path(),
            scope,
            Some(native_mcp_value()),
        );
        assert!(!result.status.success(), "{name}");
        assert!(
            fs::read_dir(out.path()).unwrap().next().is_none(),
            "{name} must fail before emitting a permission profile"
        );
    }
}

#[test]
fn native_wren_runtime_is_a_codex_only_extension_of_the_existing_scope_v1_contract() {
    let claude_out = tempfile::tempdir().unwrap();
    let mut legacy_scope =
        native_scope_value("analysis", claude_out.path(), "7", "opaque-revision");
    legacy_scope.as_object_mut().unwrap().remove("wren_runtime");
    let claude = dispatch_purpose_with_scope(
        ANALYSIS_IR,
        "claude-code:interactive",
        "analysis",
        claude_out.path(),
        legacy_scope,
    );
    assert!(
        claude.status.success(),
        "{}",
        String::from_utf8_lossy(&claude.stderr)
    );

    let codex_out = tempfile::tempdir().unwrap();
    let mut missing_runtime =
        native_scope_value("analysis", codex_out.path(), "7", "opaque-revision");
    missing_runtime
        .as_object_mut()
        .unwrap()
        .remove("wren_runtime");
    let codex = dispatch_purpose_with_scope(
        ANALYSIS_IR,
        "codex:interactive",
        "analysis",
        codex_out.path(),
        missing_runtime,
    );
    assert!(!codex.status.success());
    assert!(String::from_utf8_lossy(&codex.stderr)
        .contains("native Codex purpose requires a server-derived wren_runtime closure"));
    assert!(fs::read_dir(codex_out.path()).unwrap().next().is_none());
}

#[test]
fn native_codex_runtime_rotation_refuses_partial_artifact_replacement() {
    let out = tempfile::tempdir().unwrap();
    let scope = native_scope_value("analysis", out.path(), "7", "opaque-revision");
    assert!(dispatch_purpose_with_scope(
        ANALYSIS_IR,
        "codex:interactive",
        "analysis",
        out.path(),
        scope.clone(),
    )
    .status
    .success());
    let before = fs::read_to_string(out.path().join(".codex/config.toml")).unwrap();

    let alternate_shim_root = tempfile::tempdir().unwrap();
    let alternate_shim = alternate_shim_root.path().join("bin/wren");
    fs::create_dir_all(alternate_shim.parent().unwrap()).unwrap();
    symlink(
        scope["wren_runtime"]["launcher"].as_str().unwrap(),
        &alternate_shim,
    )
    .unwrap();
    let mut rotated = scope;
    rotated["wren_runtime"]["shim"] = serde_json::json!(alternate_shim);
    let result = dispatch_purpose_with_scope(
        ANALYSIS_IR,
        "codex:interactive",
        "analysis",
        out.path(),
        rotated,
    );
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("refusing to overwrite"));
    assert_eq!(
        fs::read_to_string(out.path().join(".codex/config.toml")).unwrap(),
        before,
        "a rotated server runtime cannot partially replace a valid native artifact set"
    );
}

#[test]
fn native_session_v3_accepts_exact_loopback_http_for_every_vendor_and_purpose() {
    for url in [
        "http://localhost:4787/api/native-sessions/mcp",
        "http://127.0.0.1:4787/api/native-sessions/mcp",
        "http://[::1]:4787/api/native-sessions/mcp",
    ] {
        for (ir, purpose) in [
            (ANALYSIS_IR, "analysis"),
            (SETUP_IR, "setup"),
            (IR, "context_enrichment"),
        ] {
            for target in ["claude-code:interactive", "codex:interactive"] {
                let out = tempfile::tempdir().unwrap();
                let result = dispatch_purpose_with_scope_and_mcp(
                    ir,
                    target,
                    purpose,
                    out.path(),
                    native_scope_value(purpose, out.path(), "7", "opaque-revision"),
                    Some(native_mcp_value_with_url(url)),
                );
                assert!(
                    result.status.success(),
                    "{target}/{purpose}/{url}: {}",
                    String::from_utf8_lossy(&result.stderr)
                );
                let discovery = if target == "claude-code:interactive" {
                    fs::read_to_string(out.path().join(".mcp.json")).unwrap()
                } else {
                    fs::read_to_string(out.path().join(".codex/config.toml")).unwrap()
                };
                assert!(discovery.contains(url), "{target}/{purpose}/{url}");
            }
        }
    }
}

#[test]
fn native_session_v3_accepts_parsed_mixed_case_https_for_both_vendors() {
    let url = "hTtPs://mcp.example.test/native";
    assert_eq!(Url::parse(url).unwrap().scheme(), "https");

    for target in ["claude-code:interactive", "codex:interactive"] {
        let out = tempfile::tempdir().unwrap();
        let result = dispatch_purpose_with_scope_and_mcp(
            ANALYSIS_IR,
            target,
            "analysis",
            out.path(),
            native_scope_value("analysis", out.path(), "7", "opaque-revision"),
            Some(native_mcp_value_with_url(url)),
        );
        assert!(
            result.status.success(),
            "{target}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}

#[test]
fn native_session_v3_accepts_only_parser_typed_ipv4_loopback_forms() {
    // The WHATWG URL parser normalizes abbreviated, hexadecimal, and octal IPv4
    // spellings. Admission follows the parsed `Host::Ipv4`, never the raw spelling.
    for url in [
        "http://127.0.0.2:4787/api/native-sessions/mcp",
        "http://127.1:4787/api/native-sessions/mcp",
        "http://0x7f.0.0.1:4787/api/native-sessions/mcp",
        "http://0177.0.0.1:4787/api/native-sessions/mcp",
    ] {
        assert!(
            matches!(Url::parse(url).unwrap().host(), Some(Host::Ipv4(address)) if address.is_loopback()),
            "{url} must remain a parsed IPv4 loopback host"
        );
        let out = tempfile::tempdir().unwrap();
        let result = dispatch_purpose_with_scope_and_mcp(
            ANALYSIS_IR,
            "claude-code:interactive",
            "analysis",
            out.path(),
            native_scope_value("analysis", out.path(), "7", "opaque-revision"),
            Some(native_mcp_value_with_url(url)),
        );
        assert!(
            result.status.success(),
            "{url}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}

#[test]
fn native_session_v3_rejects_parser_typed_non_loopback_ipv4_forms() {
    let url = "http://0x0a000001:4787/api/native-sessions/mcp";
    assert!(
        matches!(Url::parse(url).unwrap().host(), Some(Host::Ipv4(address)) if !address.is_loopback()),
        "{url} must remain a parsed non-loopback IPv4 host"
    );

    let out = tempfile::tempdir().unwrap();
    let result = dispatch_purpose_with_scope_and_mcp(
        ANALYSIS_IR,
        "claude-code:interactive",
        "analysis",
        out.path(),
        native_scope_value("analysis", out.path(), "7", "opaque-revision"),
        Some(native_mcp_value_with_url(url)),
    );
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr)
        .contains("native MCP descriptor URL must be HTTPS or exact loopback HTTP"));
    assert!(fs::read_dir(out.path()).unwrap().next().is_none());
}

#[test]
fn setup_recovery_v1_accepts_only_the_closed_redacted_report_shapes() {
    let schema = setup_recovery_input_schema();
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["properties"]["version"]["const"], "1");
    assert_eq!(
        schema["properties"]["phase"]["enum"],
        serde_json::json!(["connect", "context"])
    );

    for valid in [
        serde_json::json!({"version":"1", "sequence":1, "phase":"connect", "state":"working", "code":"in_progress"}),
        serde_json::json!({"version":"1", "sequence":2, "phase":"connect", "state":"needs_input", "code":"user_action_required"}),
        serde_json::json!({"version":"1", "sequence":3, "phase":"context", "state":"needs_decision", "code":"continue_or_stop", "decision":{"kind":"continue_or_stop", "choices":["continue", "stop"]}}),
        serde_json::json!({"version":"1", "sequence":4, "phase":"context", "state":"retryable_failure", "code":"retryable"}),
        serde_json::json!({"version":"1", "sequence":5, "phase":"context", "state":"reported_complete", "code":"completion_reported"}),
    ] {
        validate_setup_recovery_report(&valid).unwrap();
    }

    for malformed in [
        serde_json::json!({"version":"1", "sequence":0, "phase":"connect", "state":"working", "code":"in_progress"}),
        serde_json::json!({"version":"2", "sequence":1, "phase":"connect", "state":"working", "code":"in_progress"}),
        serde_json::json!({"version":"1", "sequence":1, "phase":"connect", "state":"working", "code":"in_progress", "session_id":"forbidden"}),
        serde_json::json!({"version":"1", "sequence":1, "phase":"connect", "state":"needs_input", "code":"free text"}),
        serde_json::json!({"version":"1", "sequence":1, "phase":"context", "state":"needs_decision", "code":"continue_or_stop"}),
        serde_json::json!({"version":"1", "sequence":1, "phase":"context", "state":"needs_decision", "code":"continue_or_stop", "decision":{"kind":"continue_or_stop", "choices":["stop", "continue"]}}),
        serde_json::json!({"version":"1", "sequence":1, "phase":"context", "state":"reported_complete", "code":"completion_reported", "decision":{"kind":"continue_or_stop", "choices":["continue", "stop"]}}),
    ] {
        assert!(
            validate_setup_recovery_report(&malformed).is_err(),
            "{malformed}"
        );
    }
}

#[test]
fn native_session_v3_rejects_strict_mcp_descriptor_failures_before_writes() {
    let cases = [
        (
            "missing-url",
            serde_json::json!({"version": "1", "credential": "opaque"}),
        ),
        (
            "missing-credential",
            serde_json::json!({"version": "1", "url": "https://mcp.example.test/native"}),
        ),
        (
            "extra",
            serde_json::json!({"version": "1", "url": "https://mcp.example.test/native", "credential": "opaque", "session_id": "forbidden"}),
        ),
        (
            "version",
            serde_json::json!({"version": "999", "url": "https://mcp.example.test/native", "credential": "opaque"}),
        ),
        (
            "url",
            serde_json::json!({"version": "1", "url": "https://mcp.example.test/native?session=forbidden", "credential": "opaque"}),
        ),
        (
            "fragment",
            native_mcp_value_with_url("https://mcp.example.test/native#forbidden"),
        ),
        (
            "url-without-authority",
            serde_json::json!({"version": "1", "url": "https://", "credential": "opaque"}),
        ),
        (
            "relative-https-url",
            native_mcp_value_with_url("https:relative-path"),
        ),
        (
            "public-http",
            native_mcp_value_with_url("http://mcp.example.test/native"),
        ),
        (
            "private-http",
            native_mcp_value_with_url("http://10.0.0.1/native"),
        ),
        (
            "localhost-suffix-http",
            native_mcp_value_with_url("http://localhost.example.test/native"),
        ),
        (
            "userinfo-http",
            native_mcp_value_with_url("http://localhost@evil.example/native"),
        ),
        (
            "ipv4-userinfo-http",
            native_mcp_value_with_url("http://127.0.0.1@evil.example/native"),
        ),
        (
            "ipv6-userinfo-http",
            native_mcp_value_with_url("http://[::1]@evil.example/native"),
        ),
        (
            "malformed-ipv6-http",
            native_mcp_value_with_url("http://[::1/native"),
        ),
        (
            "unsupported-scheme",
            native_mcp_value_with_url("ftp://localhost/native"),
        ),
        (
            "credential",
            serde_json::json!({"version": "1", "url": "https://mcp.example.test/native", "credential": "opaque\nforbidden"}),
        ),
        (
            "credential-whitespace",
            serde_json::json!({"version": "1", "url": "https://mcp.example.test/native", "credential": "opaque credential"}),
        ),
    ];
    for (name, descriptor) in cases {
        let out = tempfile::tempdir().unwrap();
        let result = dispatch_purpose_with_scope_and_mcp(
            ANALYSIS_IR,
            "claude-code:interactive",
            "analysis",
            out.path(),
            native_scope_value("analysis", out.path(), "7", "opaque-revision"),
            Some(descriptor),
        );
        assert!(!result.status.success(), "{name}");
        if matches!(
            name,
            "url"
                | "fragment"
                | "url-without-authority"
                | "relative-https-url"
                | "public-http"
                | "private-http"
                | "localhost-suffix-http"
                | "userinfo-http"
                | "ipv4-userinfo-http"
                | "ipv6-userinfo-http"
                | "malformed-ipv6-http"
                | "unsupported-scheme"
        ) {
            assert!(
                String::from_utf8_lossy(&result.stderr)
                    .contains("native MCP descriptor URL must be HTTPS or exact loopback HTTP"),
                "{name} must fail with a sanitized URL classification"
            );
        }
        assert!(fs::read_dir(out.path()).unwrap().next().is_none(), "{name}");
    }
}

#[test]
fn native_session_v3_rejects_hybrid_mcp_configuration_before_writes() {
    let out = tempfile::tempdir().unwrap();
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
    let descriptor_file = tempfile::NamedTempFile::new().unwrap();
    fs::write(
        descriptor_file.path(),
        serde_json::to_string(&native_mcp_value()).unwrap(),
    )
    .unwrap();
    let models_file = tempfile::NamedTempFile::new().unwrap();
    fs::write(
        models_file.path(),
        "tiers:\n  strong:\n    provider: openai_compat\n    endpoint: http://127.0.0.1:11434/v1\n    model: local-strong\n  cheap: haiku\n  orchestrator: sonnet\n",
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_warble"))
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
        .args(["--native-mcp"])
        .arg(descriptor_file.path())
        .args(["--models-config"])
        .arg(models_file.path())
        .args(["--out"])
        .arg(out.path())
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr)
        .contains("native MCP discovery requires an all-cloud"));
    assert!(fs::read_dir(out.path()).unwrap().next().is_none());
}

#[test]
fn native_session_v3_refuses_changed_opaque_mcp_credential_without_partial_replacement() {
    for (target, config_path) in [
        ("claude-code:interactive", ".mcp.json"),
        ("codex:interactive", ".codex/config.toml"),
    ] {
        let out = tempfile::tempdir().unwrap();
        let scope = native_scope_value("analysis", out.path(), "7", "opaque-revision");
        assert!(dispatch_purpose_with_scope_and_mcp(
            ANALYSIS_IR,
            target,
            "analysis",
            out.path(),
            scope.clone(),
            Some(native_mcp_value()),
        )
        .status
        .success());
        let before = fs::read_to_string(out.path().join(config_path)).unwrap();
        let mut rotated = native_mcp_value();
        rotated["credential"] = serde_json::json!("rotated-opaque-native-mcp-credential");
        let result = dispatch_purpose_with_scope_and_mcp(
            ANALYSIS_IR,
            target,
            "analysis",
            out.path(),
            scope,
            Some(rotated),
        );
        assert!(!result.status.success(), "{target}");
        assert!(String::from_utf8_lossy(&result.stderr).contains("refusing to overwrite"));
        assert_eq!(
            fs::read_to_string(out.path().join(config_path)).unwrap(),
            before
        );
    }
}

#[test]
fn native_session_v3_rejects_discovery_symlinks_before_any_write() {
    for (target, path) in [
        ("claude-code:interactive", ".mcp.json"),
        ("codex:interactive", ".codex"),
    ] {
        let out = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), out.path().join(path)).unwrap();
        let result = dispatch_purpose_with_scope_and_mcp(
            ANALYSIS_IR,
            target,
            "analysis",
            out.path(),
            native_scope_value("analysis", out.path(), "7", "opaque-revision"),
            Some(native_mcp_value()),
        );
        assert!(!result.status.success(), "{target}");
        assert!(String::from_utf8_lossy(&result.stderr).contains("symlink component"));
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
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

    // This used to assert a profile-name allowlist. The protection it stood for — you cannot open
    // an analysis session against a profile that has no analysis entry — now comes from the
    // structural check instead, and is asserted here in the form that survives a rename: the
    // declared entry verb simply is not in this IR.
    let wrong_profile = dispatch_purpose_with_scope(
        IR,
        "codex:interactive",
        "analysis",
        out.path(),
        native_scope_value("analysis", out.path(), "1", "opaque-revision-1"),
    );
    assert!(!wrong_profile.status.success());
    let stderr = String::from_utf8_lossy(&wrong_profile.stderr);
    assert!(
        stderr.contains("declared entry verb 'answer_query'") && stderr.contains("found 0"),
        "unexpected refusal: {stderr}"
    );
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
fn a_caller_cannot_declare_a_real_mutating_component_as_a_session_entry() {
    // The cases above build their unmaterializable component by editing an IR. This one uses a
    // shipped component that genuinely is one — `apply_changes` is a gated tool with a mutation
    // outcome — so the refusal is anchored to a real profile rather than only to a synthetic edit
    // that could drift away from anything real.
    let out = tempfile::tempdir().unwrap();
    let mut scope = native_scope_value("context_enrichment", out.path(), "1", "opaque-revision-1");
    scope["entry"]["verb"] = serde_json::json!("apply_changes");
    let result = dispatch_purpose_with_scope(
        IR,
        "claude-code:interactive",
        "context_enrichment",
        out.path(),
        scope,
    );
    assert!(!result.status.success());
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(
        stderr.contains("apply_changes") && stderr.contains("not materializable"),
        "unexpected refusal: {stderr}"
    );
    assert!(
        fs::read_dir(out.path()).unwrap().next().is_none(),
        "a refused entry must not leave a partial output root"
    );
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
fn a_caller_cannot_smuggle_a_vendor_flag_through_a_dash_leading_entry() {
    // Both entry fields land in argv as positional elements with no `--` sentinel in front of
    // them, so a dash-leading value would reach the vendor CLI as an option rather than as
    // content. `--dangerously-skip-permissions` is the concrete reason this matters: accepting it
    // would change what the launch authorizes without the argv contract looking unusual.
    //
    // The two fields are refused by different gates, and that asymmetry is the point. A verb is
    // already unable to be dash-leading, because it must equal the id of a component in the IR
    // and no component is named `-x` -- so `validate_profile` catches it and this test only pins
    // that it stays refused, whichever gate does it. A prompt has no such structural anchor: it
    // is free text, and the preflight shape check is the only thing standing between a caller and
    // argv. Either way nothing may be written.
    for value in ["--dangerously-skip-permissions", "  -x", "-"] {
        for target in ["claude-code:interactive", "codex:interactive"] {
            let out = tempfile::tempdir().unwrap();
            let mut scope = native_scope_value("analysis", out.path(), "7", "opaque-revision");
            scope["entry"]["prompt"] = serde_json::json!(value);
            let result =
                dispatch_purpose_with_scope(ANALYSIS_IR, target, "analysis", out.path(), scope);
            assert!(!result.status.success(), "prompt/{value}/{target}");
            let stderr = String::from_utf8_lossy(&result.stderr);
            assert!(
                stderr.contains("native session scope entry prompt must not begin with '-'"),
                "prompt/{value}/{target}: {stderr}"
            );
            assert!(
                fs::read_dir(out.path()).unwrap().next().is_none(),
                "prompt/{value}/{target}"
            );

            let out = tempfile::tempdir().unwrap();
            let mut scope = native_scope_value("analysis", out.path(), "7", "opaque-revision");
            scope["entry"]["verb"] = serde_json::json!(value);
            let result =
                dispatch_purpose_with_scope(ANALYSIS_IR, target, "analysis", out.path(), scope);
            assert!(!result.status.success(), "verb/{value}/{target}");
            assert!(
                fs::read_dir(out.path()).unwrap().next().is_none(),
                "verb/{value}/{target}"
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
        (
            "extra",
            serde_json::json!({
                "version": "1", "kind": "bound_project", "scope_id": "opaque", "cwd": root,
                "binding": { "project_identity": "opaque-project", "generation": "7", "revision": "opaque-revision" },
                "session_id": "forbidden",
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
        let mut scope =
            native_scope_value("context_enrichment", out.path(), "7", "opaque-revision");
        // `entry.prompt` is free caller-supplied text that reaches argv -- the verb, not the
        // prompt, is what reaches RUN.md. It is the new input surface this contract introduced,
        // so it belongs in the injection coverage.
        scope["entry"]["prompt"] = serde_json::json!(format!("Inspect this project {injection}"));
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
            vec!["RUN.md", ".claude/agents/propose_changes.md"]
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
    let agent = out.path().join(".claude/agents/survey_context.md");
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

// --- component-level `brief` (codex native skill materialization) --------------------------
//
// propose-apply-agent's golden IR authors no `brief`, so this injects one onto `propose_changes`
// via a mutated temp copy rather than touching the shipping fixture. The assertion computes the
// "without brief" baseline SKILL.md first and checks the "with brief" one equals that baseline with
// the brief text spliced in immediately before `propose_changes`'s own section — this fails if the
// insertion in `codex.rs`'s `build_skill` is removed or misplaced, not just if the text is missing.
#[test]
fn codex_skill_brief_is_spliced_in_verbatim_before_the_authoring_components_own_section() {
    let out_without = tempfile::tempdir().unwrap();
    let result = dispatch_purpose(
        IR,
        "codex:interactive",
        "context_enrichment",
        out_without.path(),
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let without = fs::read_to_string(
        out_without
            .path()
            .join(".agents/skills/genbi-enrich-context/SKILL.md"),
    )
    .unwrap();

    let mut ir_json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(IR).unwrap()).unwrap();
    let brief = "Custom shared framing for the enrichment skill.";
    {
        let component = ir_json["components"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|c| c["verb"] == "propose_changes")
            .expect("propose_changes must exist in propose-apply-agent's golden IR");
        component["brief"] = serde_json::json!(brief);
    }
    let fixture = tempfile::NamedTempFile::new().unwrap();
    fs::write(fixture.path(), serde_json::to_string(&ir_json).unwrap()).unwrap();

    let out_with = tempfile::tempdir().unwrap();
    let result = dispatch_purpose(
        fixture.path().to_str().unwrap(),
        "codex:interactive",
        "context_enrichment",
        out_with.path(),
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let with = fs::read_to_string(
        out_with
            .path()
            .join(".agents/skills/genbi-enrich-context/SKILL.md"),
    )
    .unwrap();

    // The header comment embeds a `scope_digest` over the dispatched IR content, so it legitimately
    // differs between the "without" and "with" runs (the IR content itself differs) — normalize it
    // out before comparing, since it is orthogonal to where the brief text landed.
    fn normalize_digest(s: &str) -> String {
        let re_prefix = "scope_digest=sha256:";
        match s.find(re_prefix) {
            Some(start) => {
                let hash_start = start + re_prefix.len();
                let hash_end = s[hash_start..]
                    .find(|c: char| !c.is_ascii_hexdigit())
                    .map(|i| hash_start + i)
                    .unwrap_or(s.len());
                format!("{}<digest>{}", &s[..hash_start], &s[hash_end..])
            }
            None => s.to_string(),
        }
    }
    let without = normalize_digest(&without);
    let with = normalize_digest(&with);

    // `propose_changes`'s prompt_fragment opens with this heading; the transform applied to the
    // fragment (native_context_enrichment_prompt_fragment) only rewrites a later "final mandate"
    // block, so the opening heading is a stable, untouched splice marker.
    let marker = "## propose";
    let idx = without
        .find(marker)
        .expect("propose_changes's section must be locatable in the baseline SKILL.md");
    let expected = format!("{}{}\n\n{}", &without[..idx], brief, &without[idx..]);
    assert_eq!(
        with, expected,
        "removing (or mispositioning) the brief-insertion line in codex.rs's build_skill would make this assertion fail"
    );
}

#[test]
fn apply_only_ir_loud_fails_without_writing_native_handoff() {
    let source: serde_json::Value = serde_json::from_str(&fs::read_to_string(IR).unwrap()).unwrap();
    let apply = source["components"]
        .as_array()
        .unwrap()
        .iter()
        .find(|component| component["id"] == "apply_changes")
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
