use warble_claude_code::{ir::WarbleIr, ModelConfig, BINDING_SPEC_VERSION};

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

// --- Layer-3 binding format (provider/endpoint/model, docs/spec/capability-model.md §7.2) -------

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

/// The binding spec is one contract with three copies of its version (Rust const, TS const, spec
/// doc). Nothing regenerates them from a single source, so this test is the guard that keeps them in
/// lockstep — it fails loudly the moment one is bumped without the others, which is exactly the
/// version-drift trap the spec doc calls out.
#[test]
fn binding_spec_version_is_in_lockstep_across_rust_ts_and_doc() {
    let crate_dir = env!("CARGO_MANIFEST_DIR");

    let ts_src = std::fs::read_to_string(format!("{crate_dir}/../claude-agent-sdk/src/models.ts"))
        .expect("read TS models.ts");
    let ts_version = extract_quoted_after(&ts_src, "export const BINDING_SPEC_VERSION")
        .expect("TS BINDING_SPEC_VERSION constant");

    let doc = std::fs::read_to_string(format!("{crate_dir}/../../docs/spec/binding-spec.md"))
        .expect("read binding-spec.md");
    let doc_version = extract_after(&doc, "binding_spec_version:")
        .expect("doc binding_spec_version in the title");

    assert_eq!(
        BINDING_SPEC_VERSION, ts_version,
        "Rust and TS BINDING_SPEC_VERSION disagree — bump both together"
    );
    assert_eq!(
        BINDING_SPEC_VERSION, doc_version,
        "Rust const and docs/spec/binding-spec.md version disagree — bump both together"
    );
}

/// The value of the first `"..."`-quoted string on the line containing `needle`.
fn extract_quoted_after(haystack: &str, needle: &str) -> Option<String> {
    let line = haystack.lines().find(|l| l.contains(needle))?;
    let after = &line[line.find(needle)? + needle.len()..];
    let start = after.find('"')? + 1;
    let end = after[start..].find('"')? + start;
    Some(after[start..end].to_string())
}

/// The version token immediately after `needle` on the line containing it — keeps only the leading
/// run of version characters (digits/dots), dropping any surrounding markdown like `` `1.0`) ``.
fn extract_after(haystack: &str, needle: &str) -> Option<String> {
    let line = haystack.lines().find(|l| l.contains(needle))?;
    let after = line[line.find(needle)? + needle.len()..]
        .trim()
        .trim_start_matches('`');
    let token: String = after
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    (!token.is_empty()).then_some(token)
}

#[test]
fn validate_flags_a_component_tier_with_no_binding() {
    // Minimal IR whose single step uses a custom tier `premium`.
    let ir: WarbleIr = serde_json::from_value(serde_json::json!({
        "warble_ir_version": "0.7",
        "profile": "p",
        "context_binding": { "project": ".", "binding_mode": "runtime_selected" },
        "config": {},
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
