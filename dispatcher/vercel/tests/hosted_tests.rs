use serde_json::{json, Value};
use warble_vercel::hosted::{emit_hosted_vercel, prepare_hosted_vercel};
use warble_vercel::{parse_provider_fragments, ProviderFragment, TargetId};

fn ir() -> Value {
    serde_json::from_str(include_str!(
        "../../../examples/analysis-agent/ir.golden.json"
    ))
    .unwrap()
}
fn host() -> Value {
    serde_json::from_str(include_str!("fixtures/host-contract.json")).unwrap()
}
fn providers() -> Vec<ProviderFragment> {
    parse_provider_fragments(include_str!("fixtures/sample-provider.yaml")).unwrap()
}
fn node<'a>(ir: &'a mut Value, id: &str) -> &'a mut Value {
    ir["components"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|n| n["id"] == id)
        .unwrap()
}
fn prepare(ir: &Value, host: &Value) -> Result<Value, warble_vercel::DispatchError> {
    prepare_hosted_vercel(
        &ir.to_string(),
        &host.to_string(),
        TargetId::Headless,
        &providers(),
    )
}

#[test]
fn real_dashboard_retains_edges_context_repair_and_separate_entry_eligibility() {
    let mut source = ir();
    node(&mut source, "answer_query")["entrypoint"] = json!(false);
    let bundle = prepare(&source, &host()).unwrap();
    assert_eq!(bundle["vercel_bundle_version"], "0.2");
    assert!(
        bundle.get("agents").is_none(),
        "legacy reader cannot strip call edges"
    );
    assert!(!bundle["entries"]
        .as_array()
        .unwrap()
        .contains(&json!("answer_query")));
    let components = &bundle["components"];
    let dashboard = &components["generate_dashboard"];
    assert_eq!(
        dashboard["declaration"]["llm_calls"][1]["component_calls"],
        json!([{"alias":"answer","component":"answer_query"}])
    );
    assert!(dashboard["steps"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["tools"] == json!([])));
    assert_eq!(
        components["answer_query"]["steps"][1]["tools"][0]["name"],
        "query"
    );
    assert_eq!(
        components["answer_query"]["steps"][2]["realization"]["kind"],
        "repair_fold"
    );
    assert_eq!(
        components["answer_query"]["declaration"]["context_precondition"],
        node(&mut source, "answer_query")["context_precondition"]
    );
    assert_eq!(bundle["execution_status"], "not_executed");
    assert_eq!(bundle["model_turn_hard_limit"], false);
    assert_eq!(
        bundle,
        prepare(&source, &host()).unwrap(),
        "deterministic plan identity"
    );
}

#[test]
fn per_step_narrowing_and_exclusive_provenance_survive_without_extra_tools() {
    let mut source = ir();
    let answer = node(&mut source, "answer_query");
    answer["llm_calls"][0]["capabilities"] = json!([]);
    answer["llm_calls"][0]["produces_exclusive"] = json!(true);
    let bundle = prepare(&source, &host()).unwrap();
    assert_eq!(
        bundle["components"]["answer_query"]["steps"][0]["tools"],
        json!([])
    );
    assert_eq!(
        bundle["components"]["answer_query"]["declaration"]["llm_calls"][0]["produces_exclusive"],
        true
    );
}

