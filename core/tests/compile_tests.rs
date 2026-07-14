use std::collections::HashMap;
use std::fs;
use std::path::Path;

use warble::{
    Additivity, BindingFile, ComponentFile, ContextLoader, DimensionInfo, LineageGraph, MetricInfo,
    ModelInfo, ProfileFile,
};

/// A controllable in-test [`ContextLoader`] so the core compile tests can drive precondition
/// evaluation without the MDL adapter (which lives in the binding layer). Defaults to a parseable,
/// empty context; builder methods add metrics/dimensions. End-to-end compilation against a real
/// MDL project is covered by the golden tests in the `warble-cli` crate.
#[derive(Default)]
struct FakeContext {
    parseable_flag: bool,
    metrics: Vec<MetricInfo>,
    dimensions: Vec<DimensionInfo>,
    time_dimensions: Vec<DimensionInfo>,
    models: Vec<ModelInfo>,
    lineage: LineageGraph,
}

impl FakeContext {
    fn parseable() -> Self {
        Self {
            parseable_flag: true,
            ..Default::default()
        }
    }
    fn unparseable() -> Self {
        Self::default()
    }
    fn with_metric(mut self, name: &str, declared: bool, additivity: Option<Additivity>) -> Self {
        self.metrics.push(MetricInfo {
            name: name.into(),
            owner: "m".into(),
            declared,
            additivity,
        });
        self
    }
    fn with_dimension(mut self, name: &str, temporal: bool) -> Self {
        let dim = DimensionInfo {
            name: name.into(),
            owner: "m".into(),
            is_temporal: temporal,
        };
        if temporal {
            self.time_dimensions.push(dim.clone());
        }
        self.dimensions.push(dim);
        self
    }
}

impl ContextLoader for FakeContext {
    fn is_parseable(&self) -> bool {
        self.parseable_flag
    }
    fn metrics(&self) -> &[MetricInfo] {
        &self.metrics
    }
    fn dimensions(&self) -> &[DimensionInfo] {
        &self.dimensions
    }
    fn time_dimensions(&self) -> &[DimensionInfo] {
        &self.time_dimensions
    }
    fn models(&self) -> &[ModelInfo] {
        &self.models
    }
    fn lineage(&self) -> &LineageGraph {
        &self.lineage
    }
}

/// Compile a fixture project with a default parseable, empty context. Mechanical tests (bind,
/// guardrail, param, vocab) don't touch preconditions, so an empty context suffices.
fn compile_project(project_dir: &Path) -> Result<serde_json::Value, String> {
    compile_project_with(project_dir, &FakeContext::parseable())
}

/// Compile a fixture project with an explicit injected context (for precondition-evaluation tests).
fn compile_project_with(
    project_dir: &Path,
    context: &dyn ContextLoader,
) -> Result<serde_json::Value, String> {
    let profile: ProfileFile =
        serde_yaml::from_str(&fs::read_to_string(project_dir.join("profile.yml")).unwrap())
            .unwrap();

    let binding_path = project_dir.join(&profile.context.project);
    let binding: BindingFile =
        serde_yaml::from_str(&fs::read_to_string(&binding_path).unwrap()).unwrap();

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
        context,
        &step_contents,
    )
    .map_err(|e| e.to_string())
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
fn unparseable_context_fails_loudly() {
    // The coarse floor: an unparseable bound project loud-fails before any per-component work.
    let dir = tempfile::tempdir().unwrap();
    write_required_bind_fixture(dir.path(), "    bind:\n      topic: \"orders\"\n");

    let err = compile_project_with(dir.path(), &FakeContext::unparseable())
        .expect_err("unparseable context must fail");
    assert!(
        err.contains("is not a parseable wren project"),
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

/// Builds a single-component fixture body declaring exactly the given `context_precondition` block
/// (inlined verbatim), so precondition-evaluation tests can control the predicates.
fn precondition_component(id: &str, precondition_block: &str) -> String {
    format!(
        r#"
id: {id}
verb: {id}
type: analytical
realization_kind: skill
binding_mode: runtime_selected
context_precondition:
{precondition_block}
llm_steps:
  - {{ name: only_step, tier: cheap, prompt_ref: steps/only_step.md }}
trigger: {{ kind: one_shot }}
guardrails:
  - {{ name: read_only_execution, locked: true }}
effect:
  render_blocks: []
  outcome: {{ kind: none }}
"#
    )
}

#[test]
fn precondition_pass_records_structured_check() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "needs_metric",
        &precondition_component("needs_metric", "  - { predicate: has_metric }"),
    );

    let ctx =
        FakeContext::parseable().with_metric("total_revenue", true, Some(Additivity::Additive));
    let ir = compile_project_with(dir.path(), &ctx).expect("has_metric is satisfied");
    assert_eq!(
        ir["components"][0]["precondition_result"]["checks"],
        serde_json::json!([{ "predicate": "has_metric", "outcome": "pass" }]),
        "a satisfied precondition is recorded as a structured pass check"
    );
    // v0.3 marker + fine-grained resolved binding present.
    assert_eq!(ir["warble_ir_version"], "0.3");
    assert_eq!(
        ir["context_binding"]["resolved"]["metrics"][0]["name"],
        "total_revenue"
    );
}

#[test]
fn precondition_false_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "needs_metric",
        &precondition_component("needs_metric", "  - { predicate: has_metric }"),
    );

    // Empty context: no metrics ⇒ has_metric is answerable but false.
    let err = compile_project_with(dir.path(), &FakeContext::parseable())
        .expect_err("has_metric must fail on a project with no metrics");
    assert!(err.contains("not satisfied"), "unexpected error: {err}");
}

