//! `eval compliance --ir` rejects an out-of-range `warble_ir_version` before the IR is ever handed
//! to the compliance scorer — closing the one remaining gap in IR-version enforcement: `dispatch`
//! (both Rust back-ends), `manifest`, `eval ablate`, and the TS `parseIr`/`prepareDispatch` all
//! already validated `warble_ir_version`; `eval compliance` alone read straight past it.
//!
//! Reuses the same cross-back-end conformance fixture the other three back-ends assert against
//! (`dispatcher/conformance-fixtures/ir-version-mismatch.json`), so `eval compliance` becomes a
//! fourth documented consumer of that shared contract rather than a one-off check with its own
//! fixture and its own drift risk.

use std::path::Path;
use std::process::{Command, Output};

const VERSION_MISMATCH_FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../dispatcher/conformance-fixtures/ir-version-mismatch.json"
);

fn run_warble(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_warble"))
        .args(args)
        .output()
        .expect("warble runs")
}

/// A minimal, schema-valid `ComplianceTrace` — this test is exercising the IR-side gate, not the
/// scorer, so the trace's shape doesn't matter beyond deserializing.
fn write_minimal_trace(dir: &Path) -> std::path::PathBuf {
    let path = dir.join("trace.json");
    std::fs::write(&path, r#"{"component":"answer_query","events":[]}"#)
        .expect("write trace fixture");
    path
}

#[test]
fn eval_compliance_rejects_the_shared_cross_back_end_version_mismatch_fixture() {
    let raw = std::fs::read_to_string(VERSION_MISMATCH_FIXTURE)
        .unwrap_or_else(|e| panic!("read {VERSION_MISMATCH_FIXTURE}: {e}"));
    let fixture: serde_json::Value = serde_json::from_str(&raw).expect("fixture is valid JSON");
    let expected: Vec<&str> = fixture["expected_error_contains"]
        .as_array()
        .expect("expected_error_contains is an array")
        .iter()
        .map(|v| {
            v.as_str()
                .expect("expected_error_contains entries are strings")
        })
        .collect();

    let tmp = tempfile::tempdir().expect("tempdir");
    let ir_path = tmp.path().join("ir.json");
    std::fs::write(
        &ir_path,
        serde_json::to_string(&fixture["ir"]).expect("fixture ir serializes"),
    )
    .expect("write ir fixture");
    let trace_path = write_minimal_trace(tmp.path());

    let output = run_warble(&[
        "eval",
        "compliance",
        "--trace",
        trace_path.to_str().unwrap(),
        "--ir",
        ir_path.to_str().unwrap(),
    ]);

    assert!(
        !output.status.success(),
        "an out-of-range IR version must not exit success; stdout: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    for substring in &expected {
        assert!(
            stderr.contains(substring),
            "expected stderr to contain '{substring}', got: {stderr}"
        );
    }
}

#[test]
fn eval_compliance_rejects_an_ir_with_no_warble_ir_version_field_at_all() {
    // ComplianceIr's own deserializer would happily accept `{"components": []}` (it never looks
    // for warble_ir_version) — this locks in that the CLI-level gate catches it first regardless.
    let tmp = tempfile::tempdir().expect("tempdir");
    let ir_path = tmp.path().join("ir.json");
    std::fs::write(&ir_path, r#"{"components": []}"#).expect("write ir fixture");
    let trace_path = write_minimal_trace(tmp.path());

    let output = run_warble(&[
        "eval",
        "compliance",
        "--trace",
        trace_path.to_str().unwrap(),
        "--ir",
        ir_path.to_str().unwrap(),
    ]);

    assert!(
        !output.status.success(),
        "an IR with no warble_ir_version must not exit success; stdout: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("warble_ir_version"),
        "error should name the missing field, got: {stderr}"
    );
}

#[test]
fn eval_compliance_accepts_a_current_version_ir() {
    // Positive control: the real golden IR (current warble_ir_version) must still be accepted, so
    // the new gate doesn't regress the happy path this scorer exists to serve.
    let ir_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../genbi-default/ir.golden.json");
    let tmp = tempfile::tempdir().expect("tempdir");
    let trace_path = write_minimal_trace(tmp.path());

    let output = run_warble(&[
        "eval",
        "compliance",
        "--trace",
        trace_path.to_str().unwrap(),
        "--ir",
        ir_path.to_str().unwrap(),
    ]);

    let stderr = String::from_utf8_lossy(&output.stderr);
    // Deliberately asserts "the gate said nothing" rather than "the command succeeded": this
    // pairing is a real IR with a *minimal* trace, so the run legitimately fails further on, at a
    // check unrelated to versioning. Asserting success here would fail for the wrong reason and
    // would couple this test to whatever that later check happens to be. Every rejection message
    // this gate can emit contains `warble_ir_version`, so its absence is exactly "the gate passed".
    assert!(
        !stderr.contains("warble_ir_version"),
        "a current-version IR must clear the version gate cleanly, got stderr: {stderr}"
    );
}

#[test]
fn eval_compliance_reports_a_non_string_version_as_a_type_error_not_a_missing_field() {
    // A present-but-wrong-typed field is its own failure: telling someone their IR "has no
    // warble_ir_version field" when the field is sitting right there sends them looking in the
    // wrong place.
    let tmp = tempfile::tempdir().expect("tempdir");
    let ir_path = tmp.path().join("ir.json");
    std::fs::write(&ir_path, r#"{"warble_ir_version": 3, "components": []}"#)
        .expect("write ir fixture");
    let trace_path = write_minimal_trace(tmp.path());

    let output = run_warble(&[
        "eval",
        "compliance",
        "--trace",
        trace_path.to_str().unwrap(),
        "--ir",
        ir_path.to_str().unwrap(),
    ]);

    assert!(
        !output.status.success(),
        "a non-string warble_ir_version must not exit success; stdout: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("not a string"),
        "error should say the field is the wrong type, got: {stderr}"
    );
    assert!(
        !stderr.contains("has no warble_ir_version"),
        "error must not claim the field is missing when it is present, got: {stderr}"
    );
}
