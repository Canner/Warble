//! Execute authored tutorial sources through the CLI, without starting a vendor/model.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}
fn write(root: &Path, name: &str, text: &str) {
    let dest = root.join(name);
    fs::create_dir_all(dest.parent().unwrap()).unwrap();
    fs::write(dest, text).unwrap();
}
fn block(title: &str) -> String {
    let doc =
        fs::read_to_string(repo().join("docs/site/docs/getting-started/first-profile.md")).unwrap();
    doc.split_once(&format!("```yaml title=\"{title}\"\n"))
        .unwrap()
        .1
        .split_once("\n```")
        .unwrap()
        .0
        .to_string()
        + "\n"
}
fn tutorial(root: &Path) {
    let source = block("profile.yml");
    assert_eq!(
        source,
        fs::read_to_string(repo().join("examples/first-harness/profile.yml")).unwrap()
    );
    write(root, "profile.yml", &source);
}
fn compile(root: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_warble"))
        .arg("compile")
        .arg(root)
        .arg("-o")
        .arg(root.join("ir.json"))
        .output()
        .unwrap()
}
fn ir(root: &Path) -> serde_json::Value {
    success(compile(root));
    serde_json::from_slice(&fs::read(root.join("ir.json")).unwrap()).unwrap()
}
fn emit(root: &Path, target: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_warble"))
        .arg("dispatch")
        .arg(root.join("ir.json"))
        .args(["--target", target, "--out"])
        .arg(root.join("agent"))
        .output()
        .unwrap()
}
fn success(output: Output) {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn failure(output: Output, expected: &str) {
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains(expected), "expected {expected:?}: {error}");
}
fn full(root: &Path) {
    write(
        root,
        "profile.yml",
        "profile: text-helper\ncomponents:\n  - use: summarize_text\n",
    );
    write(
        root,
        "components/summarize_text/component.yml",
        &block("full-component.yml"),
    );
}

