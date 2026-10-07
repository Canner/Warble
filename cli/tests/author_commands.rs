//! Author workflow contracts: exact native surfaces, honest origins, no vendor execution.
use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

fn write(root: &Path, name: &str, value: &str) {
    let path = root.join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, value).unwrap();
}
fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_warble"))
        .args(args)
        .env("ANTHROPIC_API_KEY", "AMBIENT_SECRET_MUST_NOT_APPEAR")
        .env("OPENAI_API_KEY", "ANOTHER_AMBIENT_SECRET")
        .output()
        .unwrap()
}
fn success(out: Output) -> String {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}
fn failed(out: Output, expected: &[&str]) {
    assert!(!out.status.success());
    let text = String::from_utf8_lossy(&out.stderr);
    for item in expected {
        assert!(text.contains(item), "missing {item}: {text}");
    }
    assert!(!text.contains("SECRET_MUST_NOT_APPEAR"));
}
fn simple(root: &Path) {
    write(root,"profile.yml","profile: helper\ncomponents:\n  - id: summarize\n    prompt: Summarize the supplied text.\n");
}
fn composed(root: &Path) {
    write(
        root,
        "profile.yml",
        r#"profile: helper
system_prompt: COMMON {{ slot.style }}
slots:
  - name: style
    variants: {short: style/short.md, long: style/long.md}
    default: short
components:
  - use: summarize
    brief: MOUNT_BRIEF
"#,
    );
    write(root, "style/short.md", "SHORT_STYLE");
    write(root, "style/long.md", "UNUSED_PROFILE_TEXT");
    write(
        root,
        "components/summarize/component.yml",
        r#"id: summarize
verb: summarize
type: analytical
realization_kind: skill
binding_mode: runtime_selected
brief: REPLACED_COMPONENT_TEXT
llm_steps:
  - name: respond
    tier: cheap
    prompt_ref: steps/respond.md
slots:
  - name: tone
    variants: {polite: polite.md, brisk: brisk.md}
    default: polite
trigger: {kind: one_shot}
guardrails: [{name: read_only_execution, locked: true}]
required_capabilities: [llm:cheap]
effect: {render_blocks: [], outcome: {kind: none}}
"#,
    );
    write(
        root,
        "components/summarize/steps/respond.md",
        "STEP {{ slot.tone }}",
    );
    write(root, "components/summarize/polite.md", "TONE_POLITE");
    write(
        root,
        "components/summarize/brisk.md",
        "UNUSED_COMPONENT_TEXT",
    );
}

#[test]
fn preview_is_the_exact_native_emit_for_both_targets_with_sources_and_model_choices() {
    for target in ["claude-code:headless", "claude-code:interactive"] {
        let d = tempfile::tempdir().unwrap();
        composed(d.path());
        let project = d.path().to_str().unwrap();
        let text = success(run(&[
            "preview", project, "--target", target, "--cheap", "sonnet", "--json",
        ]));
        for hidden in [
            "REPLACED_COMPONENT_TEXT",
            "UNUSED_PROFILE_TEXT",
            "UNUSED_COMPONENT_TEXT",
            "AMBIENT_SECRET",
            "ANOTHER_AMBIENT",
        ] {
            assert!(!text.contains(hidden), "{hidden}");
        }
        let preview: Value = serde_json::from_str(&text).unwrap();
        let output = d.path().join("built");
        success(run(&[
            "build",
            project,
            "--target",
            target,
            "--cheap",
            "sonnet",
            "--out",
            output.to_str().unwrap(),
        ]));
        let ir = d.path().join("ordinary.json");
        let ordinary = d.path().join("ordinary");
        success(run(&["compile", project, "-o", ir.to_str().unwrap()]));
        success(run(&[
            "dispatch",
            ir.to_str().unwrap(),
            "--target",
            target,
            "--cheap",
            "sonnet",
            "--out",
            ordinary.to_str().unwrap(),
        ]));
        for surface in preview["surfaces"].as_array().unwrap() {
            let path = surface["path"].as_str().unwrap();
            let actual = fs::read_to_string(output.join(path)).unwrap();
            assert_eq!(surface["content"], actual);
            assert_eq!(actual, fs::read_to_string(ordinary.join(path)).unwrap());
        }
        assert_eq!(
            preview["permissions"],
            serde_json::from_slice::<Value>(
                &fs::read(output.join(".claude/settings.json")).unwrap()
            )
            .unwrap()
        );
        assert_eq!(
            preview["capabilities"],
            serde_json::from_slice::<Value>(
                &fs::read(output.join("capability-report.json")).unwrap()
            )
            .unwrap()
        );
        let agent = fs::read_to_string(output.join(".claude/agents/summarize.md")).unwrap();
        for expected in [
            "COMMON SHORT_STYLE",
            "MOUNT_BRIEF",
            "STEP TONE_POLITE",
            "model: sonnet",
        ] {
            assert!(agent.contains(expected), "{agent}");
        }
        let sources = preview["sources"].as_array().unwrap();
        assert!(sources.iter().any(|s| s["role"] == "component brief"
            && s["status"].as_str().unwrap().starts_with("replaced")));
        assert!(sources
            .iter()
            .any(|s| s["field"] == "components[0].brief" && s["role"] == "mount brief"));
        assert!(sources.iter().any(
            |s| s["file"].as_str().unwrap().ends_with("steps/respond.md")
                && s["field"] == "llm_steps[0].prompt_ref"
        ));
        assert!(sources
            .iter()
            .any(|s| s["variant"] == "brisk" && s["status"] == "unselected; not emitted"));
        assert!(preview["runtime_boundary"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s.as_str().unwrap().contains("not a captured conversation")));
    }
}

