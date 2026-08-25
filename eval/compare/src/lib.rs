use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchMode {
    Scalar,
    Set,
    Ordered,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Tolerance {
    #[serde(default)]
    pub numeric: f64,
}

impl Default for Tolerance {
    fn default() -> Self {
        Tolerance { numeric: 0.0 }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Table {
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
pub struct CompareRequest {
    #[serde(rename = "match")]
    pub match_mode: MatchMode,
    #[serde(default)]
    pub tolerance: Tolerance,
    pub expected: Table,
    pub actual: Table,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct CompareResult {
    pub pass: bool,
    pub reason: String,
}

impl CompareResult {
    fn pass() -> Self {
        CompareResult {
            pass: true,
            reason: "match".to_string(),
        }
    }

    fn fail(reason: impl Into<String>) -> Self {
        CompareResult {
            pass: false,
            reason: reason.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum NormCell {
    Null,
    Num(i64),
    Str(String),
}

fn as_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn display_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

/// Compare two cells for equality: numeric values within `tolerance` are
/// equal, otherwise compare as trimmed, case-sensitive strings. `null` is
/// only equal to `null`.
pub fn cells_equal(a: &Value, b: &Value, tolerance: f64) -> bool {
    let a_null = a.is_null();
    let b_null = b.is_null();
    if a_null || b_null {
        return a_null && b_null;
    }
    if let (Some(na), Some(nb)) = (as_number(a), as_number(b)) {
        return (na - nb).abs() <= tolerance;
    }
    display_string(a).trim() == display_string(b).trim()
}

/// Number of decimal places implied by a numeric tolerance, used to snap
/// numeric cells onto a comparison grid before hashing/sorting a row.
fn decimals_for_tolerance(tolerance: f64) -> i32 {
    if tolerance <= 0.0 {
        return 9;
    }
    (-tolerance.log10()).ceil().max(0.0) as i32
}

fn round_to_grid(value: f64, decimals: i32) -> i64 {
    let multiplier = 10f64.powi(decimals);
    (value * multiplier).round() as i64
}

fn normalize_cell(v: &Value, decimals: i32) -> NormCell {
    if v.is_null() {
        return NormCell::Null;
    }
    if let Some(n) = as_number(v) {
        return NormCell::Num(round_to_grid(n, decimals));
    }
    NormCell::Str(display_string(v).trim().to_string())
}

/// Normalize a row to a sorted tuple of its cell values so that column
/// naming/ordering differences don't affect comparison.
fn normalize_row(row: &[Value], decimals: i32) -> Vec<NormCell> {
    let mut cells: Vec<NormCell> = row.iter().map(|v| normalize_cell(v, decimals)).collect();
    cells.sort();
    cells
}

fn non_null_cells(table: &Table) -> Vec<&Value> {
    table
        .rows
        .iter()
        .flat_map(|row| row.iter())
        .filter(|v| !v.is_null())
        .collect()
}

fn compare_scalar(expected: &Table, actual: &Table, tolerance: f64) -> CompareResult {
    if expected.rows.len() != 1 || expected.rows[0].len() != 1 {
        return CompareResult::fail(format!(
            "scalar match requires expected to be 1x1, got {} row(s) x {} col(s)",
            expected.rows.len(),
            expected.rows.first().map_or(0, |r| r.len())
        ));
    }
    let expected_cell = &expected.rows[0][0];

    let actual_cell = if actual.rows.len() == 1 && actual.rows[0].len() == 1 {
        &actual.rows[0][0]
    } else {
        let cells = non_null_cells(actual);
        match cells.len() {
            0 => {
                return CompareResult::fail(format!(
                    "scalar match requires actual to reduce to one non-null cell, but actual has {} row(s) x up to {} col(s) with no non-null values",
                    actual.rows.len(),
                    actual.rows.iter().map(|r| r.len()).max().unwrap_or(0)
                ));
            }
            1 => cells[0],
            n => {
                return CompareResult::fail(format!(
                    "scalar match requires actual to reduce to one non-null cell, but found {} non-null cells across {} row(s)",
                    n,
                    actual.rows.len()
                ));
            }
        }
    };

    if cells_equal(expected_cell, actual_cell, tolerance) {
        CompareResult::pass()
    } else {
        CompareResult::fail(format!(
            "scalar mismatch: expected {} but got {}",
            display_string(expected_cell),
            display_string(actual_cell)
        ))
    }
}

fn row_multiset(table: &Table, decimals: i32) -> BTreeMap<Vec<NormCell>, (usize, Vec<Value>)> {
    let mut map: BTreeMap<Vec<NormCell>, (usize, Vec<Value>)> = BTreeMap::new();
    for row in &table.rows {
        let key = normalize_row(row, decimals);
        let entry = map.entry(key).or_insert((0, row.clone()));
        entry.0 += 1;
    }
    map
}

fn compare_set(expected: &Table, actual: &Table, tolerance: f64) -> CompareResult {
    let decimals = decimals_for_tolerance(tolerance);
    let expected_map = row_multiset(expected, decimals);
    let actual_map = row_multiset(actual, decimals);

    let counts_equal = expected_map.len() == actual_map.len()
        && expected_map
            .iter()
            .all(|(key, (count, _))| actual_map.get(key).map(|(c, _)| c) == Some(count));
    if counts_equal {
        return CompareResult::pass();
    }

    let mut keys: Vec<&Vec<NormCell>> = expected_map.keys().chain(actual_map.keys()).collect();
    keys.sort();
    keys.dedup();

    for key in keys {
        let expected_count = expected_map.get(key).map_or(0, |(c, _)| *c);
        let actual_count = actual_map.get(key).map_or(0, |(c, _)| *c);
        if expected_count != actual_count {
            let example = expected_map
                .get(key)
                .or_else(|| actual_map.get(key))
                .map(|(_, row)| row.clone())
                .unwrap_or_default();
            return CompareResult::fail(format!(
                "set mismatch: expected {} row(s) total, actual {} row(s) total; row {:?} appears {} time(s) in expected but {} time(s) in actual",
                expected.rows.len(),
                actual.rows.len(),
                example,
                expected_count,
                actual_count
            ));
        }
    }

    CompareResult::fail("set mismatch: multisets differ")
}

fn compare_ordered(expected: &Table, actual: &Table, tolerance: f64) -> CompareResult {
    if expected.rows.len() != actual.rows.len() {
        return CompareResult::fail(format!(
            "ordered mismatch: row count differs (expected {}, actual {})",
            expected.rows.len(),
            actual.rows.len()
        ));
    }

    let decimals = decimals_for_tolerance(tolerance);
    for (i, (expected_row, actual_row)) in expected.rows.iter().zip(actual.rows.iter()).enumerate()
    {
        let expected_norm = normalize_row(expected_row, decimals);
        let actual_norm = normalize_row(actual_row, decimals);
        if expected_norm != actual_norm {
            return CompareResult::fail(format!(
                "ordered mismatch at row index {}: expected {:?}, actual {:?}",
                i, expected_row, actual_row
            ));
        }
    }

    CompareResult::pass()
}

pub fn compare(request: &CompareRequest) -> CompareResult {
    match request.match_mode {
        MatchMode::Scalar => compare_scalar(
            &request.expected,
            &request.actual,
            request.tolerance.numeric,
        ),
        MatchMode::Set => compare_set(
            &request.expected,
            &request.actual,
            request.tolerance.numeric,
        ),
        MatchMode::Ordered => compare_ordered(
            &request.expected,
            &request.actual,
            request.tolerance.numeric,
        ),
    }
}
