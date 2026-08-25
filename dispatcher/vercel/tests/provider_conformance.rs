//! This back-end's half of the shared provider-composition conformance fixture.
//!
//! Mirrors `dispatcher/claude-code-cli/tests/provider_conformance.rs`. The two back-ends parse the
//! fragment format independently — each composes into its own target's capability types — so the
//! merge and safety rules they must agree on are asserted from one file,
//! `dispatcher/conformance-fixtures/provider-composition.json`. A rule changed on one side fails
//! here until the other follows, or until the fixture is updated deliberately.
//!
//! The fixture carries only engine-neutral scenarios; anything engine-specific stays in that
//! back-end's own suite.

use serde_json::Value;
use warble_vercel::{compose_target, parse_provider_fragments, TargetId};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../conformance-fixtures/provider-composition.json"
);

/// Render one scenario's fragments as the YAML a real `--provider` file would carry, so the parser
/// under test is the one a user's file goes through. `engine` defaults to this back-end's.
fn fragments_yaml(scenario: &Value) -> String {
    let mut docs = Vec::new();
    for fragment in scenario["fragments"].as_array().expect("fragments array") {
        let mut doc = serde_json::Map::new();
        doc.insert("fragment_version".into(), Value::String("0.1".into()));
        doc.insert("provider".into(), fragment["provider"].clone());
        doc.insert(
            "engine".into(),
            fragment
                .get("engine")
                .cloned()
                .unwrap_or_else(|| Value::String("vercel".into())),
        );
        for key in ["capabilities", "tools"] {
            if let Some(v) = fragment.get(key) {
                doc.insert(key.into(), v.clone());
            }
        }
        docs.push(Value::Object(doc));
    }
    serde_yaml::to_string(&serde_json::json!({ "providers": docs })).expect("fixture serializes")
}

#[test]
fn composition_matches_the_shared_conformance_fixture() {
    let fixture: Value =
        serde_json::from_str(&std::fs::read_to_string(FIXTURE).expect("read fixture"))
            .expect("fixture parses");
    let scenarios = fixture["scenarios"].as_array().expect("scenarios array");
    assert!(!scenarios.is_empty(), "fixture must carry scenarios");

    for scenario in scenarios {
        let name = scenario["name"].as_str().expect("scenario name");
        let fragments =
            parse_provider_fragments(&fragments_yaml(scenario)).expect("fragments parse");
        let target = TargetId::Headless;
        let composed = compose_target(
            target.profile(),
            warble_vercel::tools::base_tool_map(),
            &fragments,
            target,
        );

        match scenario["expect"].as_str().expect("expect") {
            "ok" => {
                let composed =
                    composed.unwrap_or_else(|e| panic!("[{name}] expected ok, got: {e}"));
                if let Some(cap) = scenario["expect_capability_present"].as_str() {
                    assert!(
                        composed.profile.contains_key(cap),
                        "[{name}] composed profile must contain '{cap}'"
                    );
                }
            }
            "error" => {
                let err = composed
                    .err()
                    .unwrap_or_else(|| panic!("[{name}] expected an error, composition succeeded"));
                let needle = scenario["error_contains"].as_str().expect("error_contains");
                assert!(
                    err.to_string().contains(needle),
                    "[{name}] error should contain {needle:?}, got: {err}"
                );
            }
            other => panic!("[{name}] unknown expect '{other}'"),
        }
    }
}
