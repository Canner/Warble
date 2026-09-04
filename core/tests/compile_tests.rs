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
    fn with_model(mut self, name: &str, has_timestamp: bool) -> Self {
        self.models.push(ModelInfo {
            name: name.into(),
            has_timestamp,
            columns: Vec::new(),
        });
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
    let mut slot_contents = warble::SlotContents::default();
    for slot in &profile.slots {
        let mut variants: HashMap<String, String> = HashMap::new();
        for (key, reference) in &slot.variants {
            let content = fs::read_to_string(project_dir.join(reference)).unwrap();
            variants.insert(key.clone(), content);
        }
        slot_contents.profile.insert(slot.name.clone(), variants);
    }

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

        let mut slots: HashMap<String, HashMap<String, String>> = HashMap::new();
        for slot in &component.slots {
            let mut variants: HashMap<String, String> = HashMap::new();
            for (key, reference) in &slot.variants {
                let content = fs::read_to_string(component_dir.join(reference)).unwrap();
                variants.insert(key.clone(), content);
            }
            slots.insert(slot.name.clone(), variants);
        }
        if !slots.is_empty() {
            slot_contents.components.insert(component.id.clone(), slots);
        }

        components.insert(component.id.clone(), component);
    }

    warble::compile(
        &profile,
        &components,
        &binding.project,
        context,
        &step_contents,
        &slot_contents,
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
            "profile: fixture\ncontext:\n  project: ./context/binding.yml\ncomponents:\n  - use: needs_bind\n{bind_block}"
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

/// Same fixture with the selector-facing fields appended to the component, so their authoring rules
/// can be exercised without a shipped profile.
fn write_selector_field_fixture(dir: &Path, selector_block: &str) {
    write_required_bind_fixture(dir, "    bind:\n      topic: \"orders\"\n");
    let path = dir.join("components/needs_bind/component.yml");
    let existing = fs::read_to_string(&path).unwrap();
    fs::write(path, format!("{existing}{selector_block}")).unwrap();
}

/// Every consumer reaches the examples through the description, so examples alone would be dropped
/// with nothing said — the failure mode this project rejects everywhere else.
#[test]
fn examples_without_a_description_fail_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_selector_field_fixture(dir.path(), "examples:\n  - \"Why did revenue drop?\"\n");

    let err = compile_project(dir.path()).expect_err("examples with no description must fail");
    assert!(
        err.contains("authors 'examples' without a 'description'"),
        "unexpected error: {err}"
    );
}

/// These fields take no placeholder substitution, deliberately: they describe the component to
/// readers with no bound project. A placeholder would therefore ship unrendered.
#[test]
fn a_placeholder_in_a_selector_field_fails_loudly() {
    for block in [
        "description: \"Survey {{project}} and report.\"\n",
        "description: \"Survey the model.\"\nexamples:\n  - \"What is in {{project_name}}?\"\n",
    ] {
        let dir = tempfile::tempdir().unwrap();
        write_selector_field_fixture(dir.path(), block);

        let err = compile_project(dir.path()).expect_err("an unrendered placeholder must fail");
        assert!(
            err.contains("placeholder") && err.contains("would never be rendered"),
            "unexpected error: {err}"
        );
    }
}

/// The paired, placeholder-free form is what authors are expected to write.
#[test]
fn a_description_with_examples_compiles() {
    let dir = tempfile::tempdir().unwrap();
    write_selector_field_fixture(
        dir.path(),
        "description: \"Answer one question about the bound model.\"\nexamples:\n  - \"How many orders?\"\n",
    );

    let ir = compile_project(dir.path()).expect("the paired form must compile");
    let node = &ir["components"][0];
    assert_eq!(
        node["description"], "Answer one question about the bound model.",
        "the authored description is emitted verbatim"
    );
    assert_eq!(node["examples"][0], "How many orders?");
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
    write_component_fixture_with_profile(dir, component_id, component_yaml, "", "");
}