#[test]
fn check_and_preview_leave_no_ir_or_runtime_state_and_shorthand_origin_is_real() {
    let d = tempfile::tempdir().unwrap();
    simple(d.path());
    let p = d.path().to_str().unwrap();
    success(run(&["check", p]));
    let preview: Value = serde_json::from_str(&success(run(&["preview", p, "--json"]))).unwrap();
    assert_eq!(fs::read_dir(d.path()).unwrap().count(), 1);
    assert!(preview["sources"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["field"] == "components[0].prompt" && s["role"] == "step prompt"));
    let human = success(run(&["preview", p]));
    assert!(
        human.contains("Author sources:")
            && human.contains("Native permissions:")
            && human.contains(".claude/agents/summarize.md")
    );
}

#[test]
fn slot_selection_and_omission_change_actual_surfaces_and_sources() {
    let d = tempfile::tempdir().unwrap();
    composed(d.path());
    let p = d.path().to_str().unwrap();
    let component = d.path().join("components/summarize/component.yml");
    fs::write(
        &component,
        fs::read_to_string(&component).unwrap().replace(
            "default: polite",
            "default: polite\n    present_when: approved",
        ),
    )
    .unwrap();
    failed(
        run(&["preview", p]),
        &["slot", "tone", "component.yml", "--slot"],
    );
    let chosen: Value = serde_json::from_str(&success(run(&[
        "preview",
        p,
        "--slot",
        "tone=brisk",
        "--json",
    ])))
    .unwrap();
    assert!(chosen["surfaces"]
        .to_string()
        .contains("UNUSED_COMPONENT_TEXT"));
    assert!(!chosen["surfaces"].to_string().contains("TONE_POLITE"));
    let omitted: Value =
        serde_json::from_str(&success(run(&["preview", p, "--slot", "tone=", "--json"]))).unwrap();
    assert_ne!(chosen["surfaces"], omitted["surfaces"]);
    assert!(!omitted["surfaces"]
        .to_string()
        .contains("UNUSED_COMPONENT_TEXT"));
    assert!(omitted["sources"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["slot"] == "tone")
        .all(|s| s["status"] == "omitted by --slot; not emitted"));
    let out = d.path().join("chosen");
    success(run(&[
        "build",
        p,
        "--slot",
        "tone=brisk",
        "--out",
        out.to_str().unwrap(),
    ]));
    for s in chosen["surfaces"].as_array().unwrap() {
        assert_eq!(
            s["content"],
            fs::read_to_string(out.join(s["path"].as_str().unwrap())).unwrap()
        );
    }
}

#[test]
fn validation_errors_name_sources_and_preserve_outputs() {
    for change in [
        "context_precondition: [{predicate: has_metric}]\n",
        "required_capabilities: [llm:cheap, human_approval]\n",
    ] {
        let d = tempfile::tempdir().unwrap();
        composed(d.path());
        let p = d.path().to_str().unwrap();
        let file = d.path().join("components/summarize/component.yml");
        let text = fs::read_to_string(&file).unwrap();
        fs::write(
            &file,
            if change.starts_with("required") {
                text.replace("required_capabilities: [llm:cheap]\n", change)
            } else {
                text + change
            },
        )
        .unwrap();
        let out = d.path().join("out");
        failed(
            run(&["build", p, "--out", out.to_str().unwrap()]),
            &["summarize", "component.yml"],
        );
        assert!(!out.exists());
    }
    let d = tempfile::tempdir().unwrap();
    simple(d.path());
    let p = d.path().to_str().unwrap();
    let out = d.path().join("out");
    fs::create_dir(&out).unwrap();
    write(&out, "canary", "preserve");
    failed(
        run(&["build", p, "--out", out.to_str().unwrap()]),
        &["already exists"],
    );
    assert_eq!(fs::read_to_string(out.join("canary")).unwrap(), "preserve");
    #[cfg(unix)]
    {
        let link = d.path().join("link");
        std::os::unix::fs::symlink(&out, &link).unwrap();
        failed(
            run(&["build", p, "--out", link.to_str().unwrap()]),
            &["already exists"],
        );
        assert_eq!(fs::read_to_string(out.join("canary")).unwrap(), "preserve");
    }

    failed(
        run(&["preview", p, "--target", "codex:interactive"]),
        &["currently support", "compile/dispatch"],
    );
    failed(
        run(&["preview", p, "--native-mcp", "secret.json"]),
        &["unexpected argument"],
    );
}

