//! Unsupported IR versions are rejected before this dispatcher writes any output.

use warble_claude_code::ir::{WarbleIr, SUPPORTED_IR_VERSION};
use warble_claude_code::{emit_claude_code, emit_codex_interactive};

const VERSION_MISMATCH_FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../conformance-fixtures/ir-version-mismatch.json"
);
const COMPOSITION_FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../conformance-fixtures/component-composition-unsupported.json"
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
    let err = emit_claude_code(
        &ir,
        tmp.path(),
        "claude-code:headless",
        warble_claude_code::DEFAULT_RENDER_FLAVOR,
    )
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
        !tmp.path().join("RUN.md").exists(),
        "a rejected version must not have written any output"
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
    let err = emit_claude_code(
        &ir,
        tmp.path(),
        "claude-code:headless",
        warble_claude_code::DEFAULT_RENDER_FLAVOR,
    )
    .expect_err("the shared fixture's out-of-range version must not silently emit");

    let message = err.to_string();
    for substring in expected {
        assert!(
            message.contains(substring),
            "error should contain '{substring}', got: {message}"
        );
    }
}

fn load_composition_fixture() -> (WarbleIr, serde_json::Value) {
    let raw = std::fs::read_to_string(COMPOSITION_FIXTURE)
        .unwrap_or_else(|e| panic!("read {COMPOSITION_FIXTURE}: {e}"));
    let fixture: serde_json::Value = serde_json::from_str(&raw).expect("fixture is valid JSON");
    let ir = serde_json::from_value(fixture["ir"].clone()).expect("fixture ir deserializes");
    (ir, fixture)
}

fn assert_expected_fragments(message: &str, fixture: &serde_json::Value, key: &str) {
    for substring in fixture[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} is an array"))
        .iter()
        .map(|value| value.as_str().expect("expected fragments are strings"))
    {
        assert!(
            message.contains(substring),
            "error should contain '{substring}', got: {message}"
        );
    }
}

#[test]
fn every_claude_code_file_target_rejects_component_calls_before_writing_output() {
    let (ir, fixture) = load_composition_fixture();
    assert_eq!(
        ir.components[0].llm_calls[0].component_calls[0].alias,
        "answer"
    );
    assert!(!ir.components[1].entrypoint);

    for target in ["claude-code:headless", "claude-code:interactive"] {
        let tmp = tempfile::tempdir().expect("tempdir");
        let err = emit_claude_code(
            &ir,
            tmp.path(),
            target,
            warble_claude_code::DEFAULT_RENDER_FLAVOR,
        )
        .expect_err("an unsupported component call must wall-hit");
        assert_expected_fragments(&err.to_string(), &fixture, "expected_call_error_contains");
        assert!(
            std::fs::read_dir(tmp.path())
                .expect("temporary output root exists")
                .next()
                .is_none(),
            "target {target} must fail before writing any executable output"
        );
    }
}

#[test]
fn codex_interactive_rejects_component_calls_before_writing_output() {
    let (ir, fixture) = load_composition_fixture();
    let tmp = tempfile::tempdir().expect("tempdir");
    let err = emit_codex_interactive(&ir, tmp.path(), None, None, None)
        .expect_err("an unsupported component call must wall-hit");
    assert_expected_fragments(&err.to_string(), &fixture, "expected_call_error_contains");
    assert!(
        std::fs::read_dir(tmp.path())
            .expect("temporary output root exists")
            .next()
            .is_none(),
        "codex interactive must fail before writing discovery artifacts"
    );
}

#[test]
fn file_target_rejects_a_callee_only_mount_even_without_a_call_edge() {
    let (mut ir, fixture) = load_composition_fixture();
    ir.components[0].llm_calls[0].component_calls.clear();
    let tmp = tempfile::tempdir().expect("tempdir");
    let err = emit_claude_code(
        &ir,
        tmp.path(),
        "claude-code:headless",
        warble_claude_code::DEFAULT_RENDER_FLAVOR,
    )
    .expect_err("a callee-only mount must not become an independent entry");
    assert_expected_fragments(
        &err.to_string(),
        &fixture,
        "expected_internal_error_contains",
    );
}