/// The one fixture writer the other two delegate to. `profile_extra` is spliced in as extra
/// top-level `profile.yml` keys (e.g. a `system_prompt:` line) and `bind_block` as extra lines
/// under the component's mount entry; either may be empty. Every `llm_steps` entry must reference
/// `steps/only_step.md`, which this fixture always writes.
fn write_component_fixture_with_profile(
    dir: &Path,
    component_id: &str,
    component_yaml: &str,
    profile_extra: &str,
    bind_block: &str,
) {
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
            "profile: fixture\ncontext:\n  project: ./context/binding.yml\n{profile_extra}components:\n  - use: {component_id}\n{bind_block}"
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

/// Like `write_component_fixture`, but lets the caller supply a `bind:` block on the profile's
/// mount entry (empty string omits `bind:` entirely) — for tests exercising `$param:` resolution
/// against a mount-supplied or defaulted value.
fn write_component_fixture_with_bind(
    dir: &Path,
    component_id: &str,
    component_yaml: &str,
    bind_block: &str,
) {
    write_component_fixture_with_profile(dir, component_id, component_yaml, "", bind_block);
}

/// A `monitor_freshness`-style component body: a single `model` param (`bind: required` unless
/// `param_block` overrides it) and a `model_has_timestamp` precondition pinned to it via
/// `$param:model` — the exact shape this bug fix targets (see `hub/components/monitor_freshness`).
fn monitor_style_component(id: &str, param_block: &str) -> String {
    format!(
        r#"
id: {id}
verb: {id}
type: analytical
realization_kind: skill
binding_mode: pinned
context_precondition:
  - {{ predicate: model_has_timestamp, args: {{ model: "$param:model" }} }}
params:
{param_block}
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
    // Current IR version + fine-grained resolved binding present.
    assert_eq!(ir["warble_ir_version"], "0.7");
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
fn bind_value_resolves_into_precondition_args() {
    // A mount-supplied bind reaches the precondition's `$param:` reference, and the IR carries
    // the RESOLVED value, never the unresolved template.
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_bind(
        dir.path(),
        "monitor_style",
        &monitor_style_component("monitor_style", "  - { name: model, bind: required }"),
        "    bind:\n      model: \"orders\"\n",
    );

    let ctx = FakeContext::parseable().with_model("orders", true);
    let ir = compile_project_with(dir.path(), &ctx).expect("bound model has a timestamp");
    assert_eq!(
        ir["components"][0]["context_precondition"],
        serde_json::json!([{ "predicate": "model_has_timestamp", "args": { "model": "orders" } }]),
        "the IR must carry the resolved bind value, not the '$param:model' template"
    );
}

#[test]
fn unsupplied_optional_bind_falls_back_to_default() {
    // An optional bind the mount doesn't supply falls back to the param's declared default.
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_bind(
        dir.path(),
        "monitor_style",
        &monitor_style_component(
            "monitor_style",
            "  - { name: model, bind: optional, default: widgets }",
        ),
        "",
    );

    let ctx = FakeContext::parseable().with_model("widgets", true);
    let ir = compile_project_with(dir.path(), &ctx).expect("default model has a timestamp");
    assert_eq!(
        ir["components"][0]["context_precondition"][0]["args"]["model"],
        "widgets"
    );
    assert_eq!(ir["components"][0]["binds"]["model"], "widgets");
}

#[test]
fn unbound_optional_param_with_no_default_is_unanswerable() {
    // No mount-supplied bind and no declared default ⇒ the `$param:` reference resolves to
    // nothing, which is an unanswerable loud-fail, not a silent skip.
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_bind(
        dir.path(),
        "monitor_style",
        &monitor_style_component("monitor_style", "  - { name: model, bind: optional }"),
        "",
    );

    let err = compile_project(dir.path())
        .expect_err("an unsupplied optional bind with no default must be unanswerable");
    assert!(
        err.contains("cannot be evaluated") && err.contains("no declared default"),
        "unexpected error: {err}"
    );
}

#[test]
fn dollar_param_referencing_undeclared_param_fails_loudly() {
    // `$param:<name>` naming a param the component does not declare is a structural compile
    // error (an authoring typo), not an unanswerable predicate.
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_bind(
        dir.path(),
        "monitor_style",
        &precondition_component(
            "monitor_style",
            "  - { predicate: model_has_timestamp, args: { model: \"$param:ghost_param\" } }",
        ),
        "",
    );

    let err = compile_project(dir.path())
        .expect_err("a $param: reference to an undeclared param must loud-fail");
    assert!(
        err.contains("'ghost_param'") && err.contains("not a declared param"),
        "unexpected error: {err}"
    );
}

#[test]
fn binding_a_timestampless_model_fails_loudly_in_a_multi_model_project() {
    // The case the old existential check missed entirely — a multi-model project where the bound
    // model specifically lacks a timestamp must loud-fail, even though *some other* model in the
    // project has one.
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_bind(
        dir.path(),
        "monitor_style",
        &monitor_style_component("monitor_style", "  - { name: model, bind: required }"),
        "    bind:\n      model: \"widgets\"\n",
    );

    let ctx = FakeContext::parseable()
        .with_model("orders", true)
        .with_model("widgets", false);
    let err = compile_project_with(dir.path(), &ctx)
        .expect_err("binding a timestampless model must fail even when another model has one");
    assert!(err.contains("not satisfied"), "unexpected error: {err}");
}

#[test]
fn binding_a_nonexistent_model_no_longer_silently_passes() {
    // Binding a model that doesn't exist in the project must loud-fail (unanswerable), not
    // silently pass because some *other* declared model happens to have a timestamp.
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_bind(
        dir.path(),
        "monitor_style",
        &monitor_style_component("monitor_style", "  - { name: model, bind: required }"),
        "    bind:\n      model: \"ghost\"\n",
    );

    let ctx = FakeContext::parseable().with_model("orders", true);
    let err = compile_project_with(dir.path(), &ctx)
        .expect_err("binding a nonexistent model must fail, not silently pass");
    assert!(
        err.contains("cannot be evaluated") && err.contains("'ghost' is not a declared model"),
        "unexpected error: {err}"
    );
}

#[test]
fn model_has_timestamp_existential_fallback_is_unchanged() {
    // With no `args` at all (the pre-existing shape other profiles still use unmodified), the
    // predicate stays existential over every declared model.
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "existential_timestamp_test",
        &precondition_component(
            "existential_timestamp_test",
            "  - { predicate: model_has_timestamp }",
        ),
    );

    // No models with a timestamp ⇒ fail.
    let err = compile_project_with(
        dir.path(),
        &FakeContext::parseable().with_model("widgets", false),
    )
    .expect_err("existential model_has_timestamp must fail with no timestamped model");
    assert!(err.contains("not satisfied"), "unexpected error: {err}");

    // At least one model with a timestamp ⇒ pass, regardless of others.
    let ctx = FakeContext::parseable()
        .with_model("widgets", false)
        .with_model("orders", true);
    compile_project_with(dir.path(), &ctx)
        .expect("existential model_has_timestamp passes when any model has a timestamp");
}

#[test]
fn two_mounts_with_different_binds_produce_different_ir() {
    // Two mounts of the same component, differing only in their `bind:` value, must not produce
    // byte-identical IR.
    let dir_a = tempfile::tempdir().unwrap();
    write_component_fixture_with_bind(
        dir_a.path(),
        "monitor_style",
        &monitor_style_component("monitor_style", "  - { name: model, bind: required }"),
        "    bind:\n      model: \"orders\"\n",
    );
    let dir_b = tempfile::tempdir().unwrap();
    write_component_fixture_with_bind(
        dir_b.path(),
        "monitor_style",
        &monitor_style_component("monitor_style", "  - { name: model, bind: required }"),
        "    bind:\n      model: \"widgets\"\n",
    );

    let ctx = FakeContext::parseable()
        .with_model("orders", true)
        .with_model("widgets", true);
    let ir_a = compile_project_with(dir_a.path(), &ctx).expect("orders bind compiles");
    let ir_b = compile_project_with(dir_b.path(), &ctx).expect("widgets bind compiles");

    assert_ne!(
        ir_a["components"][0], ir_b["components"][0],
        "binding different models must produce different IR component nodes"
    );
    assert_eq!(ir_a["components"][0]["binds"]["model"], "orders");
    assert_eq!(ir_b["components"][0]["binds"]["model"], "widgets");
}

#[test]
fn runtime_injected_param_is_excluded_from_binds_facet() {
    // A `source: runtime-injected` param is never a bind — it's supplied by the runtime at
    // dispatch time, not by the profile at compile time — so it must not appear in the `binds` IR
    // facet even though it's a declared param.
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_bind(
        dir.path(),
        "monitor_style",
        &monitor_style_component(
            "monitor_style",
            "  - { name: model, bind: required }\n  - { name: connection, source: runtime-injected }",
        ),
        "    bind:\n      model: \"orders\"\n",
    );

    let ctx = FakeContext::parseable().with_model("orders", true);
    let ir =
        compile_project_with(dir.path(), &ctx).expect("compiles with a runtime-injected param");
    let binds = ir["components"][0]["binds"].as_object().unwrap();
    assert_eq!(
        binds.len(),
        1,
        "runtime-injected params must not appear in the binds facet: {binds:?}"
    );
    assert_eq!(ir["components"][0]["binds"]["model"], "orders");
}

#[test]
fn binds_facet_is_absent_when_no_bind_params_exist() {
    // The `binds` facet follows the existing optional-facet pattern — emitted only when
    // non-empty, so components with no bind-family params (or none with an effective value) must
    // not carry an empty `binds: {}` in the IR (additive-only growth, invariant #3).
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "no_binds_test",
        &precondition_component("no_binds_test", "  - { predicate: has_metric }"),
    );

    let ctx =
        FakeContext::parseable().with_metric("total_revenue", true, Some(Additivity::Additive));
    let ir = compile_project_with(dir.path(), &ctx).expect("has_metric is satisfied");
    assert!(
        ir["components"][0].get("binds").is_none(),
        "binds facet must be absent (not an empty object) when there are no bind params: {:?}",
        ir["components"][0]
    );
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
  - { name: some_upstream_step, tier: cheap, prompt_ref: steps/only_step.md }
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
        ir["components"][0]["llm_calls"][1]["conditional"],
        serde_json::json!(true)
    );
    assert_eq!(
        ir["components"][0]["llm_calls"][1]["when"],
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
  - { name: produce_it, tier: cheap, prompt_ref: steps/only_step.md, produces: some_artifact }
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
        ir["components"][0]["llm_calls"][1]["when"],
        serde_json::json!({ "guard": "on_missing", "target": "some_artifact" })
    );
}

#[test]
fn valid_cross_step_artifact_chain_compiles() {
    // A step consuming an artifact a strictly-earlier step produces must still compile — the
    // positive control for `check_step_dataflow`'s artifact-flow check.
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "valid_chain_test",
        r#"
id: valid_chain_test
verb: valid_chain_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: produce_it, tier: cheap, prompt_ref: steps/only_step.md, produces: some_artifact }
  - { name: consume_it, tier: cheap, prompt_ref: steps/only_step.md, consumes: [some_artifact] }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let ir = compile_project(dir.path())
        .expect("a step consuming a strictly-earlier step's produced artifact must compile");
    assert_eq!(
        ir["components"][0]["llm_calls"][1]["consumes"],
        serde_json::json!(["some_artifact"])
    );
}

#[test]
fn step_consuming_its_own_produces_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "self_consume_test",
        r#"
