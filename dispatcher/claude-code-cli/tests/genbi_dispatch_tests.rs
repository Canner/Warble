//! Dispatch smoke for the genbi-default flagship profile (Phase 1.2).
//!
//! Proves each of the four GenBI components legalizes onto the claude-code file target and emits a
//! runnable agent — including the two capabilities added this phase: `semantic_introspection`
//! (explore_model) and the `narrative` render block (explain_change). Each component is emitted from
//! a single-node IR sliced out of the shared golden, so per-component assertions stay isolated.

use warble_claude_code::ir::WarbleIr;
use warble_claude_code::{emit_claude_code, RenderFlavor};

const GENBI_DEFAULT_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../genbi-default/ir.golden.json"
);

fn load_ir() -> WarbleIr {
    let raw = std::fs::read_to_string(GENBI_DEFAULT_IR).expect("read genbi-default golden IR");
    serde_json::from_str(&raw).expect("golden IR deserializes")
}

/// A one-component IR carrying only the node with `verb`.
fn single(ir: &WarbleIr, verb: &str) -> WarbleIr {
    let node = ir
        .components
        .iter()
        .find(|c| c.verb == verb)
        .unwrap_or_else(|| panic!("component '{verb}' in golden"))
        .clone();
    WarbleIr {
        components: vec![node],
        ..ir.clone()
    }
}

/// An IR carrying `verbs` in exactly that order — the ordering matters for any artifact the whole
/// profile shares, since a per-component write to a shared path is decided by whoever is last.
fn ordered(ir: &WarbleIr, verbs: &[&str]) -> WarbleIr {
    WarbleIr {
        components: verbs
            .iter()
            .map(|verb| {
                ir.components
                    .iter()
                    .find(|c| c.verb == *verb)
                    .unwrap_or_else(|| panic!("component '{verb}' in golden"))
                    .clone()
            })
            .collect(),
        ..ir.clone()
    }
}

fn split_frontmatter(markdown: &str) -> (String, String) {
    let stripped = markdown
        .strip_prefix("---\n")
        .expect("agent file starts with frontmatter");
    let end = stripped.find("\n---\n").expect("frontmatter terminator");
    (
        stripped[..end].to_string(),
        stripped[end + "\n---\n".len()..].to_string(),
    )
}

fn has_tool(fm: &serde_json::Value, tool: &str) -> bool {
    fm["tools"]
        .as_array()
        .expect("tools array")
        .iter()
        .any(|v| v.as_str() == Some(tool))
}

fn emit_to_tmp(ir: &WarbleIr, target: &str, flavor: RenderFlavor) -> tempfile::TempDir {
    let out = tempfile::tempdir().expect("tempdir");
    emit_claude_code(ir, out.path(), target, flavor).expect("emit succeeds");
    out
}

