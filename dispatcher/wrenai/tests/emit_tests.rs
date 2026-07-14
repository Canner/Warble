//! Integration tests for the wrenai bundle emitter, driven against the repo's real golden IR
//! fixtures (`genbi-default` and `examples/monitor-agent`) so this back-end is exercised against
//! the same IR shapes the front-end actually produces, not a hand-rolled approximation of them.

use std::fs;
use std::path::PathBuf;

use serde_json::json;
use warble_wrenai::classify::{classify_step, StepRealization};
use warble_wrenai::ir::WarbleIr;
use warble_wrenai::{emit_wrenai, AgentBundle, StepBundle, TargetId, WrenaiBundle};

fn fixture_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn load_ir(relative: &str) -> WarbleIr {
    let raw = fs::read_to_string(fixture_path(relative))
        .unwrap_or_else(|e| panic!("failed to read {relative}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("failed to parse {relative}: {e}"))
}

fn find_agent<'a>(bundle: &'a WrenaiBundle, id: &str) -> &'a AgentBundle {
    bundle
        .agents
        .iter()
        .find(|agent| agent.id == id)
        .unwrap_or_else(|| panic!("agent '{id}' not found in bundle"))
}

fn find_step<'a>(agent: &'a AgentBundle, name: &str) -> &'a StepBundle {
    agent
        .steps
        .iter()
        .find(|step| step.name == name)
        .unwrap_or_else(|| panic!("step '{name}' not found on agent '{}'", agent.id))
}

#[test]
fn genbi_default_headless_emit_succeeds_with_expected_shape() {
    let ir = load_ir("../../genbi-default/ir.golden.json");
    let tmp = tempfile::tempdir().expect("tempdir");
    let bundle = emit_wrenai(&ir, TargetId::Headless, tmp.path()).expect("emit should succeed");

    let bundle_path = tmp.path().join("bundle.json");
    assert!(bundle_path.exists(), "bundle.json should be written");
    let raw = fs::read_to_string(&bundle_path).expect("read bundle.json");
    let round_tripped: serde_json::Value =
        serde_json::from_str(&raw).expect("bundle.json must round-trip as valid JSON");
    assert!(round_tripped.get("wrenai_bundle_version").is_some());
    assert!(round_tripped.get("compat").is_some());

    assert_eq!(bundle.agents.len(), 4);
    let ids: Vec<&str> = bundle.agents.iter().map(|a| a.id.as_str()).collect();
    for expected in [
        "explore_model",
        "answer_query",
        "generate_dashboard",
        "explain_change",
    ] {
        assert!(
            ids.contains(&expected),
            "missing agent '{expected}': {ids:?}"
        );
    }

    let answer_query = find_agent(&bundle, "answer_query");
    assert_eq!(answer_query.steps.len(), 3);
    match &find_step(answer_query, "repair_sql").realization {
        StepRealization::RepairFold {
            fold_into,
            max_attempts,
            fallback,
        } => {
            assert_eq!(fold_into, "generate_sql");
            assert_eq!(*max_attempts, 1);
            assert_eq!(*fallback, None);
        }
        other => panic!("expected RepairFold for repair_sql, got {other:?}"),
    }
    assert!(matches!(
        find_step(answer_query, "resolve_intent").realization,
        StepRealization::Independent
    ));
    assert!(matches!(
        find_step(answer_query, "generate_sql").realization,
        StepRealization::Independent
    ));

    assert!(
        !answer_query.guardrails.is_empty(),
        "answer_query declares guardrails in the golden IR"
    );
    assert!(
        !answer_query.tools.is_empty(),
        "answer_query requires tool-bearing capabilities in the golden IR"
    );
    for tool in &answer_query.tools {
        assert!(
            tool.source.starts_with("native") || tool.source.starts_with("mcp:"),
            "unexpected tool source '{}': should be native or mcp:-qualified",
            tool.source
        );
    }

    let schema = &answer_query.output_schema;
    assert!(
        schema
            .get("properties")
            .and_then(|p| p.get("blocks"))
            .is_some(),
        "output_schema must expose a 'blocks' property matching the render-contract Envelope"
    );
}

#[test]
fn monitor_agent_headless_emit_classifies_assess_severity_as_guarded_skip() {
    let ir = load_ir("../../examples/monitor-agent/ir.golden.json");
    let tmp = tempfile::tempdir().expect("tempdir");
    let bundle = emit_wrenai(&ir, TargetId::Headless, tmp.path()).expect("emit should succeed");

    let monitor = find_agent(&bundle, "monitor_freshness");
    let step = find_step(monitor, "assess_severity");
    assert!(
        matches!(step.realization, StepRealization::GuardedSkip),
        "assess_severity's on_flag guard must classify as GuardedSkip, got {:?}",
        step.realization
    );
}

