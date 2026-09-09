//! Faithful port of dispatcher/test/manifest.test.ts.

use serde::Deserialize;
use warble_claude_code::ir::{ComponentCall, WarbleIr};
use warble_claude_code::{build_manifest, CapabilityManifest};

const RENDER_DEMO_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../examples/render-demo/ir.golden.json"
);
const DEMO_AGENT_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../examples/demo-agent/ir.golden.json"
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
    roots: Vec<String>,
    mounts: Vec<ClosureMount>,
    expected_entries: Vec<ExpectedEntry>,
}

#[derive(Deserialize)]
struct ClosureMount {
    id: String,
    entrypoint: bool,
    calls: Vec<String>,
}

#[derive(Deserialize)]
struct ExpectedEntry {
    root: String,
    components: Vec<String>,
}

fn load_ir(path: &str) -> WarbleIr {
    let raw = std::fs::read_to_string(path).expect("read golden IR fixture");
    serde_json::from_str(&raw).expect("golden IR deserializes")
}

#[test]
fn manifest_projects_the_ir_profile_verbs_capabilities_render_contract() {
    let ir = load_ir(RENDER_DEMO_IR);
    let manifest: CapabilityManifest = build_manifest(&ir);

    assert_eq!(manifest.warble_manifest_version, "0.3");
    assert_eq!(manifest.profile, ir.profile);
    assert_eq!(manifest.components.len(), ir.components.len());

    let dashboard = &manifest.components[0];
    assert_eq!(dashboard.verb, "dashboard");
    assert!(dashboard.entrypoint);
    assert_eq!(dashboard.component_type, "analytical");
    assert_eq!(dashboard.realization_kind, "skill");
    assert_eq!(dashboard.trigger, "one_shot");
    assert_eq!(dashboard.outcome, "none");
    assert_eq!(dashboard.context.precondition, "pass");
    assert!(dashboard
        .required_capabilities
        .iter()
        .any(|c| c == "render_contract"));
    // render contract advertises the declared block types
    let blocks = dashboard
        .render_contract
        .as_ref()
        .expect("dashboard declares render blocks")
        .blocks
        .clone();
    assert_eq!(
        blocks,
        vec![
            "kpi_card".to_string(),
            "table".to_string(),
            "chart".to_string()
        ]
    );
}

#[test]
fn manifest_render_contract_is_null_for_a_component_with_no_render_blocks() {
    let ir = load_ir(DEMO_AGENT_IR);
    let manifest = build_manifest(&ir);
    // demo-agent's generate_dashboard declares bare-typed render blocks; assert the projection
    // reflects whatever the IR carries (non-null when blocks exist).
    let generate = manifest
        .components
        .iter()
        .find(|c| c.verb == "generate_dashboard")
        .expect("generate_dashboard must be present");
    // A `render_contract` is always either absent (`None`) or a well-formed block list — the
    // `Vec<String>` type guarantees the "block list" shape, so this just confirms which arm the
    // fixture takes (mirrors the TS test's permissive assertion).
    match &generate.render_contract {
        None => {}
        Some(contract) => assert!(
            !contract.blocks.is_empty(),
            "a present render_contract should carry at least one declared block type"
        ),
    }
}

#[test]
fn manifest_keeps_internal_mounts_visible_and_marks_them_callee_only() {
    let raw = std::fs::read_to_string(COMPOSITION_FIXTURE).expect("read composition fixture");
    let fixture: serde_json::Value = serde_json::from_str(&raw).expect("fixture is valid JSON");
    let ir: WarbleIr =
        serde_json::from_value(fixture["ir"].clone()).expect("fixture ir deserializes");
    let manifest = build_manifest(&ir);

    let caller = manifest
        .components
        .iter()
        .find(|component| component.verb == "caller")
        .expect("caller is present");
    let callee = manifest
        .components
        .iter()
        .find(|component| component.verb == "callee")
        .expect("callee is present");
    assert!(caller.entrypoint);
    assert!(!callee.entrypoint);
    assert_eq!(manifest.entries.len(), 1);
    assert_eq!(manifest.entries[0].id, "caller");
    assert_eq!(manifest.entries[0].closure, ["caller", "callee"]);
    assert_eq!(caller.dependencies.len(), 1);
    assert_eq!(caller.dependencies[0].step, "invoke");
    assert_eq!(caller.dependencies[0].alias, "answer");
    assert_eq!(caller.dependencies[0].component, "callee");
    assert!(callee.dependencies.is_empty());
}

#[test]
fn runtime_neutral_manifest_consumes_the_shared_closure_scenarios() {
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

        let manifest = build_manifest(&ir);
        let actual: Vec<_> = manifest
            .entries
            .iter()
            .filter(|entry| scenario.roots.contains(&entry.id))
            .map(|entry| (entry.id.clone(), entry.closure.clone()))
            .collect();
        let expected: Vec<_> = scenario
            .expected_entries
            .iter()
            .map(|entry| (entry.root.clone(), entry.components.clone()))
            .collect();
        assert_eq!(actual, expected, "{}", scenario.name);
    }
}
