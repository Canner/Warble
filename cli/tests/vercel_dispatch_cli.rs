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

/// The generically-named sample provider fragment (shared with `warble-vercel`'s own integration
/// tests, see `dispatcher/vercel/tests/fixtures/sample-provider.yaml`) supplying the domain
/// capabilities `genbi-default` requires, via invented, non-product mechanism names.
fn sample_provider_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("dispatcher")
        .join("vercel")
        .join("tests")
        .join("fixtures")
        .join("sample-provider.yaml")
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
        "--provider".as_ref(),
        sample_provider_path().as_os_str(),
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
        "--provider".as_ref(),
        sample_provider_path().as_os_str(),
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

/// The base vercel target's profile only resolves substrate capabilities — domain capabilities
/// (`sql_execution:read_only`, `semantic_introspection`, ...) are supplied by a `--provider`
/// fragment. Confirm a bare dispatch (no `--provider` at all) loud-fails naming the unresolved
/// domain capability, rather than silently emitting a bundle with those tools missing.
#[test]
fn bare_dispatch_with_no_provider_loud_fails_naming_a_domain_capability() {
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
        !output.status.success(),
        "a bare dispatch with no --provider must fail: genbi-default requires domain capabilities \
         the base vercel target does not resolve on its own"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("semantic_introspection"),
        "error should name the unresolved domain capability; stderr: {stderr}"
    );
    assert!(
        !out_dir.exists() || std::fs::read_dir(&out_dir).unwrap().count() == 0,
        "out_dir must not contain a partial bundle when dispatch fails"
    );
}

/// With `--provider` supplied, the emitted bundle's tool bindings for domain capabilities come
/// from that provider fragment, not from any base/built-in mapping — pins the provider mechanism
/// as the actual source of those `ToolRef`s.
#[test]
fn provider_supplied_capability_tools_are_sourced_from_the_provider_fragment() {
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
        "--provider".as_ref(),
        sample_provider_path().as_os_str(),
    ]);
    assert!(
        output.status.success(),
        "warble dispatch --target vercel --provider ... should succeed; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let raw = std::fs::read_to_string(out_dir.join("bundle.json")).expect("read bundle.json");
    let bundle: serde_json::Value =
        serde_json::from_str(&raw).expect("bundle.json must parse as JSON");
    let agents = bundle
        .get("agents")
        .and_then(|v| v.as_array())
        .expect("bundle should have an agents array");
    let answer_query = agents
        .iter()
        .find(|a| a.get("id").and_then(|v| v.as_str()) == Some("answer_query"))
        .expect("answer_query agent should be present");
    let tools = answer_query
        .get("tools")
        .and_then(|v| v.as_array())
        .expect("answer_query should have a tools array");
    let sources: Vec<&str> = tools
        .iter()
        .filter_map(|t| t.get("source").and_then(|v| v.as_str()))
        .collect();
    assert!(
        sources.iter().any(|s| s.starts_with("mcp:sample/")),
        "answer_query's tools should include a provider-sourced tool (mcp:sample/...); sources: {sources:?}"
    );
}
