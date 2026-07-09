use std::collections::HashMap;
use std::fs;
use std::path::Path;

use warble::{BindingFile, ComponentFile, ProfileFile};

fn compile_project(project_dir: &Path) -> Result<serde_json::Value, String> {
    let profile: ProfileFile =
        serde_yaml::from_str(&fs::read_to_string(project_dir.join("profile.yml")).unwrap())
            .unwrap();

    let binding_path = project_dir.join(&profile.context.project);
    let binding: BindingFile =
        serde_yaml::from_str(&fs::read_to_string(&binding_path).unwrap()).unwrap();

    let resolved_project_path = project_dir.join(&binding.project);
    let project_precondition_ok =
        resolved_project_path.is_dir() && resolved_project_path.join("wren_project.yml").is_file();

    let mut components: HashMap<String, ComponentFile> = HashMap::new();
    let mut step_contents: HashMap<String, HashMap<String, String>> = HashMap::new();

    for mount in &profile.components {
        let component_dir = project_dir.join("components").join(&mount.use_id);
        let component: ComponentFile =
            serde_yaml::from_str(&fs::read_to_string(component_dir.join("component.yml")).unwrap())
                .unwrap();

        let mut steps = HashMap::new();
        for step in &component.llm_steps {
            let content = fs::read_to_string(component_dir.join(&step.prompt_ref)).unwrap();
            steps.insert(step.name.clone(), content);
        }
        step_contents.insert(component.id.clone(), steps);
        components.insert(component.id.clone(), component);
    }

    warble::compile(
        &profile,
        &components,
        &binding.project,
        project_precondition_ok,
        &step_contents,
    )
    .map_err(|e| e.to_string())
}

#[test]
fn golden_demo_agent_matches_exactly() {
    let project_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../demo-agent");
    let ir = compile_project(&project_dir).expect("demo-agent must compile");

    let golden: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(project_dir.join("ir.golden.json")).unwrap())
            .unwrap();

    assert_eq!(ir, golden, "compiled IR must equal ir.golden.json");

    let ir_prompt = ir["components"][0]["prompt_fragment"].as_str().unwrap();
    let golden_prompt = golden["components"][0]["prompt_fragment"].as_str().unwrap();
    assert_eq!(
        ir_prompt, golden_prompt,
        "prompt_fragment must match character-for-character"
    );

    let llm_calls = ir["components"][0]["llm_calls"].as_array().unwrap();
    for call in llm_calls {
        assert!(
            !call["prompt"].as_str().unwrap().is_empty(),
            "llm_calls[].prompt must be non-empty: {call}"
        );
    }
    let compose_layout = llm_calls
        .iter()
        .find(|call| call["name"] == "compose_layout")
        .expect("compose_layout call must be present");
    assert_eq!(
        compose_layout["consumes"],
        serde_json::json!(["query_plan"])
    );
    assert_eq!(
        compose_layout["produces"],
        serde_json::json!("dashboard_summary")
    );

    let render_blocks = ir["components"][0]["effect"]["render_blocks"]
        .as_array()
        .unwrap();
    assert_eq!(
        render_blocks,
        &vec![
            serde_json::json!({ "type": "chart", "fields": {} }),
            serde_json::json!({ "type": "table", "fields": {} }),
            serde_json::json!({ "type": "kpi_card", "fields": {} }),
        ],
        "bare-string render_blocks must normalize to typed objects with empty fields"
    );
}

