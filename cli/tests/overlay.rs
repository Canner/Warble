//! End-to-end tests for the compile overlay on the real host path.
//!
//! Every case drives `compile_project_to_ir_with_overlay`, so what is exercised is the same
//! sequence a CLI invocation takes: parse the profile, apply the patch, resolve and read the
//! mounted components, compile. The ordering claim the design rests on — that a patched profile
//! is simply what every compile-time check sees — is only true on that path, so asserting it
//! anywhere else would prove nothing.

use std::fs;
use std::path::Path;

use warble_cli::{
    compile_project_to_ir_with_overlay, default_component_sources, BuiltinContextResolver,
};

/// Compiles `dir`, optionally applying the overlay at `overlay`.
fn overlay_compile(dir: &Path, overlay: Option<&Path>) -> Result<serde_json::Value, String> {
    let sources = default_component_sources(dir)?;
    compile_project_to_ir_with_overlay(dir, &sources, &BuiltinContextResolver, overlay)
}

/// Writes an overlay document into the project dir and returns its path.
fn overlay_write(dir: &Path, body: &str) -> std::path::PathBuf {
    let path = dir.join("overlay.yml");
    fs::write(&path, body).unwrap();
    path
}

/// A project mounting `asker` only, with a ceiling that admits `asker`'s capability and nothing
/// else. `writer` exists on disk but is unmounted, and requires a capability outside the ceiling
/// — which is what lets one fixture serve both the ordinary mount cases and the ceiling case.
fn overlay_write_project(dir: &Path, profile_extra: &str) {
    fs::create_dir_all(dir.join("context")).unwrap();
    fs::create_dir_all(dir.join("wren/models/widgets")).unwrap();
    fs::create_dir_all(dir.join("components/asker/steps")).unwrap();
    fs::create_dir_all(dir.join("components/writer/steps")).unwrap();

    fs::write(
        dir.join("profile.yml"),
        format!(
            "profile: fixture\ncontext:\n  project: ./context/binding.yml\n{profile_extra}components:\n  - use: asker\n"
        ),
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

    for (id, capability, param) in [
        ("asker", "llm:cheap", "tone"),
        ("writer", "data_write", "table"),
    ] {
        fs::write(
            dir.join(format!("components/{id}/component.yml")),
            format!(
                r#"
id: {id}
verb: {id}
type: analytical
realization_kind: skill
binding_mode: runtime_selected
context_precondition: []
params:
  - {{ name: {param}, bind: optional, default: "unset" }}
llm_steps:
  - {{ name: step, tier: cheap, prompt_ref: steps/step.md }}
trigger: {{ kind: one_shot }}
guardrails:
  - {{ name: read_only_execution, locked: true }}
required_capabilities: [{capability}]
borrowed_actions: []
effect:
  render_blocks: []
  outcome:
    kind: none
"#
            ),
        )
        .unwrap();
        fs::write(
            dir.join(format!("components/{id}/steps/step.md")),
            "Do the thing.\n",
        )
        .unwrap();
    }
}

// ── the no-overlay path is untouched ────────────────────────────────────────────────────────────

#[test]
fn no_overlay_compiles_exactly_as_before() {
    let project = tempfile::tempdir().unwrap();
    overlay_write_project(project.path(), "");

    // The three pre-existing entry points delegate here with `None`, so this is the same body the
    // committed goldens were produced by. That the goldens are unchanged is the real evidence;
    // this pins the local shape.
    let ir = overlay_compile(project.path(), None).expect("the unpatched project must compile");
    let components = ir["components"].as_array().unwrap();
    assert_eq!(components.len(), 1);
    assert_eq!(components[0]["id"], "asker");
}

// ── what a patch may do ─────────────────────────────────────────────────────────────────────────

#[test]
fn an_overlay_mounts_unmounts_binds_and_replaces_the_charter() {
    let project = tempfile::tempdir().unwrap();
    // A ceiling that admits both, so this case is about composition rather than authorisation.
    overlay_write_project(
        project.path(),
        "system_prompt: |\n  Base charter.\nconfig:\n  capability_ceiling: [llm:cheap, data_write]\n",
    );
    let overlay = overlay_write(
        project.path(),
        "overlay: 1\nsystem_prompt: |\n  Patched charter.\nmount:\n  - use: writer\n    bind: { table: orders }\nbind:\n  asker:\n    tone: formal\n",
    );

    let ir = overlay_compile(project.path(), Some(&overlay)).expect("a valid overlay must compile");

    let components = ir["components"].as_array().unwrap();
    assert_eq!(components.len(), 2, "the patch adds one mount");
    let ids: Vec<&str> = components
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&"asker") && ids.contains(&"writer"), "{ids:?}");

    let asker = components.iter().find(|c| c["id"] == "asker").unwrap();
    let writer = components.iter().find(|c| c["id"] == "writer").unwrap();
    assert_eq!(
        asker["binds"]["tone"], "formal",
        "patched bind reaches the IR"
    );
    assert_eq!(writer["binds"]["table"], "orders", "a new mount's bind too");
    // The charter is per-component `brief` in the IR; the patched one must be what appears.
    assert!(
        asker["brief"].as_str().unwrap().contains("Patched charter"),
        "{}",
        asker["brief"]
    );
}

