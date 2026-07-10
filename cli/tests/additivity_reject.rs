//! End-to-end additivity enforcement (plan Risk 5): a component that pins `metric_additive` to a
//! non-additive declared metric must fail to compile against the real jaffle-wren MDL — proving the
//! adapter's additivity inference (AVG → non-additive) flows through to a compile-time refusal.
//! Complements the cube-less "unanswerable" path exercised in the core + adapter unit tests.

use std::fs;
use std::path::Path;

use warble_cli::compile_project_to_ir;

/// Absolute path to the committed jaffle-wren project (has the revenue cube: total_revenue = SUM,
/// avg_order_value = AVG).
fn jaffle_wren_abs() -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../examples/jaffle-wren")
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

/// Writes a one-component Warble project into `dir` whose `metric_additive` precondition is pinned
/// to `metric`, bound to the real jaffle-wren project.
fn write_pinned_additive_fixture(dir: &Path, metric: &str) {
    fs::create_dir_all(dir.join("context")).unwrap();
    fs::create_dir_all(dir.join("components/explain/steps")).unwrap();
    fs::write(
        dir.join("profile.yml"),
        "profile: fixture\ncontext:\n  project: ./context/binding.yml\ncomponents:\n  - use: explain\n",
    )
    .unwrap();
    fs::write(
        dir.join("context/binding.yml"),
        format!("project: {}\n", jaffle_wren_abs()),
    )
    .unwrap();
    fs::write(
        dir.join("components/explain/component.yml"),
        format!(
            r#"
id: explain
verb: explain
type: analytical
realization_kind: skill
binding_mode: runtime_selected
context_precondition:
  - {{ predicate: metric_additive, args: {{ metric: {metric} }} }}
llm_steps:
  - {{ name: only_step, tier: strong, prompt_ref: steps/only_step.md }}
trigger: {{ kind: one_shot }}
guardrails:
  - {{ name: read_only_execution, locked: true }}
effect:
  render_blocks: []
  outcome: {{ kind: none }}
"#
        ),
    )
    .unwrap();
    fs::write(
        dir.join("components/explain/steps/only_step.md"),
        "Explain the change.\n",
    )
    .unwrap();
}

#[test]
fn pinning_to_a_nonadditive_metric_fails_to_compile() {
    let dir = tempfile::tempdir().unwrap();
    write_pinned_additive_fixture(dir.path(), "avg_order_value");

    let err = compile_project_to_ir(dir.path())
        .expect_err("decomposing a non-additive metric must be refused at compile time");
    assert!(
        err.contains("not satisfied"),
        "expected an additivity rejection, got: {err}"
    );
}

#[test]
fn pinning_to_an_additive_metric_compiles() {
    let dir = tempfile::tempdir().unwrap();
    write_pinned_additive_fixture(dir.path(), "total_revenue");

    compile_project_to_ir(dir.path())
        .expect("an additive declared metric satisfies metric_additive");
}
