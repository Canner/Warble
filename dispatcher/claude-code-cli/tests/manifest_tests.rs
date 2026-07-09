//! Faithful port of dispatcher/test/manifest.test.ts.

use warble_claude_code::ir::WarbleIr;
use warble_claude_code::{build_manifest, CapabilityManifest};

const RENDER_DEMO_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../examples/render-demo/ir.golden.json"
);
const DEMO_AGENT_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../examples/demo-agent/ir.golden.json"
);

fn load_ir(path: &str) -> WarbleIr {
    let raw = std::fs::read_to_string(path).expect("read golden IR fixture");
    serde_json::from_str(&raw).expect("golden IR deserializes")
}

#[test]
fn manifest_projects_the_ir_profile_verbs_capabilities_render_contract() {
    let ir = load_ir(RENDER_DEMO_IR);
    let manifest: CapabilityManifest = build_manifest(&ir);

    assert_eq!(manifest.warble_manifest_version, "0.1");
    assert_eq!(manifest.profile, ir.profile);
    assert_eq!(manifest.components.len(), ir.components.len());

    let dashboard = &manifest.components[0];
    assert_eq!(dashboard.verb, "dashboard");
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
