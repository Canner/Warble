//! End-to-end proof that `prompt_ref` resolution is validated on the real compile path — not just
//! in the isolated `resolve_file_ref` unit tests next to its definition. These drive the public
//! `compile_project_to_ir` entrypoint (real files on disk, the built-in context resolver, the
//! in-repo component sources) so a regression that only breaks the wiring, and not the helper
//! itself, still shows up here.

use std::fs;
use std::path::Path;

use warble_cli::compile_project_to_ir;

/// A one-component Warble project with a real wren-project context binding (so it compiles
/// through the ordinary, unfaked path) and a configurable `prompt_ref` value, so a test can swap
/// in an unsafe reference without touching anything else about the fixture.
fn write_project(dir: &Path, prompt_ref: &str) {
    fs::create_dir_all(dir.join("context")).unwrap();
    fs::create_dir_all(dir.join("wren/models/widgets")).unwrap();
    fs::create_dir_all(dir.join("components/asker/steps")).unwrap();
    fs::write(
        dir.join("profile.yml"),
        "profile: fixture\ncontext:\n  project: ./context/binding.yml\ncomponents:\n  - use: asker\n",
    )
    .unwrap();
    let wren_abs = dir.join("wren").canonicalize().unwrap();
    fs::write(
        dir.join("context/binding.yml"),
        format!("project: {}\n", wren_abs.to_string_lossy()),
    )
    .unwrap();
    fs::write(
        dir.join("wren/wren_project.yml"),
        "schema_version: 2\ndata_source: duckdb\ncatalog: wren\nschema: public\n",
    )
    .unwrap();
    fs::write(
        dir.join("wren/models/widgets/metadata.yml"),
        "name: widgets\ncolumns:\n  - name: id\n    type: INT\n  - name: amount\n    type: DOUBLE\n",
    )
    .unwrap();
    fs::write(
        dir.join("components/asker/component.yml"),
        format!(
            r#"
id: asker
verb: asker
type: analytical
realization_kind: skill
binding_mode: runtime_selected
context_precondition: []
params: []
llm_steps:
  - {{ name: ask, tier: cheap, prompt_ref: {prompt_ref} }}
trigger: {{ kind: one_shot }}
guardrails:
  - {{ name: read_only_execution, locked: true }}
required_capabilities: [llm:cheap]
borrowed_actions: []
effect:
  render_blocks: []
  outcome:
    kind: none
"#
        ),
    )
    .unwrap();
    // The safe fixture file. Tests that pass an escaping/absolute/missing `prompt_ref` never read
    // this — it exists only so the well-behaved baseline test below has something to point at.
    fs::write(
        dir.join("components/asker/steps/ask.md"),
        "Ask something.\n",
    )
    .unwrap();
}

#[test]
fn a_well_behaved_prompt_ref_compiles() {
    let project = tempfile::tempdir().unwrap();
    write_project(project.path(), "steps/ask.md");

    compile_project_to_ir(project.path())
        .expect("a relative prompt_ref inside the component directory must compile cleanly");
}

#[test]
fn a_prompt_ref_escaping_with_dotdot_is_rejected_on_the_real_compile_path() {
    let project = tempfile::tempdir().unwrap();
    write_project(project.path(), "../../escape.md");

    let err = compile_project_to_ir(project.path())
        .expect_err("an escaping prompt_ref must never compile, not even a single leading '..'");

    assert!(
        err.contains("prompt_ref"),
        "the error must name which field was rejected: {err}"
    );
    assert!(
        err.contains("../../escape.md"),
        "the error must name the offending reference: {err}"
    );
}

#[test]
fn an_absolute_prompt_ref_is_rejected_on_the_real_compile_path() {
    let project = tempfile::tempdir().unwrap();
    write_project(project.path(), "/etc/passwd");

    let err = compile_project_to_ir(project.path()).expect_err(
        "an absolute prompt_ref must never compile — it names a path outside any component",
    );

    assert!(
        err.contains("prompt_ref"),
        "the error must name which field was rejected: {err}"
    );
    assert!(
        err.contains("/etc/passwd"),
        "the error must name the offending reference: {err}"
    );
}

#[test]
fn a_missing_prompt_ref_target_is_rejected_on_the_real_compile_path() {
    let project = tempfile::tempdir().unwrap();
    write_project(project.path(), "steps/missing.md");

    let err = compile_project_to_ir(project.path())
        .expect_err("a prompt_ref naming a file that does not exist must never compile");

    assert!(
        err.contains("prompt_ref"),
        "the error must name which field was rejected: {err}"
    );
    assert!(
        err.contains("steps/missing.md"),
        "the error must name the offending reference: {err}"
    );
    assert!(
        err.contains("does not exist"),
        "the error must say the file is missing, not something else: {err}"
    );
}
