//! End-to-end coverage for `warble dispatch --target wrenai*`: compiles a real project through the
//! real `warble compile` binary, dispatches the resulting IR through the wrenai bundle target, and
//! asserts the emitted `bundle.json` is well-formed. `genbi-default` is the project used here — it's
//! the same fixture the `warble-wrenai` crate's own emit tests exercise directly (via its checked-in
//! `ir.golden.json`), so it's known to compile cleanly through every enum arm the wrenai back-end
//! currently realizes (skill/tool/gated-tool realizations, one_shot/scheduled triggers, and
//! none/assertion/mutation outcomes).

use std::path::{Path, PathBuf};
use std::process::Command;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn compile_genbi_default_to(out_ir: &Path) {
    let output = Command::new(env!("CARGO_BIN_EXE_warble"))
        .arg("compile")
        .arg(repo_root().join("genbi-default"))
        .arg("--out")
        .arg(out_ir)
        .output()
        .expect("warble compile runs");
    assert_eq!(
        output.status.code(),
        Some(0),
        "genbi-default must compile; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn dispatch(ir_path: &Path, target: &str, out_dir: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_warble"))
        .arg("dispatch")
        .arg(ir_path)
        .arg("--target")
        .arg(target)
        .arg("--out")
        .arg(out_dir)
        .output()
        .expect("warble dispatch runs")
}

#[test]
fn target_wrenai_emits_a_bundle_json() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let ir_path = tmp.path().join("ir.json");
    compile_genbi_default_to(&ir_path);

    let bundle_dir = tmp.path().join("bundle-dir");
    let output = dispatch(&ir_path, "wrenai", &bundle_dir);
    assert_eq!(
        output.status.code(),
        Some(0),
        "dispatch --target wrenai must succeed; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let bundle_path = bundle_dir.join("bundle.json");
    assert!(
        bundle_path.exists(),
        "expected {} to exist",
        bundle_path.display()
    );
    let bundle: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&bundle_path).expect("read bundle.json"))
            .expect("bundle.json must parse as JSON");
    assert!(
        bundle.get("wrenai_bundle_version").is_some(),
        "bundle.json must carry a wrenai_bundle_version field; got: {bundle}"
    );
}

#[test]
fn target_wrenai_interactive_also_emits_a_bundle_json() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let ir_path = tmp.path().join("ir.json");
    compile_genbi_default_to(&ir_path);

    let bundle_dir = tmp.path().join("bundle-dir");
    let output = dispatch(&ir_path, "wrenai:interactive", &bundle_dir);
    assert_eq!(
        output.status.code(),
        Some(0),
        "dispatch --target wrenai:interactive must succeed; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let bundle_path = bundle_dir.join("bundle.json");
    let bundle: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&bundle_path).expect("read bundle.json"))
            .expect("bundle.json must parse as JSON");
    assert_eq!(bundle["target"], serde_json::json!("wrenai:interactive"));
}

#[test]
fn unknown_wrenai_target_fails_loudly_with_known_names() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let ir_path = tmp.path().join("ir.json");
    compile_genbi_default_to(&ir_path);

    let bundle_dir = tmp.path().join("bundle-dir");
    let output = dispatch(&ir_path, "wrenai:bogus", &bundle_dir);
    assert_ne!(
        output.status.code(),
        Some(0),
        "an unknown wrenai target must fail"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("wrenai:bogus")
            && stderr.contains("wrenai:headless")
            && stderr.contains("wrenai:interactive"),
        "error should name the bad target and list the known ones; stderr: {stderr}"
    );
}
