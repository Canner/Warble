//! The Hub report pair — `plan_report` (plan_layout → narrate) composing `answer_batch` through one
//! batched `ask` call — pinned by a deterministic fixture rather than a model run.
//!
//! `dispatcher/conformance-fixtures/report-composition.json` holds every stage's artifact: the
//! planner's layout of typed placeholders, the single request it sends, the callee's per-slot
//! array, what a host may have narrowed that array to, the layout after the host materialised the
//! values, and the narrator's final envelope. The tests here assert the contract those artifacts
//! must satisfy against the compiled `examples/report-agent` IR, so the prompts, the fixture and the
//! render contract cannot drift apart silently. The TypeScript dispatchers assert the same fixture
//! through their own normalizers.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use warble_cli::compile_project_to_ir;

fn repo(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(rel)
}

fn fixture() -> Value {
    serde_json::from_str(
        &fs::read_to_string(repo(
            "dispatcher/conformance-fixtures/report-composition.json",
        ))
        .unwrap(),
    )
    .unwrap()
}

fn report_ir() -> Value {
    serde_json::from_str(&fs::read_to_string(repo("examples/report-agent/ir.golden.json")).unwrap())
        .unwrap()
}

fn component<'a>(ir: &'a Value, id: &str) -> &'a Value {
    ir["components"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap_or_else(|| panic!("component '{id}' must be in the report-agent IR"))
}

fn step<'a>(node: &'a Value, name: &str) -> &'a Value {
    node["llm_calls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == name)
        .unwrap_or_else(|| panic!("step '{name}' must be present"))
}

fn keys(value: &Value) -> BTreeSet<&str> {
    value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect()
}

fn slot_ids(entries: &Value) -> Vec<&str> {
    entries
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["slot_id"].as_str().expect("slot_id is a string"))
        .collect()
}

/// Recursively asserts that no JSON number appears anywhere under `value`.
fn assert_no_numbers(value: &Value, path: &str) {
    match value {
        Value::Number(n) => panic!("a numeric value {n} leaked into the layout at {path}"),
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                assert_no_numbers(item, &format!("{path}[{i}]"));
            }
        }
        Value::Object(map) => {
            for (k, v) in map {
                assert_no_numbers(v, &format!("{path}.{k}"));
            }
        }
        _ => {}
    }
}

const SHAPE_FOR_BLOCK: &[(&str, &str)] = &[
    ("kpi_card", "scalar"),
    ("chart", "series"),
    ("table", "table"),
    ("narrative", "narrative"),
];

#[test]
fn plan_layout_emits_typed_placeholders_and_no_values() {
    let plan = &fixture()["report_plan"];
    assert_eq!(
        keys(plan),
        ["title", "preamble", "slots", "blocks", "summary_brief"]
            .into_iter()
            .collect(),
        "report_plan carries exactly the keys the plan_layout prompt promises"
    );
    for key in ["period", "currency", "filters"] {
        assert!(
            !plan["preamble"][key].is_null(),
            "the preamble must carry `{key}`"
        );
    }

    let slots = plan["slots"].as_array().unwrap();
    assert!(slots.len() >= 2, "a report has several data cells");
    for slot in slots {
        let block_type = slot["block_type"].as_str().unwrap();
        let expected_shape = slot["expected_shape"].as_str().unwrap();
        assert!(
            SHAPE_FOR_BLOCK.contains(&(block_type, expected_shape)),
            "slot '{}' pairs block_type {block_type} with shape {expected_shape}, which the prompt forbids",
            slot["slot_id"]
        );
        assert!(!slot["question"].as_str().unwrap().is_empty());
        let allowed: BTreeSet<&str> = [
            "slot_id",
            "block_type",
            "expected_shape",
            "question",
            "unit",
            "max_rows",
        ]
        .into_iter()
        .collect();
        assert!(
            keys(slot).is_subset(&allowed),
            "slot '{}' carries a key outside the placeholder shape",
            slot["slot_id"]
        );
        if let Some(max_rows) = slot.get("max_rows") {
            assert!(max_rows.as_u64().is_some(), "max_rows is an integer");
        }
        if matches!(expected_shape, "series" | "table") {
            assert!(
                slot.get("max_rows").is_some(),
                "every series/table slot must bound its rows"
            );
        }
        let question = slot["question"].as_str().unwrap().to_lowercase();
        for forbidden in ["sql", "query text", "raw rows", "definition"] {
            assert!(
                !question.contains(forbidden),
                "slot '{}' asks the callee for {forbidden}",
                slot["slot_id"]
            );
        }
    }
    let ids: BTreeSet<&str> = slot_ids(&plan["slots"]).into_iter().collect();
    assert_eq!(ids.len(), slots.len(), "slot ids are unique");

    // Blocks reference values by slot_id only: no number anywhere in them, and every reference
    // resolves to a declared slot of the matching type.
    assert_no_numbers(&plan["blocks"], "report_plan.blocks");
    for block in plan["blocks"].as_array().unwrap() {
        let slot_id = block["slot_id"]
            .as_str()
            .expect("every block names its slot");
        let slot = slots
            .iter()
            .find(|s| s["slot_id"] == slot_id)
            .unwrap_or_else(|| panic!("block references undeclared slot '{slot_id}'"));
        assert_eq!(block["type"], slot["block_type"]);
        for value_field in ["value", "rows", "columns", "series", "x", "text", "unit"] {
            assert!(
                block.get(value_field).is_none(),
                "block '{slot_id}' copies a value field `{value_field}` into the layout"
            );
        }
    }
}

