//! End-to-end coverage for `warble compile`'s multi-source composition: the `--hub-dir` and
//! `--component-dir` flags. The unit tests in `cli/src/lib.rs` cover `resolve_component_dir`
//! directly; this file drives the real binary so the flag-to-source wiring in `run_compile`
//! (which the unit tests can't see) is locked in — in particular that `--hub-dir` replaces the
//! Hub source *by kind* (keeping any local override), not by list position.

use std::path::{Path, PathBuf};
use std::process::Command;

fn example_dir(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(name)
}

/// The in-repo Hub component library, as an explicit path to hand to `--component-dir`.
fn in_repo_hub() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("hub/components")
}

struct Compiled {
    code: Option<i32>,
    stderr: String,
}

fn run_compile(project: &Path, extra_args: &[&std::ffi::OsStr]) -> Compiled {
    let out = tempfile::tempdir().expect("tempdir");
    let output = Command::new(env!("CARGO_BIN_EXE_warble"))
        .arg("compile")
        .arg(project)
        .arg("--out")
        .arg(out.path().join("ir.json"))
        .args(extra_args)
        .output()
        .expect("warble compile runs");
    Compiled {
        code: output.status.code(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

/// `--hub-dir` must swap the Hub source *by kind*, leaving the project's own local override in
/// place: driftwood-agent overrides `answer_query` locally, so pointing the Hub at an empty dir
/// still compiles because the local source is (correctly) retained and consulted first.
#[test]
fn hub_dir_override_keeps_the_projects_local_override() {
    let empty_hub = tempfile::tempdir().expect("tempdir");
    let result = run_compile(
        &example_dir("examples/driftwood-agent"),
        &["--hub-dir".as_ref(), empty_hub.path().as_os_str()],
    );
    assert_eq!(
        result.code,
        Some(0),
        "local answer_query override should resolve even with an empty hub; stderr: {}",
        result.stderr
    );
}

/// The flip side: for a project with no local override, `--hub-dir` genuinely *replaces* the real
/// Hub (it does not append a second one alongside it), so an empty override dir makes the mounted
/// hub component unresolvable — a loud failure naming the search, not a silent fallback.
#[test]
fn hub_dir_override_replaces_the_real_hub() {
    let empty_hub = tempfile::tempdir().expect("tempdir");
    let result = run_compile(
        &example_dir("examples/monitor-agent"),
        &["--hub-dir".as_ref(), empty_hub.path().as_os_str()],
    );
    assert_eq!(result.code, Some(1), "unresolved component must fail");
    assert!(
        result.stderr.contains("monitor_freshness")
            && result.stderr.contains("not found in any configured source"),
        "error should name the unresolved component and the searched sources; stderr: {}",
        result.stderr
    );
}

/// `--component-dir` supplies a mounted component from an external library — the motivating case
/// (a product-specific component dir sitting outside this repo). With the Hub emptied, the extra
/// Local source is what makes `monitor_freshness` resolve.
#[test]
fn component_dir_supplies_a_mounted_component() {
    let empty_hub = tempfile::tempdir().expect("tempdir");
    let result = run_compile(
        &example_dir("examples/monitor-agent"),
        &[
            "--hub-dir".as_ref(),
            empty_hub.path().as_os_str(),
            "--component-dir".as_ref(),
            in_repo_hub().as_os_str(),
        ],
    );
    assert_eq!(
        result.code,
        Some(0),
        "monitor_freshness should resolve from the extra --component-dir; stderr: {}",
        result.stderr
    );
}

/// A `--component-dir` that also defines an id the project already provides locally is two
/// same-kind sources for one id — ambiguous, so it must loud-fail rather than pick one.
/// driftwood-agent has a local `answer_query`; pointing `--component-dir` at the Hub (which also
/// defines `answer_query`) collides.
#[test]
fn component_dir_colliding_with_local_components_is_ambiguous() {
    let result = run_compile(
        &example_dir("examples/driftwood-agent"),
        &["--component-dir".as_ref(), in_repo_hub().as_os_str()],
    );
    assert_eq!(result.code, Some(1), "ambiguous resolution must fail");
    assert!(
        result.stderr.contains("answer_query") && result.stderr.contains("ambiguous"),
        "error should flag the ambiguous component; stderr: {}",
        result.stderr
    );
}
