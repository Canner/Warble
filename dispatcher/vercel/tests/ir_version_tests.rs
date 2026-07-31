//! The IR version this back-end accepts is one contract with ten copies of its value: the
//! producer (`core`'s emitted `warble_ir_version` literal in `compile.rs`), four enforcement
//! constants (this crate's `SUPPORTED_IR_VERSION`, `claude-code-cli`'s own `SUPPORTED_IR_VERSION`,
//! the Agent SDK back-end's `SUPPORTED_IR_VERSIONS`, and the Codex back-end's
//! `SUPPORTED_IR_VERSION`) that gate what a back-end accepts, four more
//! *advisory* copies baked into emitted artifacts (this crate's own
//! `MIN`/`MAX_SUPPORTED_IR_VERSION` in `emit.rs`, and the TS manifest's port of the same pair in
//! `manifest.ts`) that describe an artifact format's own compat window rather than gating input,
//! and the spec doc's title. Nothing regenerates any of them from a single source, so the lockstep
//! test below is the guard that keeps them from drifting apart silently — but it only reads *this*
//! crate's own `SUPPORTED_IR_VERSION`, not `claude-code-cli`'s; the two crates' tests together, not
//! either alone, pin all ten to the same value via the shared doc title. The second test proves an
//! out-of-range `warble_ir_version` is rejected before any bundle content is built — never silently
//! accepted and mislabeled as 0.3-compatible.

use warble_vercel::ir::WarbleIr;
use warble_vercel::{emit_vercel, TargetId, SUPPORTED_IR_VERSION};

const VERSION_MISMATCH_FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../conformance-fixtures/ir-version-mismatch.json"
);

fn load_ir(relative: &str) -> WarbleIr {
    let path = format!("{}/{relative}", env!("CARGO_MANIFEST_DIR"));
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {path}: {e}"))
}

/// Every `"..."`-quoted string on the line containing `needle`, in order. Deliberately extracts
/// *all* of them rather than just the first — `SUPPORTED_IR_VERSIONS` is declared as a single-
/// element array (`["0.3"]`) today, and a naive "take the first quoted string" extraction would
/// stay green even if the array were silently widened to `["0.3", "0.2"]` (the TS back-end would
/// then accept an extra version the other two back-ends reject, without this test noticing). The
/// caller asserts the count, not just the first value.
fn extract_all_quoted_after(haystack: &str, needle: &str) -> Vec<String> {
    let Some(line) = haystack.lines().find(|l| l.contains(needle)) else {
        return Vec::new();
    };
    let Some(after_needle) = line.find(needle).map(|i| &line[i + needle.len()..]) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut rest = after_needle;
    while let Some(start) = rest.find('"') {
        let tail = &rest[start + 1..];
        let Some(end) = tail.find('"') else { break };
        out.push(tail[..end].to_string());
        rest = &tail[end + 1..];
    }
    out
}

/// The single `"..."`-quoted value on the line containing `needle` — for the four *advisory*
/// `MIN_SUPPORTED_IR_VERSION`/`MAX_SUPPORTED_IR_VERSION` copies (this crate's own bundle compat
/// window, and its TS manifest port) and for `core`'s emitted `"warble_ir_version": "..."` literal,
/// all of which are plain string constants rather than arrays. Still asserts the count rather than
/// assuming it, so a future widening to a range is caught the same way `SUPPORTED_IR_VERSIONS` is
/// above, instead of only checking `[0]` and missing an extra element. `needle` must be specific
/// enough to skip past this file's own doc comments (e.g. `"const MIN_SUPPORTED_IR_VERSION"`, not
/// just `"MIN_SUPPORTED_IR_VERSION"` — a comment prose mention like
/// `` `MIN/MAX_SUPPORTED_IR_VERSION` `` would otherwise match first and has no quoted value on its
/// line).
fn extract_one_quoted_after(haystack: &str, needle: &str) -> String {
    let all = extract_all_quoted_after(haystack, needle);
    assert_eq!(
        all.len(),
        1,
        "expected exactly one quoted value on the line containing `{needle}` (found {all:?})"
    );
    all[0].clone()
}