#[test]
fn one_batched_call_carries_every_slot_and_the_preamble() {
    let fixture = fixture();
    let plan = &fixture["report_plan"];
    let request = &fixture["batch_request"];
    assert_eq!(keys(request), ["request", "input"].into_iter().collect());
    assert!(!request["request"].as_str().unwrap().trim().is_empty());
    assert_eq!(
        keys(&request["input"]),
        ["preamble", "questions"].into_iter().collect()
    );
    assert_eq!(request["input"]["preamble"], plan["preamble"]);
    assert_eq!(
        request["input"]["questions"], plan["slots"],
        "the single call carries every slot, verbatim and in layout order"
    );
    let bytes = serde_json::to_vec(request).unwrap().len();
    assert!(
        bytes <= 65_536,
        "the request must fit the composition request limit, got {bytes} bytes"
    );
    let text = serde_json::to_string(request).unwrap().to_lowercase();
    assert!(
        !text.contains("sql"),
        "the caller never asks the callee for SQL"
    );
}

#[test]
fn answer_batch_returns_one_tabular_answer_per_slot_as_an_array() {
    let fixture = fixture();
    let answers = fixture["batch_answers"]
        .as_array()
        .expect("the terminal value is an array");
    assert_eq!(
        slot_ids(&fixture["batch_answers"]),
        slot_ids(&fixture["report_plan"]["slots"]),
        "one entry per requested slot, in the order received"
    );
    let ir = report_ir();
    let single = step(component(&ir, "answer_query"), "generate_sql")["prompt"]
        .as_str()
        .unwrap();
    let tabular: BTreeSet<&str> = ["columns", "rows", "summary", "verified", "definition"]
        .into_iter()
        .collect();
    for key in &tabular {
        assert!(
            single.contains(&format!("\"{key}\"")),
            "answer_query's own contract names `{key}`; the batch shape reuses it"
        );
    }
    let mut saw_unanswerable = false;
    for entry in answers {
        if entry.get("status").is_some() {
            saw_unanswerable = true;
            assert_eq!(
                keys(entry),
                ["slot_id", "status", "reason"].into_iter().collect(),
                "the unanswerable variant carries exactly slot_id, status and reason"
            );
            assert_eq!(entry["status"], "unanswerable");
            continue;
        }
        let mut expected = tabular.clone();
        expected.insert("slot_id");
        assert_eq!(
            keys(entry),
            expected,
            "a verified entry is answer_query's tabular shape plus slot_id"
        );
        assert_eq!(entry["verified"], json!(true));
        assert_eq!(
            keys(&entry["definition"]),
            ["sql", "source_tables", "filters"].into_iter().collect()
        );
        assert!(!entry["columns"].as_array().unwrap().is_empty());
        assert!(!entry["rows"].as_array().unwrap().is_empty());
    }
    assert!(
        saw_unanswerable,
        "the fixture exercises the unanswerable variant"
    );
    // The per-slot bound is honoured by the callee itself.
    for (slot, entry) in fixture["report_plan"]["slots"]
        .as_array()
        .unwrap()
        .iter()
        .zip(answers)
    {
        if let (Some(max_rows), Some(rows)) = (slot["max_rows"].as_u64(), entry["rows"].as_array())
        {
            assert!(
                rows.len() as u64 <= max_rows,
                "slot '{}' returned more rows than its max_rows",
                slot["slot_id"]
            );
        }
    }
}

