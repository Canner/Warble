//! Unsupported IR versions are rejected before this dispatcher writes any output.

use serde::Deserialize;
use warble_vercel::ir::{ComponentCall, WarbleIr};
use warble_vercel::{emit_vercel, TargetId, SUPPORTED_IR_VERSION};

const VERSION_MISMATCH_FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../conformance-fixtures/ir-version-mismatch.json"
);
const COMPOSITION_FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../conformance-fixtures/component-composition-unsupported.json"
);
const CLOSURE_FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../conformance-fixtures/component-call-closure.json"
);

#[derive(Deserialize)]
struct ClosureFixture {
    scenarios: Vec<ClosureScenario>,
}

#[derive(Deserialize)]
struct ClosureScenario {
    name: String,
    mounts: Vec<ClosureMount>,
}

#[derive(Deserialize)]
struct ClosureMount {
    id: String,
    entrypoint: bool,
    calls: Vec<String>,
}

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

#[test]
fn emit_rejects_the_shared_component_composition_fixture_before_writing_a_bundle() {
    let raw = std::fs::read_to_string(COMPOSITION_FIXTURE)
        .unwrap_or_else(|e| panic!("read {COMPOSITION_FIXTURE}: {e}"));
    let fixture: serde_json::Value = serde_json::from_str(&raw).expect("fixture is valid JSON");
    let ir: WarbleIr =
        serde_json::from_value(fixture["ir"].clone()).expect("fixture ir deserializes");
    assert_eq!(
        ir.components[0].llm_calls[0].component_calls[0].alias,
        "answer"
    );
    assert!(!ir.components[1].entrypoint);

    let tmp = tempfile::tempdir().expect("tempdir");
    let err = emit_vercel(&ir, TargetId::Headless, tmp.path(), &[])
        .expect_err("an unsupported component call must wall-hit");
    let message = err.to_string();
    for substring in fixture["expected_call_error_contains"]
        .as_array()
        .expect("expected_call_error_contains is an array")
        .iter()
        .map(|value| value.as_str().expect("expected fragments are strings"))
    {
        assert!(
            message.contains(substring),
            "error should contain '{substring}', got: {message}"
        );
    }
    let closure_raw = std::fs::read_to_string(CLOSURE_FIXTURE)
        .unwrap_or_else(|e| panic!("read {CLOSURE_FIXTURE}: {e}"));
    let closure: serde_json::Value =
        serde_json::from_str(&closure_raw).expect("closure fixture is valid JSON");
    for substring in closure["unsupported_target"]["error_contains"]
        .as_array()
        .expect("error_contains is an array")
        .iter()
        .map(|value| value.as_str().expect("expected fragments are strings"))
    {
        assert!(
            message.contains(substring),
            "error should contain '{substring}', got: {message}"
        );
    }
    assert!(
        !tmp.path().join("bundle.json").exists(),
        "composition must fail before bundle emission"
    );
}

#[test]
fn shared_closure_scenarios_drive_vercel_whole_profile_preflight() {
    let fixture: ClosureFixture = serde_json::from_str(
        &std::fs::read_to_string(CLOSURE_FIXTURE).expect("read closure fixture"),
    )
    .expect("closure fixture is valid");
    let composition: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(COMPOSITION_FIXTURE).expect("read composition fixture"),
    )
    .expect("composition fixture is valid");
    let template: WarbleIr =
        serde_json::from_value(composition["ir"].clone()).expect("fixture ir deserializes");
    let base = template.components[1].clone();

    assert_eq!(
        fixture
            .scenarios
            .iter()
            .map(|scenario| scenario.name.as_str())
            .collect::<Vec<_>>(),
        [
            "shared_callee",
            "transitive_chain",
            "unreachable_unsupported_sibling"
        ]
    );

    for scenario in fixture.scenarios {
        let mut ir = template.clone();
        ir.components = scenario
            .mounts
            .iter()
            .map(|mount| {
                let mut node = base.clone();
                node.id = mount.id.clone();
                node.verb = mount.id.clone();
                node.entrypoint = mount.entrypoint;
                node.llm_calls[0].component_calls = mount
                    .calls
                    .iter()
                    .enumerate()
                    .map(|(index, component)| ComponentCall {
                        alias: format!("call_{index}"),
                        component: component.clone(),
                    })
                    .collect();
                node.required_capabilities
                    .retain(|capability| capability != "component_invocation");
                if !mount.calls.is_empty() {
                    node.required_capabilities
                        .push("component_invocation".to_string());
                }
                node
            })
            .collect();

        let first_caller = scenario
            .mounts
            .iter()
            .find(|mount| mount.entrypoint && !mount.calls.is_empty())
            .expect("every whole-profile fixture scenario has an advertised caller");
        let tmp = tempfile::tempdir().expect("tempdir");
        let err = emit_vercel(&ir, TargetId::Headless, tmp.path(), &[])
            .expect_err("an unsupported advertised call must wall-hit");
        let message = err.to_string();
        for substring in [
            first_caller.id.as_str(),
            first_caller.calls[0].as_str(),
            "component_invocation",
            "fail",
            "wall-hit",
        ] {
            assert!(
                message.contains(substring),
                "{} error should contain '{substring}', got: {message}",
                scenario.name
            );
        }
        assert!(
            !tmp.path().join("bundle.json").exists(),
            "{} must fail before bundle emission",
            scenario.name
        );
    }
}

#[test]
fn emit_omits_an_unreachable_callee_only_mount() {
    let raw = std::fs::read_to_string(COMPOSITION_FIXTURE)
        .unwrap_or_else(|e| panic!("read {COMPOSITION_FIXTURE}: {e}"));
    let fixture: serde_json::Value = serde_json::from_str(&raw).expect("fixture is valid JSON");
    let mut ir: WarbleIr =
        serde_json::from_value(fixture["ir"].clone()).expect("fixture ir deserializes");
    ir.components[0].llm_calls[0].component_calls.clear();
    ir.components[0]
        .required_capabilities
        .retain(|capability| capability != "component_invocation");

    let tmp = tempfile::tempdir().expect("tempdir");
    let bundle = emit_vercel(&ir, TargetId::Headless, tmp.path(), &[])
        .expect("an unreachable internal mount does not block advertised entries");
    assert_eq!(bundle.agents.len(), 1);
    assert_eq!(bundle.agents[0].id, "caller");
}
