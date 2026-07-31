//! The core IR producer owns the workspace-wide IR-version compatibility contract.

use std::path::{Path, PathBuf};

fn workspace_file(relative: &str) -> String {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("core crate has a workspace parent");
    let path: PathBuf = workspace.join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// Every quoted string after `needle` on its declaration line. This catches an accidental widening
/// of the Agent SDK's accepted-version array as well as a mismatched value.
fn extract_all_quoted_after(haystack: &str, needle: &str) -> Vec<String> {
    let Some(line) = haystack.lines().find(|line| line.contains(needle)) else {
        return Vec::new();
    };
    let Some(after_needle) = line.find(needle).map(|index| &line[index + needle.len()..]) else {
        return Vec::new();
    };

    let mut values = Vec::new();
    let mut rest = after_needle;
    while let Some(start) = rest.find('"') {
        let tail = &rest[start + 1..];
        let Some(end) = tail.find('"') else {
            break;
        };
        values.push(tail[..end].to_string());
        rest = &tail[end + 1..];
    }
    values
}

fn extract_one_quoted_after(haystack: &str, needle: &str) -> String {
    let values = extract_all_quoted_after(haystack, needle);
    assert_eq!(
        values.len(),
        1,
        "expected exactly one quoted value after `{needle}` (found {values:?})"
    );
    values[0].clone()
}

fn extract_version_after(haystack: &str, needle: &str) -> String {
    let line = haystack
        .lines()
        .find(|line| line.contains(needle))
        .unwrap_or_else(|| panic!("find `{needle}`"));
    let after = line[line.find(needle).expect("needle is present") + needle.len()..]
        .trim()
        .trim_start_matches('`');
    let version: String = after
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == '.')
        .collect();
    assert!(!version.is_empty(), "extract version after `{needle}`");
    version
}

#[test]
fn emitted_ir_version_is_in_lockstep_with_dispatchers_docs_and_compat_metadata() {
    let core = workspace_file("core/src/compile.rs");
    let emitted = extract_one_quoted_after(&core, "\"warble_ir_version\":");

    let docs = workspace_file("docs/spec/ir-schema.md");
    assert_eq!(
        emitted,
        extract_version_after(&docs, "warble_ir_version:"),
        "the IR schema documentation must name core's emitted version"
    );

    for (dispatcher, source, declaration) in [
        (
            "claude-code-cli",
            "dispatcher/claude-code-cli/src/ir.rs",
            "pub const SUPPORTED_IR_VERSION",
        ),
        (
            "vercel",
            "dispatcher/vercel/src/emit.rs",
            "pub const SUPPORTED_IR_VERSION",
        ),
        (
            "codex-local",
            "dispatcher/codex-local/src/ir.ts",
            "export const SUPPORTED_IR_VERSION",
        ),
    ] {
        assert_eq!(
            emitted,
            extract_one_quoted_after(&workspace_file(source), declaration),
            "{dispatcher}'s enforced accepted IR version must match core's emitted version"
        );
    }

    let agent_sdk = workspace_file("dispatcher/claude-agent-sdk/src/ir.ts");
    let accepted = extract_all_quoted_after(&agent_sdk, "export const SUPPORTED_IR_VERSIONS");
    assert_eq!(
        accepted,
        vec![emitted.clone()],
        "claude-agent-sdk must enforce exactly core's emitted IR version"
    );

    for (artifact, source, declaration) in [
        (
            "vercel bundle",
            "dispatcher/vercel/src/emit.rs",
            "const MIN_SUPPORTED_IR_VERSION",
        ),
        (
            "vercel bundle",
            "dispatcher/vercel/src/emit.rs",
            "const MAX_SUPPORTED_IR_VERSION",
        ),
        (
            "claude-agent-sdk manifest",
            "dispatcher/claude-agent-sdk/src/manifest.ts",
            "const MIN_SUPPORTED_IR_VERSION",
        ),
        (
            "claude-agent-sdk manifest",
            "dispatcher/claude-agent-sdk/src/manifest.ts",
            "const MAX_SUPPORTED_IR_VERSION",
        ),
    ] {
        assert_eq!(
            emitted,
            extract_one_quoted_after(&workspace_file(source), declaration),
            "{artifact}'s advisory compatibility version must match core's emitted version"
        );
    }

    let codex_manifest = workspace_file("dispatcher/codex-local/src/manifest.ts");
    for field in [
        "min_ir_version: SUPPORTED_IR_VERSION",
        "max_ir_version: SUPPORTED_IR_VERSION",
    ] {
        assert!(
            codex_manifest.contains(field),
            "codex-local manifest compatibility metadata must reuse its enforced IR version ({field})"
        );
    }
}
