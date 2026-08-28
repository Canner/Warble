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

/// An IR version must have exactly two numeric dot-separated components (`x.y`). A three-part
/// version (`x.y.z`) has no unambiguous npm mapping under the `x.y` -> `x.y.0` scheme this
/// workspace uses for `@warble/ir-spec`, so it is rejected here rather than silently truncated.
fn split_ir_version(ir_version: &str) -> (u32, u32) {
    let parts: Vec<&str> = ir_version.split('.').collect();
    assert_eq!(
        parts.len(),
        2,
        "IR version `{ir_version}` must have exactly two dot-separated components (major.minor); \
         a three-part version has no unambiguous `@warble/ir-spec` npm mapping"
    );
    let major: u32 = parts[0]
        .parse()
        .unwrap_or_else(|e| panic!("IR version `{ir_version}` major component: {e}"));
    let minor: u32 = parts[1]
        .parse()
        .unwrap_or_else(|e| panic!("IR version `{ir_version}` minor component: {e}"));
    (major, minor)
}

/// Maps an IR version `x.y` to the npm version `@warble/ir-spec` publishes as: `x.y.0`. The patch
/// component is always zero.
fn ir_version_to_npm_version(ir_version: &str) -> String {
    let (major, minor) = split_ir_version(ir_version);
    format!("{major}.{minor}.0")
}

/// Maps an IR version `x.y` to the npm peer-dependency range each dispatcher declares on
/// `@warble/ir-spec`: `x.y.x`.
fn ir_version_to_npm_peer_range(ir_version: &str) -> String {
    let (major, minor) = split_ir_version(ir_version);
    format!("{major}.{minor}.x")
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

    let npm_version = ir_version_to_npm_version(&emitted);
    let peer_range = ir_version_to_npm_peer_range(&emitted);

    let ir_spec_package = workspace_file("packages/ir-spec/package.json");
    assert_eq!(
        npm_version,
        extract_one_quoted_after(&ir_spec_package, "\"version\":"),
        "@warble/ir-spec's own npm version must be core's emitted IR version mapped x.y -> x.y.0"
    );

    let ir_spec_index = workspace_file("packages/ir-spec/index.js");
    assert_eq!(
        emitted,
        extract_one_quoted_after(&ir_spec_index, "export const IR_VERSION ="),
        "@warble/ir-spec's IR_VERSION constant must match core's emitted IR version"
    );

    // index.d.ts carries the same version as two literal *types*, not values — a JS consumer only
    // ever sees index.js's runtime value, so a stale literal here is invisible to anything except a
    // TS consumer's compiler, which would silently accept a wrong type instead of a wrong value.
    let ir_spec_types = workspace_file("packages/ir-spec/index.d.ts");
    assert_eq!(
        emitted,
        extract_one_quoted_after(&ir_spec_types, "export declare const IR_VERSION:"),
        "@warble/ir-spec's exported IR_VERSION type literal must match core's emitted IR version"
    );
    assert_eq!(
        emitted,
        extract_one_quoted_after(&ir_spec_types, "declare const _default: { IR_VERSION:"),
        "@warble/ir-spec's default-export IR_VERSION type literal must match core's emitted IR version"
    );

    for (dispatcher, source) in [
        (
            "claude-agent-sdk",
            "dispatcher/claude-agent-sdk/package.json",
        ),
        ("codex-local", "dispatcher/codex-local/package.json"),
        // `@warble/cli`'s npm package is generated by cargo-dist at release time (its
        // package.json is not checked in), so there is no dispatcher/*/package.json to read
        // here. cli/npm-metadata.json is the checked-in source of truth that
        // scripts/patch-cli-npm-package.mjs injects into the generated package.json before
        // publish, and it uses the exact same JSON shape -- so the same extraction helpers apply
        // unchanged.
        ("cli", "cli/npm-metadata.json"),
    ] {
        let package_json = workspace_file(source);
        assert_eq!(
            peer_range,
            extract_one_quoted_after(&package_json, "\"@warble/ir-spec\":"),
            "{dispatcher}'s peerDependencies range on @warble/ir-spec must match core's emitted IR version mapped x.y -> x.y.x"
        );
        assert_eq!(
            emitted,
            extract_one_quoted_after(&package_json, "\"irVersion\":"),
            "{dispatcher}'s advisory warble.irVersion field must match core's emitted IR version"
        );
    }
}