#[test]
fn malformed_and_unsupported_contracts_never_touch_existing_output() {
    let mut cases: Vec<(Value, Value, &str)> = Vec::new();
    let mut h = host();
    h["bundle_version"] = json!("0.1");
    cases.push((ir(), h, "old host"));
    let mut h = host();
    h["features"].as_array_mut().unwrap().pop();
    cases.push((ir(), h, "missing feature"));
    let mut h = host();
    h["allow_unknown"] = json!(true);
    cases.push((ir(), h, "unknown host field"));
    let mut h = host();
    h["tool_authority"]["semantic_introspect"]["capabilities"] =
        json!(["semantic_introspection", "sql_execution:read_only"]);
    cases.push((ir(), h, "alternate SQL surface"));
    let mut h = host();
    h["tool_authority"] = json!({});
    cases.push((ir(), h, "missing authority"));
    let mut i = ir();
    node(&mut i, "generate_dashboard")["llm_calls"][1]["capabilities"] = json!([]);
    cases.push((i, host(), "missing invocation"));
    let mut i = ir();
    node(&mut i, "generate_dashboard")["llm_calls"][0]["capabilities"] =
        json!(["sql_execution:read_only"]);
    cases.push((i, host(), "widened authority"));
    let mut i = ir();
    node(&mut i, "generate_dashboard")["llm_calls"][1]["component_calls"][0]["component"] =
        json!("absent");
    cases.push((i, host(), "missing callee"));
    let mut i = ir();
    node(&mut i, "generate_dashboard")["llm_calls"][1]["component_calls"][0]["component"] =
        json!("generate_dashboard");
    cases.push((i, host(), "cycle"));
    let mut i = ir();
    node(&mut i, "answer_query")["required_capabilities"]
        .as_array_mut()
        .unwrap()
        .push(json!("artifact_write"));
    cases.push((i, host(), "child write"));
    let mut i = ir();
    node(&mut i, "answer_query")["trigger"]["kind"] = json!("scheduled");
    cases.push((i, host(), "scheduled child"));
    let mut i = ir();
    node(&mut i, "answer_query")["runtime_permissions"] = json!(["*"]);
    cases.push((i, host(), "unknown executable field"));
    let mut i = ir();
    node(&mut i, "answer_query")["llm_calls"][0]["capabilities"] = Value::Null;
    cases.push((i, host(), "null authority"));
    let mut i = ir();
    node(&mut i, "answer_query")["llm_calls"][1]["consumes"] = json!(["repaired_result"]);
    cases.push((i, host(), "future/conditional input"));
    let mut i = ir();
    node(&mut i, "answer_query")["llm_calls"][2]["when"]["guard"] = json!("on_missing");
    cases.push((i, host(), "unsupported guard"));
    let mut i = ir();
    node(&mut i, "answer_query")["borrowed_actions"] = json!(["external_action"]);
    cases.push((i, host(), "child borrowed action"));
    let mut i = ir();
    node(&mut i, "answer_query")["assets"] = json!([{"path":"unsafe","bytes":1,"hash":"bad"}]);
    cases.push((i, host(), "asset"));
    let mut i = ir();
    let duplicate = i["components"][0].clone();
    i["components"].as_array_mut().unwrap().push(duplicate);
    cases.push((i, host(), "duplicate mount"));
    for (input, contract, label) in cases {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("existing");
        std::fs::create_dir(&out).unwrap();
        std::fs::write(out.join("bundle.json"), "sentinel").unwrap();
        let result = emit_hosted_vercel(
            &input.to_string(),
            &contract.to_string(),
            TargetId::Headless,
            &out,
            &providers(),
        );
        assert!(result.is_err(), "{label}");
        assert_eq!(
            std::fs::read_to_string(out.join("bundle.json")).unwrap(),
            "sentinel",
            "{label}"
        );
        assert_eq!(std::fs::read_dir(out).unwrap().count(), 1);
    }
}

#[test]
fn duplicate_json_keys_fail_before_projection() {
    let raw = ir().to_string().replacen(
        "\"entrypoint\":true",
        "\"entrypoint\":false,\"entrypoint\":true",
        1,
    );
    assert!(
        prepare_hosted_vercel(&raw, &host().to_string(), TargetId::Headless, &providers()).is_err()
    );
    let raw_host = host().to_string().replacen(
        "\"bundle_version\":\"0.2\"",
        "\"bundle_version\":\"0.1\",\"bundle_version\":\"0.2\"",
        1,
    );
    assert!(prepare_hosted_vercel(
        &ir().to_string(),
        &raw_host,
        TargetId::Headless,
        &providers()
    )
    .is_err());
}

#[test]
fn context_and_render_policy_records_fail_closed_before_output() {
    for mutation in 0..16 {
        let mut source = ir();
        let answer = node(&mut source, "answer_query");
        match mutation {
            0 => answer["context_precondition"][0]["predicate"] = json!("future_predicate"),
            1 => answer["precondition_result"]["checks"] = json!([]),
            2 => answer["precondition_result"]["checks"][0]["outcome"] = json!("fail"),
            3 => answer["precondition_result"]["checks"][0]["predicate"] = json!("has_metric"),
            4 => answer["precondition_result"]["checks"][0]["authorized"] = json!(true),
            5 => answer["precondition_result"]["runtime_verified"] = json!(true),
            6 => answer["context_precondition"][0]["args"] = json!({"model":"$param:model"}),
            7 => answer["context_precondition"][0]["args"] = json!([]),
            8 => {
                node(&mut source, "generate_dashboard")["effect"]["render_blocks"][0]
                    ["runtime_permissions"] = json!(["*"])
            }
            9 => answer["llm_calls"][2]["produces"] = Value::Null,
            10 => answer["llm_calls"][0]["tier"] = json!(""),
            11 => answer["llm_calls"][0]["tier"] = json!(" "),
            12 => answer["llm_calls"][0]["tier"] = json!("undeclared"),
            13 => answer["llm_calls"][0]["prompt"] = json!("{{ slot.absent }}"),
            14 => answer["llm_calls"][0]["prompt"] = json!(""),
            15 => answer["llm_calls"][1]["consumes"] = json!(["query_intent", "query_intent"]),
            _ => unreachable!(),
        }
        let temp = tempfile::tempdir().unwrap();
        let out = temp.path().join("absent");
        assert!(
            emit_hosted_vercel(
                &source.to_string(),
                &host().to_string(),
                TargetId::Headless,
                &out,
                &providers()
            )
            .is_err(),
            "mutation {mutation}"
        );
        assert!(!out.exists());
    }
}

