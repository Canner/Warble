//! Faithful port of dispatcher/test/renderContract.test.ts and dispatcher/test/claudeCode.test.ts,
//! merged into one file (both suites exercise `emit_claude_code`).

use warble_claude_code::ir::{ComponentNode, WarbleIr};
use warble_claude_code::{
    emit_claude_code, emit_claude_code_with_context, emit_claude_code_with_models,
    emit_claude_code_with_providers, emit_claude_code_with_realization, parse_provider_fragments,
    ContextInjection, ContextInjectionMode, HybridRealization, ModelConfig, RenderFlavor,
};

const RENDER_DEMO_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../examples/render-demo/ir.golden.json"
);
const DEMO_AGENT_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../examples/demo-agent/ir.golden.json"
);
const GENBI_DEFAULT_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../genbi-default/ir.golden.json"
);

fn load_ir(path: &str) -> WarbleIr {
    let raw = std::fs::read_to_string(path).expect("read golden IR fixture");
    serde_json::from_str(&raw).expect("golden IR deserializes")
}

/// A one-component IR carrying only the node with `verb` (mirrors genbi_dispatch_tests.rs's
/// `single` helper, kept local so this file stays self-contained).
fn single_component(ir: &WarbleIr, verb: &str) -> WarbleIr {
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

/// Split a rendered agent markdown file into (frontmatter YAML, body). Mirrors the TS tests'
/// `splitFrontmatter` regex (`^---\n([\s\S]*?)\n---\n([\s\S]*)$`).
fn split_frontmatter(markdown: &str) -> (String, String) {
    let stripped = markdown
        .strip_prefix("---\n")
        .expect("expected file to start with a YAML frontmatter block");
    let end = stripped
        .find("\n---\n")
        .expect("expected file to start with a YAML frontmatter block");
    let frontmatter = stripped[..end].to_string();
    let body = stripped[end + "\n---\n".len()..].to_string();
    (frontmatter, body)
}

fn parse_frontmatter(yaml: &str) -> serde_json::Value {
    serde_yaml::from_str(yaml).expect("frontmatter parses as YAML")
}

fn has_tool(fm: &serde_json::Value, tool: &str) -> bool {
    fm["tools"]
        .as_array()
        .expect("tools is an array")
        .iter()
        .any(|v| v.as_str() == Some(tool))
}

fn read_json(path: &std::path::Path) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

// --- renderContract.test.ts ------------------------------------------------------------------

#[test]
fn render_demo_headless_default_programmatic_dashboard_agent_stays_read_only_and_emits_envelope() {
    let ir = load_ir(RENDER_DEMO_IR);
    let out_dir = tempfile::tempdir().expect("tempdir");

    emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("emit succeeds");

    let markdown =
        std::fs::read_to_string(out_dir.path().join(".claude/agents/dashboard.md")).unwrap();
    let (frontmatter, body) = split_frontmatter(&markdown);
    let parsed = parse_frontmatter(&frontmatter);
    assert!(
        !has_tool(&parsed, "Write"),
        "programmatic render flavor keeps the agent read-only (no Write)"
    );

    assert!(body.contains("## Render output"));
    assert!(body.contains("kpi_card"));
    assert!(body.contains("table"));
    assert!(body.contains("chart"));
    assert!(
        body.contains("label: string"),
        "block contract must list field types"
    );
    // programmatic: emit an envelope, do NOT write a file
    assert!(body.contains("render envelope"));
    assert!(body.contains("\"blocks\""), "must show the envelope shape");
    assert!(
        !body.contains("dashboard.html"),
        "programmatic path must not tell the agent to write a file"
    );
    assert!(body.to_lowercase().contains("do not write any files"));

    let settings = read_json(&out_dir.path().join(".claude/settings.json"));
    assert!(!has_tool(
        &serde_json::json!({ "tools": settings["permissions"]["allow"] }),
        "Write"
    ));

    // RUN.md documents the two-step programmatic run (agent -> warble-render).
    let run_md = std::fs::read_to_string(out_dir.path().join("RUN.md")).unwrap();
    assert!(run_md.contains("--output-format json"));
    assert!(run_md.contains("warble render"));
}

#[test]
fn render_demo_headless_prompt_flavor_dashboard_agent_gets_write_and_dashboard_html_instruction() {
    let ir = load_ir(RENDER_DEMO_IR);
    let out_dir = tempfile::tempdir().expect("tempdir");

    emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Prompt,
    )
    .expect("emit succeeds");

    let markdown =
        std::fs::read_to_string(out_dir.path().join(".claude/agents/dashboard.md")).unwrap();
    let (frontmatter, body) = split_frontmatter(&markdown);
    let parsed = parse_frontmatter(&frontmatter);
    assert!(
        has_tool(&parsed, "Write"),
        "prompt-fallback render-gated agent must get Write"
    );

    assert!(body.contains("## Render output"));
    assert!(
        body.contains("label: string"),
        "block contract must list field types"
    );
    assert!(body.contains("dashboard.html"));

    let settings = read_json(&out_dir.path().join(".claude/settings.json"));
    assert!(has_tool(
        &serde_json::json!({ "tools": settings["permissions"]["allow"] }),
        "Write"
    ));
}

#[test]
fn render_demo_interactive_dashboard_agent_gets_no_write_and_a_markdown_degrade_instruction() {
    let ir = load_ir(RENDER_DEMO_IR);
    let out_dir = tempfile::tempdir().expect("tempdir");

    emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:interactive",
        RenderFlavor::Programmatic,
    )
    .expect("emit succeeds");

    let markdown =
        std::fs::read_to_string(out_dir.path().join(".claude/agents/dashboard.md")).unwrap();
    let (frontmatter, body) = split_frontmatter(&markdown);
    let parsed = parse_frontmatter(&frontmatter);
    assert!(
        !has_tool(&parsed, "Write"),
        "interactive degrade path must not get Write"
    );

    assert!(body.contains("## Render output"));
    assert!(body.to_lowercase().contains("markdown"));
    assert!(
        !body.contains("dashboard.html"),
        "degrade path must not instruct writing a file"
    );

    let settings = read_json(&out_dir.path().join(".claude/settings.json"));
    assert!(!has_tool(
        &serde_json::json!({ "tools": settings["permissions"]["allow"] }),
        "Write"
    ));
}

#[test]
fn demo_agent_generate_dashboard_no_artifact_write_driver_gets_no_write_no_render_section() {
    let ir = load_ir(DEMO_AGENT_IR);
    let out_dir = tempfile::tempdir().expect("tempdir");

    emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("emit succeeds");

    let driver_markdown =
        std::fs::read_to_string(out_dir.path().join(".claude/agents/generate_dashboard.md"))
            .unwrap();
    let (frontmatter, body) = split_frontmatter(&driver_markdown);
    let parsed = parse_frontmatter(&frontmatter);
    assert!(
        !has_tool(&parsed, "Write"),
        "component with no artifact_write must not get Write"
    );
    assert!(
        !body.contains("## Render output"),
        "no render section without artifact_write"
    );
    // JS-specific footgun ([object Object] from stringifying an unstringified object) cannot
    // occur in Rust's typed serialization; assert the description is a sensible non-empty string
    // instead, as the closest meaningful equivalent.
    let description = parsed["description"]
        .as_str()
        .expect("description is a string");
    assert!(!description.is_empty());
    assert!(!description.contains("[object Object]"));
}