#[test]
fn an_overlay_bind_merges_rather_than_replacing() {
    let project = tempfile::tempdir().unwrap();
    overlay_write_project(project.path(), "");
    // The base supplies `tone`; the patch supplies nothing for it. Merging keeps it — replacing
    // would drop it, which for a component declaring a required bind would break the compile in a
    // way the patch author never asked for.
    fs::write(
        project.path().join("profile.yml"),
        "profile: fixture\ncontext:\n  project: ./context/binding.yml\ncomponents:\n  - use: asker\n    bind:\n      tone: formal\n",
    )
    .unwrap();
    let overlay = overlay_write(
        project.path(),
        "overlay: 1\nbind:\n  asker:\n    other: 1\n",
    );

    let ir = overlay_compile(project.path(), Some(&overlay)).expect("merging bind must compile");
    let binds = &ir["components"][0]["binds"];
    assert_eq!(binds["tone"], "formal", "the base value survives the patch");
}

#[test]
fn an_empty_overlay_is_a_no_op() {
    let project = tempfile::tempdir().unwrap();
    overlay_write_project(project.path(), "");
    let overlay = overlay_write(project.path(), "overlay: 1\n");

    let patched =
        overlay_compile(project.path(), Some(&overlay)).expect("an empty overlay is legal");
    let plain = overlay_compile(project.path(), None).unwrap();
    assert_eq!(
        patched, plain,
        "an empty overlay must change nothing at all"
    );
}

// ── the ordering claim the design rests on ──────────────────────────────────────────────────────

#[test]
fn a_patch_mounting_a_component_outside_the_ceiling_is_refused() {
    let project = tempfile::tempdir().unwrap();
    overlay_write_project(
        project.path(),
        "config:\n  capability_ceiling: [llm:cheap]\n",
    );
    let overlay = overlay_write(project.path(), "overlay: 1\nmount:\n  - use: writer\n");

    // This is the whole reason the patch is applied before `compile` rather than inside it: the
    // ceiling is enforced per mount, so it sees the patched list without anyone arranging an
    // order. Asserted rather than argued, because the design's simplicity depends on it.
    let err = overlay_compile(project.path(), Some(&overlay))
        .expect_err("a patch may not mount past the profile's ceiling");
    assert!(err.contains("writer"), "{err}");
    assert!(err.contains("data_write"), "{err}");
    assert!(err.contains("capability_ceiling"), "{err}");
}

// ── every ambiguous request is refused ──────────────────────────────────────────────────────────

#[test]
fn mounting_an_already_mounted_id_is_refused() {
    let project = tempfile::tempdir().unwrap();
    overlay_write_project(project.path(), "");
    let overlay = overlay_write(project.path(), "overlay: 1\nmount:\n  - use: asker\n");

    let err = overlay_compile(project.path(), Some(&overlay))
        .expect_err("mounting what is already mounted must be refused");
    assert!(err.contains("already mounts"), "{err}");
    assert!(err.contains("asker"), "{err}");
}

#[test]
fn unmounting_an_absent_id_is_refused() {
    let project = tempfile::tempdir().unwrap();
    overlay_write_project(project.path(), "");
    let overlay = overlay_write(project.path(), "overlay: 1\nunmount:\n  - nosuch\n");

    let err = overlay_compile(project.path(), Some(&overlay))
        .expect_err("unmounting something absent must be refused, not silently do nothing");
    assert!(err.contains("nosuch"), "{err}");
    assert!(err.contains("does not mount"), "{err}");
}

