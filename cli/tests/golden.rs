//! End-to-end golden tests: compile the real example projects through the real MDL `ContextLoader`
//! (the full host path) and assert the emitted IR equals the committed `ir.golden.json`, plus the
//! structural invariants each project is meant to demonstrate. These moved here from the core crate
//! in Phase 2 because they now depend on the binding-layer MDL adapter (core stays zero-wren).

use std::fs;
use std::path::{Path, PathBuf};

use warble_cli::compile_project_to_ir;

fn project(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(rel)
}

fn compile(rel: &str) -> serde_json::Value {
    compile_project_to_ir(&project(rel)).unwrap_or_else(|e| panic!("{rel} must compile: {e}"))
}

fn golden(rel: &str) -> serde_json::Value {
    let path = project(rel).join("ir.golden.json");
    serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap()
}

#[test]
fn golden_demo_agent_matches_exactly() {
    let ir = compile("examples/demo-agent");
    assert_eq!(ir, golden("examples/demo-agent"), "IR must equal golden");

    assert_eq!(ir["warble_ir_version"], "0.3");
    // Fine-grained resolved binding is present (jaffle-wren metrics/dimensions).
    assert!(ir["context_binding"]["resolved"]["metrics"].is_array());

    let render_blocks = ir["components"][0]["effect"]["render_blocks"]
        .as_array()
        .unwrap();
    assert_eq!(
        render_blocks,
        &vec![
            serde_json::json!({ "type": "chart", "fields": {} }),
            serde_json::json!({ "type": "table", "fields": {} }),
            serde_json::json!({ "type": "kpi_card", "fields": {} }),
        ],
        "bare-string render_blocks must normalize to typed objects with empty fields"
    );
}

#[test]
fn golden_render_demo_matches_exactly() {
    let ir = compile("examples/render-demo");
    assert_eq!(ir, golden("examples/render-demo"), "IR must equal golden");

    let component = &ir["components"][0];
    let guardrails = component["guardrails"].as_array().unwrap();
    assert_eq!(
        guardrails,
        &vec![
            serde_json::json!({ "name": "read_only_execution", "locked": true }),
            serde_json::json!({ "name": "artifact_write", "locked": true, "scope": "." }),
        ],
        "artifact_write guardrail must carry its scope through unchanged"
    );
    let required_capabilities = component["required_capabilities"].as_array().unwrap();
    for capability in ["render_contract", "artifact_write"] {
        assert!(
            required_capabilities.contains(&serde_json::json!(capability)),
            "required_capabilities must contain '{capability}'"
        );
    }
}

