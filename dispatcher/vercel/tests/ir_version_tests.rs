//! The IR version this back-end accepts is one contract with three copies of its value (this
//! crate's `SUPPORTED_IR_VERSION`, the TS back-end's `SUPPORTED_IR_VERSIONS`, and the spec doc's
//! title). Nothing regenerates them from a single source, so the lockstep test below is the guard
//! that keeps them from drifting apart silently. The second test proves an out-of-range
//! `warble_ir_version` is rejected before any bundle content is built — never silently accepted
//! and mislabeled as 0.3-compatible.

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

/// The value of the first `"..."`-quoted string on the line containing `needle`.
fn extract_quoted_after(haystack: &str, needle: &str) -> Option<String> {
    let line = haystack.lines().find(|l| l.contains(needle))?;
    let after = &line[line.find(needle)? + needle.len()..];
    let start = after.find('"')? + 1;
    let end = after[start..].find('"')? + start;
    Some(after[start..end].to_string())
}

/// The version token immediately after `needle` on the line containing it — keeps only the leading
/// run of version characters (digits/dots), dropping any surrounding markdown like `` `0.3`) ``.
fn extract_after(haystack: &str, needle: &str) -> Option<String> {
    let line = haystack.lines().find(|l| l.contains(needle))?;
    let after = line[line.find(needle)? + needle.len()..]
        .trim()
        .trim_start_matches('`');
    let token: String = after
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    (!token.is_empty()).then_some(token)
}

#[test]
fn ir_version_is_in_lockstep_across_rust_ts_and_doc() {
    let crate_dir = env!("CARGO_MANIFEST_DIR");

    let ts_src = std::fs::read_to_string(format!("{crate_dir}/../claude-agent-sdk/src/ir.ts"))
        .expect("read TS ir.ts");
    let ts_version = extract_quoted_after(&ts_src, "export const SUPPORTED_IR_VERSIONS")
        .expect("TS SUPPORTED_IR_VERSIONS constant");

    let doc = std::fs::read_to_string(format!("{crate_dir}/../../docs/spec/ir-schema.md"))
        .expect("read ir-schema.md");
    let doc_version =
        extract_after(&doc, "warble_ir_version:").expect("doc warble_ir_version in the title");

    assert_eq!(
        SUPPORTED_IR_VERSION, ts_version,
        "Rust and TS supported IR version disagree — bump both together"
    );
    assert_eq!(
        SUPPORTED_IR_VERSION, doc_version,
        "Rust const and docs/spec/ir-schema.md version disagree — bump both together"
    );
}

#[test]
fn emit_rejects_an_out_of_range_ir_version_explicitly() {
    let mut ir = load_ir("../../genbi-default/ir.golden.json");
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