id: self_consume_test
verb: self_consume_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md, produces: some_artifact,
      consumes: [some_artifact] }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let err = compile_project(dir.path())
        .expect_err("a step consuming its own 'produces' artifact must loud-fail");
    assert!(
        err.contains("step 'only_step'")
            && err.contains("component 'self_consume_test'")
            && err.contains("consumes 'some_artifact'")
            && err.contains("its own 'produces' artifact"),
        "unexpected error: {err}"
    );
}

#[test]
fn consuming_an_artifact_nobody_produces_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "orphan_consume_test",
        r#"
id: orphan_consume_test
verb: orphan_consume_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md, consumes: [nobody_makes_this] }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let err = compile_project(dir.path())
        .expect_err("consuming an artifact no step produces must loud-fail");
    assert!(
        err.contains("step 'only_step'")
            && err.contains("component 'orphan_consume_test'")
            && err.contains("consumes 'nobody_makes_this'")
            && err.contains("which no earlier step produces"),
        "unexpected error: {err}"
    );
}

#[test]
fn consuming_a_later_steps_artifact_fails_loudly() {
    // The artifact exists in the component, but only a *later* step produces it — still not
    // "earlier", so this must be refused exactly like the produced-by-nobody case.
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "forward_reference_test",
        r#"
id: forward_reference_test
verb: forward_reference_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: consume_it, tier: cheap, prompt_ref: steps/only_step.md, consumes: [some_artifact] }
  - { name: produce_it, tier: cheap, prompt_ref: steps/only_step.md, produces: some_artifact }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let err = compile_project(dir.path())
        .expect_err("consuming a later step's produced artifact must loud-fail");
    assert!(
        err.contains("step 'consume_it'")
            && err.contains("consumes 'some_artifact'")
            && err.contains("which no earlier step produces"),
        "unexpected error: {err}"
    );
}

#[test]
fn duplicate_step_names_fail_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "duplicate_step_name_test",
        r#"
id: duplicate_step_name_test
verb: duplicate_step_name_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md }
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let err = compile_project(dir.path()).expect_err("duplicate step names must loud-fail");
    assert!(
        err.contains("duplicate step name 'only_step'")
            && err.contains("component 'duplicate_step_name_test'"),
        "unexpected error: {err}"
    );
}

#[test]
fn duplicate_produces_artifact_names_fail_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "duplicate_produces_test",
        r#"
id: duplicate_produces_test
verb: duplicate_produces_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: first_producer, tier: cheap, prompt_ref: steps/only_step.md, produces: some_artifact }
  - { name: second_producer, tier: cheap, prompt_ref: steps/only_step.md, produces: some_artifact }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let err = compile_project(dir.path())
        .expect_err("duplicate 'produces' artifact names must loud-fail");
    assert!(
        err.contains("duplicate 'produces' artifact 'some_artifact'")
            && err.contains("component 'duplicate_produces_test'")
            && err.contains("second_producer"),
        "unexpected error: {err}"
    );
}

#[test]
fn on_failure_guard_targeting_a_non_earlier_step_fails_loudly() {
    // `on_failure` targeting the step's own name (not a strictly-earlier step) — the same
    // permanently-dead-guard failure mode as an artifact-flow forward reference.
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "on_failure_not_earlier_test",
        r#"
id: on_failure_not_earlier_test
verb: on_failure_not_earlier_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md, conditional: true,
      when: { guard: on_failure, target: only_step } }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let err = compile_project(dir.path())
        .expect_err("on_failure targeting a non-strictly-earlier step must loud-fail");
    assert!(
        err.contains("guard 'on_failure'")
            && err.contains("step 'only_step'")
            && err.contains("component 'on_failure_not_earlier_test'")
            && err.contains("targets step 'only_step'")
            && err.contains("not a strictly-earlier step"),
        "unexpected error: {err}"
    );
}

#[test]
fn on_missing_guard_targeting_an_unproduced_artifact_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "on_missing_unproduced_test",
        r#"
id: on_missing_unproduced_test
verb: on_missing_unproduced_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md, conditional: true,
      when: { guard: on_missing, target: nobody_makes_this } }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let err = compile_project(dir.path())
        .expect_err("on_missing targeting an artifact no earlier step produces must loud-fail");
    assert!(
        err.contains("guard 'on_missing'")
            && err.contains("step 'only_step'")
            && err.contains("targets artifact 'nobody_makes_this'")
            && err.contains("which no earlier step produces"),
        "unexpected error: {err}"
    );
}

#[test]
fn on_flag_guard_targeting_an_unproduced_artifact_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "on_flag_unproduced_test",
        r#"
id: on_flag_unproduced_test
verb: on_flag_unproduced_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md, conditional: true,
      when: { guard: on_flag, target: nobody_makes_this.stale } }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let err = compile_project(dir.path())
        .expect_err("on_flag targeting an artifact no earlier step produces must loud-fail");
    assert!(
        err.contains("guard 'on_flag'")
            && err.contains("step 'only_step'")
            && err.contains("targets 'nobody_makes_this.stale'")
            && err.contains("artifact 'nobody_makes_this' is not produced by any earlier step"),
        "unexpected error: {err}"
    );
}

#[test]
fn on_flag_guard_targeting_a_produced_artifact_compiles() {
    // Positive control for the `on_flag` guard-target check, mirroring the shape of the shipped
    // `monitor_freshness` component (`read_freshness` produces `freshness_reading`;
    // `assess_severity` guards `on_flag: freshness_reading.stale`).
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "on_flag_produced_test",
        r#"
id: on_flag_produced_test
verb: on_flag_produced_test
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - { name: produce_it, tier: cheap, prompt_ref: steps/only_step.md, produces: some_artifact }
  - { name: only_step, tier: cheap, prompt_ref: steps/only_step.md, conditional: true,
      when: { guard: on_flag, target: some_artifact.stale } }
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
effect:
  render_blocks: []
  outcome: { kind: none }
"#,
    );

    let ir =
        compile_project(dir.path()).expect("on_flag targeting a produced artifact should compile");
    assert_eq!(
        ir["components"][0]["llm_calls"][1]["when"],
        serde_json::json!({ "guard": "on_flag", "target": "some_artifact.stale" })
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

/// A context carrying the data to answer `has_metric` but declaring it does not answer it — the
/// shape of an adapter bound to a semantic layer the host cannot introspect where it stands.
struct DeclinesSchemaProbes(FakeContext);

impl ContextLoader for DeclinesSchemaProbes {
    fn is_parseable(&self) -> bool {
        self.0.is_parseable()
    }
    fn metrics(&self) -> &[MetricInfo] {
        self.0.metrics()
    }
    fn dimensions(&self) -> &[DimensionInfo] {
        self.0.dimensions()
    }
    fn time_dimensions(&self) -> &[DimensionInfo] {
        self.0.time_dimensions()
    }
    fn models(&self) -> &[ModelInfo] {
        self.0.models()
    }
    fn lineage(&self) -> &LineageGraph {
        self.0.lineage()
    }
    fn can_answer(&self, predicate: &str) -> bool {
        !matches!(predicate, "has_metric")
    }
}

/// `can_answer` is the documented hook for an adapter with its own answerable set, so the compiler
/// has to consult it — otherwise the override is silently ignored and an existence predicate is
/// reported as an answerable `Fail` ("not satisfied") when the truth is that the context does not
/// know. The metric below exists, which is exactly what makes this a test of the gate rather than of
/// emptiness.
#[test]
fn a_declined_predicate_is_unanswerable_even_when_the_data_is_present() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "needs_metric",
        &precondition_component("needs_metric", "  - { predicate: has_metric }"),
    );

    let ctx = DeclinesSchemaProbes(FakeContext::parseable().with_metric("revenue", true, None));
    let err = compile_project_with(dir.path(), &ctx)
        .expect_err("a declined predicate must refuse rather than be evaluated anyway");
    assert!(
        err.contains("cannot be evaluated") && !err.contains("not satisfied"),
        "expected the unanswerable loud-fail, not an answerable false: {err}"
    );
}