#[test]
fn golden_genbi_default_matches_exactly() {
    let ir = compile("genbi-default");
    assert_eq!(ir, golden("genbi-default"), "IR must equal golden");

    let components = ir["components"].as_array().unwrap();
    let verbs: Vec<&str> = components
        .iter()
        .map(|c| c["verb"].as_str().unwrap())
        .collect();
    assert_eq!(
        verbs,
        vec![
            "explore_model",
            "answer_query",
            "generate_dashboard",
            "explain_change"
        ]
    );

    let by_verb = |verb: &str| -> &serde_json::Value {
        components
            .iter()
            .find(|c| c["verb"] == verb)
            .unwrap_or_else(|| panic!("component '{verb}' must be present"))
    };

    // explore_model: semantic_introspection, renders nothing.
    let explore = by_verb("explore_model");
    assert!(explore["required_capabilities"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("semantic_introspection")));
    assert_eq!(explore["effect"]["render_blocks"], serde_json::json!([]));

    // answer_query: 3-step canonical with repair_sql conditional.
    let answer = by_verb("answer_query");
    let repair = answer["llm_calls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "repair_sql")
        .expect("repair_sql step must be present");
    assert_eq!(repair["conditional"], serde_json::json!(true));

    // generate_dashboard: has_metric + has_groupable_dimension both evaluated to pass.
    let dashboard = by_verb("generate_dashboard");
    assert_eq!(
        dashboard["precondition_result"]["checks"],
        serde_json::json!([
            { "predicate": "has_metric", "outcome": "pass" },
            { "predicate": "has_groupable_dimension", "outcome": "pass" },
        ]),
        "dashboard preconditions must be really evaluated against the MDL and pass"
    );

    // explain_change: metric_additive now really evaluated (existential) and passes because the
    // jaffle-wren revenue cube declares an additive measure (total_revenue = SUM).
    let explain = by_verb("explain_change");
    assert_eq!(
        explain["precondition_result"]["checks"],
        serde_json::json!([
            { "predicate": "metric_additive", "outcome": "pass" },
            { "predicate": "has_time_dimension", "outcome": "pass" },
            { "predicate": "has_groupable_dimension", "outcome": "pass" },
        ]),
        "explain_change additivity precondition is enforced at compile time in Phase 2"
    );

    // The resolved binding surfaces the declared metric + its inferred additivity.
    let resolved_metrics = ir["context_binding"]["resolved"]["metrics"]
        .as_array()
        .unwrap();
    let total_revenue = resolved_metrics
        .iter()
        .find(|m| m["name"] == "total_revenue")
        .expect("total_revenue metric must be resolved from the revenue cube");
    assert_eq!(total_revenue["declared"], serde_json::json!(true));
    assert_eq!(total_revenue["additivity"], serde_json::json!("additive"));
}

#[test]
fn golden_mini_agent_matches_exactly() {
    let ir = compile("examples/mini-agent");
    assert_eq!(ir, golden("examples/mini-agent"), "IR must equal golden");

    let component = &ir["components"][0];
    assert_eq!(
        component["context_precondition"],
        serde_json::json!([{ "predicate": "wren_project_exists" }]),
        "structured context_precondition predicate must be carried into the IR"
    );
    assert_eq!(
        component["precondition_result"]["checks"],
        serde_json::json!([{ "predicate": "wren_project_exists", "outcome": "pass" }]),
        "wren_project_exists is evaluated (the bound project parses) and passes"
    );
    assert_eq!(
        component["params"],
        serde_json::json!([
            { "name": "style", "bind": "optional", "default": "concise" },
            { "name": "model_binding", "source": "runtime-injected" },
        ])
    );
}

/// The litmus: the first STRUCTURALLY different component compiles through the identical front-end
/// with no spine change. `monitor_freshness` is assertive / tool / scheduled / assertion, yet its IR
/// is emitted by the same compiler as the GenBI four — the assertion arm rides the existing
/// `effect.outcome` (verdict_type + emits), the scheduled trigger rides the existing `trigger.kind`,
/// and `model_has_timestamp` is really evaluated against jaffle-wren's `orders` DATE column.
#[test]
fn golden_monitor_agent_matches_exactly() {
    let ir = compile("examples/monitor-agent");
    assert_eq!(ir, golden("examples/monitor-agent"), "IR must equal golden");

    assert_eq!(ir["warble_ir_version"], "0.3");
    let c = &ir["components"][0];

    // The four structurally-new anatomy positions, all in fields the spine already had.
    assert_eq!(c["type"], "assertive");
    assert_eq!(c["realization_kind"], "tool");
    assert_eq!(c["trigger"]["kind"], "scheduled");
    assert_eq!(
        c["effect"]["outcome"],
        serde_json::json!({
            "kind": "assertion",
            "verdict_type": "freshness_verdict",
            "emits": ["freshness_breach"],
        }),
        "assertion outcome rides the existing effect.outcome arm — no new spine field"
    );
    assert_eq!(
        c["effect"]["render_blocks"],
        serde_json::json!([{ "type": "status", "fields": {} }]),
        "the verdict's presentational facet is a status block"
    );

    // The precondition is really evaluated (not a placeholder): orders carries a DATE column.
    assert_eq!(
        c["context_precondition"],
        serde_json::json!([{ "predicate": "model_has_timestamp", "args": { "model": "$param:model" } }])
    );
    assert_eq!(
        c["precondition_result"]["checks"],
        serde_json::json!([{ "predicate": "model_has_timestamp", "outcome": "pass" }]),
        "model_has_timestamp is evaluated against the bound MDL and passes"
    );

    // Borrowed transports are declared as capabilities; on-breach actions are borrowed, not owned.
    let caps = c["required_capabilities"].as_array().unwrap();
    for cap in ["scheduler", "sql_execution:read_only", "notify_channel"] {
        assert!(
            caps.contains(&serde_json::json!(cap)),
            "required_capabilities must contain {cap}"
        );
    }
    assert_eq!(
        c["borrowed_actions"],
        serde_json::json!(["notify_slack", "open_ticket"])
    );
}

#[test]
fn golden_mutate_agent_matches_exactly() {
    let ir = compile("examples/mutate-agent");
    assert_eq!(ir, golden("examples/mutate-agent"), "IR must equal golden");

    assert_eq!(ir["warble_ir_version"], "0.3");
    let c = &ir["components"][0];

    // The +Mutating anatomy positions — all in fields the spine already carried (no new arm).
    assert_eq!(c["type"], "mutating");
    assert_eq!(c["realization_kind"], "gated-tool");
    assert_eq!(c["trigger"]["kind"], "one_shot");
    assert_eq!(
        c["effect"]["outcome"],
        serde_json::json!({
            "kind": "mutation",
            "target": "data",
            "change_type": "pipeline_definition",
        }),
        "mutation outcome rides the existing effect.outcome arm — target/change_type are facets, not new spine fields"
    );
    assert_eq!(
        c["effect"]["render_blocks"],
        serde_json::json!([{ "type": "diff", "fields": {} }]),
        "the change's presentational facet is a diff block"
    );

    // The precondition is really evaluated: jaffle-wren's lineage is resolvable, so a change's
    // blast radius can be computed and gated.
    assert_eq!(
        c["context_precondition"],
        serde_json::json!([{ "predicate": "lineage_resolvable" }])
    );
    assert_eq!(
        c["precondition_result"]["checks"],
        serde_json::json!([{ "predicate": "lineage_resolvable", "outcome": "pass" }]),
        "lineage_resolvable is evaluated against the bound MDL and passes"
    );

    // The mutating safety floor: every guardrail locked (a profile cannot weaken them).
    let guardrails = c["guardrails"].as_array().unwrap();
    for name in [
        "must_dry_run",
        "human_approval",
        "blast_radius_limit",
        "rollback_available",
        "write_authz",
    ] {
        let g = guardrails
            .iter()
            .find(|g| g["name"] == name)
            .unwrap_or_else(|| panic!("guardrail {name} must be present"));
        assert_eq!(g["locked"], true, "guardrail {name} must be locked");
    }
    // The moat gate carries its threshold through to the IR.
    let blast = guardrails
        .iter()
        .find(|g| g["name"] == "blast_radius_limit")
        .unwrap();
    assert_eq!(blast["threshold"]["max_severity"], "structural");
    assert_eq!(blast["threshold"]["max_downstream"], 5);

    // The moat + borrowed mutation capabilities are declared: human_approval (locked → fails on a
    // human-less target) and blast_radius (provided_by warble) among them.
    let caps = c["required_capabilities"].as_array().unwrap();
    for cap in [
        "blast_radius",
        "human_approval",
        "write_authz",
        "version_control",
        "sql_execution:read_only",
    ] {
        assert!(
            caps.contains(&serde_json::json!(cap)),
            "required_capabilities must contain {cap}"
        );
    }
}
