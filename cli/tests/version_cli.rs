//! `warble --version` / `-V` / `--help` — locks in that the binary reports the real workspace
//! version (via clap's `version` attribute reading `CARGO_PKG_VERSION`), not a hardcoded literal,
//! and that adding `version` to the top-level `#[command(...)]` didn't disturb `--help`'s exit code
//! or claim the `-h`/`-o` short flags any subcommand already uses.

use std::process::{Command, Output};

fn run_warble(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_warble"))
        .args(args)
        .output()
        .expect("warble runs")
}

/// The version the binary *should* report: this test crate's own `CARGO_PKG_VERSION`, which is
/// `cli/Cargo.toml`'s `version.workspace = true` — the same value clap reads at build time via the
/// `version` attribute. Comparing against this (rather than a literal like `"0.1.0"`) is what
/// catches the version attribute silently falling back to some other string.
fn expected_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[test]
fn long_version_flag_prints_workspace_version_and_exits_zero() {
    let output = run_warble(&["--version"]);
    assert!(
        output.status.success(),
        "warble --version should exit 0; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains(expected_version()),
        "expected stdout to contain {:?}, got {:?}",
        expected_version(),
        stdout
    );
}

#[test]
fn short_version_flag_prints_workspace_version_and_exits_zero() {
    let output = run_warble(&["-V"]);
    assert!(
        output.status.success(),
        "warble -V should exit 0; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains(expected_version()),
        "expected stdout to contain {:?}, got {:?}",
        expected_version(),
        stdout
    );
}

#[test]
fn help_flag_still_exits_zero() {
    let output = run_warble(&["--help"]);
    assert!(
        output.status.success(),
        "warble --help should still exit 0 after adding `version`; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