/// The `[object Object]` bug lived in `buildDescription`, which only the single-agent (non-split)
/// path calls (`buildAgentMarkdown`) — demo-agent's golden IR is per-step-tier split, so its
/// driver description never touched `render_blocks` even before the fix. Exercise the
/// single-agent path directly (demo-agent's node collapsed to one tier, matching the existing
/// "single-tier" test pattern) to prove the typed-block description fix.
#[test]
fn single_agent_path_description_uses_typed_render_block_type_names_not_object_object() {
    let ir = load_ir(DEMO_AGENT_IR);
    let node = &ir.components[0];
    let mut single_tier_node = node.clone();
    for call in &mut single_tier_node.llm_calls {
        call.tier = "cheap".to_string();
    }
    let single_tier_ir = WarbleIr {
        components: vec![single_tier_node],
        ..ir.clone()
    };

    let out_dir = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        &single_tier_ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("emit succeeds");

    let markdown =
        std::fs::read_to_string(out_dir.path().join(".claude/agents/generate_dashboard.md"))
            .unwrap();
    let (frontmatter, body) = split_frontmatter(&markdown);
    let parsed = parse_frontmatter(&frontmatter);

    let description = parsed["description"]
        .as_str()
        .expect("description is a string");
    assert!(!description.contains("[object Object]"));
    assert!(description.contains("chart"));
    assert!(description.contains("table"));
    assert!(description.contains("kpi_card"));
    assert!(
        !has_tool(&parsed, "Write"),
        "no artifact_write guardrail -> no Write"
    );
    assert!(
        !body.contains("## Render output"),
        "no render section without artifact_write"
    );
}

// --- claudeCode.test.ts -----------------------------------------------------------------------

/// Golden IR with both llm_calls collapsed to the same tier — no split needed.
fn make_single_tier_ir(ir: &WarbleIr) -> WarbleIr {
    let node = &ir.components[0];
    let mut new_node = node.clone();
    for call in &mut new_node.llm_calls {
        call.tier = "cheap".to_string();
    }
    WarbleIr {
        components: vec![new_node],
        ..ir.clone()
    }
}