/// The version token immediately after `needle` on the line containing it — keeps only the leading
/// run of version characters (digits/dots), dropping any surrounding markdown like `` `0.3`) ``.
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
fn ir_version_is_in_lockstep_across_rust_ts_and_doc() {
    let crate_dir = env!("CARGO_MANIFEST_DIR");

    // The producer: `core/src/compile.rs` is the one place that writes `warble_ir_version` into a
    // compiled IR. Everything else in this test asserts that *consumers* of that value agree with
    // each other; this assertion is what ties the agreed-upon value back to what `core` actually
    // emits. (`core/src/lib.rs`'s doctest and `core/tests/compile_tests.rs` also assert this same
    // literal — they aren't enumerated as separate lockstep copies because they self-guard: either
    // one fails loudly the moment `compile.rs` changes without a matching update there.)
    let core_src = std::fs::read_to_string(format!("{crate_dir}/../../core/src/compile.rs"))
        .expect("read core/src/compile.rs");
    let core_emitted = extract_one_quoted_after(&core_src, "\"warble_ir_version\":");
    assert_eq!(
        SUPPORTED_IR_VERSION, core_emitted,
        "core's emitted warble_ir_version literal has drifted from this back-end's enforced version — bump both together"
    );

    let ts_src = std::fs::read_to_string(format!("{crate_dir}/../claude-agent-sdk/src/ir.ts"))
        .expect("read TS ir.ts");
    let ts_versions = extract_all_quoted_after(&ts_src, "export const SUPPORTED_IR_VERSIONS");
    assert_eq!(
        ts_versions.len(),
        1,
        "TS SUPPORTED_IR_VERSIONS must declare exactly one supported version (found {ts_versions:?}) \
— this back-end's warble_ir_version contract is a single exact-match value, not a range; if TS ever \
needs to widen its accepted set, that is a deliberate cross-back-end version-support decision, not \
something to slip in silently"
    );
    let ts_version = ts_versions[0].clone();

    let doc = std::fs::read_to_string(format!("{crate_dir}/../../docs/spec/ir-schema.md"))
        .expect("read ir-schema.md");
    let doc_version =
        extract_after(&doc, "warble_ir_version:").expect("doc warble_ir_version in the title");

    assert_eq!(
        SUPPORTED_IR_VERSION, ts_version,
        "Rust and TS supported IR version disagree — bump both together"
    );

    let codex_src = std::fs::read_to_string(format!("{crate_dir}/../codex-local/src/ir.ts"))
        .expect("read Codex ir.ts");
    let codex_version = extract_one_quoted_after(&codex_src, "export const SUPPORTED_IR_VERSION");
    assert_eq!(
        SUPPORTED_IR_VERSION, codex_version,
        "Rust and Codex supported IR version disagree — bump both together"
    );
    assert_eq!(
        SUPPORTED_IR_VERSION, doc_version,
        "Rust const and docs/spec/ir-schema.md version disagree — bump both together"
    );

    // The enforcement constant above is the contract this crate validates *input* IRs against.
    // This crate and the TS manifest port separately declare an *advisory* compat window —
    // metadata baked into their emitted artifacts (this crate's bundle `compat` block, the TS
    // manifest's `compat` block) describing what that artifact format itself supports,
    // independent of the input IR's declared version. Nothing wires these to the enforcement
    // constant either; a bump that misses one of them ships a bundle or manifest that keeps
    // advertising a stale compat window to whatever downstream consumer reads it to decide
    // compatibility.
    let vercel_src = std::fs::read_to_string(format!("{crate_dir}/src/emit.rs"))
        .expect("read this crate's emit.rs");
    let vercel_min = extract_one_quoted_after(&vercel_src, "const MIN_SUPPORTED_IR_VERSION");
    let vercel_max = extract_one_quoted_after(&vercel_src, "const MAX_SUPPORTED_IR_VERSION");
    assert_eq!(
        SUPPORTED_IR_VERSION, vercel_min,
        "this crate's advisory MIN_SUPPORTED_IR_VERSION has drifted from the enforced IR version — bump both together"
    );
    assert_eq!(
        SUPPORTED_IR_VERSION, vercel_max,
        "this crate's advisory MAX_SUPPORTED_IR_VERSION has drifted from the enforced IR version — bump both together"
    );

    let ts_manifest_src =
        std::fs::read_to_string(format!("{crate_dir}/../claude-agent-sdk/src/manifest.ts"))
            .expect("read TS manifest.ts");
    let ts_manifest_min =
        extract_one_quoted_after(&ts_manifest_src, "const MIN_SUPPORTED_IR_VERSION");
    let ts_manifest_max =
        extract_one_quoted_after(&ts_manifest_src, "const MAX_SUPPORTED_IR_VERSION");
    assert_eq!(
        SUPPORTED_IR_VERSION, ts_manifest_min,
        "TS manifest's advisory MIN_SUPPORTED_IR_VERSION has drifted from the enforced IR version — bump both together"
    );
    assert_eq!(
        SUPPORTED_IR_VERSION, ts_manifest_max,
        "TS manifest's advisory MAX_SUPPORTED_IR_VERSION has drifted from the enforced IR version — bump both together"
    );
}

#[test]
fn emit_rejects_an_out_of_range_ir_version_explicitly() {
    let mut ir = load_ir("../../genbi-default/ir.golden.json");
    ir.warble_ir_version = "0.2".to_string();

    let tmp = tempfile::tempdir().expect("tempdir");
    let err = emit_vercel(&ir, TargetId::Headless, tmp.path(), &[])
        .expect_err("an out-of-range IR version must not silently emit");

    let message = err.to_string();
    assert!(
        message.contains("0.2"),
        "error should name the rejected version, got: {message}"
    );
    assert!(
        message.contains(SUPPORTED_IR_VERSION),
        "error should name the supported version, got: {message}"
    );
    assert!(
        !tmp.path().join("bundle.json").exists(),
        "a rejected version must not have written any bundle"
    );
}

#[test]
fn emit_rejects_the_shared_cross_back_end_version_mismatch_fixture() {
    let raw = std::fs::read_to_string(VERSION_MISMATCH_FIXTURE)
        .unwrap_or_else(|e| panic!("read {VERSION_MISMATCH_FIXTURE}: {e}"));
    let fixture: serde_json::Value = serde_json::from_str(&raw).expect("fixture is valid JSON");
    let ir: WarbleIr =
        serde_json::from_value(fixture["ir"].clone()).expect("fixture ir deserializes");
    let expected: Vec<&str> = fixture["expected_error_contains"]
        .as_array()
        .expect("expected_error_contains is an array")
        .iter()
        .map(|v| {
            v.as_str()
                .expect("expected_error_contains entries are strings")
        })
        .collect();

    let tmp = tempfile::tempdir().expect("tempdir");
    let err = emit_vercel(&ir, TargetId::Headless, tmp.path(), &[])
        .expect_err("the shared fixture's out-of-range version must not silently emit");

    let message = err.to_string();
    for substring in expected {
        assert!(
            message.contains(substring),
            "error should contain '{substring}', got: {message}"
        );
    }
}