fn agent_files(out: &std::path::Path) -> Vec<String> {
    let mut files: Vec<String> = std::fs::read_dir(out.join(".claude/agents"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    files.sort();
    files
}

fn read_agent(out: &std::path::Path, name: &str) -> String {
    std::fs::read_to_string(out.join(".claude/agents").join(name)).unwrap()
}

// --- explore_model: semantic_introspection grants the wren tool, no render, read-only ------------

#[test]
fn explore_model_emits_a_single_read_only_introspection_agent() {
    let ir = single(&load_ir(), "explore_model");
    let out = emit_to_tmp(&ir, "claude-code:headless", RenderFlavor::Programmatic);

    assert_eq!(
        agent_files(out.path()),
        vec!["explore_model.md".to_string()]
    );

    let (fm, body) = split_frontmatter(&read_agent(out.path(), "explore_model.md"));
    let fm = serde_yaml::from_str::<serde_json::Value>(&fm).unwrap();
    assert!(
        has_tool(&fm, "Bash(wren:*)"),
        "semantic_introspection must grant the wren CLI tool (`wren context show`)"
    );
    assert!(!has_tool(&fm, "Write"), "read-only: no Write");
    assert!(!has_tool(&fm, "Edit"), "read-only: no Edit");
    assert!(
        !body.contains("## Render output"),
        "explore_model renders no UI (render_blocks empty)"
    );

    // capability report records semantic_introspection with no fail.
    let report: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(out.path().join("capability-report.json")).unwrap(),
    )
    .unwrap();
    let caps = report["components"][0]["capabilities"].as_array().unwrap();
    assert!(caps
        .iter()
        .any(|c| c["capability"] == "semantic_introspection" && c["outcome"] == "realize-via"));
    assert!(caps.iter().all(|c| c["outcome"] != "fail"));
}

// --- answer_query: 3-step split, repair_sql subagent present -------------------------------------

#[test]
fn answer_query_splits_into_driver_plus_three_step_subagents() {
    let ir = single(&load_ir(), "answer_query");
    let out = emit_to_tmp(&ir, "claude-code:headless", RenderFlavor::Programmatic);

    assert_eq!(
        agent_files(out.path()),
        vec![
            "answer_query.md".to_string(),
            "answer_query__generate_sql.md".to_string(),
            "answer_query__repair_sql.md".to_string(),
            "answer_query__resolve_intent.md".to_string(),
        ],
        "per-step-tier split emits a driver + one subagent per step"
    );

    // repair_sql subagent runs at the strong tier and stays read-only.
    let (fm, _) = split_frontmatter(&read_agent(out.path(), "answer_query__repair_sql.md"));
    let fm = serde_yaml::from_str::<serde_json::Value>(&fm).unwrap();
    assert_eq!(fm["model"].as_str().unwrap(), "opus"); // strong → opus (default binding)
    assert!(!has_tool(&fm, "Write"));

    // no artifact_write guardrail ⇒ no render section (the table is emitted as {columns,rows}).
    let driver = read_agent(out.path(), "answer_query.md");
    assert!(!driver.contains("## Render output"));
}

// --- generate_dashboard: render contract folded into the split driver ----------------------------

#[test]
fn generate_dashboard_emits_the_locked_render_contract_in_the_driver() {
    let ir = single(&load_ir(), "generate_dashboard");
    let out = emit_to_tmp(&ir, "claude-code:headless", RenderFlavor::Programmatic);

    let driver = read_agent(out.path(), "generate_dashboard.md");
    let (fm, body) = split_frontmatter(&driver);
    let fm = serde_yaml::from_str::<serde_json::Value>(&fm).unwrap();

    assert!(body.contains("## Render output"), "render section present");
    for block in ["kpi_card", "table", "chart"] {
        assert!(body.contains(block), "block contract must list {block}");
    }
    assert!(
        body.contains("label: string"),
        "typed field schema must be shown"
    );
    // programmatic flavor: agent stays read-only, emits an envelope.
    assert!(!has_tool(&fm, "Write"), "programmatic → no Write");
    assert!(body.contains("render envelope"));

    // prompt flavor: the driver gets Write + a dashboard.html instruction.
    let out_prompt = emit_to_tmp(&ir, "claude-code:headless", RenderFlavor::Prompt);
    let (fm_p, body_p) = split_frontmatter(&read_agent(out_prompt.path(), "generate_dashboard.md"));
    let fm_p = serde_yaml::from_str::<serde_json::Value>(&fm_p).unwrap();
    assert!(has_tool(&fm_p, "Write"), "prompt flavor → Write granted");
    assert!(body_p.contains("dashboard.html"));
}

// --- explain_change: the narrative render block ---------------------------------------------------

#[test]
fn explain_change_emits_a_single_agent_with_the_narrative_render_block() {
    let ir = single(&load_ir(), "explain_change");
    let out = emit_to_tmp(&ir, "claude-code:headless", RenderFlavor::Programmatic);

    assert_eq!(
        agent_files(out.path()),
        vec!["explain_change.md".to_string()],
        "both steps are strong tier → single agent, no split"
    );
    let (fm, body) = split_frontmatter(&read_agent(out.path(), "explain_change.md"));
    let fm = serde_yaml::from_str::<serde_json::Value>(&fm).unwrap();

    assert!(body.contains("## Render output"));
    assert!(
        body.contains("narrative"),
        "the narrative block must appear in the render contract"
    );
    assert!(!has_tool(&fm, "Write"), "programmatic → no Write");
}

// --- interactive degrade + whole-profile smoke ---------------------------------------------------

#[test]
fn render_components_degrade_to_markdown_on_interactive() {
    let ir = single(&load_ir(), "explain_change");
    let out = emit_to_tmp(&ir, "claude-code:interactive", RenderFlavor::Programmatic);
    let (_, body) = split_frontmatter(&read_agent(out.path(), "explain_change.md"));
    assert!(
        body.to_lowercase().contains("markdown"),
        "interactive degrades render to markdown"
    );
}

#[test]
fn the_whole_flagship_profile_dispatches_all_four_components() {
    let ir = load_ir();
    let out = emit_to_tmp(&ir, "claude-code:headless", RenderFlavor::Programmatic);
    let files = agent_files(out.path());
    for verb in [
        "explore_model.md",
        "answer_query.md",
        "generate_dashboard.md",
        "explain_change.md",
    ] {
        assert!(
            files.contains(&verb.to_string()),
            "flagship dispatch must emit the '{verb}' agent; got {files:?}"
        );
    }
}

/// The session envelope is the union of the profile's components, not whichever component the IR
/// ends with. `answer_query` is a per-step-tier split whose driver delegates with `Task`;
/// `explore_model` is a plain agent that never needs it. Ordered so the plain one is last, a
/// per-component write leaves the session without `Task` pre-approved at all.
#[test]
fn settings_json_is_the_union_of_the_profile_not_its_last_component() {
    let ir = ordered(&load_ir(), &["answer_query", "explore_model"]);
    let out = emit_to_tmp(&ir, "claude-code:headless", RenderFlavor::Programmatic);
    let settings: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(out.path().join(".claude/settings.json")).unwrap(),
    )
    .unwrap();
    let allow = settings["permissions"]["allow"]
        .as_array()
        .expect("allow array")
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    for tool in ["Task", "Read", "Bash(wren:*)"] {
        assert!(
            allow.contains(&tool.to_string()),
            "session envelope must carry '{tool}' from some component; got {allow:?}"
        );
    }
    assert_eq!(
        allow.len(),
        allow.iter().collect::<std::collections::HashSet<_>>().len(),
        "union must not duplicate a grant two components share: {allow:?}"
    );
    let deny = settings["permissions"]["deny"]
        .as_array()
        .expect("a component demanded the destructive-bash denials, so the scope keeps them");
    assert!(deny.iter().any(|v| v.as_str() == Some("Bash(rm:*)")));
    let comment = settings["$comment"].as_str().expect("comment");
    for verb in ["answer_query", "explore_model"] {
        assert!(
            comment.contains(&format!("{verb}: ")),
            "each component's own note keeps its subject once they share one file"
        );
    }
}