// --- component-level `brief` ---------------------------------------------------------------------

/// A minimal single-step component body, optionally carrying an authored `brief:` (empty string
/// omits the field entirely — the "no brief authored" case).
fn brief_component(id: &str, brief_line: &str) -> String {
    format!(
        r#"
id: {id}
verb: {id}
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - {{ name: only_step, tier: cheap, prompt_ref: steps/only_step.md }}
trigger: {{ kind: one_shot }}
guardrails:
  - {{ name: read_only_execution, locked: true }}
effect:
  render_blocks: []
  outcome: {{ kind: none }}
{brief_line}
"#
    )
}

#[test]
fn absent_brief_produces_no_brief_key_in_ir() {
    // A component that authors no `brief` at all must not gain a `brief` key in its IR node —
    // the unit-level half of the byte-identical-IR guarantee (the full before/after diff of an
    // unchanged example is checked separately, not as a unit test).
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(dir.path(), "no_brief", &brief_component("no_brief", ""));

    let ir = compile_project(dir.path()).expect("component with no brief should compile");
    assert!(
        ir["components"][0].get("brief").is_none(),
        "a component with no authored brief must not gain a 'brief' key: {:?}",
        ir["components"][0]
    );
}

#[test]
fn component_brief_is_rendered_with_placeholders_and_carried_into_ir() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "with_brief",
        &brief_component(
            "with_brief",
            r#"brief: "Shared framing for {{project_name}} at {{project}}.""#,
        ),
    );

    let ir = compile_project(dir.path()).expect("component with brief should compile");
    assert_eq!(
        ir["components"][0]["brief"],
        serde_json::json!("Shared framing for wren_project at ./wren_project."),
        "brief must have its {{{{project}}}}/{{{{project_name}}}} placeholders substituted, \
same as a step body: {:?}",
        ir["components"][0]["brief"]
    );
}

#[test]
fn profile_mount_brief_replaces_component_brief_wholesale() {
    // A profile-mount brief is a full replacement, never a merge — the IR must carry only the
    // mount's text, with no trace of the component's own brief.
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_bind(
        dir.path(),
        "overridden_brief",
        &brief_component(
            "overridden_brief",
            r#"brief: "Component's own framing, must not appear.""#,
        ),
        "    brief: \"Mount-level framing for {{project_name}}.\"\n",
    );

    let ir = compile_project(dir.path()).expect("component with overridden brief should compile");
    assert_eq!(
        ir["components"][0]["brief"],
        serde_json::json!("Mount-level framing for wren_project."),
        "a profile-mount brief must replace the component's brief entirely: {:?}",
        ir["components"][0]["brief"]
    );
}

#[test]
fn profile_system_prompt_becomes_the_brief_when_the_component_has_none() {
    // The profile-level `system_prompt` reaches every mounted component, including one that
    // authors no `brief` of its own — that is the whole point of authoring it once on the profile
    // instead of repeating it in every mount.
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_profile(
        dir.path(),
        "no_brief",
        &brief_component("no_brief", ""),
        "system_prompt: \"House rules every behavior follows.\"\n",
        "",
    );

    let ir = compile_project(dir.path()).expect("profile system_prompt should compile");
    assert_eq!(
        ir["components"][0]["brief"],
        serde_json::json!("House rules every behavior follows."),
        "a profile system_prompt must reach a component that authors no brief: {:?}",
        ir["components"][0]
    );
}

#[test]
fn profile_system_prompt_precedes_the_component_brief() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_profile(
        dir.path(),
        "with_brief",
        &brief_component("with_brief", r#"brief: "Framing for this one behavior.""#),
        "system_prompt: \"House rules every behavior follows.\"\n",
        "",
    );

    let ir = compile_project(dir.path()).expect("profile system_prompt should compile");
    assert_eq!(
        ir["components"][0]["brief"],
        serde_json::json!("House rules every behavior follows.\n\nFraming for this one behavior."),
        "the shared system_prompt must come first, then the component's own brief: {:?}",
        ir["components"][0]["brief"]
    );
}

#[test]
fn profile_system_prompt_survives_a_mount_brief_replacement() {
    // A mount `brief` replaces the *component's* brief wholesale, but it does not stand in for the
    // profile's shared framing — the two are separate layers, so the system_prompt is still there.
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_profile(
        dir.path(),
        "overridden_brief",
        &brief_component(
            "overridden_brief",
            r#"brief: "Component's own framing, must not appear.""#,
        ),
        "system_prompt: \"House rules every behavior follows.\"\n",
        "    brief: \"Mount-level framing.\"\n",
    );

    let ir = compile_project(dir.path()).expect("profile system_prompt should compile");
    assert_eq!(
        ir["components"][0]["brief"],
        serde_json::json!("House rules every behavior follows.\n\nMount-level framing."),
        "a mount brief replaces the component's brief but not the profile system_prompt: {:?}",
        ir["components"][0]["brief"]
    );
}

#[test]
fn profile_system_prompt_is_rendered_with_placeholders() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_profile(
        dir.path(),
        "no_brief",
        &brief_component("no_brief", ""),
        "system_prompt: \"Answer about {{project_name}} at {{project}}.\"\n",
        "",
    );

    let ir = compile_project(dir.path()).expect("profile system_prompt should compile");
    assert_eq!(
        ir["components"][0]["brief"],
        serde_json::json!("Answer about wren_project at ./wren_project."),
        "system_prompt must take the same placeholder substitution as a brief or a step body: {:?}",
        ir["components"][0]["brief"]
    );
}

#[test]
fn empty_profile_system_prompt_does_not_conjure_a_brief() {
    // An empty system_prompt contributes nothing. Without this, authoring `system_prompt: ""`
    // would put `"brief": ""` onto every component that has no brief — inventing a key where the
    // no-brief guarantee says there must not be one.
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_profile(
        dir.path(),
        "no_brief",
        &brief_component("no_brief", ""),
        "system_prompt: \"\"\n",
        "",
    );

    let ir = compile_project(dir.path()).expect("empty system_prompt should compile");
    assert!(
        ir["components"][0].get("brief").is_none(),
        "an empty system_prompt must not add a 'brief' key: {:?}",
        ir["components"][0]
    );
}

#[test]
fn empty_mount_brief_still_blanks_the_component_brief_under_a_system_prompt() {
    // `brief: ""` on a mount is the documented way to blank a component's own framing. That must
    // keep working with a profile system_prompt above it: the result is the shared framing alone,
    // with no trailing separator and no trace of the component's text.
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_profile(
        dir.path(),
        "overridden_brief",
        &brief_component(
            "overridden_brief",
            r#"brief: "Component's own framing, must not appear.""#,
        ),
        "system_prompt: \"House rules every behavior follows.\"\n",
        "    brief: \"\"\n",
    );

    let ir = compile_project(dir.path()).expect("profile system_prompt should compile");
    assert_eq!(
        ir["components"][0]["brief"],
        serde_json::json!("House rules every behavior follows."),
        "blanking the component brief must leave the shared framing alone, unpadded: {:?}",
        ir["components"][0]["brief"]
    );
}

/// A component whose `required_capabilities` is exactly `capabilities` (flow-style YAML, e.g.
/// `"[sql_execution]"` or `"[]"`) — used to exercise the `config.capability_ceiling` gate without
/// dragging in params or preconditions the ceiling check does not care about.
fn capability_component(id: &str, capabilities: &str) -> String {
    format!(
        r#"
id: {id}
verb: {id}
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - {{ name: only_step, tier: cheap, prompt_ref: steps/only_step.md }}
trigger: {{ kind: one_shot }}
guardrails:
  - {{ name: read_only_execution, locked: true }}
required_capabilities: {capabilities}
effect:
  render_blocks: []
  outcome: {{ kind: none }}
"#
    )
}

