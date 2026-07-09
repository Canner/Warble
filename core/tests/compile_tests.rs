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
    let project_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/demo-agent");
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
    let project_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/render-demo");
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

#[test]
fn golden_genbi_default_matches_exactly() {
    let project_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../genbi-default");
    let ir = compile_project(&project_dir).expect("genbi-default must compile");

    let golden: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(project_dir.join("ir.golden.json")).unwrap())
            .unwrap();

    assert_eq!(ir, golden, "compiled IR must equal ir.golden.json");

    // The flagship profile mounts the four Phase 1.2 GenBI components, in order.
    let components = ir["components"].as_array().unwrap();
    let verbs: Vec<&str> = components
        .iter()
        .map(|c| c["verb"].as_str().unwrap())
        .collect();
    assert_eq!(
        verbs,
        vec![
            "explore_model",
            "answer_query",
            "generate_dashboard",
            "explain_change"
        ]
    );

    let by_verb = |verb: &str| -> &serde_json::Value {
        components
            .iter()
            .find(|c| c["verb"] == verb)
            .unwrap_or_else(|| panic!("component '{verb}' must be present"))
    };

    // explore_model: requires the new semantic_introspection capability and renders nothing.
    let explore = by_verb("explore_model");
    assert!(explore["required_capabilities"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("semantic_introspection")));
    assert_eq!(
        explore["effect"]["render_blocks"],
        serde_json::json!([]),
        "explore_model feeds other components; it renders no UI"
    );

    // answer_query: the 3-step canonical version with repair_sql conditional.
    let answer = by_verb("answer_query");
    let repair = answer["llm_calls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "repair_sql")
        .expect("repair_sql step must be present");
    assert_eq!(repair["conditional"], serde_json::json!(true));
    assert_eq!(
        answer["effect"]["render_blocks"],
        serde_json::json!([{ "type": "table", "fields": {} }])
    );

    // generate_dashboard: the locked render contract (typed blocks) + artifact_write guardrail.
    let dashboard = by_verb("generate_dashboard");
    assert_eq!(
        dashboard["effect"]["render_blocks"],
        serde_json::json!([
            { "type": "kpi_card", "fields": { "label": "string", "value": "number|string", "unit": "string?", "delta": "number?" } },
            { "type": "table", "fields": { "columns": "string[]", "rows": "row[]" } },
            { "type": "chart", "fields": { "chart_type": "bar|line|pie|area|scatter", "x": "string", "series": "string[]", "rows": "row[]" } },
        ]),
        "generate_dashboard locks the typed render-block contract"
    );
    assert!(dashboard["guardrails"]
        .as_array()
        .unwrap()
        .iter()
        .any(|g| g["name"] == "artifact_write" && g["locked"] == true && g["scope"] == "."));

    // explain_change: additivity precondition carried (declared, not evaluated) + narrative block.
    let explain = by_verb("explain_change");
    assert_eq!(
        explain["context_precondition"],
        serde_json::json!([
            { "predicate": "metric_additive" },
            { "predicate": "has_time_dimension" },
            { "predicate": "has_groupable_dimension" },
        ]),
        "explain_change carries the additivity + shape preconditions into the IR"
    );
    assert_eq!(
        explain["effect"]["render_blocks"],
        serde_json::json!([{ "type": "narrative", "fields": { "title": "string?", "text": "string" } }]),
        "explain_change declares the new narrative render block"
    );
}

#[test]
fn golden_mini_agent_matches_exactly() {
    let project_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/mini-agent");
    let ir = compile_project(&project_dir).expect("mini-agent must compile");

    let golden: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(project_dir.join("ir.golden.json")).unwrap())
            .unwrap();

    assert_eq!(ir, golden, "compiled IR must equal ir.golden.json");

    // mini-agent is the v0.2-schema smoke fixture: assert each new authoring field survives compile.
    let component = &ir["components"][0];
    assert_eq!(
        component["context_precondition"],
        serde_json::json!([{ "predicate": "wren_project_exists" }]),
        "structured context_precondition predicate must be carried into the IR"
    );
    assert_eq!(
        component["params"],
        serde_json::json!([
            { "name": "style", "bind": "optional", "default": "concise" },
            { "name": "model_binding", "source": "runtime-injected" },
        ]),
        "bind and runtime-injected params must both be carried, verbatim"
    );
    assert_eq!(
        component["guardrails"],
        serde_json::json!([
            { "name": "read_only_execution", "locked": true },
            { "name": "verbosity", "locked": false },
        ]),
        "overridable guardrail must normalize to locked:false"
    );
    assert_eq!(
        component["eval"],
        serde_json::json!({ "template_ref": "eval/", "metrics": ["correctness"] }),
        "structured eval block must be carried into the IR"
    );
    assert_eq!(
        component["llm_calls"][0]["conditional"],
        serde_json::json!(false),
        "llm_calls must carry the conditional flag (default false)"
    );
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