#[test]
fn metric_additive_unanswerable_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "needs_additive",
        &precondition_component("needs_additive", "  - { predicate: metric_additive }"),
    );

    // Only an implicit (undeclared) metric: additivity is not expressible ⇒ can_answer=false.
    let ctx = FakeContext::parseable().with_metric("amount", false, None);
    let err = compile_project_with(dir.path(), &ctx)
        .expect_err("metric_additive must be unanswerable without a declared metric");
    assert!(
        err.contains("cannot be evaluated") && err.contains("additivity"),
        "unexpected error (expected the can_answer=false loud-fail): {err}"
    );
}

#[test]
fn metric_additive_existential_passes_with_an_additive_metric() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "needs_additive",
        &precondition_component("needs_additive", "  - { predicate: metric_additive }"),
    );

    // A declared additive measure exists (plus a non-additive one) ⇒ existential pass.
    let ctx = FakeContext::parseable()
        .with_metric("total_revenue", true, Some(Additivity::Additive))
        .with_metric("avg_order", true, Some(Additivity::NonAdditive));
    compile_project_with(dir.path(), &ctx).expect("an additive declared metric satisfies it");
}

#[test]
fn metric_additive_pinned_to_nonadditive_metric_fails() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "needs_additive",
        &precondition_component(
            "needs_additive",
            "  - { predicate: metric_additive, args: { metric: avg_order } }",
        ),
    );

    // Pinned to a declared but non-additive metric ⇒ answerable-and-false loud-fail.
    let ctx =
        FakeContext::parseable().with_metric("avg_order", true, Some(Additivity::NonAdditive));
    let err =
        compile_project_with(dir.path(), &ctx).expect_err("a non-additive pinned metric must fail");
    assert!(err.contains("not satisfied"), "unexpected error: {err}");
}

#[test]
fn time_dimension_predicate_evaluates() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "needs_time",
        &precondition_component("needs_time", "  - { predicate: has_time_dimension }"),
    );

    // No time dimension ⇒ fail.
    let err = compile_project_with(dir.path(), &FakeContext::parseable())
        .expect_err("has_time_dimension must fail with no time dimension");
    assert!(err.contains("not satisfied"), "unexpected error: {err}");

    // With a temporal dimension ⇒ pass.
    let ctx = FakeContext::parseable().with_dimension("order_date", true);
    compile_project_with(dir.path(), &ctx).expect("a temporal dimension satisfies it");
}

#[test]
fn unknown_precondition_predicate_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "precon_test",
        &precondition_component("precon_test", "  - { predicate: not_a_real_predicate }"),
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
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md, conditional: true,
      when: { guard: on_failure, target: some_upstream_step } }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let ir =
        compile_project(dir.path()).expect("conditional step with a when guard should compile");
    assert_eq!(
        ir["components"][0]["llm_calls"][0]["conditional"],
        serde_json::json!(true)
    );
    assert_eq!(
        ir["components"][0]["llm_calls"][0]["when"],
        serde_json::json!({ "guard": "on_failure", "target": "some_upstream_step" })
    );
}

#[test]
fn bare_conditional_without_when_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "bare_conditional_test",
        r#"
id: bare_conditional_test
verb: bare_conditional_test
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

    let err =
        compile_project(dir.path()).expect_err("bare conditional with no when must loud-fail");
    assert!(
        err.contains("has no 'when' guard"),
        "unexpected error: {err}"
    );
}

#[test]
fn when_guard_without_conditional_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "when_without_conditional_test",
        r#"
id: when_without_conditional_test
verb: when_without_conditional_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md,
      when: { guard: on_failure, target: some_step } }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let err =
        compile_project(dir.path()).expect_err("when guard without conditional must loud-fail");
    assert!(
        err.contains("is not 'conditional: true'"),
        "unexpected error: {err}"
    );
}

#[test]
fn unknown_guard_name_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "unknown_guard_test",
        r#"
id: unknown_guard_test
verb: unknown_guard_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md, conditional: true,
      when: { guard: on_vibes, target: some_step } }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let err = compile_project(dir.path()).expect_err("unknown guard name must loud-fail");
    assert!(
        err.contains("unknown guard 'on_vibes'"),
        "unexpected error: {err}"
    );
}

#[test]
fn on_flag_guard_requires_dotted_target() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "on_flag_bad_target_test",
        r#"
id: on_flag_bad_target_test
verb: on_flag_bad_target_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md, conditional: true,
      when: { guard: on_flag, target: no_dot_here } }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let err =
        compile_project(dir.path()).expect_err("on_flag with a non-dotted target must loud-fail");
    assert!(err.contains("expects a dotted"), "unexpected error: {err}");
}

#[test]
fn on_missing_guard_is_valid() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "on_missing_test",
        r#"
id: on_missing_test
verb: on_missing_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md, conditional: true,
      when: { guard: on_missing, target: some_artifact } }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let ir = compile_project(dir.path()).expect("on_missing guard should compile");
    assert_eq!(
        ir["components"][0]["llm_calls"][0]["when"],
        serde_json::json!({ "guard": "on_missing", "target": "some_artifact" })
    );
}

#[test]
fn unconditional_step_emits_null_when() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "unconditional_when_test",
        r#"
id: unconditional_when_test
verb: unconditional_when_test
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
"#,
    );

    let ir = compile_project(dir.path()).expect("unconditional step with no when should compile");
    assert_eq!(
        ir["components"][0]["llm_calls"][0]["when"],
        serde_json::json!(null)
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