#[test]
fn capability_within_ceiling_compiles_and_the_ceiling_appears_in_the_ir() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_profile(
        dir.path(),
        "needs_sql",
        &capability_component("needs_sql", "[sql_execution]"),
        "config:\n  capability_ceiling:\n    - sql_execution\n",
        "",
    );

    let ir = compile_project(dir.path()).expect("a capability within the ceiling must compile");
    assert_eq!(
        ir["config"]["capability_ceiling"],
        serde_json::json!(["sql_execution"]),
        "a declared ceiling must be carried into the IR's config block: {:?}",
        ir["config"]
    );
}

#[test]
fn capability_outside_ceiling_fails_compile_naming_both_values() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_profile(
        dir.path(),
        "needs_write",
        &capability_component("needs_write", "[filesystem_write]"),
        "config:\n  capability_ceiling:\n    - sql_execution\n",
        "",
    );

    let err = compile_project(dir.path())
        .expect_err("a capability outside the declared ceiling must fail compile");
    assert!(
        err.contains("needs_write")
            && err.contains("filesystem_write")
            && err.contains("sql_execution"),
        "error must name the component, the offending capability, and the declared ceiling: {err}"
    );
}

#[test]
fn absent_capability_ceiling_leaves_config_exactly_empty() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_profile(
        dir.path(),
        "needs_anything",
        &capability_component("needs_anything", "[whatever_capability_it_wants]"),
        "",
        "",
    );

    let ir = compile_project(dir.path()).expect("with no declared ceiling, any capability is fine");
    assert_eq!(
        ir["config"],
        serde_json::json!({}),
        "a profile with no declared ceiling must still emit an empty config block: {:?}",
        ir["config"]
    );
}

#[test]
fn capability_ceiling_does_not_admit_a_more_specific_qualifier() {
    // A ceiling of `sql_execution` must not be read as covering `sql_execution:read_only` — the
    // `:` qualifier is not a hierarchy. This pins exact-string-set containment down explicitly.
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_profile(
        dir.path(),
        "needs_read_only_sql",
        &capability_component("needs_read_only_sql", "[sql_execution:read_only]"),
        "config:\n  capability_ceiling:\n    - sql_execution\n",
        "",
    );

    let err = compile_project(dir.path()).expect_err(
        "a ceiling of 'sql_execution' must not admit 'sql_execution:read_only' by prefix",
    );
    assert!(
        err.contains("sql_execution:read_only") && err.contains("sql_execution"),
        "unexpected error: {err}"
    );
}

/// A component body with a populated `required_capabilities` list and a single `llm_steps` entry,
/// so capability-subset tests can vary just the step's own `capabilities`/`produces_exclusive`
/// lines (`step_extra`, inlined verbatim under the step's `prompt_ref` line) without duplicating
/// the rest of a minimal component.
fn step_capability_component(
    id: &str,
    required_capabilities_block: &str,
    step_extra: &str,
) -> String {
    format!(
        r#"
id: {id}
verb: {id}
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - name: only_step
    tier: cheap
    prompt_ref: steps/only_step.md
{step_extra}
trigger: {{ kind: one_shot }}
guardrails:
  - {{ name: read_only_execution, locked: true }}
required_capabilities:
{required_capabilities_block}
effect:
  render_blocks: []
  outcome: {{ kind: none }}
"#
    )
}

#[test]
fn step_capabilities_subset_of_required_reaches_ir() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "capped_step",
        &step_capability_component(
            "capped_step",
            "  - sql_execution:read_only\n  - render_contract\n",
            "    capabilities:\n      - sql_execution:read_only\n",
        ),
    );

    let ir = compile_project(dir.path()).expect("a capability that is a subset must compile");
    assert_eq!(
        ir["components"][0]["llm_calls"][0]["capabilities"],
        serde_json::json!(["sql_execution:read_only"]),
        "the step's narrowed capabilities must reach the matching llm_calls entry verbatim"
    );
}

#[test]
fn step_capability_outside_required_set_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "capped_step",
        &step_capability_component(
            "capped_step",
            "  - render_contract\n",
            "    capabilities:\n      - sql_execution:read_only\n",
        ),
    );

    let err = compile_project(dir.path())
        .expect_err("a capability outside required_capabilities must fail");
    assert!(
        err.contains("step 'only_step'")
            && err.contains("component 'capped_step'")
            && err.contains("capability 'sql_execution:read_only'"),
        "error must name both the offending step and capability: {err}"
    );
}

#[test]
fn step_produces_exclusive_reaches_ir() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "exclusive_step",
        &step_capability_component(
            "exclusive_step",
            "  - render_contract\n",
            "    produces: draft\n    produces_exclusive: true\n",
        ),
    );

    let ir = compile_project(dir.path()).expect("produces_exclusive must compile");
    assert_eq!(
        ir["components"][0]["llm_calls"][0]["produces_exclusive"],
        serde_json::json!(true),
        "an authored produces_exclusive: true must reach the matching llm_calls entry"
    );
}

#[test]
fn unauthored_capabilities_and_produces_exclusive_are_absent_from_ir() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture(
        dir.path(),
        "plain_step",
        &step_capability_component("plain_step", "  - render_contract\n", ""),
    );

    let ir = compile_project(dir.path()).expect("a step with neither field must compile");
    let call = ir["components"][0]["llm_calls"][0]
        .as_object()
        .expect("llm_calls entry must be an object");
    assert!(
        !call.contains_key("capabilities"),
        "an unauthored 'capabilities' must be absent as a key, not null: {call:?}"
    );
    assert!(
        !call.contains_key("produces_exclusive"),
        "an unauthored 'produces_exclusive' must be absent as a key, not null: {call:?}"
    );
}

/// Writes a one-component fixture whose slot variants live on disk, for the `slots:` tests.
///
/// Helper names in this file carry a feature prefix deliberately: two parallel branches once
/// landed different `capability_component` helpers and had to be merged by hand.
fn slot_write_fixture(
    dir: &Path,
    component_yaml: &str,
    step_body: &str,
    variant_files: &[(&str, &str)],
) {
    write_component_fixture_with_profile(dir, "slotted", component_yaml, "", "");
    fs::write(dir.join("components/slotted/steps/only_step.md"), step_body).unwrap();
    for (rel, content) in variant_files {
        let path = dir.join("components/slotted").join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
}

/// A component body with an arbitrary `slots:` block and a single step.
fn slot_component(slots_block: &str) -> String {
    format!(
        r#"
id: slotted
verb: slotted
type: analytical
realization_kind: skill
binding_mode: pinned
description: A component that carries slots.
examples:
  - Do the slotted thing.
llm_steps:
  - name: only_step
    tier: strong
    prompt_ref: steps/only_step.md
trigger: {{ kind: one_shot }}
guardrails: []
effect:
  render_blocks: []
  outcome: {{ kind: none }}
{slots_block}"#
    )
}

#[test]
fn slot_variants_reach_the_ir_with_placeholders_substituted() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(
        dir.path(),
        &slot_component(
            "slots:\n  - name: verification\n    variants:\n      base: fragments/base.md\n      terse: fragments/terse.md\n    default: base\n",
        ),
        "Answer, then: {{ slot.verification }}\n",
        &[
            ("fragments/base.md", "Verify against {{project_name}}.\n"),
            ("fragments/terse.md", "Verify.\n"),
        ],
    );

    let ir = compile_project(dir.path()).expect("a declared and referenced slot must compile");
    let slots = ir["components"][0]["slots"].as_array().unwrap();
    assert_eq!(slots.len(), 1);
    assert_eq!(slots[0]["name"], "verification");
    assert_eq!(slots[0]["default"], "base");
    // Every variant travels; compile selects none of them.
    assert_eq!(slots[0]["variants"]["base"], "Verify against wren_project.");
    assert_eq!(slots[0]["variants"]["terse"], "Verify.");
    // `present_when` is absent, not null, when unauthored.
    assert!(slots[0].get("present_when").is_none());
}