#[test]
fn a_host_may_only_narrow_a_callee_result_before_the_alias_resolves() {
    let fixture = fixture();
    let before = fixture["batch_answers"].as_array().unwrap();
    let after = fixture["post_processed_answers"].as_array().unwrap();
    assert_eq!(
        slot_ids(&fixture["batch_answers"]),
        slot_ids(&fixture["post_processed_answers"]),
        "narrowing never adds, drops or reorders slots"
    );
    let mut saw_refusal = false;
    for (before, after) in before.iter().zip(after) {
        if after["status"] == "refused" {
            saw_refusal = true;
            assert_eq!(
                keys(after),
                ["slot_id", "status", "reason_category"]
                    .into_iter()
                    .collect(),
                "a refused slot reaches the caller as status plus reason category only"
            );
            assert!(
                after.get("rows").is_none() && after.get("summary").is_none(),
                "no data survives a refusal"
            );
            continue;
        }
        let mut stripped = before.clone();
        stripped.as_object_mut().unwrap().remove("definition");
        assert_eq!(
            after, &stripped,
            "an admitted entry is the callee's entry with only `definition` stripped"
        );
        assert!(
            keys(after).is_subset(&keys(before)),
            "narrowing adds no key"
        );
    }
    assert!(saw_refusal, "the fixture exercises a host refusal");
    assert!(
        !serde_json::to_string(after).unwrap().contains("\"sql\""),
        "no query text crosses to the caller"
    );
}

/// The value-bearing fields the narrator must copy verbatim from the materialised layout.
const VALUE_FIELDS: &[&str] = &["value", "unit", "x", "series", "rows", "columns", "text"];

#[test]
fn narrate_preserves_every_materialised_value_and_maps_unavailable_cells() {
    let fixture = fixture();
    let materialised = fixture["materialised_plan"]["blocks"].as_array().unwrap();
    let report = &fixture["report"];
    assert_eq!(
        keys(report),
        ["blocks", "summary", "verified"].into_iter().collect()
    );
    assert!(!report["summary"].as_str().unwrap().is_empty());
    assert!(report["verified"].is_boolean());
    let blocks = report["blocks"].as_array().unwrap();
    assert_eq!(
        blocks.len(),
        materialised.len(),
        "the narrator neither drops nor adds blocks"
    );
    let mut saw_unavailable = 0;
    for (from, to) in materialised.iter().zip(blocks) {
        if from["status"] == "unavailable" {
            saw_unavailable += 1;
            assert_eq!(to["type"], "unavailable");
            assert_eq!(to["block_type"], from["type"], "the original type is kept");
            assert_eq!(to["reason_category"], from["reason_category"]);
            assert_eq!(to["slot_id"], from["slot_id"]);
            assert!(
                VALUE_FIELDS.iter().all(|f| to.get(*f).is_none()),
                "an unavailable cell carries no value"
            );
            continue;
        }
        assert_eq!(to["type"], from["type"], "a filled block keeps its type");
        assert_eq!(to["slot_id"], from["slot_id"]);
        for field in VALUE_FIELDS {
            if let Some(value) = from.get(*field) {
                assert_eq!(
                    to.get(*field),
                    Some(value),
                    "`{field}` of slot {} must survive narration unchanged",
                    from["slot_id"]
                );
            }
        }
        if from["type"] == "definition" {
            assert_eq!(to, from, "definition blocks pass through untouched");
        }
    }
    assert!(
        saw_unavailable >= 2,
        "the fixture maps both a refused and an unanswerable slot"
    );
    let summary = report["summary"].as_str().unwrap();
    assert!(
        summary.contains("unavailable"),
        "the summary names unavailable cells instead of speculating"
    );
}

