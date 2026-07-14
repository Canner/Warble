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

// --- hybrid-LLM spike: §9.2 layer-3 binding format (provider/endpoint/model) --------------------

#[test]
fn shorthand_string_tier_is_an_anthropic_binding() {
    let m = ModelConfig::from_yaml("tiers: { strong: opus }\n").expect("parse");
    let b = m.binding("strong").unwrap();
    assert_eq!(b.provider, "anthropic");
    assert_eq!(b.endpoint, None);
    assert_eq!(b.model, "opus");
    // `require` still returns just the model — the file target's whole contract is unchanged.
    assert_eq!(m.require("strong").unwrap(), "opus");
}

#[test]
fn structured_tier_binds_provider_endpoint_model() {
    let yaml = r#"
tiers:
  strong: opus
  cheap:
    provider: openai_compat
    endpoint: http://localhost:11434/v1
    model: qwen2.5
"#;
    let m = ModelConfig::from_yaml(yaml).expect("parse");
    // strong stays anthropic shorthand
    assert_eq!(m.binding("strong").unwrap().provider, "anthropic");
    // cheap is the local OpenAI-compat binding
    let cheap = m.binding("cheap").unwrap();
    assert_eq!(cheap.provider, "openai_compat");
    assert_eq!(cheap.endpoint.as_deref(), Some("http://localhost:11434/v1"));
    assert_eq!(cheap.model, "qwen2.5");
    // require() gives the file target the model regardless of provider.
    assert_eq!(m.require("cheap").unwrap(), "qwen2.5");
}

#[test]
fn explicit_anthropic_provider_needs_no_endpoint() {
    let m = ModelConfig::from_yaml(
        "tiers: { strong: { provider: anthropic, model: claude-opus-4-8 } }\n",
    )
    .expect("parse");
    assert_eq!(m.binding("strong").unwrap().provider, "anthropic");
    assert_eq!(m.require("strong").unwrap(), "claude-opus-4-8");
}

#[test]
fn openai_compat_without_endpoint_is_loud_fail() {
    let err =
        ModelConfig::from_yaml("tiers: { cheap: { provider: openai_compat, model: qwen2.5 } }\n")
            .expect_err("missing endpoint must fail");
    assert!(err.to_string().contains("endpoint"));
}

#[test]
fn structured_tier_without_model_is_loud_fail() {
    let err = ModelConfig::from_yaml("tiers: { cheap: { provider: anthropic } }\n")
        .expect_err("missing model must fail");
    assert!(err.to_string().contains("model"));
}

#[test]
fn novel_provider_is_opaque_pass_through() {
    // `provider` is an open string — warble does not validate it against a fixed list. A
    // provider warble has never heard of still compiles cleanly; the endpoint requirement only
    // applies to the well-known `openai_compat` name, so a novel provider needs no endpoint.
    let m = ModelConfig::from_yaml("tiers: { cheap: { provider: bedrock, model: m } }\n")
        .expect("novel provider must parse opaquely");
    let cheap = m.binding("cheap").unwrap();
    assert_eq!(cheap.provider, "bedrock");
    assert_eq!(cheap.endpoint, None);
    assert_eq!(m.require("cheap").unwrap(), "m");
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