// The temporary preflight has a short path and succeeds; only delivery at --out fails.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn failed_delivery_removes_new_output_for_both_targets() {
    let d = tempfile::tempdir().unwrap();
    simple(d.path());
    let path_max = if cfg!(target_os = "macos") {
        1024
    } else {
        4096
    };
    let mut parent = d.path().canonicalize().unwrap();
    while parent.as_os_str().len() + 181 + 20 < path_max - 20 {
        parent.push("d".repeat(180));
    }
    let out = parent.join("o".repeat(path_max - 20 - parent.as_os_str().len() - 1));
    for target in ["claude-code:headless", "claude-code:interactive"] {
        for _ in 0..2 {
            failed(
                run(&[
                    "build",
                    d.path().to_str().unwrap(),
                    "--target",
                    target,
                    "--out",
                    out.to_str().unwrap(),
                ]),
                &["output for", "failed"],
            );
            assert!(
                out.symlink_metadata().is_err(),
                "failed output must be removed"
            );
        }
    }
}

#[test]
fn unknown_fields_and_invalid_scalars_do_not_echo_secret_values() {
    let d = tempfile::tempdir().unwrap();
    simple(d.path());
    let p = d.path().to_str().unwrap();
    let file = d.path().join("profile.yml");
    let original = fs::read_to_string(&file).unwrap();
    fs::write(
        &file,
        format!("{original}api_key: SECRET_MUST_NOT_APPEAR\n"),
    )
    .unwrap();
    failed(
        run(&["preview", p]),
        &["profile.yml", "unknown profile field api_key"],
    );
    fs::write(
        &file,
        format!("{original}config: {{token: SECRET_MUST_NOT_APPEAR}}\n"),
    )
    .unwrap();
    failed(
        run(&["check", p]),
        &["profile.yml#config", "unknown field token"],
    );
    fs::write(
        &file,
        original.replace(
            "prompt: Summarize the supplied text.",
            "prompt: {token: SECRET_MUST_NOT_APPEAR}",
        ),
    )
    .unwrap();
    failed(
        run(&["preview", p]),
        &["profile.yml#components[0]", "invalid YAML"],
    );
    fs::write(
        &file,
        original.replace(
            "    prompt: Summarize the supplied text.",
            "    tier: strong\n    promt: SECRET_MUST_NOT_APPEAR",
        ),
    )
    .unwrap();
    failed(
        run(&["check", p]),
        &[
            "profile.yml#components[0]",
            "top-level tier requires a top-level prompt",
            "check the prompt field spelling",
        ],
    );
}

#[cfg(unix)]
#[test]
fn author_commands_never_start_a_vendor_or_tool_process() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let project = d.path().join("project");
    simple(&project);
    let bins = d.path().join("bin");
    for name in ["claude", "codex", "wren", "node"] {
        write(
            &bins,
            name,
            "#!/bin/sh\nprintf invoked >> \"$INVOCATION_CANARY\"\nexit 99\n",
        );
        fs::set_permissions(bins.join(name), fs::Permissions::from_mode(0o755)).unwrap();
    }
    let canary = d.path().join("invoked");
    for name in ["check", "preview", "build"] {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_warble"));
        cmd.arg(name)
            .arg(&project)
            .env("PATH", &bins)
            .env("INVOCATION_CANARY", &canary);
        if name == "build" {
            cmd.arg("--out").arg(d.path().join("built"));
        }
        success(cmd.output().unwrap());
    }
    assert!(!canary.exists());
}

#[test]
fn data_profile_preview_includes_every_emitted_subagent_surface() {
    let project = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/demo-agent");
    let p = project.to_str().unwrap();
    let preview: Value = serde_json::from_str(&success(run(&["preview", p, "--json"]))).unwrap();
    let d = tempfile::tempdir().unwrap();
    let out = d.path().join("native");
    success(run(&["build", p, "--out", out.to_str().unwrap()]));
    let agent_count = fs::read_dir(out.join(".claude/agents")).unwrap().count();
    assert!(agent_count > 1, "exercise the multi-tier subagent path");
    assert_eq!(
        preview["surfaces"].as_array().unwrap().len(),
        agent_count + 1
    );
    for s in preview["surfaces"].as_array().unwrap() {
        assert_eq!(
            s["content"],
            fs::read_to_string(out.join(s["path"].as_str().unwrap())).unwrap()
        );
    }
    assert!(preview["sources"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["file"]
            .as_str()
            .unwrap()
            .contains("examples/demo-agent/components/generate_dashboard")));
}