fn matches_field_type(value: &Value, ty: &str) -> bool {
    let nullable = ty.ends_with('?');
    if value.is_null() {
        return nullable;
    }
    let ty = ty.trim_end_matches('?');
    if ty.contains('|') {
        let variants: Vec<&str> = ty.split('|').collect();
        let primitives = ["string", "number", "boolean", "row"];
        return if variants.iter().all(|v| primitives.contains(v)) {
            variants.iter().any(|v| matches_field_type(value, v))
        } else {
            value.as_str().is_some_and(|s| variants.contains(&s))
        };
    }
    if let Some(element) = ty.strip_suffix("[]") {
        return value
            .as_array()
            .is_some_and(|items| items.iter().all(|i| matches_field_type(i, element)));
    }
    match ty {
        "string" => value.is_string(),
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        "row" => value.as_array().is_some_and(|cells| {
            cells
                .iter()
                .all(|c| c.is_null() || c.is_string() || c.is_boolean() || c.is_number())
        }),
        other => value.as_str() == Some(other),
    }
}

#[test]
fn the_narrated_report_satisfies_plan_reports_render_contract() {
    let ir = report_ir();
    let contract = component(&ir, "plan_report")["effect"]["render_blocks"]
        .as_array()
        .unwrap();
    let types: BTreeSet<&str> = contract
        .iter()
        .map(|b| b["type"].as_str().unwrap())
        .collect();
    assert_eq!(
        types,
        [
            "kpi_card",
            "table",
            "chart",
            "narrative",
            "unavailable",
            "definition"
        ]
        .into_iter()
        .collect(),
        "plan_report's contract is the stdlib blocks plus its unavailable cell"
    );
    for block in fixture()["report"]["blocks"].as_array().unwrap() {
        let block_type = block["type"].as_str().unwrap();
        let fields = contract
            .iter()
            .find(|b| b["type"] == block_type)
            .unwrap_or_else(|| panic!("undeclared block type '{block_type}'"))["fields"]
            .as_object()
            .unwrap();
        for (field, ty) in fields {
            let ty = ty.as_str().unwrap();
            let present = block.get(field).unwrap_or(&Value::Null);
            assert!(
                matches_field_type(present, ty),
                "block {block_type}.{field} does not match '{ty}': {present}"
            );
        }
        for key in keys(block) {
            assert!(
                key == "type" || fields.contains_key(key),
                "block {block_type} carries undeclared field `{key}` (strict envelope validators reject it)"
            );
        }
    }
}

/// Words that would name a concrete data-access mechanism. Split on non-alphanumerics so
/// `read-only` cannot hide `cli` inside `client`.
const MECHANISM_WORDS: &[&str] = &[
    "sql", "wren", "bash", "shell", "cli", "mcp", "psql", "duckdb", "sqlite", "command",
    "terminal", "tool",
];

fn words(text: &str) -> BTreeSet<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
        .collect()
}

#[test]
fn plan_report_prompts_name_no_data_access_mechanism_and_never_ask_for_sql_or_raw_rows() {
    let ir = report_ir();
    let planner = component(&ir, "plan_report");
    // The authored prompt sources, not the compiled prompts: compilation substitutes the bound
    // project's name and path (`jaffle-wren`, here) into `{{project_name}}` / `{{project}}`, and a
    // project name is not a mechanism. The mount brief has no placeholder and is read compiled.
    let mut surfaces = vec![("brief", planner["brief"].as_str().unwrap_or("").to_string())];
    for step in ["plan_layout", "narrate"] {
        surfaces.push((
            step,
            fs::read_to_string(repo(&format!("hub/components/plan_report/steps/{step}.md")))
                .unwrap(),
        ));
    }
    for (surface, text) in &surfaces {
        let found: Vec<&str> = MECHANISM_WORDS
            .iter()
            .copied()
            .filter(|w| words(text).contains(*w))
            .collect();
        assert!(
            found.is_empty(),
            "plan_report {surface} names a data-access mechanism: {found:?}"
        );
    }
    let plan_layout = step(planner, "plan_layout")["prompt"].as_str().unwrap();
    for required in [
        "Never ask for the query text, the definition or the provenance behind\n  an answer",
        "never ask for raw rows beyond what a cell displays",
        "never ask for more rows than\n  a slot's `max_rows`",
        "Call the logical `ask` alias **exactly once**",
        "Do not call it\n  once per slot",
        "Blocks reference their value by `slot_id` **only**",
        "Do not copy any number, row, series or prose\n  answer into a block",
    ] {
        assert!(
            plan_layout.contains(required),
            "plan_layout must keep: {required:?}"
        );
    }
    let narrate = step(planner, "narrate")["prompt"].as_str().unwrap();
    for required in [
        "**Never alter a value.**",
        "Do not compute\n  totals, deltas, ratios or growth rates",
        "Map each unavailable block to an `unavailable` block",
        "\"reason_category\"",
        "Pass every `definition` block through unchanged",
    ] {
        assert!(
            narrate.contains(required),
            "narrate must keep: {required:?}"
        );
    }
}