#[test]
fn binding_an_absent_id_is_refused() {
    let project = tempfile::tempdir().unwrap();
    overlay_write_project(project.path(), "");
    let overlay = overlay_write(
        project.path(),
        "overlay: 1\nbind:\n  nosuch:\n    tone: formal\n",
    );

    let err = overlay_compile(project.path(), Some(&overlay))
        .expect_err("binding values on something absent must be refused");
    assert!(err.contains("nosuch"), "{err}");
    assert!(err.contains("does not mount"), "{err}");
}

#[test]
fn the_same_id_mounted_and_unmounted_is_refused() {
    let project = tempfile::tempdir().unwrap();
    overlay_write_project(project.path(), "");
    let overlay = overlay_write(
        project.path(),
        "overlay: 1\nmount:\n  - use: writer\nunmount:\n  - writer\n",
    );

    let err = overlay_compile(project.path(), Some(&overlay))
        .expect_err("a contradictory patch must be refused rather than resolved");
    assert!(err.contains("contradictory"), "{err}");
    assert!(err.contains("writer"), "{err}");
}

#[test]
fn mounting_the_same_id_twice_is_refused() {
    let project = tempfile::tempdir().unwrap();
    overlay_write_project(project.path(), "");
    let overlay = overlay_write(
        project.path(),
        "overlay: 1\nmount:\n  - use: writer\n    bind: { table: a }\n  - use: writer\n    bind: { table: b }\n",
    );

    // Last-wins would compile, and would silently discard one of the two bind sets.
    let err = overlay_compile(project.path(), Some(&overlay))
        .expect_err("a duplicate mount must be refused");
    assert!(err.contains("more than once"), "{err}");
}

#[test]
fn unmounting_everything_is_refused() {
    let project = tempfile::tempdir().unwrap();
    overlay_write_project(project.path(), "");
    let overlay = overlay_write(project.path(), "overlay: 1\nunmount:\n  - asker\n");

    let err = overlay_compile(project.path(), Some(&overlay))
        .expect_err("a harness with no behaviors is not a valid product");
    assert!(err.contains("no mounted behaviors"), "{err}");
}

#[test]
fn an_unsupported_format_version_is_refused() {
    let project = tempfile::tempdir().unwrap();
    overlay_write_project(project.path(), "");
    let overlay = overlay_write(project.path(), "overlay: 2\n");

    let err = overlay_compile(project.path(), Some(&overlay))
        .expect_err("an unknown overlay format version must be refused");
    assert!(err.contains("format version 2"), "{err}");
    assert!(
        err.contains("supported: 1"),
        "the message must name what this build accepts: {err}"
    );
}

#[test]
fn an_unknown_overlay_key_is_refused() {
    let project = tempfile::tempdir().unwrap();
    overlay_write_project(project.path(), "");
    // `tier_overrides` is the key most likely to be assumed present. Accepting and ignoring it
    // would let a deployment believe it had changed a tier when nothing had happened.
    let overlay = overlay_write(
        project.path(),
        "overlay: 1\ntier_overrides:\n  asker:\n    step: strong\n",
    );

    let err = overlay_compile(project.path(), Some(&overlay))
        .expect_err("an unknown overlay key must be refused, not ignored");
    assert!(err.contains("tier_overrides"), "{err}");
}

#[test]
fn a_contradictory_patch_changes_nothing_before_failing() {
    let project = tempfile::tempdir().unwrap();
    overlay_write_project(project.path(), "system_prompt: |\n  Base charter.\n");
    // The charter replacement is legal and the unmount is not. Validation runs before any
    // mutation, so this must fail without the profile having been half-patched — otherwise a
    // caller reusing the parsed profile would carry a partial application forward.
    let overlay = overlay_write(
        project.path(),
        "overlay: 1\nsystem_prompt: |\n  Patched charter.\nunmount:\n  - nosuch\n",
    );

    let err = overlay_compile(project.path(), Some(&overlay)).expect_err("the unmount is invalid");
    assert!(err.contains("nosuch"), "{err}");

    let plain = overlay_compile(project.path(), None).unwrap();
    assert!(
        plain["components"][0]["brief"]
            .as_str()
            .unwrap()
            .contains("Base charter"),
        "a refused patch must leave nothing behind: {}",
        plain["components"][0]["brief"]
    );
}
