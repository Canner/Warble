//! End-to-end CLI coverage for `warble dispatch --target vercel[:mode]`: compiles the repo's
//! `genbi-default` flagship profile to IR through the real binary, then dispatches that IR through
//! the vercel back-end and inspects the emitted `bundle.json` — locking in the `--target vercel`
//! routing added to `run_dispatch` in `cli/src/main.rs`.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn genbi_default_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("genbi-default")
}

fn run_warble(args: &[&std::ffi::OsStr]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_warble"))
        .args(args)
        .output()
        .expect("warble runs")
}

/// Compile `genbi-default` to an `ir.json` inside `dir` via the real `warble compile`, returning
/// its path. Panics (failing the test loudly) if compilation itself fails — that would mean the
/// fixture is broken, not that the vercel dispatch path under test is.
fn compile_genbi_default_ir(dir: &Path) -> PathBuf {
    let ir_path = dir.join("ir.json");
    let output = run_warble(&[
        "compile".as_ref(),
        genbi_default_dir().as_os_str(),
        "--out".as_ref(),
        ir_path.as_os_str(),
    ]);
    assert!(
        output.status.success(),
        "warble compile genbi-default should succeed; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    ir_path
}

#[test]
fn target_vercel_emits_a_bundle_with_a_version_field() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let ir_path = compile_genbi_default_ir(tmp.path());
    let out_dir = tmp.path().join("out");

    let output = run_warble(&[
        "dispatch".as_ref(),
        ir_path.as_os_str(),
        "--target".as_ref(),
        "vercel".as_ref(),
        "--out".as_ref(),
        out_dir.as_os_str(),
    ]);
    assert!(
        output.status.success(),
        "warble dispatch --target vercel should succeed; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let bundle_path = out_dir.join("bundle.json");
    assert!(
        bundle_path.exists(),
        "bundle.json should be written to --out"
    );
    let raw = std::fs::read_to_string(&bundle_path).expect("read bundle.json");
    let bundle: serde_json::Value =
        serde_json::from_str(&raw).expect("bundle.json must parse as JSON");
    assert!(
        bundle.get("vercel_bundle_version").is_some(),
        "bundle should carry a vercel_bundle_version field; bundle: {bundle}"
    );
}

#[test]
fn target_vercel_interactive_selects_the_interactive_mode() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let ir_path = compile_genbi_default_ir(tmp.path());
    let out_dir = tmp.path().join("out");

    let output = run_warble(&[
        "dispatch".as_ref(),
        ir_path.as_os_str(),
        "--target".as_ref(),
        "vercel:interactive".as_ref(),
        "--out".as_ref(),
        out_dir.as_os_str(),
    ]);
    assert!(
        output.status.success(),
        "warble dispatch --target vercel:interactive should succeed; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let raw = std::fs::read_to_string(out_dir.join("bundle.json")).expect("read bundle.json");
    let bundle: serde_json::Value =
        serde_json::from_str(&raw).expect("bundle.json must parse as JSON");
    assert_eq!(
        bundle.get("target").and_then(|v| v.as_str()),
        Some("vercel:interactive"),
        "bundle's target field should reflect the selected mode; bundle: {bundle}"
    );
}

#[test]
fn unknown_vercel_target_fails_loudly_naming_the_known_targets() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let ir_path = compile_genbi_default_ir(tmp.path());
    let out_dir = tmp.path().join("out");

    let output = run_warble(&[
        "dispatch".as_ref(),
        ir_path.as_os_str(),
        "--target".as_ref(),
        "vercel:bogus".as_ref(),
        "--out".as_ref(),
        out_dir.as_os_str(),
    ]);
    assert!(
        !output.status.success(),
        "an unknown vercel target should fail rather than silently fall back"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("vercel:bogus"),
        "error should name the bad target; stderr: {stderr}"
    );
    assert!(
        stderr.contains("vercel:headless"),
        "error should list vercel:headless as a known target; stderr: {stderr}"
    );
    assert!(
        stderr.contains("vercel:interactive"),
        "error should list vercel:interactive as a known target; stderr: {stderr}"
    );
}