#[test]
fn answer_batch_carries_answer_querys_authority_and_no_more() {
    let ir = report_ir();
    let batch = component(&ir, "answer_batch");
    let single = component(&ir, "answer_query");
    for field in [
        "type",
        "realization_kind",
        "trigger",
        "guardrails",
        "required_capabilities",
        "context_precondition",
        "borrowed_actions",
        "effect",
    ] {
        assert_eq!(
            batch[field], single[field],
            "answer_batch.{field} must equal answer_query's"
        );
    }
    assert_eq!(batch["effect"]["render_blocks"], json!([]));
    let names = |node: &Value| -> Vec<String> {
        node["llm_calls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                format!(
                    "{}:{}:{}:{}",
                    s["name"], s["tier"], s["conditional"], s["when"]
                )
            })
            .collect()
    };
    assert_eq!(
        names(batch),
        names(single),
        "the batch keeps answer_query's step names, tiers and repair guard"
    );
    assert_eq!(batch["entrypoint"], json!(false));
    let generate = step(batch, "generate_sql")["prompt"].as_str().unwrap();
    for required in [
        "exactly one JSON ARRAY with one entry per slot",
        "\"slot_id\"",
        "\"status\": \"unanswerable\"",
        "honour each slot's `max_rows`",
        "does NOT fail the batch",
    ] {
        assert!(
            generate.contains(required),
            "generate_sql must keep: {required:?}"
        );
    }
}

fn write(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

/// A copy of `examples/report-agent` whose profile-local `plan_report` override gives one step an
/// explicit data capability. The Local source outranks the Hub, so this is exactly how someone
/// would try to widen the planner without touching the Hub.
fn widened_planner_project(step_name: &str, capability: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let example = repo("examples/report-agent");
    write(
        &dir.path().join("profile.yml"),
        &fs::read_to_string(example.join("profile.yml")).unwrap(),
    );
    write(
        &dir.path().join("context/binding.yml"),
        &fs::read_to_string(example.join("context/binding.yml"))
            .unwrap()
            .replace(
                "../jaffle-wren",
                &repo("examples/jaffle-wren").display().to_string(),
            ),
    );
    write(
        &dir.path().join("context/context.json"),
        &fs::read_to_string(example.join("context/context.json")).unwrap(),
    );
    let hub = repo("hub/components/plan_report");
    let needle = format!("name: {step_name},");
    let authored = fs::read_to_string(hub.join("component.yml")).unwrap();
    assert!(authored.contains(&needle), "step '{step_name}' exists");
    let widened = authored.replace(
        &needle,
        &format!("name: {step_name}, capabilities: [\"{capability}\"],"),
    );
    write(
        &dir.path().join("components/plan_report/component.yml"),
        &widened,
    );
    for prompt in ["plan_layout.md", "narrate.md"] {
        write(
            &dir.path().join("components/plan_report/steps").join(prompt),
            &fs::read_to_string(hub.join("steps").join(prompt)).unwrap(),
        );
    }
    dir
}

#[test]
fn the_compiler_rejects_a_data_capability_on_either_plan_report_step() {
    for (step_name, capability) in [
        ("plan_layout", "sql_execution:read_only"),
        ("narrate", "semantic_introspection"),
        ("plan_layout", "genbi_build"),
    ] {
        let project = widened_planner_project(step_name, capability);
        let err = compile_project_to_ir(project.path())
            .err()
            .unwrap_or_else(|| panic!("widening {step_name} with {capability} must not compile"));
        assert!(
            err.contains(&format!("step '{step_name}'"))
                && err.contains("component 'plan_report'")
                && err.contains(&format!("capability '{capability}'")),
            "the error names the step, component and capability: {err}"
        );
    }
}