#[test]
fn single_file_tutorial_emits_native_files_without_semantic_framing() {
    for target in ["claude-code:headless", "claude-code:interactive"] {
        let dir = tempfile::tempdir().unwrap();
        tutorial(dir.path());
        assert!(!warble_cli::project_needs_hub(dir.path(), &[], None).unwrap());
        let value = ir(dir.path());
        assert_eq!(value["warble_ir_version"], "0.9");
        assert!(value["context_binding"].is_null());
        assert!(value["components"][0]["context_binding"].is_null());
        assert_eq!(
            value["components"][0]["precondition_result"]["checks"],
            serde_json::json!([])
        );
        success(emit(dir.path(), target));
        let agent =
            fs::read_to_string(dir.path().join("agent/.claude/agents/summarize_text.md")).unwrap();
        assert!(agent.contains("Summarize the text supplied"));
        assert!(agent.contains("---\n\n## respond"), "{agent}");
        let scope = fs::read_to_string(dir.path().join("agent/.claude/CLAUDE.md")).unwrap();
        let settings = fs::read_to_string(dir.path().join("agent/.claude/settings.json")).unwrap();
        let run = fs::read_to_string(dir.path().join("agent/RUN.md")).unwrap();
        for text in [&agent, &scope, &settings, &run] {
            for unwanted in [
                "semantic layer",
                "Report what your own tools",
                "schema_digest",
                "Data access goes through",
                ".wren/config.json",
                "strict_mode",
                "<data question>",
            ] {
                assert!(!text.contains(unwanted), "{unwanted}: {text}");
            }
        }
        if target == "claude-code:headless" {
            assert!(run.contains("<request>"));
        }
        let settings: serde_json::Value = serde_json::from_str(&settings).unwrap();
        assert_eq!(
            settings["permissions"],
            serde_json::json!({
                "allow": ["Read"],
                "deny": ["Bash(rm:*)", "Bash(sudo:*)", "Bash(dd:*)"]
            })
        );
        let front = agent.split("---").nth(1).unwrap();
        let front: serde_yaml::Value = serde_yaml::from_str(front).unwrap();
        assert_eq!(
            front["tools"],
            serde_yaml::from_str::<serde_yaml::Value>("[Read]").unwrap()
        );
        assert!(!dir.path().join("agent/.wren").exists());
        let report: serde_json::Value = serde_json::from_slice(
            &fs::read(dir.path().join("agent/context-report.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(report["mode"], "none");
    }
}

#[test]
fn extraction_and_full_form_preserve_ir_and_permissions() {
    let dir = tempfile::tempdir().unwrap();
    tutorial(dir.path());
    let inline = ir(dir.path());
    success(emit(dir.path(), "claude-code:headless"));
    let agent = fs::read(dir.path().join("agent/.claude/agents/summarize_text.md")).unwrap();
    let settings = fs::read(dir.path().join("agent/.claude/settings.json")).unwrap();
    write(dir.path(), "profile.yml", &block("extracted-profile.yml"));
    write(
        dir.path(),
        "components/summarize_text/component.yml",
        &block("component.yml"),
    );
    assert_eq!(inline, ir(dir.path()));
    success(emit(dir.path(), "claude-code:headless"));
    assert_eq!(
        agent,
        fs::read(dir.path().join("agent/.claude/agents/summarize_text.md")).unwrap()
    );
    assert_eq!(
        settings,
        fs::read(dir.path().join("agent/.claude/settings.json")).unwrap()
    );
    let full_component: serde_yaml::Value =
        serde_yaml::from_str(&block("full-component.yml")).unwrap();
    let inline_full = serde_yaml::to_string(&serde_json::json!({
        "profile": "text-helper", "components": [full_component]
    }))
    .unwrap();
    write(dir.path(), "profile.yml", &inline_full);
    assert_eq!(inline, ir(dir.path()));
    full(dir.path());
    assert_eq!(inline, ir(dir.path()));
    let path = dir.path().join("components/summarize_text/component.yml");
    let mut component: serde_yaml::Value =
        serde_yaml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    let text = component["llm_steps"][0]
        .as_mapping_mut()
        .unwrap()
        .remove(serde_yaml::Value::String("prompt".into()))
        .unwrap();
    component["llm_steps"][0]["prompt_ref"] = "steps/respond.md".into();
    write(
        dir.path(),
        "components/summarize_text/steps/respond.md",
        text.as_str().unwrap(),
    );
    fs::write(path, serde_yaml::to_string(&component).unwrap()).unwrap();
    assert_eq!(inline, ir(dir.path()));
}

#[test]
fn missing_context_and_invalid_sources_have_distinct_diagnostics() {
    for (addition, expected) in [
        (
            "context_precondition:\n  - predicate: mdl_parseable\n",
            "requires context",
        ),
        (
            "context_requirements: [semantic schema]\n",
            "requires context",
        ),
        (
            "params:\n  - { name: metric, source: metric }\n",
            "unknown source 'metric'",
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        full(dir.path());
        let path = dir.path().join("components/summarize_text/component.yml");
        let text = fs::read_to_string(&path).unwrap();
        fs::write(path, text + addition).unwrap();
        let out = compile(dir.path());
        assert!(String::from_utf8_lossy(&out.stderr).contains("summarize_text"));
        failure(out, expected);
        assert!(!dir.path().join("ir.json").exists());
    }
    let dir = tempfile::tempdir().unwrap();
    tutorial(dir.path());
    let path = dir.path().join("profile.yml");
    let text = fs::read_to_string(&path)
        .unwrap()
        .replace("Return plain text.", "Return {{project_name}}.");
    fs::write(path, text).unwrap();
    failure(compile(dir.path()), "requires context");
}

#[test]
fn actual_prepared_context_satisfies_the_documented_predicate() {
    let dir = tempfile::tempdir().unwrap();
    full(dir.path());
    let component_path = dir.path().join("components/summarize_text/component.yml");
    let text = fs::read_to_string(&component_path).unwrap();
    fs::write(
        component_path,
        text + "context_precondition:\n  - predicate: has_metric\n",
    )
    .unwrap();
    failure(compile(dir.path()), "requires context");
    write(dir.path(), "profile.yml", &block("context-profile.yml"));
    write(
        dir.path(),
        "context/binding.yml",
        &block("context/binding.yml"),
    );
    fs::copy(
        repo().join("examples/demo-agent/context/context.json"),
        dir.path().join("context/context.json"),
    )
    .unwrap();
    let value = ir(dir.path());
    assert!(!value["context_binding"]["resolved"]["metrics"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        value["components"][0]["precondition_result"]["checks"][0]["outcome"],
        "pass"
    );
    success(emit(dir.path(), "claude-code:headless"));
}

#[test]
fn ambiguous_or_unsafe_shorthand_fails_without_overwriting_ir() {
    for entry in [
        "{ id: summarize_text, use: summarize_text, prompt: hello }",
        "{ id: summarize_text, prompt: hello, type: mutating }",
        "{ id: summarize_text, prompt: hello, required_capabilities: [sql_execution] }",
        "{ id: summarize_text, prompt: hello, config: {} }",
        "{ id: summarize_text, prompt: hello, entrypoint: false }",
        "{ id: summarize_text, prompt: '' }",
        "{ id: '../escape', prompt: hello }",
        "{ use: summarize_text, promtp: hello }",
    ] {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "profile.yml",
            &format!("profile: text-helper\ncomponents:\n  - {entry}\n"),
        );
        write(dir.path(), "ir.json", "previous artifact");
        assert!(!compile(dir.path()).status.success(), "{entry}");
        assert_eq!(
            fs::read_to_string(dir.path().join("ir.json")).unwrap(),
            "previous artifact"
        );
    }
    let dir = tempfile::tempdir().unwrap();
    full(dir.path());
    let path = dir.path().join("components/summarize_text/component.yml");
    let text = fs::read_to_string(&path).unwrap().replace(
        "    prompt: |",
        "    prompt_ref: steps/missing.md\n    prompt: |",
    );
    fs::write(path, text).unwrap();
    failure(compile(dir.path()), "exactly one");
}

#[test]
fn context_free_unsupported_shapes_and_targets_refuse_before_output() {
    for addition in [
        "required_capabilities: [llm:cheap, human_approval]\n",
        "required_capabilities: [llm:cheap, sql_execution]\n",
    ] {
        let dir = tempfile::tempdir().unwrap();
        full(dir.path());
        let path = dir.path().join("components/summarize_text/component.yml");
        let text = fs::read_to_string(&path)
            .unwrap()
            .replace("required_capabilities: [llm:cheap]\n", addition);
        fs::write(path, text).unwrap();
        ir(dir.path());
        failure(emit(dir.path(), "claude-code:headless"), "context-free");
        assert!(!dir.path().join("agent").exists());
    }
    let dir = tempfile::tempdir().unwrap();
    tutorial(dir.path());
    ir(dir.path());
    failure(emit(dir.path(), "codex:interactive"), "context-free");
    failure(
        emit(dir.path(), "vercel"),
        "context-free IR is not supported by vercel",
    );
    assert!(!dir.path().join("agent").exists());
}

#[test]
fn old_ir_and_mixed_context_absence_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    tutorial(dir.path());
    let original = ir(dir.path());
    let mut old = original.clone();
    old["warble_ir_version"] = "0.8".into();
    fs::write(
        dir.path().join("ir.json"),
        serde_json::to_vec(&old).unwrap(),
    )
    .unwrap();
    failure(
        emit(dir.path(), "claude-code:headless"),
        "unsupported warble_ir_version",
    );
    for component in [false, true] {
        let mut missing = original.clone();
        let object = if component {
            &mut missing["components"][0]
        } else {
            &mut missing
        };
        object.as_object_mut().unwrap().remove("context_binding");
        fs::write(
            dir.path().join("ir.json"),
            serde_json::to_vec(&missing).unwrap(),
        )
        .unwrap();
        failure(
            emit(dir.path(), "claude-code:headless"),
            "missing field `context_binding`",
        );
    }
    let mut mixed = original;
    mixed["components"][0]["context_binding"] =
        serde_json::json!({"project":"real", "binding_mode":"runtime_selected"});
    fs::write(
        dir.path().join("ir.json"),
        serde_json::to_vec(&mixed).unwrap(),
    )
    .unwrap();
    failure(emit(dir.path(), "claude-code:headless"), "must agree");
    assert!(!dir.path().join("agent").exists());
}

#[test]
fn stale_context_injection_cannot_add_semantic_framing_to_context_free_ir() {
    use warble_claude_code::{
        emit_claude_code_with_context, ContextInjection, HybridRealization, ModelConfig,
        DEFAULT_CONTEXT_INJECTION, DEFAULT_RENDER_FLAVOR,
    };
    let dir = tempfile::tempdir().unwrap();
    tutorial(dir.path());
    let simple: warble_claude_code::ir::WarbleIr = serde_json::from_value(ir(dir.path())).unwrap();
    let bound = serde_json::from_slice(
        &fs::read(repo().join("examples/demo-agent/ir.golden.json")).unwrap(),
    )
    .unwrap();
    let stale = ContextInjection::from_ir(&bound, DEFAULT_CONTEXT_INJECTION);
    let out = dir.path().join("agent");
    let error = emit_claude_code_with_context(
        &simple,
        &out,
        "claude-code:headless",
        DEFAULT_RENDER_FLAVOR,
        &ModelConfig::default(),
        HybridRealization::default(),
        &stale,
    )
    .unwrap_err();
    assert!(error.to_string().contains("context injection must agree"));
    assert!(!out.exists());
}

#[test]
fn compile_parse_errors_keep_the_profile_path() {
    for text in [
        "profile: helper\ncomponents: 3\n",
        "profile: helper\ncomponents: [\n",
    ] {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "profile.yml", text);
        let expected = format!(
            "failed to parse {}:",
            dir.path().join("profile.yml").display()
        );
        failure(compile(dir.path()), &expected);
        let error = warble_cli::compile_project_to_ir(dir.path()).unwrap_err();
        assert!(error.contains(&expected), "{error}");
        assert!(!dir.path().join("ir.json").exists());
    }
}

#[test]
fn missing_description_uses_a_neutral_native_fallback() {
    for target in ["claude-code:headless", "claude-code:interactive"] {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "profile.yml", "profile: helper\ncomponents:\n  - id: helper\n    prompt: Do not copy this prompt into the description.\n");
        ir(dir.path());
        success(emit(dir.path(), target));
        let agent = fs::read_to_string(dir.path().join("agent/.claude/agents/helper.md")).unwrap();
        let front: serde_yaml::Value =
            serde_yaml::from_str(agent.split("---").nth(1).unwrap()).unwrap();
        assert_eq!(
            front["description"].as_str().unwrap(),
            "Follow the authored instructions for this component."
        );
        assert!(agent.contains("---\n\n## respond"), "{agent}");
    }
}

#[test]
fn runtime_injected_params_do_not_require_context_but_native_files_refuse_them() {
    let dir = tempfile::tempdir().unwrap();
    full(dir.path());
    let path = dir.path().join("components/summarize_text/component.yml");
    let text = fs::read_to_string(&path).unwrap();
    fs::write(
        path,
        format!("{text}\nparams:\n  - {{ name: connection, source: runtime-injected }}\n"),
    )
    .unwrap();
    let value = ir(dir.path());
    assert!(value["context_binding"].is_null());
    assert_eq!(
        value["components"][0]["params"][0]["source"],
        "runtime-injected"
    );
    for target in ["claude-code:headless", "claude-code:interactive"] {
        failure(
            emit(dir.path(), target),
            "runtime-injected parameter 'connection' is not supported",
        );
        assert!(!dir.path().join("agent").exists());
    }
}

#[test]
fn vercel_distinguishes_null_missing_and_malformed_context_bindings() {
    let dir = tempfile::tempdir().unwrap();
    tutorial(dir.path());
    let original = ir(dir.path());
    let binding = serde_json::json!({"project": "example", "binding_mode": "runtime_selected"});
    for component in [false, true] {
        for (value, expected) in [
            (
                Some(serde_json::Value::Null),
                "context-free IR is not supported by vercel",
            ),
            (None, "missing field `context_binding`"),
            (Some(serde_json::json!({})), "missing field `project`"),
        ] {
            let mut input = original.clone();
            input["context_binding"] = binding.clone();
            input["components"][0]["context_binding"] = binding.clone();
            let owner = if component {
                &mut input["components"][0]
            } else {
                &mut input
            };
            match value {
                Some(value) => {
                    owner["context_binding"] = value;
                }
                None => {
                    owner.as_object_mut().unwrap().remove("context_binding");
                }
            }
            fs::write(
                dir.path().join("ir.json"),
                serde_json::to_vec(&input).unwrap(),
            )
            .unwrap();
            failure(emit(dir.path(), "vercel"), expected);
            assert!(!dir.path().join("agent").exists());
        }
    }
}