#[test]
fn golden_render_demo_matches_exactly() {
    let project_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../render-demo");
    let ir = compile_project(&project_dir).expect("render-demo must compile");

    let golden: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(project_dir.join("ir.golden.json")).unwrap())
            .unwrap();

    assert_eq!(ir, golden, "compiled IR must equal ir.golden.json");

    let component = &ir["components"][0];

    let render_blocks = component["effect"]["render_blocks"].as_array().unwrap();
    assert_eq!(
        render_blocks,
        &vec![
            serde_json::json!({
                "type": "kpi_card",
                "fields": { "label": "string", "value": "number", "unit": "string?" }
            }),
            serde_json::json!({
                "type": "table",
                "fields": { "columns": "string[]", "rows": "row[]" }
            }),
            serde_json::json!({
                "type": "chart",
                "fields": { "chart_type": "string", "x": "string", "series": "string[]", "rows": "row[]" }
            }),
        ],
        "typed render_blocks must be normalized as authored"
    );

    let guardrails = component["guardrails"].as_array().unwrap();
    assert_eq!(
        guardrails,
        &vec![
            serde_json::json!({ "name": "read_only_execution", "locked": true }),
            serde_json::json!({ "name": "artifact_write", "locked": true, "scope": "." }),
        ],
        "artifact_write guardrail must carry its scope through unchanged"
    );

    let required_capabilities = component["required_capabilities"].as_array().unwrap();
    for capability in ["render_contract", "artifact_write"] {
        assert!(
            required_capabilities.contains(&serde_json::json!(capability)),
            "required_capabilities must contain '{capability}': {required_capabilities:?}"
        );
    }
}

/// Writes a minimal Warble project into `dir` with one component whose single param has
/// `bind: required`. `bind_block` is inlined verbatim under the profile's component mount
/// entry (empty string omits the `bind:` map entirely, exercising the missing-bind case).
fn write_required_bind_fixture(dir: &Path, bind_block: &str) {
    fs::create_dir_all(dir.join("context")).unwrap();
    fs::create_dir_all(dir.join("components/needs_bind/steps")).unwrap();
    fs::create_dir_all(dir.join("wren_project")).unwrap();
    fs::write(
        dir.join("wren_project/wren_project.yml"),
        "schema_version: 2\n",
    )
    .unwrap();

    fs::write(
        dir.join("profile.yml"),
        format!(
            "profile: fixture\ncontext:\n  project: ./context/binding.yml\nconfig:\n  tier_policy: null\ncomponents:\n  - use: needs_bind\n{bind_block}"
        ),
    )
    .unwrap();
    fs::write(dir.join("context/binding.yml"), "project: ./wren_project\n").unwrap();
    fs::write(
        dir.join("components/needs_bind/component.yml"),
        r#"
id: needs_bind
verb: needs_bind
type: analytical
realization_kind: skill
binding_mode: runtime_selected
params:
  - { name: topic, bind: required }
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
required_capabilities: []
borrowed_actions: []
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    )
    .unwrap();
    fs::write(
        dir.join("components/needs_bind/steps/only_step.md"),
        "Do the thing.\n",
    )
    .unwrap();
}

#[test]
fn missing_required_bind_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_required_bind_fixture(dir.path(), "");

    let err = compile_project(dir.path()).expect_err("missing required bind must fail");
    assert!(
        err.contains("missing required bind 'topic' for component 'needs_bind'"),
        "unexpected error: {err}"
    );
}

#[test]
fn supplied_required_bind_compiles() {
    let dir = tempfile::tempdir().unwrap();
    write_required_bind_fixture(dir.path(), "    bind:\n      topic: \"orders\"\n");

    compile_project(dir.path()).expect("bind is supplied, compile should succeed");
}

#[test]
fn locked_guardrail_override_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_required_bind_fixture(
        dir.path(),
        "    bind:\n      topic: \"orders\"\n    guardrails:\n      read_only_execution:\n        locked: false\n",
    );

    let err = compile_project(dir.path()).expect_err("locked guardrail override must fail");
    assert!(
        err.contains(
            "cannot override locked guardrail 'read_only_execution' on component 'needs_bind'"
        ),
        "unexpected error: {err}"
    );
}

#[test]
fn precondition_failure_on_missing_wren_project_file() {
    let dir = tempfile::tempdir().unwrap();
    write_required_bind_fixture(dir.path(), "    bind:\n      topic: \"orders\"\n");
    // Point the binding at a directory that has no wren_project.yml.
    fs::create_dir_all(dir.path().join("not_a_wren_project")).unwrap();
    fs::write(
        dir.path().join("context/binding.yml"),
        "project: ./not_a_wren_project\n",
    )
    .unwrap();

    let err = compile_project(dir.path()).expect_err("missing wren_project.yml must fail");
    assert!(
        err.contains("context precondition failed:") && err.contains("is not a wren project"),
        "unexpected error: {err}"
    );
}
