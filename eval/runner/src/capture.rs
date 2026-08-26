//! Capture-confirmed — golden growth (roadmap Phase 1.4 step 5).
//!
//! Turns one *confirmed* run into a candidate golden case: given the question, the captured
//! `{columns, rows}` result, and the context version it was confirmed against, it renders a
//! golden-shaped YAML case for a human to accept into the golden set. This is the **local, basic**
//! hook only — scale generation and an annotation UI are out of scope. Nothing here
//! auto-accepts: a captured result becomes a *candidate*, never a golden, until a person moves it in.
//!
//! Soft-depends on the 1.3 conversation runtime for the "confirmed" signal; until that surfaces one,
//! this is driven by hand — pipe a captured result in, get a candidate out.

use serde::Serialize;

/// The recognized result-comparison modes (mirrors `warble_eval_compare::MatchMode`).
const MATCH_MODES: [&str; 3] = ["scalar", "set", "ordered"];

/// Everything needed to mint one candidate golden case.
pub struct CaptureInput<'a> {
    pub id: &'a str,
    pub question: &'a str,
    /// `scalar` | `set` | `ordered`.
    pub match_mode: &'a str,
    pub numeric_tolerance: f64,
    pub tags: Vec<String>,
    /// The agent's final text (raw, or a `claude -p --output-format json` envelope already unwrapped
    /// to its `.result`) — the `{columns, rows}` object is extracted from it.
    pub result_text: &'a str,
}

#[derive(Serialize)]
struct Tol {
    numeric: f64,
}

#[derive(Serialize)]
struct CandidateCase {
    id: String,
    question: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tags: Vec<String>,
    #[serde(rename = "match")]
    match_mode: String,
    tolerance: Tol,
    expected: serde_json::Value,
}

/// The candidates staging file header — a golden-shaped document so accepted candidates can be moved
/// straight into a golden set. Written once when the file is first created.
pub fn candidates_header(dataset: Option<&str>, context_version: Option<&str>) -> String {
    let mut out = String::from(
        "# Candidate goldens captured from confirmed runs (`warble eval capture`).\n\
# Review each case, then move accepted ones into the golden set. NOT auto-accepted.\n",
    );
    if let Some(d) = dataset {
        out.push_str(&format!("dataset: {d}\n"));
    }
    if let Some(cv) = context_version {
        out.push_str(&format!("context_version: {cv}\n"));
    }
    out.push_str("cases:\n");
    out
}

/// Render one confirmed run as a golden-shaped case block (a single `- …` list item), ready to
/// append under a candidates file's `cases:`. Fails if the result carries no `{columns, rows}` or the
/// match mode is unrecognized — a candidate that wouldn't parse as a golden is not worth writing.
pub fn build_candidate_yaml(input: &CaptureInput) -> Result<String, String> {
    if !MATCH_MODES.contains(&input.match_mode) {
        return Err(format!(
            "unknown match mode '{}' (expected one of: {})",
            input.match_mode,
            MATCH_MODES.join(", ")
        ));
    }
    let expected = crate::extract_result_json(input.result_text).ok_or_else(|| {
        "no parseable {columns, rows} object in the captured result — nothing to capture"
            .to_string()
    })?;

    let case = CandidateCase {
        id: input.id.to_string(),
        question: input.question.to_string(),
        tags: input.tags.clone(),
        match_mode: input.match_mode.to_string(),
        tolerance: Tol {
            numeric: input.numeric_tolerance,
        },
        expected,
    };
    // Serializing a single-element Vec yields exactly a `cases:` list item (`- id: …`).
    serde_yaml::to_string(&vec![case]).map_err(|e| format!("serialize candidate: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Golden, GoldenCase};

    fn input<'a>(result: &'a str, match_mode: &'a str) -> CaptureInput<'a> {
        CaptureInput {
            id: "q_new_case",
            question: "How many orders shipped in Q3?",
            match_mode,
            numeric_tolerance: 0.01,
            tags: vec!["agg".into(), "time-filter".into()],
            result_text: result,
        }
    }

    #[test]
    fn candidate_from_fenced_claude_result_parses_back_as_a_golden() {
        // A confirmed run's final text, with the result in a fenced block (as agents emit).
        let result = "Here you go:\n```json\n{\"columns\":[\"n\"],\"rows\":[[42]]}\n```\n";
        let block = build_candidate_yaml(&input(result, "scalar")).unwrap();

        // Assemble a full candidates file and prove it round-trips through the golden parser.
        let doc = format!(
            "{}{}",
            candidates_header(Some("jaffle_shop"), Some("jaffle_shop@abc1234")),
            block
        );
        let golden: Golden = serde_yaml::from_str(&doc).expect("candidate file parses as a golden");
        assert_eq!(golden.dataset.as_deref(), Some("jaffle_shop"));
        assert_eq!(
            golden.context_version.as_deref(),
            Some("jaffle_shop@abc1234")
        );
        assert_eq!(golden.cases.len(), 1);
        let case: &GoldenCase = &golden.cases[0];
        assert_eq!(case.id, "q_new_case");
        assert_eq!(case.expected.columns, vec!["n"]);
        assert_eq!(case.tags, vec!["agg", "time-filter"]);
    }

    #[test]
    fn candidate_from_bare_object_works() {
        let result = "{\"columns\":[\"seg\",\"rev\"],\"rows\":[[\"ent\",100],[\"smb\",50]]}";
        let block = build_candidate_yaml(&input(result, "set")).unwrap();
        let doc = format!("{}{}", candidates_header(None, None), block);
        let golden: Golden = serde_yaml::from_str(&doc).unwrap();
        assert_eq!(golden.cases[0].expected.rows.len(), 2);
    }

    #[test]
    fn rejects_result_without_a_table() {
        let err =
            build_candidate_yaml(&input("sorry, I couldn't answer that", "scalar")).unwrap_err();
        assert!(err.contains("no parseable"));
    }

    #[test]
    fn rejects_unknown_match_mode() {
        let result = "{\"columns\":[\"n\"],\"rows\":[[1]]}";
        let err = build_candidate_yaml(&input(result, "fuzzy")).unwrap_err();
        assert!(err.contains("unknown match mode"));
    }
}