/// An authored purpose reaches the two places a selector reads — the entry agent's frontmatter
/// `description` and the scope inventory — and stops at the component boundary: a per-step subagent
/// keeps its own step-scoped line, because a step is not a destination anything may choose.
#[test]
fn an_authored_purpose_replaces_the_synthesized_shape_line_for_entry_agents_only() {
    let ir = load_ir();
    let authored = ir
        .components
        .iter()
        .find(|c| c.verb == "answer_query")
        .and_then(|c| c.description.clone())
        .expect("answer_query carries an authored description");
    let out = emit_to_tmp(&ir, "claude-code:headless", RenderFlavor::Programmatic);

    let (driver_fm, _) = split_frontmatter(&read_agent(out.path(), "answer_query.md"));
    let driver_fm = serde_yaml::from_str::<serde_json::Value>(&driver_fm).unwrap();
    let driver_description = driver_fm["description"].as_str().expect("description");
    assert!(
        driver_description.starts_with(authored.trim()),
        "the entry agent's description is the authored purpose, not a synthesized shape line: {driver_description}"
    );
    assert!(
        !driver_description.contains("orchestrator that delegates"),
        "how the component subdivides its work is not what it is for: {driver_description}"
    );
    for example in &ir
        .components
        .iter()
        .find(|c| c.verb == "answer_query")
        .expect("answer_query")
        .examples
    {
        assert!(
            driver_description.contains(example.trim()),
            "authored examples ride along in the field the selector reads"
        );
    }

    // The step subagent keeps its own subject.
    let (step_fm, _) = split_frontmatter(&read_agent(out.path(), "answer_query__generate_sql.md"));
    let step_fm = serde_yaml::from_str::<serde_json::Value>(&step_fm).unwrap();
    let step_description = step_fm["description"].as_str().expect("description");
    assert!(step_description.contains("step of"));
    assert!(
        !step_description.contains(authored.trim()),
        "a step must not advertise itself with the component's purpose: {step_description}"
    );

    // And the scope inventory uses the purpose instead of the shape word.
    let prompt = std::fs::read_to_string(out.path().join(".claude/CLAUDE.md")).unwrap();
    assert!(prompt.contains(authored.trim()));
    assert!(
        !prompt.contains("- `answer_query` — analytical"),
        "the inventory line must not fall back to the shape word once a purpose is authored"
    );
}

