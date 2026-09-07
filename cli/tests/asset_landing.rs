//! End-to-end proof that a component's declared assets reach the directory an agent runs in.
//!
//! IR 0.7 let a component declare `assets:` and compile recorded each file's identity, but nothing
//! consumed the manifest: a component declared its files and the agent then ran in a directory that
//! did not contain them, with no error at all. These tests cover the whole path — compile writes the
//! content beside the IR, dispatch lands it and verifies every hash — and the two refusals, since a
//! silent partial landing is what made the original defect hard to see.
//!
//! See decision-101 for why the content travels beside the IR rather than being re-read from a
//! component directory (there is none at dispatch) or carried inside the IR (deliberately not).

use std::fs;
use std::path::Path;

use warble_cli::{
    asset_dir_for_ir, compile_project_to_ir_with_assets, land_assets, write_assets,
    BuiltinContextResolver, ComponentSource,
};

/// A one-component project. `assets` is spliced into `component.yml` verbatim so a test can declare
/// none at all and prove the no-asset path is untouched.
fn write_project(dir: &Path, assets: &str) {
    fs::create_dir_all(dir.join("context")).unwrap();
    fs::create_dir_all(dir.join("wren/models/widgets")).unwrap();
    fs::create_dir_all(dir.join("components/asker/steps")).unwrap();
    fs::create_dir_all(dir.join("components/asker/themes")).unwrap();
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
{assets}
"#
        ),
    )
    .unwrap();
    fs::write(
        dir.join("components/asker/steps/ask.md"),
        "Ask something.\n",
    )
    .unwrap();
    fs::write(
        dir.join("components/asker/themes/dark.css"),
        "body { color: black }\n",
    )
    .unwrap();
}

const DECLARES_ONE_ASSET: &str = "assets:\n  - path: themes/dark.css";

fn compile(project: &Path) -> (serde_json::Value, warble_cli::CompiledAssets) {
    let sources = vec![ComponentSource::local(project.join("components"))];
    compile_project_to_ir_with_assets(project, &sources, &BuiltinContextResolver, None)
        .expect("the fixture project must compile")
}

#[test]
fn a_declared_asset_reaches_the_directory_the_agent_runs_in() {
    let project = tempfile::tempdir().unwrap();
    write_project(project.path(), DECLARES_ONE_ASSET);
    let (ir, assets) = compile(project.path());

    // Compile hands back the content, and writes it beside the IR.
    let staging = tempfile::tempdir().unwrap();
    let ir_path = staging.path().join("ir.json");
    fs::write(&ir_path, serde_json::to_string_pretty(&ir).unwrap()).unwrap();
    write_assets(&asset_dir_for_ir(&ir_path), &assets).unwrap();
    assert!(
        asset_dir_for_ir(&ir_path)
            .join("asker/themes/dark.css")
            .exists(),
        "compile writes the content beside the IR, since nothing downstream can re-read it"
    );

    // Dispatch lands it into the working directory, at the authored relative path.
    let out = tempfile::tempdir().unwrap();
    let landed = land_assets(&ir, &ir_path, out.path()).expect("landing must succeed");
    assert_eq!(landed.len(), 1);
    assert_eq!(
        fs::read_to_string(out.path().join("themes/dark.css")).unwrap(),
        "body { color: black }\n",
        "the agent's working directory holds the file the component declared"
    );
}

#[test]
fn an_asset_missing_from_the_travelling_directory_is_refused() {
    // The case a copied IR produces: the manifest names a file that did not come with it. Loud,
    // because silently running without it is precisely the defect this closes.
    let project = tempfile::tempdir().unwrap();
    write_project(project.path(), DECLARES_ONE_ASSET);
    let (ir, _assets) = compile(project.path());

    let staging = tempfile::tempdir().unwrap();
    let ir_path = staging.path().join("ir.json");
    fs::write(&ir_path, serde_json::to_string_pretty(&ir).unwrap()).unwrap();
    // Deliberately no `write_assets`.

    let out = tempfile::tempdir().unwrap();
    let err = land_assets(&ir, &ir_path, out.path()).expect_err("a missing asset must refuse");
    assert!(
        err.contains("declared in the IR but missing from"),
        "unexpected message: {err}"
    );
    assert!(
        !out.path().join("themes/dark.css").exists(),
        "and nothing is left half-landed"
    );
}

#[test]
fn an_asset_whose_content_changed_after_compile_is_refused() {
    let project = tempfile::tempdir().unwrap();
    write_project(project.path(), DECLARES_ONE_ASSET);
    let (ir, assets) = compile(project.path());

    let staging = tempfile::tempdir().unwrap();
    let ir_path = staging.path().join("ir.json");
    fs::write(&ir_path, serde_json::to_string_pretty(&ir).unwrap()).unwrap();
    write_assets(&asset_dir_for_ir(&ir_path), &assets).unwrap();
    // Same path, different bytes: the manifest now names content that is not there.
    fs::write(
        asset_dir_for_ir(&ir_path).join("asker/themes/dark.css"),
        "body { color: red }\n",
    )
    .unwrap();

    let out = tempfile::tempdir().unwrap();
    let err = land_assets(&ir, &ir_path, out.path()).expect_err("a hash mismatch must refuse");
    assert!(
        err.contains("does not match its manifest"),
        "unexpected message: {err}"
    );
}

#[test]
fn a_component_declaring_no_assets_is_untouched() {
    let project = tempfile::tempdir().unwrap();
    write_project(project.path(), "");
    let (ir, assets) = compile(project.path());

    assert!(assets.is_empty(), "nothing is collected");
    assert!(
        ir["components"][0].get("assets").is_none(),
        "and the IR carries no assets key, exactly as before this existed"
    );

    let staging = tempfile::tempdir().unwrap();
    let ir_path = staging.path().join("ir.json");
    fs::write(&ir_path, serde_json::to_string_pretty(&ir).unwrap()).unwrap();
    write_assets(&asset_dir_for_ir(&ir_path), &assets).unwrap();
    assert!(
        !asset_dir_for_ir(&ir_path).exists(),
        "no directory is created for a project without assets"
    );

    let out = tempfile::tempdir().unwrap();
    assert!(land_assets(&ir, &ir_path, out.path()).unwrap().is_empty());
}
