//! End-to-end tests for the asset manifest on the real compile path: what reaches the IR, what is
//! deliberately kept out of it, and the two classes of refusal (an escaping/missing path, and a
//! field an author must not write).
//!
//! These live here rather than beside the compiler because both refusals happen while the host
//! parses and resolves files — core never opens one — so only this path returns them as errors.

use std::fs;
use std::path::Path;

use warble_cli::compile_project_to_ir;

const CSS: &[u8] = b"body { color: white }\n";
/// `sha256` of `CSS`, taken from outside this workspace so the assertion cannot merely agree with
/// the implementation it checks:
///
/// ```text
/// $ printf 'body { color: white }\n' | shasum -a 256
/// 9869fecca739acd9fa21143a226e014380324c1a4ee49d863f0371ff5d0d18d6
/// ```
///
/// `openssl dgst -sha256` gives the same value.
const CSS_SHA256: &str = "sha256:9869fecca739acd9fa21143a226e014380324c1a4ee49d863f0371ff5d0d18d6";

/// A one-component project with an `assets:` block built from `asset_entries`, plus whatever files
/// `asset_files` names, written inside the component directory.
fn write_project(dir: &Path, asset_entries: &str, asset_files: &[(&str, &[u8])]) {
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
{asset_entries}"#
        ),
    )
    .unwrap();
    fs::write(
        dir.join("components/asker/steps/ask.md"),
        "Ask something.\n",
    )
    .unwrap();
    for (rel, content) in asset_files {
        let path = dir.join("components/asker").join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
}

#[test]
fn an_asset_reaches_the_ir_as_path_hash_and_size() {
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        "assets:\n  - path: themes/dark.css\n",
        &[("themes/dark.css", CSS)],
    );

    let ir = compile_project_to_ir(project.path()).expect("a declared asset must compile");
    let assets = ir["components"][0]["assets"].as_array().unwrap();
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0]["path"], "themes/dark.css");
    assert_eq!(assets[0]["bytes"], CSS.len() as u64);
    // Pinned against a hash computed outside this crate, so a change in how the digest is produced
    // (or a truncated/misformatted one) fails rather than agreeing with itself.
    assert_eq!(assets[0]["hash"], CSS_SHA256);
}

#[test]
fn asset_content_never_appears_in_the_ir() {
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        "assets:\n  - path: themes/dark.css\n",
        &[("themes/dark.css", CSS)],
    );

    let ir = compile_project_to_ir(project.path()).unwrap();
    let serialized = serde_json::to_string(&ir).unwrap();
    // The whole point of the manifest: an asset is a file that must exist on disk at run time, not
    // prompt text. Base64-ing binaries into every IR is the outcome this line exists to prevent.
    assert!(
        !serialized.contains("color: white"),
        "asset content must not be carried in the IR"
    );
}

#[test]
fn several_assets_keep_their_declared_order() {
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        "assets:\n  - path: themes/dark.css\n  - path: templates/basic.md\n",
        &[
            ("themes/dark.css", CSS),
            ("templates/basic.md", b"# Basic\n"),
        ],
    );

    let ir = compile_project_to_ir(project.path()).unwrap();
    let assets = ir["components"][0]["assets"].as_array().unwrap();
    assert_eq!(assets[0]["path"], "themes/dark.css");
    assert_eq!(assets[1]["path"], "templates/basic.md");
}

#[test]
fn an_asset_path_escaping_with_dotdot_is_rejected() {
    let project = tempfile::tempdir().unwrap();
    write_project(project.path(), "assets:\n  - path: ../../escape.css\n", &[]);

    let err = compile_project_to_ir(project.path())
        .expect_err("an escaping asset path must never compile");
    assert!(
        err.contains("asset '../../escape.css'"),
        "the error must name the offending asset: {err}"
    );
}

#[test]
fn an_absolute_asset_path_is_rejected() {
    let project = tempfile::tempdir().unwrap();
    write_project(project.path(), "assets:\n  - path: /etc/passwd\n", &[]);

    let err = compile_project_to_ir(project.path())
        .expect_err("an absolute asset path must never compile");
    assert!(err.contains("asset '/etc/passwd'"), "{err}");
}

#[test]
fn a_missing_asset_is_rejected() {
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        "assets:\n  - path: themes/absent.css\n",
        &[],
    );

    let err = compile_project_to_ir(project.path())
        .expect_err("an asset naming a file that does not exist must never compile");
    assert!(err.contains("asset 'themes/absent.css'"), "{err}");
    assert!(err.contains("does not exist"), "{err}");
}

#[test]
fn an_authored_asset_hash_is_rejected_rather_than_silently_replaced() {
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        "assets:\n  - path: themes/dark.css\n    hash: \"sha256:deadbeef\"\n",
        &[("themes/dark.css", CSS)],
    );

    // An author-written hash is a claim about file content that nothing keeps true. Computing over
    // it would be nearly as bad as trusting it — the author would go on believing the field means
    // something. Asserted on the parse rejection specifically, not merely on the word "hash"
    // appearing, since a value-level complaint would also mention it.
    let err = compile_project_to_ir(project.path())
        .expect_err("an authored hash must be refused, not replaced");
    assert!(
        err.contains("unknown field") && err.contains("hash"),
        "the parse must reject the field by name: {err}"
    );
}

#[test]
fn an_authored_asset_size_is_rejected() {
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        "assets:\n  - path: themes/dark.css\n    bytes: 12\n",
        &[("themes/dark.css", CSS)],
    );

    let err = compile_project_to_ir(project.path()).expect_err("an authored size must be refused");
    assert!(
        err.contains("unknown field") && err.contains("bytes"),
        "the parse must reject the field by name: {err}"
    );
}
