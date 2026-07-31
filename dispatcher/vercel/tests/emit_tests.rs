//! Integration tests for the vercel bundle emitter, driven against the repo's real golden IR
//! fixtures (`genbi-default` and `examples/monitor-agent`) so this back-end is exercised against
//! the same IR shapes the front-end actually produces, not a hand-rolled approximation of them.

use std::fs;
use std::path::PathBuf;

use serde_json::json;
use warble_vercel::classify::{classify_step, StepRealization};
use warble_vercel::ir::WarbleIr;
use warble_vercel::provider::{parse_provider_fragments, ProviderFragment};
use warble_vercel::{emit_vercel, AgentBundle, StepBundle, TargetId, VercelBundle};

fn fixture_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn load_ir(relative: &str) -> WarbleIr {
    let raw = fs::read_to_string(fixture_path(relative))
        .unwrap_or_else(|e| panic!("failed to read {relative}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("failed to parse {relative}: {e}"))
}

/// The generically-named sample provider fixture (`tests/fixtures/sample-provider.yaml`) supplying
/// the domain capabilities this crate's golden IR fixtures require. See that file's header comment
/// for why it's invented-mechanism, not product-named.
fn sample_providers() -> Vec<ProviderFragment> {
    let raw = fs::read_to_string(fixture_path("tests/fixtures/sample-provider.yaml"))
        .expect("read sample-provider.yaml");
    parse_provider_fragments(&raw).expect("parse sample-provider.yaml")
}

fn find_agent<'a>(bundle: &'a VercelBundle, id: &str) -> &'a AgentBundle {
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
    let bundle = emit_vercel(&ir, TargetId::Headless, tmp.path(), &sample_providers())
        .expect("emit should succeed");

    let bundle_path = tmp.path().join("bundle.json");
    assert!(bundle_path.exists(), "bundle.json should be written");
    let raw = fs::read_to_string(&bundle_path).expect("read bundle.json");
    let round_tripped: serde_json::Value =
        serde_json::from_str(&raw).expect("bundle.json must round-trip as valid JSON");
    assert!(round_tripped.get("vercel_bundle_version").is_some());
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
    let bundle = emit_vercel(&ir, TargetId::Headless, tmp.path(), &sample_providers())
        .expect("emit should succeed");

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
/// pinning the all-or-nothing atomicity guarantee documented on `emit::emit_vercel`.
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
    let result = emit_vercel(&ir, TargetId::Headless, tmp.path(), &sample_providers());
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

/// Mutate a real (non-conditional) call in the golden IR into an unrecognized-guard shape and
/// confirm `emit_vercel` wall-hits before writing anything — the atomic pre-pass check
/// (`emit::check_conditional_shapes`) covering a shape `classify_step`'s else-branch would
/// otherwise silently fold into `GuardedSkip`.
#[test]
fn unrecognized_when_guard_wall_hits_before_any_bundle_content_is_built() {
    let mut ir = load_ir("../../genbi-default/ir.golden.json");
    let call = ir
        .components
        .iter_mut()
        .flat_map(|c| c.llm_calls.iter_mut())
        .find(|c| c.when.is_none())
        .expect("fixture must have at least one call with no 'when' guard to mutate");
    call.conditional = true;
    call.when = Some(warble_vercel::ir::WhenGuard {
        guard: "on_timeout".to_string(),
        target: "whatever".to_string(),
    });

    let tmp = tempfile::tempdir().expect("tempdir");
    let result = emit_vercel(&ir, TargetId::Headless, tmp.path(), &sample_providers());
    assert!(
        result.is_err(),
        "an unrecognized 'when' guard must wall-hit, not silently classify as GuardedSkip"
    );

    let entries = fs::read_dir(tmp.path()).expect("read_dir").count();
    assert_eq!(
        entries, 0,
        "out_dir must remain untouched when the pre-pass rejects a component"
    );
}

/// Same atomicity pin as above, for the `conditional: true` with no `when` shape — `classify.rs`
/// would otherwise classify this as `Independent`, silently running a step declared conditional as
/// if it were unconditional.
#[test]
fn bare_conditional_with_no_when_wall_hits_before_any_bundle_content_is_built() {
    let mut ir = load_ir("../../genbi-default/ir.golden.json");
    let call = ir
        .components
        .iter_mut()
        .flat_map(|c| c.llm_calls.iter_mut())
        .find(|c| c.when.is_none())
        .expect("fixture must have at least one call with no 'when' guard to mutate");
    call.conditional = true;

    let tmp = tempfile::tempdir().expect("tempdir");
    let result = emit_vercel(&ir, TargetId::Headless, tmp.path(), &sample_providers());
    assert!(
        result.is_err(),
        "'conditional: true' with no 'when' must wall-hit, not silently run as Independent"
    );

    let entries = fs::read_dir(tmp.path()).expect("read_dir").count();
    assert_eq!(
        entries, 0,
        "out_dir must remain untouched when the pre-pass rejects a component"
    );
}

/// Same atomicity pin as the two tests above, for the `conditional: false` with `when: Some` shape
/// — `classify.rs` never inspects `conditional`, so without this check a call could be silently
/// classified purely off `when`'s presence despite declaring itself unconditional.
#[test]
fn conditional_false_with_when_present_wall_hits_before_any_bundle_content_is_built() {
    let mut ir = load_ir("../../genbi-default/ir.golden.json");
    let call = ir
        .components
        .iter_mut()
        .flat_map(|c| c.llm_calls.iter_mut())
        .find(|c| c.when.is_none())
        .expect("fixture must have at least one call with no 'when' guard to mutate");
    call.when = Some(warble_vercel::ir::WhenGuard {
        guard: "on_flag".to_string(),
        target: "whatever".to_string(),
    });

    let tmp = tempfile::tempdir().expect("tempdir");
    let result = emit_vercel(&ir, TargetId::Headless, tmp.path(), &sample_providers());
    assert!(
        result.is_err(),
        "a 'when' guard on a call not marked 'conditional: true' must wall-hit, not be silently classified"
    );

    let entries = fs::read_dir(tmp.path()).expect("read_dir").count();
    assert_eq!(
        entries, 0,
        "out_dir must remain untouched when the pre-pass rejects a component"
    );
}

#[test]
fn classify_step_r1_adjacency_rule() {
    fn node_with_calls(calls: Vec<serde_json::Value>) -> warble_vercel::ir::ComponentNode {
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
    let bundle = emit_vercel(&ir, TargetId::Headless, tmp.path(), &sample_providers())
        .expect("emit should succeed");
    let actual = serde_json::to_value(&bundle).expect("serialize bundle");

    let golden_path = fixture_path("tests/golden/genbi-default.bundle.json");
    let golden_raw = fs::read_to_string(&golden_path).unwrap_or_else(|e| {
        panic!(
            "failed to read golden fixture {}: {e} (run `cargo test -p warble-vercel --test emit_tests regenerate_golden_fixture -- --ignored` to create it)",
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
    let bundle = emit_vercel(&ir, TargetId::Headless, tmp.path(), &sample_providers())
        .expect("emit should succeed");
    let json = serde_json::to_string_pretty(&bundle).expect("serialize bundle");
    fs::write(fixture_path("tests/golden/genbi-default.bundle.json"), json)
        .expect("write golden fixture");
}
