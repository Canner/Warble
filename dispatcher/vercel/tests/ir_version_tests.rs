//! Unsupported IR versions are rejected before this dispatcher writes any output.

use warble_vercel::ir::WarbleIr;
use warble_vercel::{emit_vercel, TargetId, SUPPORTED_IR_VERSION};

const VERSION_MISMATCH_FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../conformance-fixtures/ir-version-mismatch.json"
);

fn load_ir(relative: &str) -> WarbleIr {
    let path = format!("{}/{relative}", env!("CARGO_MANIFEST_DIR"));
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {path}: {e}"))
}

#[test]
fn emit_rejects_an_out_of_range_ir_version_explicitly() {
    let mut ir = load_ir("../../examples/analysis-agent/ir.golden.json");
    ir.warble_ir_version = "0.2".to_string();

    let tmp = tempfile::tempdir().expect("tempdir");
    let err = emit_vercel(&ir, TargetId::Headless, tmp.path(), &[])
        .expect_err("an out-of-range IR version must not silently emit");

    let message = err.to_string();
    assert!(
        message.contains("0.2"),
        "error should name the rejected version, got: {message}"
    );
    assert!(
        message.contains(SUPPORTED_IR_VERSION),
        "error should name the supported version, got: {message}"
    );
    assert!(
        !tmp.path().join("bundle.json").exists(),
        "a rejected version must not have written any bundle"
    );
}

#[test]
fn emit_rejects_the_shared_cross_back_end_version_mismatch_fixture() {
    let raw = std::fs::read_to_string(VERSION_MISMATCH_FIXTURE)
        .unwrap_or_else(|e| panic!("read {VERSION_MISMATCH_FIXTURE}: {e}"));
    let fixture: serde_json::Value = serde_json::from_str(&raw).expect("fixture is valid JSON");
    let ir: WarbleIr =
        serde_json::from_value(fixture["ir"].clone()).expect("fixture ir deserializes");
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
    let err = emit_vercel(&ir, TargetId::Headless, tmp.path(), &[])
        .expect_err("the shared fixture's out-of-range version must not silently emit");

    let message = err.to_string();
    for substring in expected {
        assert!(
            message.contains(substring),
            "error should contain '{substring}', got: {message}"
        );
    }
}