/// Writes a minimal Warble project into `dir` mounting a single component whose `component.yml`
/// body is exactly `component_yaml`. Mirrors `write_required_bind_fixture`'s scaffolding but lets
/// each test control the full component body (id/verb/params/guardrails/etc.) directly. Every
/// `llm_steps` entry must reference `steps/only_step.md`, which this fixture always writes.
fn write_component_fixture(dir: &Path, component_id: &str, component_yaml: &str) {
    fs::create_dir_all(dir.join("context")).unwrap();
    fs::create_dir_all(dir.join(format!("components/{component_id}/steps"))).unwrap();
    fs::create_dir_all(dir.join("wren_project")).unwrap();
    fs::write(
        dir.join("wren_project/wren_project.yml"),
        "schema_version: 2\n",
    )
    .unwrap();
    fs::write(
        dir.join("profile.yml"),
        format!(
            "profile: fixture\ncontext:\n  project: ./context/binding.yml\nconfig:\n  tier_policy: null\ncomponents:\n  - use: {component_id}\n"
        ),
    )
    .unwrap();
    fs::write(dir.join("context/binding.yml"), "project: ./wren_project\n").unwrap();
    fs::write(
        dir.join(format!("components/{component_id}/component.yml")),
        component_yaml,
    )
    .unwrap();
    fs::write(
        dir.join(format!("components/{component_id}/steps/only_step.md")),
        "Do the thing.\n",
    )
    .unwrap();
}

#[test]
fn unknown_precondition_predicate_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "precon_test",
        r#"
id: precon_test
verb: precon_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
context_precondition:
  - { predicate: not_a_real_predicate }
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let err = compile_project(dir.path()).expect_err("unknown precondition predicate must fail");
    assert!(
        err.contains("unknown context_precondition predicate"),
        "unexpected error: {err}"
    );
}

#[test]
fn source_param_is_carried_into_ir() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "source_param_test",
        r#"
id: source_param_test
verb: source_param_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
params:
  - { name: connection, source: runtime-injected }
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let ir = compile_project(dir.path()).expect("source param should compile");
    let params = ir["components"][0]["params"].as_array().unwrap();
    assert_eq!(
        params,
        &vec![serde_json::json!({ "name": "connection", "source": "runtime-injected" })],
        "source param must be carried into IR params verbatim: {params:?}"
    );
}

#[test]
fn param_with_both_bind_and_source_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "both_test",
        r#"
id: both_test
verb: both_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
params:
  - { name: topic, bind: optional, source: runtime-injected }
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let err = compile_project(dir.path()).expect_err("bind + source must fail");
    assert!(err.contains("declares both"), "unexpected error: {err}");
}

#[test]
fn param_with_neither_bind_nor_source_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "neither_test",
        r#"
id: neither_test
verb: neither_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
params:
  - { name: topic }
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let err = compile_project(dir.path()).expect_err("neither bind nor source must fail");
    assert!(err.contains("declares neither"), "unexpected error: {err}");
}

#[test]
fn param_with_unknown_source_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "unknown_source_test",
        r#"
id: unknown_source_test
verb: unknown_source_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
params:
  - { name: topic, source: some-other-source }
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let err = compile_project(dir.path()).expect_err("unknown source value must fail");
    assert!(err.contains("unknown source"), "unexpected error: {err}");
}

#[test]
fn conditional_llm_step_is_carried_into_ir() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "conditional_test",
        r#"
id: conditional_test
verb: conditional_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md, conditional: true }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let ir = compile_project(dir.path()).expect("conditional step should compile");
    assert_eq!(
        ir["components"][0]["llm_calls"][0]["conditional"],
        serde_json::json!(true)
    );
}

#[test]
fn authored_eval_block_is_carried_into_ir() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "eval_test",
        r#"
id: eval_test
verb: eval_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
eval:
  template_ref: eval/
  metrics: [accuracy]
"#,
    );

    let ir = compile_project(dir.path()).expect("component with eval should compile");
    assert_eq!(
        ir["components"][0]["eval"],
        serde_json::json!({ "template_ref": "eval/", "metrics": ["accuracy"] })
    );
}

#[test]
fn component_file_rejects_unknown_fields() {
    let yaml = r#"
id: bad
verb: bad
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
totally_unknown_field: true
"#;

    let err = serde_yaml::from_str::<ComponentFile>(yaml)
        .expect_err("unknown field must be rejected at parse time");
    assert!(
        err.to_string().contains("unknown field"),
        "unexpected error: {err}"
    );
}

#[test]
fn overridable_guardrail_normalizes_to_locked_false() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "overridable_test",
        r#"
id: overridable_test
verb: overridable_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, overridable: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let ir = compile_project(dir.path()).expect("overridable guardrail should compile");
    assert_eq!(
        ir["components"][0]["guardrails"][0],
        serde_json::json!({ "name": "read_only_execution", "locked": false })
    );
}

#[test]
fn contradictory_locked_and_overridable_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "contradictory_test",
        r#"
id: contradictory_test
verb: contradictory_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true, overridable: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let err = compile_project(dir.path()).expect_err("contradictory locked/overridable must fail");
    assert!(err.contains("contradictory"), "unexpected error: {err}");
}

#[test]
fn guardrail_with_neither_locked_nor_overridable_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "no_lock_decl_test",
        r#"
id: no_lock_decl_test
verb: no_lock_decl_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let err = compile_project(dir.path()).expect_err("missing locked/overridable must fail");
    assert!(err.contains("must declare"), "unexpected error: {err}");
}
