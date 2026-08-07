//! End-to-end proof that `model_has_timestamp` honors `args.model` (the PINNED mode, not the old
//! existential "some model somewhere has a timestamp" mode) using the SAME real hub
//! `monitor_freshness` component and the SAME multi-model `jaffle-wren` project as the
//! `genbi-monitor` golden -- only the bound model differs.
//!
//! jaffle-wren's `orders`/`customers` models DO carry a timestamp column (that's what makes the
//! genbi-monitor golden compile). Under the pre-bind-resolution existential semantics, ANY bind
//! against this project would have passed, because *some* model in it has a timestamp. Binding
//! `monitor_freshness` to `raw_payments` instead (INT/TEXT columns only, no timestamp) must still
//! loud-fail at compile time -- proving the pinned check really targets the named model, not just
//! "does this project have a timestamp anywhere."
//!
//! This is a separate file from `freshness_precondition.rs` on purpose: that file's fixture is a
//! synthetic, single-model wren project (its own point is "a project with literally no timestamped
//! model anywhere refuses to compile"). This test instead reuses the real jaffle-wren project (whose
//! *other* models do have timestamps) and the real Hub component, which is the only way to
//! discriminate pinned-by-name enforcement from existential enforcement.

use std::fs;
use std::path::{Path, PathBuf};

use warble_cli::compile_project_to_ir;

/// jaffle-wren, resolved once as an absolute path so the fixture project (written into a tempdir
/// elsewhere on disk) can bind to it regardless of its own working directory.
fn jaffle_wren_abs() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("examples/jaffle-wren")
        .canonicalize()
        .expect("examples/jaffle-wren must exist in this checkout")
}

/// Write a one-component Warble project into `dir` that mounts the real Hub `monitor_freshness`
/// component (resolved via the default component sources' Hub fallback -- no local component copy
/// needed) bound to `model` in the real jaffle-wren project at `wren_abs`.
fn write_monitor_fixture(dir: &Path, wren_abs: &Path, model: &str) {
    fs::create_dir_all(dir.join("context")).unwrap();
    fs::write(
        dir.join("profile.yml"),
        format!(
            "profile: fixture-multi-model\ncontext:\n  project: ./context/binding.yml\ncomponents:\n  - use: monitor_freshness\n    bind:\n      model: {model}\n"
        ),
    )
    .unwrap();
    fs::write(
        dir.join("context/binding.yml"),
        format!("project: {}\n", wren_abs.display()),
    )
    .unwrap();
}

#[test]
fn monitoring_a_timestampless_model_in_a_multi_model_project_fails_to_compile() {
    let wren_abs = jaffle_wren_abs();

    let project = tempfile::tempdir().unwrap();
    write_monitor_fixture(project.path(), &wren_abs, "raw_payments");

    let err = compile_project_to_ir(project.path()).expect_err(
        "binding monitor_freshness to raw_payments (no timestamp column) must be refused, even \
         though this SAME jaffle-wren project has other models (orders, customers) that DO carry \
         one -- proving the check is pinned to the named model, not existential over the project",
    );
    assert!(
        err.contains("model_has_timestamp") && err.contains("not satisfied"),
        "expected a model_has_timestamp rejection, got: {err}"
    );
    assert!(
        err.contains("monitor_freshness"),
        "the message must name the offending component so the failure is actionable: {err}"
    );
}