#[test]
fn unreachable_internal_runtime_requirements_are_not_executable_entries() {
    let mut source = ir();
    let mut hidden = node(&mut source, "explore_model").clone();
    hidden["id"] = json!("unreachable");
    hidden["entrypoint"] = json!(false);
    hidden["required_capabilities"] = json!(["unsupported_private_tool"]);
    source["components"].as_array_mut().unwrap().push(hidden);
    let bundle = prepare(&source, &host()).unwrap();
    assert!(bundle["components"].get("unreachable").is_none());
}

#[test]
fn interactive_and_headless_require_the_same_explicit_host_protocol() {
    let source = ir();
    let dir = tempfile::tempdir().unwrap();
    let bundle = emit_hosted_vercel(
        &source.to_string(),
        &host().to_string(),
        TargetId::Interactive,
        dir.path(),
        &providers(),
    )
    .unwrap();
    assert_eq!(bundle["target"], "vercel:interactive");
    assert_eq!(
        serde_json::from_str::<Value>(
            &std::fs::read_to_string(dir.path().join("bundle.json")).unwrap()
        )
        .unwrap(),
        bundle
    );
}

#[test]
fn shared_leaf_is_allowed_but_longer_cached_path_cannot_bypass_depth_limit() {
    let mut source = ir();
    let leaf = node(&mut source, "answer_query").clone();
    let mut entry = node(&mut source, "generate_dashboard").clone();
    entry["id"] = json!("root");
    entry["llm_calls"][1]["component_calls"] = json!([
        {"alias":"direct", "component":"answer_query"},
        {"alias":"via_chain", "component":"level_a"}
    ]);
    let mut components = vec![entry, leaf.clone()];
    let ids = [
        "level_a", "level_b", "level_c", "level_d", "level_e", "level_f", "level_g", "level_h",
    ];
    for (index, id) in ids.iter().enumerate() {
        let mut child = leaf.clone();
        child["id"] = json!(id);
        child["entrypoint"] = json!(false);
        child["required_capabilities"]
            .as_array_mut()
            .unwrap()
            .push(json!("component_invocation"));
        child["llm_calls"][0]["component_calls"] = json!([{"alias":"next", "component": ids.get(index+1).copied().unwrap_or("answer_query")}]);
        components.push(child);
    }
    source["components"] = json!(components);
    let error = prepare(&source, &host()).unwrap_err();
    assert!(error.0.contains("depth"));
    // Remove one intermediate: root + seven chain nodes + leaf reaches depth8, which is valid.
    source["components"].as_array_mut().unwrap().pop();
    source["components"][8]["llm_calls"][0]["component_calls"][0]["component"] =
        json!("answer_query");
    assert!(prepare(&source, &host()).is_ok());
}

#[test]
fn static_host_fixture_remains_compatible_with_the_wire_protocol() {
    let declaration: Value =
        serde_json::from_str(include_str!("fixtures/host-contract.json")).unwrap();
    assert!(prepare(&ir(), &declaration).is_ok());
}

#[test]
fn distinct_native_tools_match_by_name_and_source_without_unioning_authority() {
    let mut declaration = host();
    declaration["tool_authority"]["query"]["source"] = json!("native");
    declaration["tool_authority"]["semantic_introspect"]["source"] = json!("native");
    let provider = include_str!("fixtures/sample-provider.yaml")
        .replace("source: mcp:sample/query", "source: native")
        .replace("source: mcp:sample/semantic_introspect", "source: native");
    let fragments = parse_provider_fragments(&provider).unwrap();
    let bundle = prepare_hosted_vercel(
        &ir().to_string(),
        &declaration.to_string(),
        TargetId::Headless,
        &fragments,
    )
    .unwrap();
    assert_eq!(
        bundle["components"]["explore_model"]["steps"][0]["tools"],
        json!([{"name":"semantic_introspect", "source":"native"}])
    );
    declaration["tool_authority"]["semantic_introspect"]["capabilities"]
        .as_array_mut()
        .unwrap()
        .push(json!("sql_execution:read_only"));
    assert!(prepare_hosted_vercel(
        &ir().to_string(),
        &declaration.to_string(),
        TargetId::Headless,
        &fragments
    )
    .is_err());
    declaration["tool_authority"]["semantic_introspect"]["capabilities"]
        .as_array_mut()
        .unwrap()
        .pop();
    declaration["tool_authority"]["query"]["source"] = json!("other_transport");
    assert!(prepare_hosted_vercel(
        &ir().to_string(),
        &declaration.to_string(),
        TargetId::Headless,
        &fragments
    )
    .is_err());
}
