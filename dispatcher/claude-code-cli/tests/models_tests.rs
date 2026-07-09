use warble_claude_code::{ir::WarbleIr, ModelConfig};

#[test]
fn default_binds_strong_cheap_orchestrator() {
    let m = ModelConfig::default();
    assert_eq!(m.require("strong").unwrap(), "opus");
    assert_eq!(m.require("cheap").unwrap(), "haiku");
    assert_eq!(m.orchestrator().unwrap(), "sonnet"); // reserved core tier
}

#[test]
fn from_flags_binds_all_three_core_tiers() {
    let m = ModelConfig::from_flags("sonnet-5".into(), "haiku-4-5".into(), "opus".into());
    assert_eq!(m.require("strong").unwrap(), "sonnet-5");
    assert_eq!(m.require("cheap").unwrap(), "haiku-4-5");
    assert_eq!(m.orchestrator().unwrap(), "opus");
}

#[test]
fn from_yaml_parses_custom_tiers_and_orchestrator_is_optional() {
    let yaml = r#"
tiers:
  strong: claude-opus-4-8
  cheap: claude-haiku-4-5
  local: qwen2.5
"#;
    let m = ModelConfig::from_yaml(yaml).expect("parse");
    assert_eq!(m.require("strong").unwrap(), "claude-opus-4-8");
    assert_eq!(m.require("local").unwrap(), "qwen2.5"); // custom tier
                                                        // No `orchestrator` tier declared -> only a loud-fail if a split actually needs it.
    assert!(m.orchestrator().is_err());
}

#[test]
fn from_yaml_orchestrator_is_a_reserved_tier() {
    let m =
        ModelConfig::from_yaml("tiers: { strong: opus, orchestrator: haiku }\n").expect("parse");
    assert_eq!(m.orchestrator().unwrap(), "haiku");
}

#[test]
fn require_undefined_tier_is_loud_fail() {
    let m = ModelConfig::default();
    let err = m.require("premium").expect_err("undefined tier must fail");
    assert!(err.to_string().contains("premium"));
    assert!(err.to_string().contains("no model binding"));
}

#[test]
fn empty_tiers_config_is_rejected() {
    assert!(ModelConfig::from_yaml("driver: sonnet\n").is_err());
}

#[test]
fn validate_flags_a_component_tier_with_no_binding() {
    // Minimal IR whose single step uses a custom tier `premium`.
    let ir: WarbleIr = serde_json::from_value(serde_json::json!({
        "warble_ir_version": "0.2",
        "profile": "p",
        "context_binding": { "project": ".", "binding_mode": "runtime_selected" },
        "config": { "tier_policy": null },
        "components": [{
            "id": "c", "verb": "c", "type": "analytical", "realization_kind": "skill",
            "context_binding": { "project": ".", "binding_mode": "runtime_selected" },
            "precondition_result": { "status": "pass", "checks": [] },
            "prompt_fragment": "x",
            "llm_calls": [{ "name": "s", "tier": "premium", "consumes": [], "produces": null, "prompt": "x" }],
            "guardrails": [], "trigger": { "kind": "one_shot" },
            "required_capabilities": [], "borrowed_actions": [], "eval_ref": "c.eval",
            "effect": { "render_blocks": [], "outcome": { "kind": "none" } }
        }]
    }))
    .expect("ir");

    // Default config only knows strong/cheap → `premium` is undefined → loud-fail.
    let err = ModelConfig::default()
        .validate(&ir)
        .expect_err("premium is undefined");
    assert!(err.to_string().contains("premium"));

    // A config that defines `premium` validates cleanly.
    let m = ModelConfig::from_yaml("tiers: { premium: claude-opus-4-8 }\n").expect("parse");
    assert!(m.validate(&ir).is_ok());
}
