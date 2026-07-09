//! Faithful port of dispatcher/test/resolve.test.ts.

use warble_claude_code::ir::{ComponentNode, WarbleIr};
use warble_claude_code::{
    emit_claude_code, resolve_node_capabilities, RenderFlavor, ResolutionReport,
};

const DEMO_AGENT_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../demo-agent/ir.golden.json"
);

fn load_golden_ir() -> WarbleIr {
    let raw = std::fs::read_to_string(DEMO_AGENT_IR).expect("read golden IR fixture");
    serde_json::from_str(&raw).expect("golden IR deserializes")
}

fn outcome_str(entry: &warble_claude_code::ResolvedCapability) -> String {
    serde_json::to_value(entry.outcome)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
}

fn find_entry<'a>(
    report: &'a ResolutionReport,
    capability: &str,
) -> &'a warble_claude_code::ResolvedCapability {
    report
        .iter()
        .find(|r| r.capability == capability)
        .unwrap_or_else(|| panic!("expected report to include capability '{capability}'"))
}

fn make_human_approval_node(base: &ComponentNode) -> ComponentNode {
    let mut node = base.clone();
    node.required_capabilities
        .push("human_approval".to_string());
    node
}

#[test]
fn generate_dashboard_resolves_cleanly_on_claude_code_headless() {
    let ir = load_golden_ir();
    let node = &ir.components[0];

    let report = resolve_node_capabilities(node, "claude-code:headless").expect("resolves");

    assert_eq!(
        outcome_str(find_entry(&report, "llm:per_step_tier")),
        "realize-via"
    );
    assert_eq!(
        outcome_str(find_entry(&report, "render_contract")),
        "realize-via"
    );
    assert!(
        report.iter().all(|r| outcome_str(r) != "fail"),
        "no capability should fail"
    );

    let out_dir = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("emit succeeds");

    let files: Vec<String> = std::fs::read_dir(out_dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert!(files.contains(&"capability-report.json".to_string()));

    let cap_report: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(out_dir.path().join("capability-report.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        cap_report["target"].as_str().unwrap(),
        "claude-code:headless"
    );
    assert_eq!(cap_report["components"].as_array().unwrap().len(), 1);
    assert!(cap_report["components"][0]["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["outcome"].as_str().unwrap() != "fail"));

    let agents_dir = out_dir.path().join(".claude").join("agents");
    let agent_files: Vec<String> = std::fs::read_dir(&agents_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert!(agent_files.contains(&"generate_dashboard.md".to_string()));
}

/// Golden IR with both llm_calls collapsed to the same tier — "answer-agent" style, single-tier IR.
fn make_single_tier_ir(ir: &WarbleIr) -> WarbleIr {
    let node = &ir.components[0];
    let mut new_node = node.clone();
    new_node
        .required_capabilities
        .retain(|cap| cap != "llm:per_step_tier");
    for call in &mut new_node.llm_calls {
        call.tier = "cheap".to_string();
    }
    WarbleIr {
        components: vec![new_node],
        ..ir.clone()
    }
}

#[test]
fn single_tier_answer_agent_style_ir_resolves_cleanly_on_headless() {
    let golden = load_golden_ir();
    let ir = make_single_tier_ir(&golden);
    let node = &ir.components[0];

    let report = resolve_node_capabilities(node, "claude-code:headless").expect("resolves");
    assert!(
        report.iter().all(|r| outcome_str(r) != "fail"),
        "no capability should fail"
    );
    assert!(
        !report.iter().any(|r| r.capability == "llm:per_step_tier"),
        "single-tier IR should not imply llm:per_step_tier"
    );

    let out_dir = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("emit succeeds");
    let agents_dir = out_dir.path().join(".claude").join("agents");
    let mut files: Vec<String> = std::fs::read_dir(&agents_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    files.sort();
    assert_eq!(files, vec!["generate_dashboard.md".to_string()]);
}

#[test]
fn human_approval_aborts_resolution_on_claude_code_headless() {
    let golden = load_golden_ir();
    let node = make_human_approval_node(&golden.components[0]);

    let err = resolve_node_capabilities(&node, "claude-code:headless").unwrap_err();
    assert!(
        err.0
            .contains("human_approval: fail on claude-code:headless"),
        "unexpected error message: {}",
        err.0
    );
}

#[test]
fn human_approval_resolves_natively_on_claude_code_interactive() {
    let golden = load_golden_ir();
    let node = make_human_approval_node(&golden.components[0]);

    let report = resolve_node_capabilities(&node, "claude-code:interactive").expect("resolves");
    assert_eq!(outcome_str(find_entry(&report, "human_approval")), "native");
    assert!(report.iter().all(|r| outcome_str(r) != "fail"));
}

#[test]
fn human_approval_requirement_blocks_emission_entirely_on_headless() {
    let golden = load_golden_ir();
    let ir = WarbleIr {
        components: vec![make_human_approval_node(&golden.components[0])],
        ..golden.clone()
    };

    let out_dir = tempfile::tempdir().expect("tempdir");
    let err = emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .unwrap_err();
    assert!(
        err.0
            .contains("human_approval: fail on claude-code:headless"),
        "unexpected error message: {}",
        err.0
    );

    let files: Vec<_> = std::fs::read_dir(out_dir.path()).unwrap().collect();
    assert!(
        files.is_empty(),
        "no files should be emitted when resolution aborts"
    );
}

#[test]
fn render_contract_implied_by_render_blocks_realize_via_headless_degrade_interactive_never_fail() {
    let golden = load_golden_ir();
    let node = &golden.components[0];
    assert!(!node.effect.render_blocks.is_empty());

    let headless_report =
        resolve_node_capabilities(node, "claude-code:headless").expect("resolves");
    let interactive_report =
        resolve_node_capabilities(node, "claude-code:interactive").expect("resolves");

    assert_eq!(
        outcome_str(find_entry(&headless_report, "render_contract")),
        "realize-via"
    );
    assert_eq!(
        outcome_str(find_entry(&interactive_report, "render_contract")),
        "degrade"
    );
}

#[test]
fn unknown_target_returns_a_clear_error() {
    let golden = load_golden_ir();
    let node = &golden.components[0];
    let err = resolve_node_capabilities(node, "claude-code:vscode").unwrap_err();
    assert!(
        err.0
            .contains("target 'claude-code:vscode' has no capability profile"),
        "unexpected error message: {}",
        err.0
    );
}
