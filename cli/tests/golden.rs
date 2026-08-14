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

    assert_eq!(ir["warble_ir_version"], "0.4");
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
    assert_eq!(
        repair["when"],
        serde_json::json!({ "guard": "on_failure", "target": "generate_sql" }),
        "a conditional step's `when` guard (here on_failure) must compile into the IR"
    );
    let generate_sql = answer["llm_calls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "generate_sql")
        .expect("generate_sql step must be present");
    let programmatic_contract = generate_sql["prompt"].as_str().unwrap();
    for required in [
        "exactly one object with this shape and no extra keys",
        "\"columns\"",
        "\"rows\"",
        "\"summary\"",
        "\"verified\": true",
        "\"definition\"",
    ] {
        assert!(
            programmatic_contract.contains(required),
            "the golden programmatic answer_query contract must retain {required}"
        );
    }

    // generate_dashboard: no context_precondition -- WrenAI is an orchestrator and doesn't gate
    // on data-shape/richness (has_groupable_dimension was dropped, same reasoning that already
    // dropped has_metric); that check belongs at the sub-agent level.
    let dashboard = by_verb("generate_dashboard");
    assert_eq!(
        dashboard["context_precondition"],
        serde_json::json!([]),
        "generate_dashboard declares no context_precondition"
    );
    assert_eq!(
        dashboard["precondition_result"]["checks"],
        serde_json::json!([]),
        "with no declared preconditions there is nothing to evaluate"
    );

    // explain_change: no context_precondition -- metric_additive / has_time_dimension /
    // has_groupable_dimension were all dropped for the same orchestrator-shouldn't-gate reason.
    // The per-metric additivity check still runs at runtime via the additivity_guard guardrail.
    let explain = by_verb("explain_change");
    assert_eq!(
        explain["context_precondition"],
        serde_json::json!([]),
        "explain_change declares no context_precondition"
    );
    assert_eq!(
        explain["precondition_result"]["checks"],
        serde_json::json!([]),
        "with no declared preconditions there is nothing to evaluate"
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

    assert_eq!(ir["warble_ir_version"], "0.4");
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

    // The precondition is really evaluated (not a placeholder): orders carries a DATE column. The
    // IR carries the RESOLVED bind value ("orders"), not the authored "$param:model" template.
    assert_eq!(
        c["context_precondition"],
        serde_json::json!([{ "predicate": "model_has_timestamp", "args": { "model": "orders" } }])
    );
    assert_eq!(
        c["precondition_result"]["checks"],
        serde_json::json!([{ "predicate": "model_has_timestamp", "outcome": "pass" }]),
        "model_has_timestamp is evaluated against the bound MDL and passes"
    );

    // The `binds` facet carries the effective values: "model" from the mount, "expected_cadence"
    // from the param's declared default (the mount doesn't supply it) — runtime-injected params
    // (connection, model_binding) are excluded.
    assert_eq!(
        c["binds"],
        serde_json::json!({ "model": "orders", "expected_cadence": "24h" })
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

    // assess_severity is guarded by on_flag(freshness_reading.stale) — a guarded-skip conditional
    // step carrying a closed-vocabulary `when` guard, not a bare `conditional` bool.
    let assess = c["llm_calls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|call| call["name"] == "assess_severity")
        .expect("assess_severity step must be present");
    assert_eq!(assess["conditional"], serde_json::json!(true));
    assert_eq!(
        assess["when"],
        serde_json::json!({ "guard": "on_flag", "target": "freshness_reading.stale" })
    );
}

#[test]
fn golden_mutate_agent_matches_exactly() {
    let ir = compile("examples/mutate-agent");
    assert_eq!(ir, golden("examples/mutate-agent"), "IR must equal golden");

    assert_eq!(ir["warble_ir_version"], "0.4");
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

#[test]
fn golden_driftwood_agent_matches_exactly() {
    let ir = compile("examples/driftwood-agent");
    assert_eq!(
        ir,
        golden("examples/driftwood-agent"),
        "IR must equal golden"
    );

    // driftwood-wren is authored in the wren CLI v5 project shape (keyed `relationships:`
    // mapping + `cubes/<name>/metadata.yml`), so this golden also exercises that adapter
    // path end-to-end — jaffle-wren covers the older bare-list + root-cubes.yml shape.
    let resolved = &ir["context_binding"]["resolved"];
    assert_eq!(
        resolved["lineage"]["resolvable"], true,
        "keyed relationships must produce a resolvable lineage"
    );
    // Cubes from the cubes/ directory reach the fine-grained binding: declared measures
    // (e.g. mrr_metrics.mrr) appear among the resolved metrics with known additivity.
    let metrics = resolved["metrics"].as_array().unwrap();
    let mrr = metrics
        .iter()
        .find(|m| m["name"] == "mrr")
        .expect("declared cube measure `mrr` must be resolved");
    assert_eq!(mrr["additivity"], "additive", "SUM measure infers additive");
}

/// The Constitutive litmus (Phase 4b): a component whose OUTPUT is the Context compiles through the
/// identical front-end, and the SPINE grows by vocabulary only. Two constitutive components mount on
/// a RAW source binding (no MDL yet); their preconditions read the new raw-shape predicates, and each
/// reuses the +Mutating `mutation` arm with `target: context` — differentiated from 4a's `target:
/// data` by that facet alone, no new outcome arm. The scoped third enforcement point (`models/` vs
/// `knowledge/`) is carried through per-component.
#[test]
fn golden_bootstrap_agent_matches_exactly() {
    let ir = compile("examples/bootstrap-agent");
    assert_eq!(
        ir,
        golden("examples/bootstrap-agent"),
        "IR must equal golden"
    );

    assert_eq!(ir["warble_ir_version"], "0.4");
    let components = ir["components"].as_array().unwrap();
    let by_verb = |verb: &str| -> &serde_json::Value {
        components
            .iter()
            .find(|c| c["verb"] == verb)
            .unwrap_or_else(|| panic!("component '{verb}' must be present"))
    };

    // bootstrap_mdl: constitutive, raw-shape precondition really evaluated against the raw source.
    let bootstrap = by_verb("bootstrap_mdl");
    assert_eq!(bootstrap["type"], "constitutive");
    assert_eq!(bootstrap["realization_kind"], "gated-tool");
    assert_eq!(
        bootstrap["context_precondition"],
        serde_json::json!([{ "predicate": "source_introspectable" }])
    );
    assert_eq!(
        bootstrap["precondition_result"]["checks"],
        serde_json::json!([{ "predicate": "source_introspectable", "outcome": "pass" }]),
        "source_introspectable is evaluated against the RAW source (not an existing MDL) and passes"
    );
    // The mutation arm is REUSED with target: context (spine stays 4-valued — no new outcome arm).
    assert_eq!(
        bootstrap["effect"]["outcome"],
        serde_json::json!({
            "kind": "mutation",
            "target": "context",
            "change_type": "mdl_bootstrap",
        }),
        "constitutive rides the +Mutating mutation arm; target: context is the facet, not a new arm"
    );
    // The third enforcement point, scoped to models/ (constitutive has NO blast_radius: it CREATES
    // lineage rather than gating an existing one).
    let bootstrap_guardrails = bootstrap["guardrails"].as_array().unwrap();
    let context_authz = bootstrap_guardrails
        .iter()
        .find(|g| g["name"] == "context_write_authz")
        .expect("context_write_authz guardrail present");
    assert_eq!(context_authz["locked"], true);
    assert_eq!(context_authz["scope"], "models/");
    assert!(
        !bootstrap_guardrails
            .iter()
            .any(|g| g["name"] == "blast_radius_limit"),
        "a constitutive create has no existing lineage to gate — no blast_radius_limit"
    );
    let bootstrap_caps = bootstrap["required_capabilities"].as_array().unwrap();
    for cap in [
        "schema_introspection",
        "context_write_authz",
        "human_approval",
    ] {
        assert!(
            bootstrap_caps.contains(&serde_json::json!(cap)),
            "bootstrap_mdl required_capabilities must contain {cap}"
        );
    }
    assert!(
        !bootstrap_caps.contains(&serde_json::json!("blast_radius")),
        "constitutive does not require blast_radius"
    );

    // enrich_knowledge: the sibling constitutive component reads the OTHER raw-shape predicate and
    // writes a DIFFERENT scope (knowledge/) — proving the scope is a per-component boundary.
    let enrich = by_verb("enrich_knowledge");
    assert_eq!(enrich["type"], "constitutive");
    assert_eq!(
        enrich["precondition_result"]["checks"],
        serde_json::json!([{ "predicate": "raw_docs_readable", "outcome": "pass" }]),
        "raw_docs_readable is evaluated against the raw docs and passes"
    );
    let enrich_scope = enrich["guardrails"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == "context_write_authz")
        .expect("context_write_authz guardrail present")["scope"]
        .clone();
    assert_eq!(
        enrich_scope, "knowledge/",
        "enrich_knowledge is scoped to knowledge/, NOT models/ — the scopes do not cross"
    );
}

/// genbi-setup (Phase 1 of the agentic onboarding flow): a new 5th enforcement point,
/// `setup_execution`, and two components that deliberately stay on the skill/`outcome.kind: none`
/// lifecycle rather than constitutive/gated-tool — unlike bootstrap_mdl above, there is no MDL diff
/// to gate here, only guarded onboarding actions (Bash + scoped Write), so `human_approval` never
/// enters the picture and this profile compiles clean on a headless target. Also exercises the RAW
/// binding path with an intentionally empty `raw/schema.json` (no tables) — proving the coarse
/// `is_parseable()` floor only needs a schema that parses, independent of any per-component
/// precondition (neither component here declares one).
#[test]
fn golden_genbi_setup_matches_exactly() {
    let ir = compile("genbi-setup");
    assert_eq!(ir, golden("genbi-setup"), "IR must equal golden");

    assert_eq!(ir["warble_ir_version"], "0.4");
    let components = ir["components"].as_array().unwrap();
    let verbs: Vec<&str> = components
        .iter()
        .map(|c| c["verb"].as_str().unwrap())
        .collect();
    assert_eq!(verbs, vec!["connect_source", "build_context"]);

    let by_verb = |verb: &str| -> &serde_json::Value {
        components
            .iter()
            .find(|c| c["verb"] == verb)
            .unwrap_or_else(|| panic!("component '{verb}' must be present"))
    };

    for (verb, capability) in [
        ("connect_source", "source_connect"),
        ("build_context", "context_build"),
    ] {
        let c = by_verb(verb);
        assert_eq!(c["type"], "analytical");
        assert_eq!(c["realization_kind"], "skill");
        assert_eq!(
            c["effect"]["outcome"],
            serde_json::json!({ "kind": "none" }),
            "{verb} stays on the skill lifecycle (outcome.kind: none), not gated-tool/mutation"
        );
        assert_eq!(
            c["context_precondition"],
            serde_json::json!([]),
            "{verb} declares no context_precondition — no existing semantic layer to probe yet"
        );

        // The 5th enforcement point: setup_execution, locked, scoped to the project root.
        let guardrails = c["guardrails"].as_array().unwrap();
        let setup = guardrails
            .iter()
            .find(|g| g["name"] == "setup_execution")
            .unwrap_or_else(|| panic!("{verb} must carry the setup_execution guardrail"));
        assert_eq!(
            setup["locked"], true,
            "{verb}'s setup_execution must be locked"
        );
        assert_eq!(
            setup["scope"], ".",
            "{verb}'s setup_execution scope defaults to the project root"
        );
        assert!(
            !guardrails
                .iter()
                .any(|g| g["name"] == "read_only_execution"),
            "{verb} must NOT also declare read_only_execution — setup_execution is its own flavor"
        );

        let caps = c["required_capabilities"].as_array().unwrap();
        assert!(
            caps.contains(&serde_json::json!(capability)),
            "{verb} required_capabilities must contain {capability}"
        );
    }

    // The RAW binding resolved (no MDL): context_binding.project is the raw pointer, not an MDL path.
    assert_eq!(ir["context_binding"]["project"], "raw");
}

/// genbi-monitor: the genbi-facing product profile that mounts `monitor_freshness` (sibling to
/// genbi-default/genbi-setup, at the repo root rather than under examples/). Structurally identical
/// to the examples/monitor-agent litmus, but deliberately binds `expected_cadence` to a NON-default
/// value (`48h`, vs the component's own default `24h`) -- a defaulted optional bind would compile
/// to the same IR whether or not binds actually flow through, so this golden is the one that proves
/// a *mount-supplied* optional bind (not just a required one) reaches the IR's `binds` facet and, if
/// referenced by a precondition, its resolved args.
#[test]
fn golden_genbi_monitor_matches_exactly() {
    let ir = compile("genbi-monitor");
    assert_eq!(ir, golden("genbi-monitor"), "IR must equal golden");

    assert_eq!(ir["warble_ir_version"], "0.4");
    let c = &ir["components"][0];
    assert_eq!(c["verb"], "monitor_freshness");

    // The precondition is really evaluated against jaffle-wren's `orders` model (DATE column) and
    // carries the RESOLVED bind value, not the authored "$param:model" template.
    assert_eq!(
        c["context_precondition"],
        serde_json::json!([{ "predicate": "model_has_timestamp", "args": { "model": "orders" } }])
    );
    assert_eq!(
        c["precondition_result"]["checks"],
        serde_json::json!([{ "predicate": "model_has_timestamp", "outcome": "pass" }])
    );

    // Both the required bind (`model`) and the NON-default optional bind (`expected_cadence: 48h`,
    // not the component's `24h` default) reach the IR's additive `binds` facet.
    assert_eq!(
        c["binds"],
        serde_json::json!({ "model": "orders", "expected_cadence": "48h" }),
        "a non-default optional bind must flow through, not silently fall back to the param default"
    );
    // The component's own declared default is unaffected -- only the mount's effective value changed.
    assert_eq!(
        c["params"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == "expected_cadence")
            .unwrap()["default"],
        serde_json::json!("24h")
    );
}

/// Optional post-bind enrichment is intentionally a separate profile from genbi-setup. It proves
/// the compiler sees an existing pinned MDL, while the terminal/approval lifecycle is owned by the
/// typed host contract rather than expanding onboarding's guarded setup execution.
#[test]
fn golden_genbi_enrich_context_matches_exactly() {
    let ir = compile("genbi-enrich-context");
    assert_eq!(ir, golden("genbi-enrich-context"), "IR must equal golden");

    let components = ir["components"].as_array().unwrap();
    let verbs: Vec<&str> = components
        .iter()
        .map(|component| component["verb"].as_str().unwrap())
        .collect();
    assert_eq!(
        verbs,
        vec!["inspect_context", "draft_enrichment", "apply_enrichment"]
    );

    let by_verb = |verb: &str| -> &serde_json::Value {
        components
            .iter()
            .find(|component| component["verb"] == verb)
            .unwrap_or_else(|| panic!("component '{verb}' must be present"))
    };
    for verb in ["inspect_context", "draft_enrichment", "apply_enrichment"] {
        let component = by_verb(verb);
        assert_eq!(component["context_binding"]["binding_mode"], "pinned");
        assert_eq!(
            component["context_precondition"],
            serde_json::json!([{ "predicate": "wren_project_exists" }]),
            "{verb} requires an existing bound project"
        );
    }

    let inspect = by_verb("inspect_context");
    assert_eq!(inspect["llm_calls"][0]["tier"], "cheap");
    assert!(
        inspect["guardrails"]
            .as_array()
            .unwrap()
            .iter()
            .any(|guardrail| guardrail["name"] == "read_only_execution"
                && guardrail["locked"] == true)
    );

    let draft = by_verb("draft_enrichment");
    assert_eq!(draft["llm_calls"][0]["tier"], "strong");
    let draft_prompt = draft["llm_calls"][0]["prompt"].as_str().unwrap();
    for required in [
        "cubes/<name>/metadata.yml",
        "`base_object`",
        "Never invent",
        "host validates the sink and revision",
        "Do not include prose or",
        "Markdown fences",
        "`measures: [{name, expression, type}]`",
        "Do not emit",
        "`autopilot_eligible: false`",
        "`[\"accept\", \"edit\", \"skip\"]`",
    ] {
        assert!(
            draft_prompt.contains(required),
            "draft contract must contain '{required}'"
        );
    }
    assert!(
        !draft_prompt.contains("Make a proposal hash"),
        "authoritative proposal hashes are host-owned, never model-authored"
    );
    assert_eq!(
        draft["effect"]["outcome"],
        serde_json::json!({ "kind": "none" })
    );

    let apply = by_verb("apply_enrichment");
    assert_eq!(
        apply["llm_calls"],
        serde_json::json!([]),
        "apply is deterministic, not an LLM step"
    );
    assert_eq!(apply["type"], "constitutive");
    assert_eq!(apply["realization_kind"], "gated-tool");
    assert_eq!(
        apply["effect"]["outcome"],
        serde_json::json!({
            "kind": "mutation",
            "target": "context",
            "change_type": "context_enrichment",
        })
    );
    for name in [
        "must_dry_run",
        "human_approval",
        "no_silent_overwrite",
        "context_write_authz",
        "rollback_available",
    ] {
        assert!(
            apply["guardrails"]
                .as_array()
                .unwrap()
                .iter()
                .any(|guardrail| guardrail["name"] == name && guardrail["locked"] == true),
            "{name} must be locked"
        );
    }
    assert_eq!(
        apply["guardrails"]
            .as_array()
            .unwrap()
            .iter()
            .find(|guardrail| guardrail["name"] == "context_write_authz")
            .unwrap()["scope"],
        "enrichment-sinks",
        "the apply contract is sink-scoped, never a broad project write"
    );
}

#[test]
fn golden_brief_demo_matches_exactly() {
    let ir = compile("examples/brief-demo");
    assert_eq!(ir, golden("examples/brief-demo"), "IR must equal golden");

    let component = &ir["components"][0];
    assert_eq!(
        component["brief"],
        serde_json::json!(
            "You are a senior data analyst working on the jaffle-wren project, serving business users\n\
             who don't write SQL. Their questions are often ambiguous about exactly what they mean — state\n\
             any assumption you had to make before giving your answer."
        ),
        "brief must be rendered with the same {{project_name}} placeholder substitution as step prompts, \
         and emitted once on the component node (not per-step)"
    );
}
