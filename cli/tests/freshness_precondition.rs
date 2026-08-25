//! End-to-end `model_has_timestamp` enforcement (Phase 3 litmus, risk #3): an assertive component
//! that declares `model_has_timestamp` must fail to compile against a semantic layer whose models
//! carry NO temporal column — proving the precondition really gates (compile-fail), not a placeholder.
//! The mirror case (bound to jaffle-wren, whose `orders` has a DATE column) is the monitor-agent
//! golden, which compiles. Together they are the "one model with a timestamp, one without" pair the
//! litmus calls for.

use std::fs;
use std::path::Path;

use warble_cli::compile_project_to_ir;

/// Write a minimal wren project into `dir` whose single model has only non-temporal columns
/// (INT / TEXT / DOUBLE). It PARSES (so `mdl_parseable` holds) but `model_has_timestamp` is false.
fn write_timestampless_wren_project(dir: &Path) {
    fs::create_dir_all(dir.join("models/widgets")).unwrap();
    fs::write(
        dir.join("wren_project.yml"),
        "schema_version: 2\ndata_source: duckdb\ncatalog: wren\nschema: public\n",
    )
    .unwrap();
    fs::write(
        dir.join("models/widgets/metadata.yml"),
        "name: widgets\ncolumns:\n  - name: id\n    type: INT\n  - name: category\n    type: TEXT\n  - name: amount\n    type: DOUBLE\n",
    )
    .unwrap();
}

/// Write a one-component Warble project bound to the wren project at `wren_abs`, whose component
/// declares the `model_has_timestamp` precondition (the monitor_freshness gate).
fn write_monitor_fixture(dir: &Path, wren_abs: &str) {
    fs::create_dir_all(dir.join("context")).unwrap();
    fs::create_dir_all(dir.join("components/monitor/steps")).unwrap();
    fs::write(
        dir.join("profile.yml"),
        "profile: fixture\ncontext:\n  project: ./context/binding.yml\ncomponents:\n  - use: monitor\n    bind:\n      model: widgets\n",
    )
    .unwrap();
    fs::write(
        dir.join("context/binding.yml"),
        format!("project: {wren_abs}\n"),
    )
    .unwrap();
    fs::write(
        dir.join("components/monitor/component.yml"),
        r#"
id: monitor
verb: monitor_freshness
type: assertive
realization_kind: tool
binding_mode: pinned
context_precondition:
  - { predicate: model_has_timestamp, args: { model: "$param:model" } }
params:
  - { name: model, bind: required }
llm_steps:
  - { name: assess_severity, tier: cheap, conditional: true, prompt_ref: steps/assess_severity.md,
      when: { guard: on_flag, target: freshness_reading.stale } }
trigger: { kind: scheduled }
guardrails:
  - { name: read_only_execution, locked: true }
required_capabilities: [scheduler, sql_execution:read_only, notify_channel, llm:cheap]
borrowed_actions: [notify_slack]
effect:
  render_blocks: [status]
  outcome:
    kind: assertion
    verdict_type: freshness_verdict
    emits: [freshness_breach]
"#,
    )
    .unwrap();
    fs::write(
        dir.join("components/monitor/steps/assess_severity.md"),
        "Classify the breach severity.\n",
    )
    .unwrap();
}

#[test]
fn monitoring_a_model_without_a_timestamp_fails_to_compile() {
    let wren = tempfile::tempdir().unwrap();
    write_timestampless_wren_project(wren.path());
    let wren_abs = wren.path().canonicalize().unwrap();

    let project = tempfile::tempdir().unwrap();
    write_monitor_fixture(project.path(), &wren_abs.to_string_lossy());

    let err = compile_project_to_ir(project.path())
        .expect_err("monitoring freshness on a model with no timestamp column must be refused");
    assert!(
        err.contains("model_has_timestamp") && err.contains("not satisfied"),
        "expected a model_has_timestamp rejection, got: {err}"
    );
}
