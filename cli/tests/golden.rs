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

    assert_eq!(ir["warble_ir_version"], "0.6");
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

/// `examples/analysis-agent` is the fixture warble's own suites compare against — the compliance
/// ground truth, the IR-version gate's positive control, the Agent SDK turnkey/route/ir/manifest
/// suites and the codex ask path all read its golden. Every other profile that ships a golden has
/// a sync gate below; without one here, a component edit could regenerate every other golden
/// loudly while this one went quietly stale, and each of those suites would keep passing against
/// an IR the compiler no longer produces.
///
/// It is also where the analytical quartet's per-component assertions live — the conditional
/// repair step, the programmatic answer contract, the deliberately absent data-shape
/// preconditions, and the resolved metric's inferred additivity.
#[test]
fn golden_analysis_agent_matches_exactly() {
    let ir = compile("examples/analysis-agent");
    assert_eq!(
        ir,
        golden("examples/analysis-agent"),
        "IR must equal golden"
    );

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

    // generate_dashboard: no context_precondition -- an orchestrator does not gate on
    // data-shape/richness (has_groupable_dimension was dropped, same reasoning that already
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

    assert_eq!(ir["warble_ir_version"], "0.6");
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
    // consumes must name a slot a real, strictly-earlier step produces — see
    // `monitor_freshness_assess_severity_is_reachable` below for the reachability proof itself.
    assert_eq!(assess["consumes"], serde_json::json!(["freshness_reading"]));

    // read_freshness runs the deterministic assert and produces the slot assess_severity consumes
    // and gates on; it is the fix for assess_severity previously being unreachable.
    let read = c["llm_calls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|call| call["name"] == "read_freshness")
        .expect("read_freshness step must be present");
    assert_eq!(read["produces"], serde_json::json!("freshness_reading"));
}

/// Mutation proof: `assess_severity` is only ever reachable if BOTH (a) every slot it `consumes`
/// and (b) the slot its `when.target` guards on are each `produces`d by some OTHER, strictly
/// earlier step in `llm_calls`. Before `read_freshness` existed, `freshness_reading` had no
/// producer at all — `assess_severity` named a slot nothing ever wrote, so the guard could never
/// observe anything but the dispatcher's placeholder-error string and the step could never
/// meaningfully run. This test fails the same way today if that regresses.
#[test]
fn monitor_freshness_assess_severity_is_reachable() {
    let ir = compile("examples/monitor-agent");
    let calls = ir["components"][0]["llm_calls"].as_array().unwrap();

    let assess_index = calls
        .iter()
        .position(|call| call["name"] == "assess_severity")
        .expect("assess_severity step must be present");
    let assess = &calls[assess_index];

    let consumed_slots = assess["consumes"]
        .as_array()
        .expect("assess_severity must declare consumes")
        .iter()
        .map(|v| v.as_str().unwrap().to_string());
    let guard_target = assess["when"]["target"]
        .as_str()
        .expect("assess_severity must declare a when.target");
    let guard_slot = guard_target
        .split('.')
        .next()
        .expect("when.target must be a dotted path");

    for slot in consumed_slots.chain(std::iter::once(guard_slot.to_string())) {
        let producer = calls[..assess_index]
            .iter()
            .find(|call| call["produces"] == serde_json::json!(slot));
        assert!(
            producer.is_some(),
            "no strictly-earlier step produces slot '{slot}' that assess_severity consumes or \
             gates on — assess_severity is unreachable"
        );
    }
}

#[test]
fn golden_mutate_agent_matches_exactly() {
    let ir = compile("examples/mutate-agent");
    assert_eq!(ir, golden("examples/mutate-agent"), "IR must equal golden");

    assert_eq!(ir["warble_ir_version"], "0.6");
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

    assert_eq!(ir["warble_ir_version"], "0.6");
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

/// `examples/provision-agent` is the neutral setup-shaped fixture: two one-shot SKILL components
/// under the setup enforcement point (`setup_execution`), bound to a raw source because nothing has
/// been built yet. The Agent SDK's option/resolve/codegen suites and the codex setup path read its
/// golden, so it needs a sync gate for the same reason every other golden-shipping profile has one:
/// without it a compiler change could regenerate every other golden loudly while this one went
/// quietly stale, and each of those suites would keep passing against an IR the compiler no longer
/// produces.
///
/// The realization MIX is the property here, not the component count. `examples/bootstrap-agent`
/// also mounts two components over a raw binding, but both are gated-tool, so it never reaches skill
/// materialization, the setup guard, or the bootstrap scope kind.
#[test]
fn golden_provision_agent_matches_exactly() {
    let ir = compile("examples/provision-agent");
    assert_eq!(
        ir,
        golden("examples/provision-agent"),
        "IR must equal golden"
    );

    assert_eq!(ir["warble_ir_version"], "0.6");
    let components = ir["components"].as_array().unwrap();
    let verbs: Vec<&str> = components
        .iter()
        .map(|c| c["verb"].as_str().unwrap())
        .collect();
    assert_eq!(verbs, vec!["attach_source", "compose_context"]);

    let by_verb = |verb: &str| -> &serde_json::Value {
        components
            .iter()
            .find(|c| c["verb"] == verb)
            .unwrap_or_else(|| panic!("component '{verb}' must be present"))
    };

    for (verb, capability) in [
        ("attach_source", "source_connect"),
        ("compose_context", "context_build"),
    ] {
        let c = by_verb(verb);
        assert_eq!(c["type"], "analytical");
        assert_eq!(c["realization_kind"], "skill");
        assert_eq!(c["trigger"]["kind"], "one_shot");
        assert_eq!(
            c["effect"]["outcome"],
            serde_json::json!({ "kind": "none" }),
            "{verb} stays on the skill lifecycle (outcome.kind: none), not gated-tool/mutation"
        );
        assert_eq!(
            c["effect"]["render_blocks"],
            serde_json::json!([]),
            "{verb} renders nothing — the Setup contract rejects a component that does"
        );
        assert_eq!(
            c["context_precondition"],
            serde_json::json!([]),
            "{verb} declares no context_precondition — there is no semantic layer to probe yet"
        );

        // The setup enforcement point: exactly one guardrail, locked, scoped to the project root.
        let guardrails = c["guardrails"].as_array().unwrap();
        assert_eq!(
            guardrails,
            &vec![serde_json::json!({
                "name": "setup_execution",
                "locked": true,
                "scope": "."
            })],
            "{verb} must carry exactly one locked setup_execution guardrail scoped to '.'"
        );

        // Exactly one domain capability plus its single tier — the Setup contract checks the set
        // exactly, so `contains` would not notice a third capability creeping in.
        assert_eq!(
            c["required_capabilities"],
            serde_json::json!([capability, "llm:strong"]),
            "{verb} must require exactly {capability} and llm:strong"
        );
    }

    // The RAW binding resolved: context_binding.project is the raw pointer, not a semantic project.
    assert_eq!(ir["context_binding"]["project"], "raw");
}

/// `examples/propose-apply-agent` is the neutral read-only-vs-mutating fixture: two one-shot SKILL
/// components followed by a gated-tool whose outcome is a mutation of the bound context. Both the
/// Agent SDK and codex enrich suites read its golden, so it carries a sync gate for the same reason
/// as every other golden-shipping profile.
///
/// The SPLIT is the property. `examples/analysis-agent` is all skills and `examples/mutate-agent` is
/// one gated-tool alone, so neither can show that a target which cannot honestly realize the apply
/// wall-hits on that component while the read-only components still dispatch.
#[test]
fn golden_propose_apply_agent_matches_exactly() {
    let ir = compile("examples/propose-apply-agent");
    assert_eq!(
        ir,
        golden("examples/propose-apply-agent"),
        "IR must equal golden"
    );

    assert_eq!(ir["warble_ir_version"], "0.6");
    let components = ir["components"].as_array().unwrap();
    let verbs: Vec<&str> = components
        .iter()
        .map(|component| component["verb"].as_str().unwrap())
        .collect();
    assert_eq!(
        verbs,
        vec!["survey_context", "propose_changes", "apply_changes"]
    );

    let by_verb = |verb: &str| -> &serde_json::Value {
        components
            .iter()
            .find(|component| component["verb"] == verb)
            .unwrap_or_else(|| panic!("component '{verb}' must be present"))
    };
    for verb in ["survey_context", "propose_changes", "apply_changes"] {
        let component = by_verb(verb);
        assert_eq!(component["context_binding"]["binding_mode"], "pinned");
        assert_eq!(
            component["context_precondition"],
            serde_json::json!([{ "predicate": "wren_project_exists" }]),
            "{verb} requires an existing bound project"
        );
    }

    // The cheap read-only half declares BOTH enrich domain capabilities; the strong half declares
    // only one. The pair is what shows the contract accepts a subset rather than a fixed set.
    let survey = by_verb("survey_context");
    assert_eq!(survey["llm_calls"][0]["tier"], "cheap");
    assert_eq!(
        survey["required_capabilities"],
        serde_json::json!(["semantic_introspection", "raw_material_read", "llm:cheap"])
    );
    assert_eq!(
        survey["guardrails"],
        serde_json::json!([{ "name": "read_only_execution", "locked": true }]),
        "read-only means exactly one locked read_only_execution guardrail, with no scope"
    );

    let propose = by_verb("propose_changes");
    assert_eq!(propose["llm_calls"][0]["tier"], "strong");
    assert_eq!(
        propose["required_capabilities"],
        serde_json::json!(["semantic_introspection", "llm:strong"])
    );
    // Renders a diff while staying non-mutating: showing a change and making one are different, and
    // a back-end that inferred mutation from a diff block would misfile this component.
    assert_eq!(
        propose["effect"]["render_blocks"],
        serde_json::json!([{ "type": "diff", "fields": {} }]),
        "a bare-string render_block normalizes to a typed object with empty fields"
    );
    assert_eq!(
        propose["effect"]["outcome"],
        serde_json::json!({ "kind": "none" })
    );

    // The prompt must carry the headless JSON-final mandate VERBATIM. Native interactive
    // materialization rewrites that exact block by literal replacement, so a paraphrase here would
    // leave the rewrite unexercised and its tests passing on a no-op.
    let propose_prompt = propose["llm_calls"][0]["prompt"].as_str().unwrap();
    for required in [
        "Produce `enrichment_proposal`; approval, canonical hashes/digests, and application are deterministic",
        "host responsibilities. Your FINAL message must be one JSON object only. Do not include prose or",
        "Markdown fences. The top level is `{ \"enrichment_proposal\": { ... } }`; for Grill it contains the",
        "supplied `project_revision`, exactly one operation with `relative_sink` and `recommended_yaml`,",
        "confidence/evidence locators, `impact: \"high\"`, `requires_approval: true`,",
        "`autopilot_eligible: false`, and one decision whose allowed responses are exactly",
        "`[\"accept\", \"edit\", \"skip\"]`.",
    ] {
        assert!(
            propose_prompt.contains(required),
            "the drafting prompt must contain the mandate line '{required}'"
        );
    }
    assert!(
        propose_prompt.contains("do not claim authoritative hashes or content digests of your own"),
        "authoritative hashes are host-owned, never model-authored"
    );

    let apply = by_verb("apply_changes");
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
    assert!(
        apply["required_capabilities"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("enrichment_apply:deterministic")),
        "the safety-critical apply capability is what native materialization refuses — removing it \
         here would retire that assertion instead of breaking it"
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