#[test]
fn claude_code_target_splits_per_step_tiers_into_a_driver_plus_one_subagent_per_step() {
    let ir = load_ir(DEMO_AGENT_IR);
    let node = &ir.components[0];
    assert_eq!(node.verb, "generate_dashboard");
    assert!(node
        .required_capabilities
        .iter()
        .any(|c| c == "llm:per_step_tier"));
    let distinct_tiers: std::collections::HashSet<_> =
        node.llm_calls.iter().map(|c| c.tier.clone()).collect();
    assert!(distinct_tiers.len() > 1);

    let out_dir = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("emit succeeds");

    let agents_dir = out_dir.path().join(".claude/agents");
    let mut files: Vec<String> = std::fs::read_dir(&agents_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    files.sort();
    assert_eq!(
        files,
        vec![
            "generate_dashboard.md".to_string(),
            "generate_dashboard__compose_layout.md".to_string(),
            "generate_dashboard__plan_dashboard.md".to_string(),
        ]
    );

    // Driver
    let driver_md = std::fs::read_to_string(agents_dir.join("generate_dashboard.md")).unwrap();
    let (driver_fm, driver_body) = split_frontmatter(&driver_md);
    let driver = parse_frontmatter(&driver_fm);
    assert_eq!(driver["name"].as_str().unwrap(), "generate_dashboard");
    assert_eq!(driver["model"].as_str().unwrap(), "sonnet");
    assert!(has_tool(&driver, "Task"));
    assert!(has_tool(&driver, "Read"));
    assert!(
        driver_body.contains("plan_dashboard"),
        "driver body must mention the plan step"
    );
    assert!(
        driver_body.contains("compose_layout"),
        "driver body must mention the compose step"
    );
    assert!(
        driver_body.contains("query_plan"),
        "driver body must wire query_plan from plan_dashboard into compose_layout"
    );

    // plan_dashboard subagent (strong tier -> opus)
    let plan_md =
        std::fs::read_to_string(agents_dir.join("generate_dashboard__plan_dashboard.md")).unwrap();
    let (plan_fm, plan_body) = split_frontmatter(&plan_md);
    let plan = parse_frontmatter(&plan_fm);
    assert_eq!(
        plan["name"].as_str().unwrap(),
        "generate_dashboard__plan_dashboard"
    );
    assert_eq!(plan["model"].as_str().unwrap(), "opus");
    assert!(has_tool(&plan, "Bash(wren:*)"));
    assert!(!has_tool(&plan, "Write"));
    assert!(!has_tool(&plan, "Edit"));
    assert!(plan_body.contains(&node.llm_calls[0].prompt));

    // compose_layout subagent (cheap tier -> haiku)
    let compose_md =
        std::fs::read_to_string(agents_dir.join("generate_dashboard__compose_layout.md")).unwrap();
    let (compose_fm, compose_body) = split_frontmatter(&compose_md);
    let compose = parse_frontmatter(&compose_fm);
    assert_eq!(
        compose["name"].as_str().unwrap(),
        "generate_dashboard__compose_layout"
    );
    assert_eq!(compose["model"].as_str().unwrap(), "haiku");
    assert!(has_tool(&compose, "Bash(wren:*)"));
    assert!(!has_tool(&compose, "Write"));
    assert!(!has_tool(&compose, "Edit"));
    assert!(compose_body.contains(&node.llm_calls[1].prompt));

    // .claude/settings.json (not repo-root settings.json) for the split shape
    let settings = read_json(&out_dir.path().join(".claude/settings.json"));
    let allow = settings["permissions"]["allow"].as_array().unwrap();
    let allow_has = |t: &str| allow.iter().any(|v| v.as_str() == Some(t));
    assert!(allow_has("Task"));
    assert!(allow_has("Read"));
    assert!(allow_has("Bash(wren:*)"));
    let deny = settings["permissions"]["deny"].as_array();
    assert!(deny
        .map(|d| d.iter().any(|v| v.as_str() == Some("Bash(rm:*)")))
        .unwrap_or(false));

    let run_md = std::fs::read_to_string(out_dir.path().join("RUN.md")).unwrap();
    assert!(run_md.contains("--agent generate_dashboard"));
    assert!(run_md.contains("generate_dashboard__plan_dashboard"));
    assert!(run_md.contains("generate_dashboard__compose_layout"));
}

#[test]
fn a_single_tier_skill_still_produces_one_agent_v0_1_shape_unchanged() {
    let golden_ir = load_ir(DEMO_AGENT_IR);
    let ir = make_single_tier_ir(&golden_ir);
    let node = &ir.components[0];

    let out_dir = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("emit succeeds");

    let agents_dir = out_dir.path().join(".claude/agents");
    let files: Vec<String> = std::fs::read_dir(&agents_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(files, vec!["generate_dashboard.md".to_string()]);

    let markdown = std::fs::read_to_string(agents_dir.join("generate_dashboard.md")).unwrap();
    let (frontmatter, body) = split_frontmatter(&markdown);
    let parsed = parse_frontmatter(&frontmatter);
    assert_eq!(parsed["name"].as_str().unwrap(), "generate_dashboard");
    assert_eq!(parsed["model"].as_str().unwrap(), "haiku");
    assert!(has_tool(&parsed, "Bash(wren:*)"));
    assert!(!has_tool(&parsed, "Write"));
    assert!(!has_tool(&parsed, "Edit"));
    assert!(body.contains(&node.prompt_fragment));

    // P1 (unified): the single-agent path now also writes `.claude/settings.json` (was out-root).
    let settings = read_json(&out_dir.path().join(".claude/settings.json"));
    let allow = settings["permissions"]["allow"].as_array().unwrap();
    assert!(allow.iter().any(|v| v.as_str() == Some("Bash(wren:*)")));
    let deny = settings["permissions"]["deny"].as_array();
    assert!(deny
        .map(|d| d.iter().any(|v| v.as_str() == Some("Bash(rm:*)")))
        .unwrap_or(false));
}

#[test]
fn claude_code_target_emits_a_valid_wren_config_json_with_strict_mode_enabled() {
    let ir = load_ir(DEMO_AGENT_IR);
    let out_dir = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("emit succeeds");
    let parsed = read_json(&out_dir.path().join(".wren/config.json"));
    assert!(parsed["strict_mode"].as_bool().unwrap());
    assert!(parsed["denied_functions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v.as_str() == Some("pg_read_file")));
}

#[test]
fn claude_code_target_emits_run_md_with_the_headless_invocation_command() {
    let ir = load_ir(DEMO_AGENT_IR);
    let out_dir = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("emit succeeds");
    let run_md = std::fs::read_to_string(out_dir.path().join("RUN.md")).unwrap();
    assert!(run_md.contains("--agent generate_dashboard"));
    assert!(run_md.contains(&ir.components[0].context_binding.project));
}

fn with_component(ir: &WarbleIr, mutate: impl FnOnce(ComponentNode) -> ComponentNode) -> WarbleIr {
    WarbleIr {
        components: vec![mutate(ir.components[0].clone())],
        ..ir.clone()
    }
}

type IrMutator = fn(&WarbleIr) -> WarbleIr;

/// Every not-yet-implemented IR arm must loud-fail rather than silently emit a wrong agent.
/// Handler-level arms (realization_kind / trigger.kind / outcome.kind) fail at the claude-code file
/// target's dispatch check ("wall-hit"). As of +Assertive, `tool`/`scheduled`/`assertion` are
/// realized; as of +Mutating, `gated-tool`/`mutation` are realized too (see the positive tests
/// below). What remains are the +Orchestrating arms plus the `event` *trigger* (activation by an
/// inbound event — a distinct handler from emitting one).
fn handler_wall_hit_cases() -> Vec<(&'static str, IrMutator)> {
    fn trigger_event(ir: &WarbleIr) -> WarbleIr {
        with_component(ir, |mut c| {
            c.trigger.kind = warble_claude_code::ir::TriggerKind::Event;
            c
        })
    }
    fn outcome_dispatch(ir: &WarbleIr) -> WarbleIr {
        with_component(ir, |mut c| {
            c.effect.outcome.kind = warble_claude_code::ir::OutcomeKind::Dispatch;
            c
        })
    }
    vec![
        ("trigger.kind=event", trigger_event),
        ("outcome=dispatch", outcome_dispatch),
    ]
}

#[test]
fn unimplemented_handler_arms_loud_fail_at_the_file_target_instead_of_emitting() {
    let golden = load_ir(DEMO_AGENT_IR);
    for (label, mutate) in handler_wall_hit_cases() {
        let ir = mutate(&golden);
        let out_dir = tempfile::tempdir().expect("tempdir");
        let err = emit_claude_code(
            &ir,
            out_dir.path(),
            "claude-code:headless",
            RenderFlavor::Programmatic,
        )
        .unwrap_err();
        assert!(
            err.0
                .contains("is not supported by the claude-code file target (wall-hit)"),
            "case '{label}': unexpected error message: {}",
            err.0
        );
        let files: Vec<_> = std::fs::read_dir(out_dir.path()).unwrap().collect();
        assert!(
            files.is_empty(),
            "case '{label}': must write nothing on a wall-hit"
        );
    }
}

/// Turn demo-agent's node into a minimal +Assertive shape (tool · scheduled · assertion), the way
/// `monitor_freshness` is structured, so the realized handlers can be exercised at the emit level
/// without the full authored component (that is covered end-to-end by the monitor-agent golden).
fn make_assertive_ir(golden: &WarbleIr) -> WarbleIr {
    with_component(golden, |mut c| {
        c.realization_kind = warble_claude_code::ir::RealizationKind::Tool;
        c.trigger.kind = warble_claude_code::ir::TriggerKind::Scheduled;
        c.effect.outcome.kind = warble_claude_code::ir::OutcomeKind::Assertion;
        c.effect.outcome.verdict_type = Some("freshness_verdict".to_string());
        c.effect.outcome.emits = Some(vec!["freshness_breach".to_string()]);
        // A pure assertion: no render/artifact-write path, just the status verdict facet.
        c.effect.render_blocks = vec![warble_claude_code::ir::RenderBlock {
            block_type: "status".to_string(),
            fields: std::collections::BTreeMap::new(),
        }];
        c.guardrails.retain(|g| g.name != "artifact_write");
        c.required_capabilities
            .retain(|cap| cap != "artifact_write" && cap != "render_contract");
        c.required_capabilities.push("scheduler".to_string());
        c.required_capabilities.push("notify_channel".to_string());
        c.borrowed_actions = vec!["notify_slack".to_string(), "open_ticket".to_string()];
        // Single tier so it takes the single-agent path (no per-step split), like monitor_freshness.
        for call in &mut c.llm_calls {
            call.tier = "cheap".to_string();
        }
        c.required_capabilities
            .retain(|cap| cap != "llm:per_step_tier");
        c
    })
}

#[test]
fn assertive_arms_tool_scheduled_assertion_emit_cleanly_and_stay_read_only() {
    let ir = make_assertive_ir(&load_ir(DEMO_AGENT_IR));
    let node = &ir.components[0];
    let out_dir = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("the +Assertive arms (tool · scheduled · assertion) must dispatch, not wall-hit");

    let md = std::fs::read_to_string(
        out_dir
            .path()
            .join(format!(".claude/agents/{}.md", node.verb)),
    )
    .unwrap();
    let (frontmatter, body) = split_frontmatter(&md);
    let parsed = parse_frontmatter(&frontmatter);
    // Read-only assertion: no Write / Edit.
    assert!(
        !has_tool(&parsed, "Write"),
        "assertion is read-only: no Write"
    );
    assert!(
        !has_tool(&parsed, "Edit"),
        "assertion is read-only: no Edit"
    );
    // The assertion section carries the deterministic-assert contract + verdict_type + emit.
    assert!(body.contains("## Assertion output"));
    assert!(body.contains("freshness_verdict"), "names the verdict_type");
    assert!(
        body.contains("DETERMINISTIC"),
        "core assert is deterministic SQL, not an LLM call"
    );
    assert!(
        body.contains("freshness_breach"),
        "lists the emitted signal"
    );
    assert!(
        body.contains("notify_slack") || body.contains("open_ticket"),
        "names the borrowed on-breach actions"
    );

    // Capability report: the borrowed transports resolve realize-via, nothing fails.
    let cap: serde_json::Value = read_json(&out_dir.path().join("capability-report.json"));
    let caps = cap["components"][0]["capabilities"].as_array().unwrap();
    let outcome_of = |name: &str| {
        caps.iter()
            .find(|c| c["capability"] == name)
            .unwrap_or_else(|| panic!("capability '{name}' present in report"))["outcome"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(outcome_of("scheduler"), "realize-via");
    assert_eq!(
        outcome_of("event_bus"),
        "realize-via",
        "emits implies event_bus (borrowed)"
    );
    assert_eq!(outcome_of("notify_channel"), "realize-via");
    assert!(caps
        .iter()
        .all(|c| c["outcome"].as_str().unwrap() != "fail"));

    // RUN.md documents the scheduled cron wiring + the verdict two-step.
    let run_md = std::fs::read_to_string(out_dir.path().join("RUN.md")).unwrap();
    assert!(
        run_md.contains("scheduler"),
        "RUN.md names the borrowed scheduler"
    );
    assert!(
        run_md.contains("verdict.json"),
        "RUN.md shows the verdict capture step"
    );
}

/// Turn demo-agent's node into a minimal +Mutating shape (gated-tool · one_shot · mutation), the
/// way a schema-migration component is structured: a proposed change to a `target`, gated on a
/// dry-run, a blast-radius check, and human approval before anything is applied. `human_approval`
/// and `blast_radius` are *declared* capabilities here (not shape-implied — see `resolve.rs`'s
/// `implied_capabilities`), and the fine-grained `context_binding.resolved` lets `blast_radius`
/// resolve natively rather than loud-failing on a coarse binding.
fn make_mutating_ir(golden: &WarbleIr) -> WarbleIr {
    with_component(golden, |mut c| {
        c.realization_kind = warble_claude_code::ir::RealizationKind::GatedTool;
        c.effect.outcome.kind = warble_claude_code::ir::OutcomeKind::Mutation;
        c.effect.outcome.target = Some("models/orders.yml".to_string());
        c.effect.outcome.change_type = Some("schema_migration".to_string());
        c.context_binding.resolved = Some(serde_json::json!({ "lineage": { "resolvable": true } }));
        // A mutating component is not read-only: drop the base guardrail so Edit/Write are granted.
        c.guardrails.retain(|g| g.name != "read_only_execution");
        c.guardrails.push(warble_claude_code::ir::Guardrail {
            name: "must_dry_run".to_string(),
            locked: true,
            scope: None,
            threshold: None,
        });
        c.guardrails.push(warble_claude_code::ir::Guardrail {
            name: "blast_radius_limit".to_string(),
            locked: true,
            scope: None,
            threshold: Some(serde_json::json!(5)),
        });
        c.required_capabilities.push("human_approval".to_string());
        c.required_capabilities.push("blast_radius".to_string());
        // Single tier so it takes the single-agent path (no per-step split), like monitor_freshness.
        for call in &mut c.llm_calls {
            call.tier = "cheap".to_string();
        }
        c.required_capabilities
            .retain(|cap| cap != "llm:per_step_tier");
        c
    })
}

#[test]
fn mutating_arms_gated_tool_mutation_emit_the_lifecycle_on_interactive() {
    let ir = make_mutating_ir(&load_ir(DEMO_AGENT_IR));
    let node = &ir.components[0];
    let out_dir = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:interactive",
        RenderFlavor::Programmatic,
    )
    .expect(
        "the +Mutating arms (gated-tool · mutation) must dispatch on interactive, not wall-hit",
    );

    let md = std::fs::read_to_string(
        out_dir
            .path()
            .join(format!(".claude/agents/{}.md", node.verb)),
    )
    .unwrap();
    let (frontmatter, body) = split_frontmatter(&md);
    let parsed = parse_frontmatter(&frontmatter);

    assert!(
        has_tool(&parsed, "Edit"),
        "mutating component must get Edit"
    );
    assert!(
        has_tool(&parsed, "Write"),
        "mutating component must get Write"
    );
    assert!(
        has_tool(&parsed, "Bash(warble:*)"),
        "mutating component must get the blast-radius gate CLI"
    );
    assert!(
        has_tool(&parsed, "Bash(wren:*)"),
        "mutating component needs wren to analyze the target before proposing a diff"
    );

    assert!(body.contains("## Mutation lifecycle"));
    let lower = body.to_lowercase();
    assert!(lower.contains("dry-run"), "names the dry-run phase");
    assert!(lower.contains("blast"), "names the blast-radius gate");
    assert!(lower.contains("approval"), "names human approval");
    assert!(
        lower.contains("rollback"),
        "names the rollback (borrowed from git)"
    );
    assert!(
        body.contains(r#""type": "diff""#),
        "shows the diff render-block envelope example"
    );

    let cap: serde_json::Value = read_json(&out_dir.path().join("capability-report.json"));
    let caps = cap["components"][0]["capabilities"].as_array().unwrap();
    let outcome_of = |name: &str| {
        caps.iter()
            .find(|c| c["capability"] == name)
            .unwrap_or_else(|| panic!("capability '{name}' present in report"))["outcome"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(
        outcome_of("write_authz"),
        "realize-via",
        "write_authz is shape-implied by outcome=mutation"
    );
    assert_eq!(
        outcome_of("version_control"),
        "realize-via",
        "version_control (git) is shape-implied by outcome=mutation"
    );
    assert_eq!(
        outcome_of("human_approval"),
        "native",
        "human_approval resolves natively on interactive"
    );
    assert_eq!(
        outcome_of("blast_radius"),
        "native",
        "fine-grained binding lets blast_radius resolve natively"
    );
    assert!(caps
        .iter()
        .all(|c| c["outcome"].as_str().unwrap() != "fail"));

    let run_md = std::fs::read_to_string(out_dir.path().join("RUN.md")).unwrap();
    assert!(
        run_md.contains(".warble/interactive-launch.json"),
        "interactive RUN.md delegates launch to the versioned native handoff"
    );
    assert!(
        !run_md.contains("blast-radius"),
        "interactive RUN.md must not recreate a headless lifecycle command"
    );
}

#[test]
fn mutating_component_loud_fails_on_headless_due_to_human_approval() {
    let ir = make_mutating_ir(&load_ir(DEMO_AGENT_IR));
    let out_dir = tempfile::tempdir().expect("tempdir");
    let err = emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .unwrap_err();
    assert!(
        err.0
            .contains("human_approval: fail on claude-code:headless"),
        "unexpected error message: {}",
        err.0
    );
    let files: Vec<_> = std::fs::read_dir(out_dir.path()).unwrap().collect();
    assert!(
        files.is_empty(),
        "no files should be emitted when resolution aborts"
    );
}

/// Turn demo-agent's node into a minimal +Constitutive shape (gated-tool · one_shot · mutation,
/// `target: "context"`), the way a `bootstrap_mdl` component is structured: proposing a change to
/// the semantic model/knowledge structure itself (models/metrics/knowledge), gated on a dry-run and
/// human approval, but scoped by `context_write_authz` (a path authorization) rather than
/// `blast_radius` (a downstream-lineage computation) — +Constitutive reuses the same `mutation`
/// outcome arm as +Mutating (see `make_mutating_ir`), differentiated purely by `outcome.target`.
fn make_constitutive_ir(golden: &WarbleIr) -> WarbleIr {
    with_component(golden, |mut c| {
        c.realization_kind = warble_claude_code::ir::RealizationKind::GatedTool;
        c.effect.outcome.kind = warble_claude_code::ir::OutcomeKind::Mutation;
        c.effect.outcome.target = Some("context".to_string());
        c.effect.outcome.change_type = Some("mdl_bootstrap".to_string());
        // A constitutive component is not read-only: drop the base guardrail so Edit/Write are
        // granted.
        c.guardrails.retain(|g| g.name != "read_only_execution");
        c.guardrails.push(warble_claude_code::ir::Guardrail {
            name: "context_write_authz".to_string(),
            locked: true,
            scope: Some("models/".to_string()),
            threshold: None,
        });
        c.guardrails.push(warble_claude_code::ir::Guardrail {
            name: "must_dry_run".to_string(),
            locked: true,
            scope: None,
            threshold: None,
        });
        c.guardrails.push(warble_claude_code::ir::Guardrail {
            name: "human_approval".to_string(),
            locked: true,
            scope: None,
            threshold: None,
        });
        c.guardrails.push(warble_claude_code::ir::Guardrail {
            name: "no_silent_overwrite".to_string(),
            locked: true,
            scope: None,
            threshold: None,
        });
        c.guardrails.push(warble_claude_code::ir::Guardrail {
            name: "rollback_available".to_string(),
            locked: true,
            scope: None,
            threshold: None,
        });
        c.required_capabilities
            .push("schema_introspection".to_string());
        c.required_capabilities
            .push("context_write_authz".to_string());
        c.required_capabilities.push("version_control".to_string());
        c.required_capabilities.push("human_approval".to_string());
        // No `blast_radius` / `blast_radius_limit` anywhere: this path is never gated by blast
        // radius — only the scoped context-write authorization above.
        // Single tier so it takes the single-agent path (no per-step split), like monitor_freshness.
        for call in &mut c.llm_calls {
            call.tier = "cheap".to_string();
        }
        c.required_capabilities
            .retain(|cap| cap != "llm:per_step_tier");
        c
    })
}

#[test]
fn constitutive_arms_gated_tool_context_mutation_emit_cleanly_on_interactive() {
    let ir = make_constitutive_ir(&load_ir(DEMO_AGENT_IR));
    let node = &ir.components[0];
    let out_dir = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:interactive",
        RenderFlavor::Programmatic,
    )
    .expect(
        "the +Constitutive arm (gated-tool · mutation · target=context) must dispatch on \
interactive, not wall-hit",
    );

    let md = std::fs::read_to_string(
        out_dir
            .path()
            .join(format!(".claude/agents/{}.md", node.verb)),
    )
    .unwrap();
    let (frontmatter, body) = split_frontmatter(&md);
    let parsed = parse_frontmatter(&frontmatter);

    assert!(
        has_tool(&parsed, "Edit"),
        "constitutive component must get Edit"
    );
    assert!(
        has_tool(&parsed, "Write"),
        "constitutive component must get Write"
    );
    assert!(
        has_tool(&parsed, "Bash(wren:*)"),
        "constitutive component needs wren for schema_introspection"
    );
    assert!(
        !has_tool(&parsed, "Bash(warble:*)"),
        "constitutive component is not gated by blast-radius: no warble CLI grant"
    );

    assert!(body.contains("## Mutation lifecycle"));
    let lower = body.to_lowercase();
    assert!(lower.contains("dry-run"), "names the dry-run phase");
    assert!(lower.contains("approval"), "names human approval");
    assert!(
        lower.contains("rollback"),
        "names the rollback (borrowed from git)"
    );
    assert!(lower.contains("diff"), "names the diff envelope");
    assert!(lower.contains("context"), "names the context target");
    assert!(
        body.contains("models/"),
        "names the context_write_authz scope"
    );
    assert!(
        !lower.contains("blast"),
        "constitutive mutation section must never mention blast-radius"
    );
    assert!(
        body.contains(r#""type": "diff""#),
        "shows the diff render-block envelope example"
    );

    let settings = read_json(&out_dir.path().join(".claude/settings.json"));
    let allow = settings["permissions"]["allow"].as_array().unwrap();
    let allow_has = |t: &str| allow.iter().any(|v| v.as_str() == Some(t));
    assert!(allow_has("Edit"));
    assert!(allow_has("Write"));
    assert!(allow_has("Bash(wren:*)"));
    assert!(
        !allow_has("Bash(warble:*)"),
        "settings must not grant the blast-radius CLI to a constitutive component"
    );

    let cap: serde_json::Value = read_json(&out_dir.path().join("capability-report.json"));
    let caps = cap["components"][0]["capabilities"].as_array().unwrap();
    let outcome_of = |name: &str| {
        caps.iter()
            .find(|c| c["capability"] == name)
            .unwrap_or_else(|| panic!("capability '{name}' present in report"))["outcome"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(
        outcome_of("context_write_authz"),
        "realize-via",
        "context_write_authz is shape-implied by outcome=mutation, target=context"
    );
    assert_eq!(
        outcome_of("version_control"),
        "realize-via",
        "version_control (git) is shape-implied by outcome=mutation"
    );
    assert_eq!(
        outcome_of("schema_introspection"),
        "realize-via",
        "schema_introspection resolves via the wren CLI"
    );
    assert_eq!(
        outcome_of("human_approval"),
        "native",
        "human_approval resolves natively on interactive"
    );
    assert!(
        caps.iter().all(|c| c["capability"] != "write_authz"),
        "target=context must use context_write_authz, never write_authz (scopes must not cross)"
    );
    assert!(caps
        .iter()
        .all(|c| c["outcome"].as_str().unwrap() != "fail"));
}

#[test]
fn constitutive_component_loud_fails_on_headless_due_to_human_approval() {
    let ir = make_constitutive_ir(&load_ir(DEMO_AGENT_IR));
    let out_dir = tempfile::tempdir().expect("tempdir");
    let err = emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .unwrap_err();
    assert!(
        err.0
            .contains("human_approval: fail on claude-code:headless"),
        "unexpected error message: {}",
        err.0
    );
    let files: Vec<_> = std::fs::read_dir(out_dir.path()).unwrap().collect();
    assert!(
        files.is_empty(),
        "no files should be emitted when resolution aborts"
    );
}

// --- Phase 1.3: hero render contract (verified facet + definition block + explicit verify gate) ---

/// `generate_dashboard`'s locked render contract (genbi-default) must list the `definition` block
/// and its driver body must carry the shared verify+definition contract text verbatim, including the
/// `"verified": true` envelope example — the same wording asserted in render_tests.rs for the HTML
/// side of this contract.
#[test]
fn genbi_default_generate_dashboard_driver_lists_definition_block_and_verify_contract() {
    let ir = single_component(&load_ir(GENBI_DEFAULT_IR), "generate_dashboard");
    let out_dir = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("emit succeeds");

    let driver_md =
        std::fs::read_to_string(out_dir.path().join(".claude/agents/generate_dashboard.md"))
            .unwrap();
    let (_, body) = split_frontmatter(&driver_md);

    assert!(
        body.contains("`definition`"),
        "render section must list a `definition` block line"
    );
    assert!(
        body.contains("per-answer verify"),
        "body must carry the per-answer verify wording"
    );
    assert!(
        body.contains("REFUSE"),
        "body must carry the refuse path wording"
    );
    assert!(
        body.contains("\"verified\": true"),
        "envelope example must show the verified facet"
    );
}

/// `answer_query`'s 3-step split makes the deterministic verify gate explicit in the subagent
/// bodies (the split path folds each step's prompt verbatim into its own subagent file): the
/// `generate_sql` step names the gate and asks the agent to verify the result set, and the
/// `repair_sql` step carries the REFUSE path when the result still cannot be validated.
#[test]
fn genbi_default_answer_query_subagents_make_the_deterministic_gate_explicit() {
    let ir = single_component(&load_ir(GENBI_DEFAULT_IR), "answer_query");
    let out_dir = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("emit succeeds");

    let generate_sql_md = std::fs::read_to_string(
        out_dir
            .path()
            .join(".claude/agents/answer_query__generate_sql.md"),
    )
    .unwrap();
    assert!(
        generate_sql_md.contains("deterministic gate"),
        "generate_sql step must name the deterministic gate"
    );
    assert!(
        generate_sql_md.contains("Verify the result set"),
        "generate_sql step must ask the agent to verify the result set"
    );

    let repair_sql_md = std::fs::read_to_string(
        out_dir
            .path()
            .join(".claude/agents/answer_query__repair_sql.md"),
    )
    .unwrap();
    assert!(
        repair_sql_md.contains("REFUSE"),
        "repair_sql step must carry the refuse path when validation still fails"
    );
}

/// P1: the single-agent (non-split) emit path writes its settings to
/// `.claude/settings.json` — the same location the split path already used — and must NOT write a
/// root-level `settings.json` (that was the pre-fix location).
#[test]
fn single_agent_path_writes_dotclaude_settings_and_not_a_root_settings_file() {
    let golden_ir = load_ir(DEMO_AGENT_IR);
    let ir = make_single_tier_ir(&golden_ir);

    let out_dir = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("emit succeeds");

    assert!(
        out_dir.path().join(".claude/settings.json").exists(),
        "single-agent path must write .claude/settings.json"
    );
    assert!(
        !out_dir.path().join("settings.json").exists(),
        "single-agent path must NOT write a root-level settings.json"
    );
}

// --- hybrid: llm:per_step_provider on the file target (bash-script realization) -------------------

const HYBRID_CFG: &str = "tiers:\n  strong: opus\n  cheap:\n    provider: openai_compat\n    endpoint: http://localhost:11434/v1\n    model: qwen2.5\n  orchestrator: sonnet\n";

#[test]
fn non_anthropic_provider_binding_emits_bash_script_hybrid_on_file_target() {
    // The file target now realizes llm:per_step_provider via bash-script: the LOCAL step becomes an
    // emitted local-inference script the driver runs through Bash; the cloud steps stay the driver's
    // own work. It must NOT loud-fail, and must NOT put the local model in an agent's frontmatter.
    let ir = single_component(&load_ir(GENBI_DEFAULT_IR), "answer_query");
    let models = ModelConfig::from_yaml(HYBRID_CFG).expect("parse hybrid config");
    let out = tempfile::tempdir().expect("tempdir");
    emit_claude_code_with_models(
        &ir,
        out.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
        &models,
    )
    .expect("hybrid bash-script emit succeeds on the file target");

    // Local-inference script + its system prompt + a wrapper for the local step are emitted.
    assert!(out.path().join("scripts/local_infer.py").is_file());
    assert!(out
        .path()
        .join("scripts/answer_query__resolve_intent.sh")
        .is_file());
    assert!(out
        .path()
        .join("scripts/answer_query__resolve_intent.system.txt")
        .is_file());

    let driver =
        std::fs::read_to_string(out.path().join(".claude/agents/answer_query.md")).unwrap();
    let (frontmatter, body) = split_frontmatter(&driver);
    // Driver runs on the cloud (strong) model; the local model must NOT leak into frontmatter.
    assert!(
        frontmatter.contains("model: opus"),
        "driver hosts on the cloud tier"
    );
    assert!(
        !driver.contains("model: qwen2.5"),
        "local model must not be a frontmatter model"
    );
    // Local step routed to the script; cloud steps done by the driver itself.
    assert!(body.contains("resolve_intent` — runs on a LOCAL model"));
    assert!(body.contains("answer_query__resolve_intent.sh"));
    assert!(body.contains("generate_sql` — you do this yourself"));

    // Settings allow bash (to run the wrapper) + wren, and keep the destructive-bash denials.
    let settings = read_json(&out.path().join(".claude/settings.json"));
    let allow = &settings["permissions"]["allow"];
    assert!(allow
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v.as_str() == Some("Bash(bash:*)")));
    assert!(allow
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v.as_str() == Some("Bash(wren:*)")));
}

#[test]
fn all_anthropic_string_binding_passes_the_provider_gate() {
    // The M3 proxy path: `cheap` bound to a bare model name (provider defaults to anthropic) must NOT
    // trip the gate — Warble sees all-anthropic; a proxy does name-based routing invisibly.
    let ir = single_component(&load_ir(GENBI_DEFAULT_IR), "answer_query");
    let models = ModelConfig::from_yaml(
        "tiers:\n  strong: opus\n  cheap: qwen2.5\n  orchestrator: sonnet\n",
    )
    .expect("parse");
    let out = std::env::temp_dir().join("warble-emit-gate-ok");
    let res = emit_claude_code_with_models(
        &ir,
        &out,
        "claude-code:headless",
        RenderFlavor::Programmatic,
        &models,
    );
    assert!(
        res.is_ok(),
        "all-anthropic (string) binding passes the gate: {:?}",
        res.err()
    );
}

#[test]
fn mcp_server_realization_emits_mcp_config_and_no_bash_widening() {
    let ir = single_component(&load_ir(GENBI_DEFAULT_IR), "answer_query");
    let models = ModelConfig::from_yaml(HYBRID_CFG).expect("parse hybrid config");
    let out = tempfile::tempdir().expect("tempdir");
    emit_claude_code_with_realization(
        &ir,
        out.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
        &models,
        HybridRealization::McpServer,
    )
    .expect("mcp-server hybrid emit succeeds");

    // .mcp.json registers `warble mcp-serve`; mcp-steps.json carries the local binding.
    let mcp = read_json(&out.path().join(".mcp.json"));
    let args = mcp["mcpServers"]["warble"]["args"].as_array().unwrap();
    assert!(args.iter().any(|v| v.as_str() == Some("mcp-serve")));
    let steps = read_json(&out.path().join("mcp-steps.json"));
    assert_eq!(steps["steps"]["resolve_intent"]["model"], "qwen2.5");
    assert_eq!(
        steps["steps"]["resolve_intent"]["endpoint"],
        "http://localhost:11434/v1"
    );

    // Driver calls the MCP tool for the local step; settings allow it and do NOT widen bash.
    let driver =
        std::fs::read_to_string(out.path().join(".claude/agents/answer_query.md")).unwrap();
    assert!(driver.contains("local_infer` MCP tool"));
    assert!(!driver.contains("model: qwen2.5"));
    let allow = read_json(&out.path().join(".claude/settings.json"))["permissions"]["allow"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect::<Vec<_>>();
    assert!(allow.contains(&"mcp__warble__local_infer".to_string()));
    assert!(
        !allow.contains(&"Bash(bash:*)".to_string()),
        "mcp-server realization must NOT widen the bash allowlist"
    );
}

// --- dispatch-time context injection ------------------------------------------------------------

#[test]
fn schema_digest_is_order_independent_and_reports_do_not_leak_context_text() {
    let ir = single_component(&load_ir(GENBI_DEFAULT_IR), "answer_query");
    let mut reordered = ir.clone();
    let resolved = reordered.context_binding.resolved.as_mut().unwrap();
    for key in ["models", "metrics", "dimensions", "time_dimensions"] {
        resolved[key].as_array_mut().unwrap().reverse();
    }

    let first = ContextInjection::from_ir(
        &ir,
        ContextInjectionMode::SchemaWithKnowledge,
        Some("PRIVATE_RULE_MARKER\r\n".to_string()),
    );
    let second = ContextInjection::from_ir(
        &reordered,
        ContextInjectionMode::SchemaWithKnowledge,
        Some("PRIVATE_RULE_MARKER\n".to_string()),
    );

    assert_eq!(first.report(), second.report());
    let report_json = serde_json::to_string(&first.report()).unwrap();
    assert!(!report_json.contains("PRIVATE_RULE_MARKER"));
    assert!(first.prompt_section().contains("PRIVATE_RULE_MARKER"));
    assert!(!first.prompt_section().contains("wren context"));
}

#[test]
fn schema_only_and_schema_with_knowledge_are_explicit_distinct_agent_and_report_identities() {
    let ir = make_single_tier_ir(&single_component(
        &load_ir(GENBI_DEFAULT_IR),
        "answer_query",
    ));
    let models = ModelConfig::default();
    let schema_only = ContextInjection::from_ir(&ir, ContextInjectionMode::SchemaOnly, None);
    let with_knowledge = ContextInjection::from_ir(
        &ir,
        ContextInjectionMode::SchemaWithKnowledge,
        Some("BUSINESS_RULE_MARKER".to_string()),
    );
    let out_schema = tempfile::tempdir().unwrap();
    let out_knowledge = tempfile::tempdir().unwrap();

    emit_claude_code_with_context(
        &ir,
        out_schema.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
        &models,
        HybridRealization::BashScript,
        &schema_only,
    )
    .unwrap();
    emit_claude_code_with_context(
        &ir,
        out_knowledge.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
        &models,
        HybridRealization::BashScript,
        &with_knowledge,
    )
    .unwrap();

    let schema_agent =
        std::fs::read_to_string(out_schema.path().join(".claude/agents/answer_query.md")).unwrap();
    let knowledge_agent =
        std::fs::read_to_string(out_knowledge.path().join(".claude/agents/answer_query.md"))
            .unwrap();
    assert!(schema_agent.contains("Context injection mode: `schema-only`"));
    assert!(schema_agent.contains("Knowledge rules are intentionally excluded"));
    assert!(!schema_agent.contains("BUSINESS_RULE_MARKER"));
    assert!(knowledge_agent.contains("Context injection mode: `schema+knowledge`"));
    assert!(knowledge_agent.contains("BUSINESS_RULE_MARKER"));
    assert_ne!(schema_agent, knowledge_agent);

    let schema_report = read_json(&out_schema.path().join("context-report.json"));
    let knowledge_report = read_json(&out_knowledge.path().join("context-report.json"));
    assert_eq!(schema_report["mode"], "schema-only");
    assert_eq!(knowledge_report["mode"], "schema+knowledge");
    assert_ne!(schema_report, knowledge_report);
}

#[test]
fn split_and_both_hybrid_realizations_receive_the_same_context_contract() {
    let split_ir = load_ir(DEMO_AGENT_IR);
    let marker = "PARITY_RULE_MARKER";
    let split_context = ContextInjection::from_ir(
        &split_ir,
        ContextInjectionMode::SchemaWithKnowledge,
        Some(marker.to_string()),
    );
    let split_out = tempfile::tempdir().unwrap();
    emit_claude_code_with_context(
        &split_ir,
        split_out.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
        &ModelConfig::default(),
        HybridRealization::BashScript,
        &split_context,
    )
    .unwrap();
    for entry in std::fs::read_dir(split_out.path().join(".claude/agents")).unwrap() {
        let body = std::fs::read_to_string(entry.unwrap().path()).unwrap();
        assert!(
            body.contains(marker),
            "every split prompt gets injected context"
        );
    }

    let hybrid_ir = single_component(&load_ir(GENBI_DEFAULT_IR), "answer_query");
    let hybrid_context = ContextInjection::from_ir(
        &hybrid_ir,
        ContextInjectionMode::SchemaWithKnowledge,
        Some(marker.to_string()),
    );
    let models = ModelConfig::from_yaml(HYBRID_CFG).unwrap();
    for realization in [HybridRealization::BashScript, HybridRealization::McpServer] {
        let out = tempfile::tempdir().unwrap();
        emit_claude_code_with_context(
            &hybrid_ir,
            out.path(),
            "claude-code:headless",
            RenderFlavor::Programmatic,
            &models,
            realization,
            &hybrid_context,
        )
        .unwrap();
        let driver =
            std::fs::read_to_string(out.path().join(".claude/agents/answer_query.md")).unwrap();
        assert!(driver.contains(marker));
        let local_prompt = match realization {
            HybridRealization::BashScript => std::fs::read_to_string(
                out.path()
                    .join("scripts/answer_query__resolve_intent.system.txt"),
            )
            .unwrap(),
            HybridRealization::McpServer => read_json(&out.path().join("mcp-steps.json"))["steps"]
                ["resolve_intent"]["system"]
                .as_str()
                .unwrap()
                .to_string(),
        };
        assert!(local_prompt.contains(marker));
        assert_eq!(
            read_json(&out.path().join("context-report.json"))["mode"],
            "schema+knowledge"
        );
    }
}

/// A component whose only capability comes from a provider fragment: the granted tools appear, and
/// nothing else does. The absence of `Bash(wren:*)` carries as much weight as the presence of the
/// grant — realizing a domain capability as an MCP tool rather than a shell wrapper is what keeps a
/// read-only agent read-only (capability-model §7.2) — and the preamble must not order an agent with
/// no wren grant to route data access through it.
#[test]
fn a_provider_supplied_capability_is_granted_and_costs_no_bash() {
    let ir = with_component(&load_ir(DEMO_AGENT_IR), |mut c| {
        c.required_capabilities = vec!["remote_thing".to_string(), "llm:cheap".to_string()];
        for call in &mut c.llm_calls {
            call.tier = "cheap".to_string();
        }
        c
    });
    let providers = parse_provider_fragments(
        r#"
fragment_version: "0.1"
provider: some-service
engine: claude-code
capabilities:
  remote_thing:
    outcome: realize-via
    via: mcp:svc
    provided_by: runtime
    criticality: required
tools:
  remote_thing:
    names: [mcp__svc__ask, mcp__svc__follow_up]
    source: mcp:svc/ask
"#,
    )
    .expect("fragment parses");

    let out_dir = tempfile::tempdir().expect("tempdir");
    let context = ContextInjection::from_ir(&ir, ContextInjectionMode::SchemaOnly, None);
    emit_claude_code_with_providers(
        &ir,
        out_dir.path(),
        "claude-code:interactive",
        RenderFlavor::Programmatic,
        &ModelConfig::default(),
        HybridRealization::default(),
        &context,
        &providers,
    )
    .expect("a provider-bound capability must dispatch");

    let verb = &ir.components[0].verb;
    let md = std::fs::read_to_string(out_dir.path().join(format!(".claude/agents/{verb}.md")))
        .expect("agent file");
    let settings = read_json(&out_dir.path().join(".claude/settings.json"));
    let allow = settings["permissions"]["allow"].as_array().unwrap();

    for tool in ["mcp__svc__ask", "mcp__svc__follow_up"] {
        assert!(md.contains(tool), "frontmatter must grant {tool}:\n{md}");
        assert!(
            allow.contains(&serde_json::json!(tool)),
            "settings allow must grant {tool}: {allow:?}"
        );
    }
    assert!(
        !allow.contains(&serde_json::json!("Bash(wren:*)")),
        "a provider-supplied capability must not widen the bash surface: {allow:?}"
    );
    assert!(
        !md.contains("All data access MUST go through the `wren` CLI"),
        "an agent with no wren grant must not be told to route data access through it:\n{md}"
    );

    // Provenance: which fragment-supplied tools were granted, and what backs them.
    let bindings = &read_json(&out_dir.path().join("capability-report.json"))["components"][0]
        ["tool_bindings"]["remote_thing"];
    assert_eq!(bindings["source"], "mcp:svc/ask");
}

/// Without a fragment binding it, a domain capability is unknown — and unknown must abort, not pass.
/// This is the point of keeping domain capabilities out of the target: the back-end no longer knows
/// what satisfies them, so nothing quietly grants a tool it cannot back.
#[test]
fn a_domain_capability_with_no_provider_fragment_loud_fails() {
    let ir = with_component(&load_ir(DEMO_AGENT_IR), |mut c| {
        c.required_capabilities.push("remote_thing".to_string());
        c
    });
    let out_dir = tempfile::tempdir().expect("tempdir");
    let err = emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:interactive",
        RenderFlavor::Programmatic,
    )
    .expect_err("an unbound domain capability must abort dispatch");
    let msg = err.to_string();
    assert!(
        msg.contains("remote_thing") && msg.contains("not declared"),
        "the error must name the unbound capability: {msg}"
    );
    assert!(
        !out_dir.path().join(".claude").exists(),
        "abort-before-write: nothing may be emitted when a capability fails to resolve"
    );
}

/// A fragment may not quietly take over something the base already owns. Redefining a
/// safety-critical capability is the case that matters — a provider that could restate
/// `human_approval` could weaken it.
#[test]
fn a_fragment_may_not_redefine_a_base_capability() {
    let ir = load_ir(DEMO_AGENT_IR);
    let providers = parse_provider_fragments(
        r#"
fragment_version: "0.1"
provider: hostile
engine: claude-code
capabilities:
  human_approval:
    outcome: native
    provided_by: runtime
    criticality: best-effort
"#,
    )
    .expect("fragment parses");
    let out_dir = tempfile::tempdir().expect("tempdir");
    let context = ContextInjection::from_ir(&ir, ContextInjectionMode::SchemaOnly, None);
    let err = emit_claude_code_with_providers(
        &ir,
        out_dir.path(),
        "claude-code:interactive",
        RenderFlavor::Programmatic,
        &ModelConfig::default(),
        HybridRealization::default(),
        &context,
        &providers,
    )
    .expect_err("a provider must not redefine a base capability");
    assert!(
        err.to_string()
            .contains("already provided by the base target"),
        "unexpected error: {err}"
    );
}

/// A grant has to name a tool the runtime could actually allow. On this engine that means
/// `mcp__<server>__<tool>` matching the binding's own source — otherwise the allowlist entry matches
/// nothing and the agent is handed a tool it cannot call.
#[test]
fn a_fragment_grant_must_match_its_own_source_server() {
    let providers = parse_provider_fragments(
        r#"
fragment_version: "0.1"
provider: mismatched
engine: claude-code
capabilities:
  remote_thing:
    outcome: realize-via
    via: mcp:svc
    provided_by: runtime
    criticality: required
tools:
  remote_thing:
    name: mcp__some_other_server__ask
    source: mcp:svc/ask
"#,
    )
    .expect("fragment parses");
    let ir = load_ir(DEMO_AGENT_IR);
    let out_dir = tempfile::tempdir().expect("tempdir");
    let context = ContextInjection::from_ir(&ir, ContextInjectionMode::SchemaOnly, None);
    let err = emit_claude_code_with_providers(
        &ir,
        out_dir.path(),
        "claude-code:interactive",
        RenderFlavor::Programmatic,
        &ModelConfig::default(),
        HybridRealization::default(),
        &context,
        &providers,
    )
    .expect_err("a grant that cannot come from its declared server must be refused");
    assert!(
        err.to_string().contains("cannot come from server"),
        "unexpected error: {err}"
    );
}

/// Isolation and the per-step-tier split want opposite things from the same component: the split
/// gives each STEP a child and marshals every artifact through the parent, which is the leakage
/// isolation exists to stop. Isolation therefore wins — and because that swallows a realized
/// capability, the collapse has to be reported rather than inferred from missing files.
#[test]
fn context_isolation_beats_the_per_step_split_and_reports_the_tier_collapse() {
    let ir = with_component(&load_ir(DEMO_AGENT_IR), |mut c| {
        c.required_capabilities
            .push("context_isolation".to_string());
        c
    });
    let node = &ir.components[0];
    assert!(
        node.llm_calls
            .iter()
            .map(|c| &c.tier)
            .collect::<std::collections::HashSet<_>>()
            .len()
            > 1,
        "fixture must have >1 distinct tier, or it is not testing the interaction"
    );

    let out_dir = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        &ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("isolation must dispatch");

    let agents = out_dir.path().join(".claude/agents");
    assert!(
        agents.join(format!("{}__isolated.md", node.verb)).is_file(),
        "the whole component must land in one child"
    );
    for call in &node.llm_calls {
        assert!(
            !agents
                .join(format!("{}__{}.md", node.verb, call.name))
                .is_file(),
            "no per-step child may be emitted alongside an isolated one — that is the split shape"
        );
    }

    let isolation =
        &read_json(&out_dir.path().join("capability-report.json"))["components"][0]["isolation"];
    assert_eq!(isolation["realized_via"], "single-child-subagent");
    assert_eq!(
        isolation["per_step_tier"]["outcome"], "degrade",
        "collapsing per-step tiers is a degrade and must be recorded: {isolation}"
    );
    assert!(
        isolation["per_step_tier"]["collapsed_to"].is_string(),
        "the report must name the model the steps collapsed onto: {isolation}"
    );
}

// --- component-level `brief` -----------------------------------------------------------------
//
// None of the golden fixtures author a `brief`, so every case here injects one via `with_component`
// / `make_single_tier_ir` rather than editing a committed golden file. Every positive assertion
// computes the "without brief" baseline first and asserts the "with brief" output equals that
// baseline with the brief text spliced in at the exact insertion point the emitter code uses — this
// fails if the brief-insertion line is removed or moved, not just if the text is missing outright.

fn emit_single_agent(ir: &WarbleIr) -> String {
    let out_dir = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("emit succeeds");
    std::fs::read_to_string(out_dir.path().join(".claude/agents/generate_dashboard.md")).unwrap()
}

#[test]
fn single_tier_agent_brief_absent_matches_the_unchanged_golden_shape() {
    let ir = make_single_tier_ir(&load_ir(DEMO_AGENT_IR));
    assert_eq!(
        ir.components[0].brief, None,
        "golden fixture must author no brief"
    );
    let without = emit_single_agent(&ir);
    let (_, body) = split_frontmatter(&without);
    assert!(body.contains(&ir.components[0].prompt_fragment));
}

#[test]
fn single_tier_agent_brief_is_spliced_in_verbatim_before_the_prompt_fragment() {
    let golden = load_ir(DEMO_AGENT_IR);
    let base_ir = make_single_tier_ir(&golden);
    let without = emit_single_agent(&base_ir);

    let brief_ir = with_component(&base_ir, |mut c| {
        c.brief = Some("Custom shared framing text for the single-tier agent.".to_string());
        c
    });
    let with = emit_single_agent(&brief_ir);
    let brief = brief_ir.components[0].brief.as_ref().unwrap();

    let marker = &base_ir.components[0].prompt_fragment;
    let idx = without
        .find(marker.as_str())
        .expect("prompt_fragment must be locatable in the baseline markdown");
    let expected = format!("{}{}\n\n{}", &without[..idx], brief, &without[idx..]);
    assert_eq!(
        with, expected,
        "removing (or mispositioning) the brief-insertion line would make this assertion fail"
    );
}

#[test]
fn split_driver_brief_is_spliced_in_verbatim_before_the_driver_body() {
    let base_ir = load_ir(DEMO_AGENT_IR);
    let out_dir = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        &base_ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("emit succeeds");
    let without =
        std::fs::read_to_string(out_dir.path().join(".claude/agents/generate_dashboard.md"))
            .unwrap();

    let brief_ir = with_component(&base_ir, |mut c| {
        c.brief = Some("Driver-level framing text.".to_string());
        c
    });
    let out_dir2 = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        &brief_ir,
        out_dir2.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("emit succeeds");
    let with =
        std::fs::read_to_string(out_dir2.path().join(".claude/agents/generate_dashboard.md"))
            .unwrap();
    let brief = brief_ir.components[0].brief.as_ref().unwrap();

    // `build_driver_body` always opens with this sentence — unique to the driver (not present
    // verbatim in either subagent's body) — so it's a safe splice marker.
    let driver_marker = format!("You orchestrate the `{}` steps", base_ir.components[0].verb);
    let idx = without
        .find(driver_marker.as_str())
        .expect("driver body marker must be present in the baseline driver markdown");
    let expected = format!("{}{}\n\n{}", &without[..idx], brief, &without[idx..]);
    assert_eq!(
        with, expected,
        "removing (or mispositioning) the brief-insertion line would make this assertion fail"
    );
}

#[test]
fn split_subagent_brief_is_spliced_in_verbatim_before_each_steps_own_prompt() {
    let base_ir = load_ir(DEMO_AGENT_IR);
    let node = &base_ir.components[0];
    let out_dir = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        &base_ir,
        out_dir.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("emit succeeds");

    let brief_ir = with_component(&base_ir, |mut c| {
        c.brief = Some("Subagent framing text.".to_string());
        c
    });
    let out_dir2 = tempfile::tempdir().expect("tempdir");
    emit_claude_code(
        &brief_ir,
        out_dir2.path(),
        "claude-code:headless",
        RenderFlavor::Programmatic,
    )
    .expect("emit succeeds");
    let brief = brief_ir.components[0].brief.as_ref().unwrap();

    for call in &node.llm_calls {
        let file = format!(".claude/agents/{}__{}.md", node.verb, call.name);
        let without = std::fs::read_to_string(out_dir.path().join(&file)).unwrap();
        let with = std::fs::read_to_string(out_dir2.path().join(&file)).unwrap();
        let idx = without
            .find(call.prompt.as_str())
            .expect("the step's own prompt must be locatable in the baseline subagent markdown");
        let expected = format!("{}{}\n\n{}", &without[..idx], brief, &without[idx..]);
        assert_eq!(
            with, expected,
            "subagent '{file}': removing (or mispositioning) the brief-insertion line would make this assertion fail"
        );
    }
}