#[test]
fn slot_present_when_reaches_the_ir_when_authored() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(
        dir.path(),
        &slot_component(
            "slots:\n  - name: plan_mode\n    variants:\n      on: fragments/on.md\n    default: on\n    present_when: plan_mode_enabled\n",
        ),
        "{{ slot.plan_mode }}\n",
        &[("fragments/on.md", "Draft a plan first.\n")],
    );

    let ir = compile_project(dir.path()).expect("present_when must compile");
    assert_eq!(
        ir["components"][0]["slots"][0]["present_when"],
        "plan_mode_enabled"
    );
}

#[test]
fn a_component_without_slots_emits_no_slots_key() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(dir.path(), &slot_component(""), "Just answer.\n", &[]);

    let ir = compile_project(dir.path()).expect("no slots must compile");
    assert!(
        ir["components"][0].get("slots").is_none(),
        "the field must be absent, not an empty array — that is what keeps existing goldens byte-identical"
    );
}

#[test]
fn a_referenced_but_undeclared_slot_fails_compile() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(
        dir.path(),
        &slot_component(
            "slots:\n  - name: verification\n    variants:\n      base: fragments/base.md\n    default: base\n",
        ),
        "{{ slot.verification }} and {{ slot.verifcation }}\n",
        &[("fragments/base.md", "Verify.\n")],
    );

    let err = compile_project(dir.path()).expect_err("a mistyped slot name must fail");
    assert!(
        err.contains("verifcation") && err.contains("does not \n                 declare")
            || err.contains("verifcation"),
        "error must name the offending slot: {err}"
    );
}

#[test]
fn referencing_a_slot_when_none_are_declared_fails_compile() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(
        dir.path(),
        &slot_component(""),
        "{{ slot.verification }}\n",
        &[],
    );

    let err =
        compile_project(dir.path()).expect_err("a slot reference with no declarations must fail");
    assert!(err.contains("verification"), "{err}");
    assert!(err.contains("declares no slots"), "{err}");
}

#[test]
fn a_declared_but_unreferenced_slot_fails_compile() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(
        dir.path(),
        &slot_component(
            "slots:\n  - name: verification\n    variants:\n      base: fragments/base.md\n    default: base\n",
        ),
        "No slot reference here.\n",
        &[("fragments/base.md", "Verify.\n")],
    );

    let err = compile_project(dir.path()).expect_err("an unreferenced slot must fail");
    assert!(err.contains("verification"), "{err}");
}

#[test]
fn a_slot_default_outside_its_variants_fails_compile() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(
        dir.path(),
        &slot_component(
            "slots:\n  - name: verification\n    variants:\n      base: fragments/base.md\n    default: terse\n",
        ),
        "{{ slot.verification }}\n",
        &[("fragments/base.md", "Verify.\n")],
    );

    let err = compile_project(dir.path()).expect_err("a default naming no variant must fail");
    assert!(err.contains("terse"), "{err}");
    assert!(err.contains("base"), "the allowed set must be named: {err}");
}

#[test]
fn a_slot_with_no_variants_fails_compile() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(
        dir.path(),
        &slot_component("slots:\n  - name: verification\n    variants: {}\n    default: base\n"),
        "{{ slot.verification }}\n",
        &[],
    );

    let err = compile_project(dir.path()).expect_err("a slot with no variants must fail");
    assert!(err.contains("no variants"), "{err}");
}

#[test]
fn a_duplicate_slot_declaration_fails_compile() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(
        dir.path(),
        &slot_component(
            "slots:\n  - name: verification\n    variants:\n      base: fragments/base.md\n    default: base\n  - name: verification\n    variants:\n      terse: fragments/terse.md\n    default: terse\n",
        ),
        "{{ slot.verification }}\n",
        &[
            ("fragments/base.md", "Verify.\n"),
            ("fragments/terse.md", "Verify briefly.\n"),
        ],
    );

    let err = compile_project(dir.path()).expect_err("a duplicate slot name must fail");
    assert!(err.contains("more than once"), "{err}");
}

#[test]
fn a_slot_referenced_only_from_a_brief_counts_as_used() {
    let dir = tempfile::tempdir().unwrap();
    let component = format!(
        "{}\nbrief: |\n  Framing. {{{{ slot.verification }}}}\n",
        slot_component(
            "slots:\n  - name: verification\n    variants:\n      base: fragments/base.md\n    default: base\n",
        )
    );
    slot_write_fixture(
        dir.path(),
        &component,
        "No slot reference in the step.\n",
        &[("fragments/base.md", "Verify.\n")],
    );

    let ir = compile_project(dir.path()).expect("a brief reference must satisfy the usage check");
    assert_eq!(ir["components"][0]["slots"][0]["name"], "verification");
}

#[test]
fn a_slot_reference_inside_a_variant_counts_as_used() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(
        dir.path(),
        &slot_component(
            "slots:\n  - name: outer\n    variants:\n      base: fragments/outer.md\n    default: base\n  - name: inner\n    variants:\n      base: fragments/inner.md\n    default: base\n",
        ),
        "{{ slot.outer }}\n",
        &[
            ("fragments/outer.md", "Outer, then {{ slot.inner }}.\n"),
            ("fragments/inner.md", "Inner.\n"),
        ],
    );

    let ir = compile_project(dir.path())
        .expect("a slot referenced from another slot's variant must count as used");
    let slots = ir["components"][0]["slots"].as_array().unwrap();
    assert_eq!(slots.len(), 2);
    // Carried verbatim — nesting is not expanded at compile; dispatch does the choosing.
    assert_eq!(
        slots[0]["variants"]["base"],
        "Outer, then {{ slot.inner }}."
    );
}

#[test]
fn a_malformed_slot_reference_is_rejected_as_unrecognised_syntax() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(
        dir.path(),
        &slot_component(""),
        "Literal {{ slot.Verification }} would reach the model as text.\n",
        &[],
    );

    // The inverse of this test used to assert the reference was left verbatim, which is what
    // compile did before unrecognised template syntax became a compile error. A malformed slot
    // name is the case that motivated the change: it is too close to a real reference to be worth
    // passing through to a model as literal text.
    let err = compile_project(dir.path())
        .expect_err("a malformed slot reference must be rejected, not passed through");
    assert!(
        err.contains("unrecognised template syntax"),
        "the error must say what kind of problem this is: {err}"
    );
    assert!(
        err.contains("slot.Verification"),
        "the error must quote the offending reference: {err}"
    );
    assert!(
        err.contains("step 'only_step' of component 'slotted'"),
        "the error must name the surface the author has to open: {err}"
    );
}

