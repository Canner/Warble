//! Faithful port of dispatcher/test/renderContract.test.ts and dispatcher/test/claudeCode.test.ts,
//! merged into one file (both suites exercise `emit_claude_code`).

use warble_claude_code::ir::{ComponentNode, WarbleIr};
use warble_claude_code::{emit_claude_code, RenderFlavor};

const RENDER_DEMO_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../examples/render-demo/ir.golden.json"
);
const DEMO_AGENT_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../examples/demo-agent/ir.golden.json"
);

fn load_ir(path: &str) -> WarbleIr {
    let raw = std::fs::read_to_string(path).expect("read golden IR fixture");
    serde_json::from_str(&raw).expect("golden IR deserializes")
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

    let settings = read_json(&out_dir.path().join("settings.json"));
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

    let settings = read_json(&out_dir.path().join("settings.json"));
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

    let settings = read_json(&out_dir.path().join("settings.json"));
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

    // v0.1 shape: settings.json at the out-dir root, not under .claude/.
    let settings = read_json(&out_dir.path().join("settings.json"));
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
/// Handler-level arms (realization_kind / outcome.kind) fail at the claude-code file target's
/// dispatch check ("wall-hit").
fn handler_wall_hit_cases() -> Vec<(&'static str, IrMutator)> {
    fn realization_tool(ir: &WarbleIr) -> WarbleIr {
        with_component(ir, |mut c| {
            c.realization_kind = warble_claude_code::ir::RealizationKind::Tool;
            c
        })
    }
    fn realization_gated_tool(ir: &WarbleIr) -> WarbleIr {
        with_component(ir, |mut c| {
            c.realization_kind = warble_claude_code::ir::RealizationKind::GatedTool;
            c
        })
    }
    fn outcome_assertion(ir: &WarbleIr) -> WarbleIr {
        with_component(ir, |mut c| {
            c.effect.outcome.kind = warble_claude_code::ir::OutcomeKind::Assertion;
            c
        })
    }
    fn outcome_mutation(ir: &WarbleIr) -> WarbleIr {
        with_component(ir, |mut c| {
            c.effect.outcome.kind = warble_claude_code::ir::OutcomeKind::Mutation;
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
        ("realization_kind=tool", realization_tool),
        ("realization_kind=gated-tool", realization_gated_tool),
        ("outcome=assertion", outcome_assertion),
        ("outcome=mutation", outcome_mutation),
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

#[test]
fn unimplemented_trigger_arms_loud_fail_at_capability_resolution() {
    let golden = load_ir(DEMO_AGENT_IR);
    let cases: Vec<(&str, IrMutator, &str)> = vec![
        (
            "trigger=scheduled",
            (|ir: &WarbleIr| {
                with_component(ir, |mut c| {
                    c.trigger.kind = warble_claude_code::ir::TriggerKind::Scheduled;
                    c
                })
            }) as IrMutator,
            "scheduler: fail",
        ),
        (
            "trigger=event",
            (|ir: &WarbleIr| {
                with_component(ir, |mut c| {
                    c.trigger.kind = warble_claude_code::ir::TriggerKind::Event;
                    c
                })
            }) as IrMutator,
            "event_bus: fail",
        ),
    ];

    for (label, mutate, pattern) in cases {
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
            err.0.contains(pattern),
            "case '{label}': unexpected error message: {}",
            err.0
        );
    }
}
