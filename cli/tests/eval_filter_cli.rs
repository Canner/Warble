//! CLI-level checks for the stratified-eval flags (`--tags` / `--sample`).
//!
//! These exercise the two paths that fail *before* the runner shells out to `claude`, so they run
//! in CI without a live agent: an unparseable `--sample`, and a `--tags` filter that selects zero
//! cases from a real golden. The selection logic itself is unit-tested in `warble-eval-runner`.

use std::process::Command;

fn warble() -> Command {
    Command::new(env!("CARGO_BIN_EXE_warble"))
}

/// The committed driftwood golden (tagged cases) resolved from this crate's manifest dir.
fn driftwood_golden() -> String {
    format!(
        "{}/../eval/golden/driftwood/cases.yaml",
        env!("CARGO_MANIFEST_DIR")
    )
}

#[test]
fn invalid_sample_value_fails_fast_with_guidance() {
    let out = warble()
        .args([
            "eval",
            "run",
            "--project",
            "/nonexistent",
            "--agent-dir",
            "/nonexistent",
            "--golden",
            "/nonexistent.yaml",
            "--sample",
            "not-a-number",
        ])
        .output()
        .expect("run warble");
    assert!(!out.status.success(), "invalid --sample must exit non-zero");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("--sample"),
        "error should name the offending flag, got: {stderr}"
    );
}

#[test]
fn tags_matching_no_case_errors_before_running_claude() {
    // A real golden but a tag no case carries: select_and_subset must refuse rather than run zero
    // cases (and it happens before agent install / any `claude` call, so no live agent is needed).
    let out = warble()
        .args([
            "eval",
            "run",
            "--project",
            "/nonexistent",
            "--agent-dir",
            "/nonexistent",
            "--golden",
            &driftwood_golden(),
            "--tags",
            "__no_such_tag__",
        ])
        .output()
        .expect("run warble");
    assert!(
        !out.status.success(),
        "an empty tag selection must exit non-zero"
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("no golden cases match"),
        "error should explain the empty selection, got: {stderr}"
    );
}

#[test]
fn unsupported_backend_fails_fast_naming_the_supported_set() {
    // `--backend vercel` is a real dispatcher target, but it has no eval-runner adapter yet.
    // `resolve_adapter` must reject it before any agent install / `claude` call — through the
    // real compiled binary, not a direct unit call into `resolve_adapter` itself.
    let out = warble()
        .args([
            "eval",
            "run",
            "--project",
            "/nonexistent",
            "--agent-dir",
            "/nonexistent",
            "--golden",
            &driftwood_golden(),
            "--backend",
            "vercel",
        ])
        .output()
        .expect("run warble");
    assert!(
        !out.status.success(),
        "an adapter-less --backend must exit non-zero"
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("vercel") && stderr.contains("no eval runner adapter"),
        "error should name the requested backend and explain why, got: {stderr}"
    );
    assert!(
        stderr.contains("claude-code-cli") && stderr.contains("claude-agent-sdk"),
        "error should name the supported backends, got: {stderr}"
    );
}

#[test]
fn per_tag_sample_is_accepted_and_selects_a_subset() {
    // `--sample per-tag:1` parses and reaches the selection note (printed to stderr) before the
    // agent step fails on the dummy dir — proving the flag threads through to the runner.
    let out = warble()
        .args([
            "eval",
            "run",
            "--project",
            "/nonexistent",
            "--agent-dir",
            "/nonexistent",
            "--golden",
            &driftwood_golden(),
            "--sample",
            "per-tag:1",
        ])
        .output()
        .expect("run warble");
    let stderr = String::from_utf8_lossy(&out.stderr);
    // The no-silent-caps selection note is emitted for the driftwood golden (53 cases → a subset).
    assert!(
        stderr.contains("golden selection:") && stderr.contains("per-tag:1"),
        "expected the selection note on stderr, got: {stderr}"
    );
    assert!(
        stderr.contains("/53"),
        "note should show the subset out of the 53-case total, got: {stderr}"
    );
}
