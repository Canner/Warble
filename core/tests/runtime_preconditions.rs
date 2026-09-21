use serde_json::json;
use warble::{verify_context_preconditions, ExternalContext, PreparedContext};

fn snapshot() -> serde_json::Value {
    json!({"context_version":2,"parseable":true,
        "metrics":[{"name":"revenue","owner":"orders","declared":true,"additivity":"additive"}],
        "dimensions":[{"name":"date","owner":"orders","is_temporal":true}],
        "models":[{"name":"orders","has_timestamp":true},{"name":"plain","has_timestamp":false}],
        "source_introspectable":true,"raw_docs_readable":true})
}

#[test]
fn runtime_predicates_use_the_full_core_vocabulary_and_resolved_arguments() {
    let context = PreparedContext::from_json(&snapshot().to_string()).unwrap();
    for predicate in [
        "mdl_parseable",
        "wren_project_exists",
        "has_metric",
        "has_queryable_dimension",
        "has_groupable_dimension",
        "has_time_dimension",
        "model_has_timestamp",
        "metric_additive",
        "lineage_resolvable",
        "source_introspectable",
        "raw_docs_readable",
    ] {
        verify_context_preconditions(&json!([{"predicate":predicate}]), &context).unwrap();
    }
    verify_context_preconditions(
        &json!([
            {"predicate":"model_has_timestamp","args":{"model":"orders"}},
            {"predicate":"metric_additive","args":{"metric":"revenue"}}
        ]),
        &context,
    )
    .unwrap();
    let failed = verify_context_preconditions(
        &json!([
            {"predicate":"model_has_timestamp","args":{"model":"plain"}}
        ]),
        &context,
    )
    .unwrap_err();
    assert!(failed.to_string().contains("failed"));
    let missing = verify_context_preconditions(
        &json!([
            {"predicate":"model_has_timestamp","args":{"model":"missing"}}
        ]),
        &context,
    )
    .unwrap_err();
    assert!(missing.to_string().contains("unanswerable"));
}

#[test]
fn runtime_verification_rejects_unknown_or_unresolved_argument_shapes() {
    let context = PreparedContext::from_json(&snapshot().to_string()).unwrap();
    for condition in [
        json!(null),
        json!({"predicate":"unknown"}),
        json!({"predicate":"mdl_parseable","outcome":"pass"}),
        json!({"predicate":"model_has_timestamp","args":null}),
        json!({"predicate":"model_has_timestamp","args":{"model":4}}),
        json!({"predicate":"model_has_timestamp","args":{"model":""}}),
        json!({"predicate":"model_has_timestamp","args":{"model":"$param:model"}}),
    ] {
        assert!(verify_context_preconditions(&json!([condition]), &context).is_err());
    }
    assert!(verify_context_preconditions(&json!({}), &context).is_err());
    verify_context_preconditions(&json!([]), &context).unwrap();
}

#[test]
fn changed_snapshot_and_unanswerable_probes_never_reuse_a_pass() {
    let mut value = snapshot();
    let conditions = json!([{"predicate":"mdl_parseable"}]);
    verify_context_preconditions(
        &conditions,
        &PreparedContext::from_json(&value.to_string()).unwrap(),
    )
    .unwrap();
    value["parseable"] = json!(false);
    assert!(verify_context_preconditions(
        &conditions,
        &PreparedContext::from_json(&value.to_string()).unwrap()
    )
    .is_err());
    let minimal = PreparedContext::from_json(r#"{"context_version":2,"parseable":true}"#).unwrap();
    for predicate in [
        "source_introspectable",
        "raw_docs_readable",
        "metric_additive",
    ] {
        let error =
            verify_context_preconditions(&json!([{"predicate":predicate}]), &minimal).unwrap_err();
        assert!(error.to_string().contains("unanswerable"));
    }
    assert!(verify_context_preconditions(&conditions, &ExternalContext::new()).is_err());
}

#[test]
fn resolved_auxiliary_arguments_keep_the_compiler_representation() {
    let context = PreparedContext::from_json(&snapshot().to_string()).unwrap();
    verify_context_preconditions(
        &json!([
            {"predicate":"mdl_parseable","args":{"aux":{"tags":[true,42,null]},"name":"orders"}},
            {"predicate":"model_has_timestamp","args":{"model":"orders","aux":[1,2]}},
            {"predicate":"metric_additive","args":{"metric":"revenue","aux":false}}
        ]),
        &context,
    )
    .unwrap();
}