/// The scope prompt describes the whole profile and only states what the emitted output backs.
#[test]
fn scope_prompt_inventories_every_agent_and_discloses_the_render_degrade() {
    let ir = load_ir();
    let out = emit_to_tmp(&ir, "claude-code:interactive", RenderFlavor::Programmatic);
    let prompt = std::fs::read_to_string(out.path().join(".claude/CLAUDE.md")).unwrap();
    assert!(prompt.contains(&format!("# Warble scope: `{}`", ir.profile)));
    assert!(prompt.contains(&ir.components[0].context_binding.project));
    for verb in [
        "explore_model",
        "answer_query",
        "generate_dashboard",
        "explain_change",
    ] {
        assert!(
            prompt.contains(&format!("- `{verb}`")),
            "scope prompt must inventory '{verb}'"
        );
    }
    // Interactive degrades the render contract, so the prompt must say so rather than let a session
    // promise a file it cannot write.
    assert!(
        prompt.contains("degrades to a markdown table")
            && prompt.contains("Do not offer a dashboard file"),
        "scope prompt must disclose the render degrade: {prompt}"
    );
    // Describes, never routes: no per-profile policy about which agent answers what.
    assert!(
        !prompt.to_lowercase().contains("when the user asks"),
        "scope prompt must not carry routing policy"
    );
}

/// RUN.md is one document for the whole profile. There is a single emitted directory and a single
/// RUN.md path, so a per-component document would be written once per component and the last one
/// would silently win — leaving three quarters of the flagship profile undocumented.
#[test]
fn run_md_documents_every_component_of_the_profile_not_just_the_last_one() {
    let ir = load_ir();
    let out = emit_to_tmp(&ir, "claude-code:headless", RenderFlavor::Programmatic);
    let run = std::fs::read_to_string(out.path().join("RUN.md")).unwrap();
    assert!(
        run.starts_with(&format!("# Running `{}`", ir.profile)),
        "RUN.md is titled after the profile, not one of its components: {run}"
    );
    for verb in [
        "explore_model",
        "answer_query",
        "generate_dashboard",
        "explain_change",
    ] {
        assert!(
            run.contains(&format!("## `{verb}`")),
            "RUN.md must carry a section for '{verb}'"
        );
        assert!(
            run.contains(&format!("--agent {verb}")),
            "RUN.md must show how to invoke '{verb}'"
        );
    }
}