/// Writes a fixture whose *profile* declares slots. `profile_extra` is inlined into `profile.yml`
/// above `components:`, and `profile_variant_files` are written relative to the project dir —
/// which is what a profile-level slot reference resolves against.
fn slot_write_profile_fixture(
    dir: &Path,
    profile_extra: &str,
    component_yaml: &str,
    step_body: &str,
    component_variant_files: &[(&str, &str)],
    profile_variant_files: &[(&str, &str)],
) {
    write_component_fixture_with_profile(dir, "slotted", component_yaml, profile_extra, "");
    fs::write(dir.join("components/slotted/steps/only_step.md"), step_body).unwrap();
    for (rel, content) in component_variant_files {
        let path = dir.join("components/slotted").join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    for (rel, content) in profile_variant_files {
        let path = dir.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
}

#[test]
fn profile_slots_reach_the_top_level_ir() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_profile_fixture(
        dir.path(),
        "system_prompt: |\n  You are a fixture. {{ slot.plan_mode }}\nslots:\n  - name: plan_mode\n    variants:\n      on: fragments/plan_on.md\n      off: fragments/plan_off.md\n    default: off\n    present_when: plan_mode_enabled\n",
        &slot_component(""),
        "Just answer.\n",
        &[],
        &[
            ("fragments/plan_on.md", "Draft a plan for {{project_name}} first.\n"),
            ("fragments/plan_off.md", "Act directly.\n"),
        ],
    );

    let ir = compile_project(dir.path()).expect("a profile-level slot must compile");

    // This assertion is the point of the test: `profile.yml` is NOT parsed with
    // `deny_unknown_fields`, so a field placed at the wrong level would be dropped in silence and
    // the compile would still succeed. Asserting on the emitted IR is the only way to know the
    // declaration was actually read.
    let slots = ir["slots"]
        .as_array()
        .expect("top-level slots must be emitted");
    assert_eq!(slots.len(), 1);
    assert_eq!(slots[0]["name"], "plan_mode");
    assert_eq!(slots[0]["default"], "off");
    assert_eq!(slots[0]["present_when"], "plan_mode_enabled");
    assert_eq!(
        slots[0]["variants"]["on"],
        "Draft a plan for wren_project first."
    );
    // Profile slots are not copied onto component nodes — each layer is addressed where declared.
    assert!(ir["components"][0].get("slots").is_none());
}

#[test]
fn a_profile_without_slots_emits_no_top_level_slots_key() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_profile_fixture(
        dir.path(),
        "",
        &slot_component(""),
        "Just answer.\n",
        &[],
        &[],
    );

    let ir = compile_project(dir.path()).expect("no profile slots must compile");
    assert!(
        ir.get("slots").is_none(),
        "absent, not empty — this is what keeps existing goldens byte-identical"
    );
}

#[test]
fn a_profile_slot_colliding_with_a_component_slot_fails_compile() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_profile_fixture(
        dir.path(),
        "system_prompt: |\n  Framing. {{ slot.verification }}\nslots:\n  - name: verification\n    variants:\n      loose: fragments/loose.md\n    default: loose\n",
        &slot_component(
            "slots:\n  - name: verification\n    variants:\n      base: fragments/base.md\n    default: base\n",
        ),
        "{{ slot.verification }}\n",
        &[("fragments/base.md", "Verify.\n")],
        &[("fragments/loose.md", "Verify loosely.\n")],
    );

    let err = compile_project(dir.path())
        .expect_err("the same slot name on both layers must fail rather than shadow");
    assert!(err.contains("verification"), "{err}");
    assert!(
        err.contains("slotted"),
        "the error must name the colliding component: {err}"
    );
}

#[test]
fn a_profile_slot_unreferenced_by_the_system_prompt_fails_compile() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_profile_fixture(
        dir.path(),
        "system_prompt: |\n  Framing with no slot reference.\nslots:\n  - name: plan_mode\n    variants:\n      on: fragments/plan_on.md\n    default: on\n",
        &slot_component(""),
        "Just answer.\n",
        &[],
        &[("fragments/plan_on.md", "Plan first.\n")],
    );

    let err = compile_project(dir.path()).expect_err("an unreferenced profile slot must fail");
    assert!(err.contains("plan_mode"), "{err}");
}

#[test]
fn a_system_prompt_referencing_an_undeclared_slot_fails_compile() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_profile_fixture(
        dir.path(),
        "system_prompt: |\n  Framing. {{ slot.plan_mode }}\n",
        &slot_component(""),
        "Just answer.\n",
        &[],
        &[],
    );

    let err = compile_project(dir.path())
        .expect_err("a system_prompt slot reference with no profile declaration must fail");
    assert!(err.contains("plan_mode"), "{err}");
    assert!(err.contains("system_prompt"), "{err}");
}

#[test]
fn a_component_slot_is_not_satisfied_by_a_system_prompt_reference() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_profile_fixture(
        dir.path(),
        "system_prompt: |\n  Framing. {{ slot.verification }}\n",
        &slot_component(
            "slots:\n  - name: verification\n    variants:\n      base: fragments/base.md\n    default: base\n",
        ),
        "No slot reference in the step.\n",
        &[("fragments/base.md", "Verify.\n")],
        &[],
    );

    // The layers are checked against their own text. A component slot referenced only from the
    // profile's `system_prompt` is unused as far as the component is concerned, and the
    // system_prompt's reference is undeclared as far as the profile is concerned — either error is
    // correct, and both are better than accepting a cross-layer reference the name space forbids.
    let err = compile_project(dir.path())
        .expect_err("a cross-layer slot reference must not satisfy either layer's check");
    assert!(err.contains("verification"), "{err}");
}

#[test]
fn a_duplicate_profile_slot_declaration_fails_compile() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_profile_fixture(
        dir.path(),
        "system_prompt: |\n  Framing. {{ slot.plan_mode }}\nslots:\n  - name: plan_mode\n    variants:\n      on: fragments/plan_on.md\n    default: on\n  - name: plan_mode\n    variants:\n      off: fragments/plan_off.md\n    default: off\n",
        &slot_component(""),
        "Just answer.\n",
        &[],
        &[
            ("fragments/plan_on.md", "Plan first.\n"),
            ("fragments/plan_off.md", "Act directly.\n"),
        ],
    );

    let err = compile_project(dir.path()).expect_err("a duplicate profile slot name must fail");
    assert!(err.contains("more than once"), "{err}");
}

#[test]
fn a_profile_slot_default_outside_its_variants_fails_compile() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_profile_fixture(
        dir.path(),
        "system_prompt: |\n  Framing. {{ slot.plan_mode }}\nslots:\n  - name: plan_mode\n    variants:\n      on: fragments/plan_on.md\n    default: off\n",
        &slot_component(""),
        "Just answer.\n",
        &[],
        &[("fragments/plan_on.md", "Plan first.\n")],
    );

    let err =
        compile_project(dir.path()).expect_err("a profile default naming no variant must fail");
    assert!(err.contains("off"), "{err}");
    assert!(
        err.contains("profile 'fixture'"),
        "the owner must be named: {err}"
    );
}

/// Writes a one-component fixture with an arbitrary `assets:` block and the asset files on disk.
/// Prefixed `asset_` per this file's helper-naming convention.
fn asset_write_fixture(dir: &Path, assets_block: &str, asset_files: &[(&str, &[u8])]) {
    let component_yaml = format!(
        r#"
id: assetted
verb: assetted
type: analytical
realization_kind: skill
binding_mode: pinned
description: A component that carries files.
examples:
  - Do the thing with files.
llm_steps:
  - name: only_step
    tier: strong
    prompt_ref: steps/only_step.md
trigger: {{ kind: one_shot }}
guardrails: []
effect:
  render_blocks: []
  outcome: {{ kind: none }}
{assets_block}"#
    );
    write_component_fixture_with_profile(dir, "assetted", &component_yaml, "", "");
    for (rel, content) in asset_files {
        let path = dir.join("components/assetted").join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
}

#[test]
fn a_component_without_assets_emits_no_assets_key() {
    let dir = tempfile::tempdir().unwrap();
    asset_write_fixture(dir.path(), "", &[]);

    let ir = compile_project(dir.path()).expect("no assets must compile");
    assert!(
        ir["components"][0].get("assets").is_none(),
        "absent, not empty — this is what keeps existing goldens byte-identical"
    );
}

// ── unrecognised template syntax ────────────────────────────────────────────────────────────────
//
// One test per prompt-text surface, because the check lives in the single shared substitution
// function and the value of these tests is proving every surface actually routes through it.

#[test]
fn an_unknown_placeholder_in_a_step_body_fails_compile() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(
        dir.path(),
        &slot_component(""),
        "Answer about {{ topic }}.\n",
        &[],
    );

    let err = compile_project(dir.path()).expect_err("an unknown placeholder must fail");
    assert!(err.contains("unrecognised template syntax"), "{err}");
    assert!(
        err.contains("{{ topic }}"),
        "the error must quote it: {err}"
    );
    assert!(
        err.contains("step 'only_step' of component 'slotted'"),
        "{err}"
    );
    assert!(
        err.contains("literal one"),
        "the message must tell the author how to write a literal brace: {err}"
    );
}

