use warble_eval_compare::{compare, CompareRequest};

fn run(json: &str) -> (bool, String) {
    let req: CompareRequest = serde_json::from_str(json).expect("valid test input");
    let result = compare(&req);
    (result.pass, result.reason)
}

#[test]
fn scalar_exact_match() {
    let (pass, _) = run(r#"{
            "match": "scalar",
            "tolerance": {"numeric": 0.0},
            "expected": {"columns": ["n"], "rows": [[42]]},
            "actual": {"columns": ["count"], "rows": [[42]]}
        }"#);
    assert!(pass);
}

#[test]
fn scalar_numeric_tolerance_pass() {
    let (pass, _) = run(r#"{
            "match": "scalar",
            "tolerance": {"numeric": 0.01},
            "expected": {"columns": ["n"], "rows": [[1.00]]},
            "actual": {"columns": ["n"], "rows": [[1.005]]}
        }"#);
    assert!(pass);
}

#[test]
fn scalar_numeric_tolerance_fail_outside() {
    let (pass, reason) = run(r#"{
            "match": "scalar",
            "tolerance": {"numeric": 0.01},
            "expected": {"columns": ["n"], "rows": [[1.00]]},
            "actual": {"columns": ["n"], "rows": [[1.05]]}
        }"#);
    assert!(!pass);
    assert!(reason.contains("scalar mismatch"));
}

#[test]
fn scalar_wrong_value_fails() {
    let (pass, reason) = run(r#"{
            "match": "scalar",
            "tolerance": {"numeric": 0.0},
            "expected": {"columns": ["n"], "rows": [["hello"]]},
            "actual": {"columns": ["n"], "rows": [["world"]]}
        }"#);
    assert!(!pass);
    assert!(reason.contains("scalar mismatch"));
}

#[test]
fn scalar_actual_reduces_from_extra_null_columns() {
    let (pass, _) = run(r#"{
            "match": "scalar",
            "tolerance": {"numeric": 0.0},
            "expected": {"columns": ["n"], "rows": [[7]]},
            "actual": {"columns": ["a", "b"], "rows": [[null, 7]]}
        }"#);
    assert!(pass);
}

#[test]
fn scalar_actual_too_many_non_null_cells_fails() {
    let (pass, reason) = run(r#"{
            "match": "scalar",
            "tolerance": {"numeric": 0.0},
            "expected": {"columns": ["n"], "rows": [[7]]},
            "actual": {"columns": ["a", "b"], "rows": [[7, 8]]}
        }"#);
    assert!(!pass);
    assert!(reason.contains("reduce to one non-null cell"));
}

#[test]
fn set_match_passes_under_row_permutation() {
    let (pass, _) = run(r#"{
            "match": "set",
            "tolerance": {"numeric": 0.0},
            "expected": {"columns": ["a", "b"], "rows": [[1, "x"], [2, "y"]]},
            "actual": {"columns": ["a", "b"], "rows": [[2, "y"], [1, "x"]]}
        }"#);
    assert!(pass);
}

#[test]
fn set_match_ignores_column_order_within_row() {
    let (pass, _) = run(r#"{
            "match": "set",
            "tolerance": {"numeric": 0.0},
            "expected": {"columns": ["a", "b"], "rows": [[1, "x"]]},
            "actual": {"columns": ["b", "a"], "rows": [["x", 1]]}
        }"#);
    assert!(pass);
}

#[test]
fn ordered_match_fails_under_same_permutation_that_passes_set() {
    let (pass, reason) = run(r#"{
            "match": "ordered",
            "tolerance": {"numeric": 0.0},
            "expected": {"columns": ["a", "b"], "rows": [[1, "x"], [2, "y"]]},
            "actual": {"columns": ["a", "b"], "rows": [[2, "y"], [1, "x"]]}
        }"#);
    assert!(!pass);
    assert!(reason.contains("row index 0"));
}

#[test]
fn ordered_match_passes_when_positions_align() {
    let (pass, _) = run(r#"{
            "match": "ordered",
            "tolerance": {"numeric": 0.01},
            "expected": {"columns": ["a"], "rows": [[1.0], [2.0]]},
            "actual": {"columns": ["a"], "rows": [[1.004], [2.0]]}
        }"#);
    assert!(pass);
}

#[test]
fn empty_vs_nonempty_fails() {
    let (pass, reason) = run(r#"{
            "match": "set",
            "tolerance": {"numeric": 0.0},
            "expected": {"columns": ["a"], "rows": []},
            "actual": {"columns": ["a"], "rows": [[1]]}
        }"#);
    assert!(!pass);
    assert!(reason.contains("set mismatch"));
}

#[test]
fn empty_vs_empty_passes() {
    let (pass, _) = run(r#"{
            "match": "set",
            "tolerance": {"numeric": 0.0},
            "expected": {"columns": ["a"], "rows": []},
            "actual": {"columns": ["a"], "rows": []}
        }"#);
    assert!(pass);
}

#[test]
fn row_count_mismatch_fails_for_ordered() {
    let (pass, reason) = run(r#"{
            "match": "ordered",
            "tolerance": {"numeric": 0.0},
            "expected": {"columns": ["a"], "rows": [[1], [2]]},
            "actual": {"columns": ["a"], "rows": [[1]]}
        }"#);
    assert!(!pass);
    assert!(reason.contains("row count differs"));
}

#[test]
fn duplicates_are_significant_for_set_match() {
    let (pass, reason) = run(r#"{
            "match": "set",
            "tolerance": {"numeric": 0.0},
            "expected": {"columns": ["a"], "rows": [[1], [1], [2]]},
            "actual": {"columns": ["a"], "rows": [[1], [2], [2]]}
        }"#);
    assert!(!pass);
    assert!(reason.contains("set mismatch"));
}

#[test]
fn duplicates_matching_counts_pass_for_set_match() {
    let (pass, _) = run(r#"{
            "match": "set",
            "tolerance": {"numeric": 0.0},
            "expected": {"columns": ["a"], "rows": [[1], [1], [2]]},
            "actual": {"columns": ["a"], "rows": [[2], [1], [1]]}
        }"#);
    assert!(pass);
}

#[test]
fn null_cells_only_equal_null() {
    let (pass, _) = run(r#"{
            "match": "ordered",
            "tolerance": {"numeric": 0.0},
            "expected": {"columns": ["a"], "rows": [[null]]},
            "actual": {"columns": ["a"], "rows": [[null]]}
        }"#);
    assert!(pass);

    let (pass2, reason2) = run(r#"{
            "match": "ordered",
            "tolerance": {"numeric": 0.0},
            "expected": {"columns": ["a"], "rows": [[null]]},
            "actual": {"columns": ["a"], "rows": [[0]]}
        }"#);
    assert!(!pass2);
    assert!(reason2.contains("row index 0"));
}
