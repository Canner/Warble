//! End-to-end proof that a slot variant's file reference is resolved by the same rule as
//! `prompt_ref` — relative to the component directory, no escaping it, must exist — on the real
//! compile path rather than only in the isolated `resolve_file_ref` unit tests.
//!
//! This is the shared-file-reference contract holding for its second field. A slot variant is the
//! case where content is read *into* the IR, so an unchecked reference here would put arbitrary
//! file contents in front of a model, not merely fail to find a file.

use std::fs;
use std::path::Path;

use warble_cli::compile_project_to_ir;

/// A one-component project whose single slot has one variant at `variant_ref`, referenced from the
/// step body so the declared-and-used checks are satisfied and the reference itself is what fails.
fn write_project(dir: &Path, variant_ref: &str) {
    fs::create_dir_all(dir.join("context")).unwrap();
    fs::create_dir_all(dir.join("wren/models/widgets")).unwrap();
    fs::create_dir_all(dir.join("components/asker/steps")).unwrap();
    fs::create_dir_all(dir.join("components/asker/fragments")).unwrap();
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
        "name: widgets\ncolumns:\n  - name: id\n    type: INT\n",
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
  - {{ name: ask, tier: cheap, prompt_ref: steps/ask.md }}
trigger: {{ kind: one_shot }}
guardrails:
  - {{ name: read_only_execution, locked: true }}
required_capabilities: [llm:cheap]
borrowed_actions: []
effect:
  render_blocks: []
  outcome:
    kind: none
slots:
  - name: verification
    variants:
      base: {variant_ref}
    default: base
"#
        ),
    )
    .unwrap();
    fs::write(
        dir.join("components/asker/steps/ask.md"),
        "Ask something. {{ slot.verification }}\n",
    )
    .unwrap();
    // The safe target, used only by the well-behaved baseline below.
    fs::write(
        dir.join("components/asker/fragments/base.md"),
        "Verify the answer.\n",
    )
    .unwrap();
}

#[test]
fn a_well_behaved_slot_variant_compiles_and_lands_in_the_ir() {
    let project = tempfile::tempdir().unwrap();
    write_project(project.path(), "fragments/base.md");

    let ir = compile_project_to_ir(project.path())
        .expect("a relative variant reference inside the component directory must compile");
    assert_eq!(
        ir["components"][0]["slots"][0]["variants"]["base"],
        "Verify the answer."
    );
}

#[test]
fn a_slot_variant_escaping_with_dotdot_is_rejected_on_the_real_compile_path() {
    let project = tempfile::tempdir().unwrap();
    write_project(project.path(), "../../escape.md");

    let err = compile_project_to_ir(project.path())
        .expect_err("an escaping variant reference must never compile");

    assert!(
        err.contains("slot 'verification' variant 'base'"),
        "the error must name the slot and variant that was rejected: {err}"
    );
    assert!(
        err.contains("../../escape.md"),
        "the error must name the offending reference: {err}"
    );
}

#[test]
fn an_absolute_slot_variant_reference_is_rejected_on_the_real_compile_path() {
    let project = tempfile::tempdir().unwrap();
    write_project(project.path(), "/etc/passwd");

    let err = compile_project_to_ir(project.path()).expect_err(
        "an absolute variant reference must never compile — it would read a file outside any component into the IR",
    );

    assert!(
        err.contains("slot 'verification' variant 'base'"),
        "the error must name the slot and variant that was rejected: {err}"
    );
    assert!(
        err.contains("/etc/passwd"),
        "the error must name the offending reference: {err}"
    );
}

#[test]
fn a_missing_slot_variant_target_is_rejected_on_the_real_compile_path() {
    let project = tempfile::tempdir().unwrap();
    write_project(project.path(), "fragments/missing.md");

    let err = compile_project_to_ir(project.path())
        .expect_err("a variant reference naming a file that does not exist must never compile");

    assert!(
        err.contains("slot 'verification' variant 'base'"),
        "the error must name the slot and variant that was rejected: {err}"
    );
    assert!(
        err.contains("does not exist"),
        "the error must say the file is missing: {err}"
    );
}

/// A project whose *profile* declares one slot, referenced from `system_prompt`, with its single
/// variant at `variant_ref` — resolved against the profile's own directory (the project dir).
fn write_profile_slot_project(dir: &Path, variant_ref: &str) {
    write_project(dir, "fragments/base.md");
    // Drop the component's slot so only the profile-level reference is under test.
    let component = fs::read_to_string(dir.join("components/asker/component.yml")).unwrap();
    let trimmed = component
        .split("slots:")
        .next()
        .expect("the fixture component declares slots")
        .to_string();
    fs::write(dir.join("components/asker/component.yml"), trimmed).unwrap();
    fs::write(
        dir.join("components/asker/steps/ask.md"),
        "Ask something.\n",
    )
    .unwrap();
    fs::write(
        dir.join("profile.yml"),
        format!(
            "profile: fixture\ncontext:\n  project: ./context/binding.yml\nsystem_prompt: |\n  Framing. {{{{ slot.plan_mode }}}}\nslots:\n  - name: plan_mode\n    variants:\n      enabled: {variant_ref}\n    default: enabled\ncomponents:\n  - use: asker\n"
        ),
    )
    .unwrap();
    fs::create_dir_all(dir.join("fragments")).unwrap();
    fs::write(dir.join("fragments/plan.md"), "Draft a plan first.\n").unwrap();
}

#[test]
fn a_well_behaved_profile_slot_variant_compiles_and_lands_at_the_top_level() {
    let project = tempfile::tempdir().unwrap();
    write_profile_slot_project(project.path(), "fragments/plan.md");

    let ir = compile_project_to_ir(project.path())
        .expect("a relative profile-level variant reference must compile");
    assert_eq!(ir["slots"][0]["name"], "plan_mode");
    assert_eq!(ir["slots"][0]["variants"]["enabled"], "Draft a plan first.");
}

#[test]
fn a_profile_slot_variant_escaping_with_dotdot_is_rejected() {
    let project = tempfile::tempdir().unwrap();
    write_profile_slot_project(project.path(), "../../escape.md");

    let err = compile_project_to_ir(project.path())
        .expect_err("an escaping profile-level variant reference must never compile");
    assert!(
        err.contains("profile slot 'plan_mode' variant 'enabled'"),
        "the error must name the profile slot and variant: {err}"
    );
    assert!(err.contains("../../escape.md"), "{err}");
}

#[test]
fn an_absolute_profile_slot_variant_reference_is_rejected() {
    let project = tempfile::tempdir().unwrap();
    write_profile_slot_project(project.path(), "/etc/passwd");

    let err = compile_project_to_ir(project.path())
        .expect_err("an absolute profile-level variant reference must never compile");
    assert!(
        err.contains("profile slot 'plan_mode' variant 'enabled'"),
        "{err}"
    );
    assert!(err.contains("/etc/passwd"), "{err}");
}