#[test]
fn an_unknown_placeholder_in_a_component_brief_fails_compile() {
    let dir = tempfile::tempdir().unwrap();
    let component = format!(
        "{}\nbrief: |\n  Framing about {{{{ topic }}}}.\n",
        slot_component("")
    );
    slot_write_fixture(dir.path(), &component, "Just answer.\n", &[]);

    let err = compile_project(dir.path()).expect_err("an unknown placeholder in a brief must fail");
    assert!(err.contains("unrecognised template syntax"), "{err}");
    assert!(
        err.contains("the brief of component 'slotted'"),
        "the error must name the brief, not the step: {err}"
    );
}

#[test]
fn an_unknown_placeholder_in_a_mount_brief_names_the_mount() {
    let dir = tempfile::tempdir().unwrap();
    write_component_fixture_with_profile(
        dir.path(),
        "slotted",
        &slot_component(""),
        "",
        "    brief: |\n      Mount framing about {{ topic }}.\n",
    );

    let err =
        compile_project(dir.path()).expect_err("an unknown placeholder in a mount brief must fail");
    assert!(
        err.contains("the mount brief for component 'slotted'"),
        "a profile-supplied brief must be named as such, since that is the file to edit: {err}"
    );
}

#[test]
fn an_unknown_placeholder_in_a_system_prompt_fails_compile() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_profile_fixture(
        dir.path(),
        "system_prompt: |\n  You work on {{ topic }}.\n",
        &slot_component(""),
        "Just answer.\n",
        &[],
        &[],
    );

    let err =
        compile_project(dir.path()).expect_err("an unknown placeholder in system_prompt must fail");
    assert!(err.contains("the profile's system_prompt"), "{err}");
}

#[test]
fn an_unknown_placeholder_in_a_slot_variant_fails_compile() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(
        dir.path(),
        &slot_component(
            "slots:\n  - name: verification\n    variants:\n      base: fragments/base.md\n    default: base\n",
        ),
        "{{ slot.verification }}\n",
        &[("fragments/base.md", "Verify using {{ tool }}.\n")],
    );

    let err =
        compile_project(dir.path()).expect_err("an unknown placeholder in a variant must fail");
    assert!(
        err.contains("variant 'base' of slot 'verification'"),
        "{err}"
    );
}

#[test]
fn a_jinja_statement_delimiter_fails_compile() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(
        dir.path(),
        &slot_component(""),
        "{% if verbose %}Say more.{% endif %}\n",
        &[],
    );

    let err = compile_project(dir.path()).expect_err("a statement delimiter must fail");
    assert!(err.contains("unrecognised template syntax"), "{err}");
    assert!(
        err.contains("'{%'"),
        "the error must quote the delimiter it found: {err}"
    );
}

#[test]
fn a_jinja_comment_delimiter_fails_compile() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(
        dir.path(),
        &slot_component(""),
        "Answer. {# a note to nobody #}\n",
        &[],
    );

    let err = compile_project(dir.path()).expect_err("a comment delimiter must fail");
    assert!(err.contains("'{#'"), "{err}");
}

#[test]
fn the_known_placeholders_and_slot_references_still_compile() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(
        dir.path(),
        &slot_component(
            "slots:\n  - name: verification\n    variants:\n      base: fragments/base.md\n    default: base\n",
        ),
        "Work on {{project}} ({{ project_name }}). {{ slot.verification }}\n",
        &[("fragments/base.md", "Verify against {{project_name}}.\n")],
    );

    let ir = compile_project(dir.path())
        .expect("the recognised forms must still compile, spacing variants included");
    let prompt = ir["components"][0]["prompt_fragment"].as_str().unwrap();
    assert!(
        prompt.contains("wren_project"),
        "substitution still happens: {prompt}"
    );
    // A slot reference is deliberately NOT substituted at compile — dispatch chooses the variant.
    assert!(prompt.contains("{{ slot.verification }}"), "{prompt}");
}

#[test]
fn a_single_brace_is_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(
        dir.path(),
        &slot_component(""),
        "Reply with JSON: { \"answer\": 1, \"nested\": { \"ok\": true } }\n",
        &[],
    );

    // The in-repo prompts that teach a model to emit JSON use single braces, which is why this
    // check could be added with a measured blast radius of zero. If single braces ever started
    // failing, every such prompt would break at once.
    let ir = compile_project(dir.path()).expect("single braces must not trip the check");
    let prompt = ir["components"][0]["prompt_fragment"].as_str().unwrap();
    assert!(prompt.contains("{ \"answer\": 1"), "{prompt}");
}

#[test]
fn an_unterminated_double_brace_is_not_reported_as_a_reference() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(
        dir.path(),
        &slot_component(""),
        "An unclosed {{ thing without a closing delimiter\n",
        &[],
    );

    // Nothing here can be read as a reference, and guessing at where the author meant it to end
    // would invent an error message about text they did not write. Left alone, exactly as today.
    compile_project(dir.path()).expect("an unterminated '{{' must not be reported as a reference");
}

#[test]
fn a_slot_name_that_cannot_be_referenced_fails_compile_on_the_declaration() {
    let dir = tempfile::tempdir().unwrap();
    slot_write_fixture(
        dir.path(),
        &slot_component(
            "slots:\n  - name: Verification\n    variants:\n      base: fragments/base.md\n    default: base\n",
        ),
        "Answer, then: {{ slot.Verification }}\n",
        &[("fragments/base.md", "Verify.\n")],
    );

    // The author wrote both halves consistently, so the useful complaint is about the name, not
    // about the reference. Before this check the name was accepted, no reference to it was ever
    // recognised, and the error told the author to add prompt text they had already written.
    let err = compile_project(dir.path())
        .expect_err("a slot name that cannot appear in a reference must fail");
    assert!(
        err.contains("not a usable slot name"),
        "the error must name the real problem, not report the slot as unreferenced: {err}"
    );
    assert!(err.contains("Verification"), "{err}");
}

#[test]
fn produces_exclusive_without_a_produced_artifact_fails_compile() {
    let dir = tempfile::tempdir().unwrap();
    let component = r#"
id: exclusive_nothing
verb: exclusive_nothing
type: analytical
realization_kind: skill
binding_mode: pinned
description: A component whose step claims exclusivity over nothing.
examples:
  - Claim nothing.
llm_steps:
  - name: only_step
    tier: strong
    prompt_ref: steps/only_step.md
    produces_exclusive: true
trigger: { kind: one_shot }
guardrails: []
effect:
  render_blocks: []
  outcome: { kind: none }
"#;
    write_component_fixture(dir.path(), "exclusive_nothing", component);

    // Exclusivity is provenance on a `produces` name. With no artifact it marks nothing, so
    // accepting it would emit a marker no consumer can act on while the author believes they
    // constrained who may write something.
    let err = compile_project(dir.path())
        .expect_err("exclusivity over no artifact must fail rather than compile to a no-op");
    assert!(
        err.contains("produces no \n                 artifact") || err.contains("produces no"),
        "{err}"
    );
    assert!(
        err.contains("only_step"),
        "the error must name the step: {err}"
    );
}