/// Mutate the golden IR's last component to require a capability no profile can resolve, and
/// confirm emission fails *and* leaves the output directory exactly as empty as it started —
/// pinning the all-or-nothing atomicity guarantee documented on `emit::emit_wrenai`.
#[test]
fn atomic_emit_leaves_out_dir_untouched_on_failure() {
    let mut ir = load_ir("../../genbi-default/ir.golden.json");
    assert!(
        ir.components.len() >= 2,
        "fixture must have at least 2 components for this test to be meaningful"
    );
    ir.components
        .last_mut()
        .expect("at least one component")
        .required_capabilities
        .push("definitely_unknown_capability".to_string());

    let tmp = tempfile::tempdir().expect("tempdir");
    let result = emit_wrenai(&ir, TargetId::Headless, tmp.path());
    assert!(
        result.is_err(),
        "emission must fail when any component's capabilities cannot resolve"
    );

    let entries = fs::read_dir(tmp.path()).expect("read_dir").count();
    assert_eq!(
        entries, 0,
        "out_dir must remain completely empty when emission fails partway through the pre-pass"
    );
}

#[test]
fn classify_step_r1_adjacency_rule() {
    fn node_with_calls(calls: Vec<serde_json::Value>) -> warble_wrenai::ir::ComponentNode {
        let value = json!({
            "id": "fixture_component",
            "verb": "fixture_component",
            "type": "analytical",
            "realization_kind": "skill",
            "context_binding": { "project": "x", "binding_mode": "runtime_selected" },
            "precondition_result": { "status": "pass" },
            "prompt_fragment": "",
            "llm_calls": calls,
            "guardrails": [],
            "trigger": { "kind": "one_shot" },
            "eval_ref": "fixture_component.eval",
            "effect": { "outcome": { "kind": "none" } }
        });
        serde_json::from_value(value).expect("valid ComponentNode fixture")
    }

    // on_failure targeting the immediately-preceding call -> RepairFold.
    let adjacent = node_with_calls(vec![
        json!({"name": "step_a", "tier": "strong", "prompt": "p"}),
        json!({
            "name": "step_b", "tier": "strong", "prompt": "p",
            "when": {"guard": "on_failure", "target": "step_a"}
        }),
    ]);
    assert!(matches!(
        classify_step(&adjacent, 1),
        StepRealization::RepairFold { .. }
    ));

    // on_failure targeting a call two steps back (not adjacent) -> GuardedSkip.
    let non_adjacent = node_with_calls(vec![
        json!({"name": "step_a", "tier": "strong", "prompt": "p"}),
        json!({"name": "step_b", "tier": "strong", "prompt": "p"}),
        json!({
            "name": "step_c", "tier": "strong", "prompt": "p",
            "when": {"guard": "on_failure", "target": "step_a"}
        }),
    ]);
    assert!(matches!(
        classify_step(&non_adjacent, 2),
        StepRealization::GuardedSkip
    ));

    // on_flag -> GuardedSkip, regardless of adjacency.
    let flagged = node_with_calls(vec![json!({
        "name": "step_a", "tier": "strong", "prompt": "p",
        "when": {"guard": "on_flag", "target": "some.flag"}
    })]);
    assert!(matches!(
        classify_step(&flagged, 0),
        StepRealization::GuardedSkip
    ));
}

#[test]
fn genbi_default_headless_bundle_matches_golden_fixture() {
    let ir = load_ir("../../genbi-default/ir.golden.json");
    let tmp = tempfile::tempdir().expect("tempdir");
    let bundle = emit_wrenai(&ir, TargetId::Headless, tmp.path()).expect("emit should succeed");
    let actual = serde_json::to_value(&bundle).expect("serialize bundle");

    let golden_path = fixture_path("tests/golden/genbi-default.bundle.json");
    let golden_raw = fs::read_to_string(&golden_path).unwrap_or_else(|e| {
        panic!(
            "failed to read golden fixture {}: {e} (run `cargo test -p warble-wrenai --test emit_tests regenerate_golden_fixture -- --ignored` to create it)",
            golden_path.display()
        )
    });
    let golden: serde_json::Value =
        serde_json::from_str(&golden_raw).expect("parse golden fixture");

    assert_eq!(
        actual,
        golden,
        "bundle output drifted from the golden fixture at {}",
        golden_path.display()
    );
}

/// Regenerates the golden bundle fixture. Not run by default — a developer utility for updating
/// the pinned fixture after an intentional, reviewed bundle-format change, not a correctness test
/// itself (see `genbi_default_headless_bundle_matches_golden_fixture`).
#[test]
#[ignore]
fn regenerate_golden_fixture() {
    let ir = load_ir("../../genbi-default/ir.golden.json");
    let tmp = tempfile::tempdir().expect("tempdir");
    let bundle = emit_wrenai(&ir, TargetId::Headless, tmp.path()).expect("emit should succeed");
    let json = serde_json::to_string_pretty(&bundle).expect("serialize bundle");
    fs::write(fixture_path("tests/golden/genbi-default.bundle.json"), json)
        .expect("write golden fixture");
}
