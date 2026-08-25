//! The closed `llm_calls[].when.guard` vocabulary (`on_failure` / `on_flag` / `on_missing`) is
//! defined once, in `core::compile::GUARD_VOCABULARY`, and then re-declared independently by
//! every runtime consumer that must recognize it — dispatchers never depend on `warble`/`core`
//! (see the crate's `CLAUDE.md` invariant #1), so each copy is its own hand-maintained literal.
//! Nothing regenerates any of them from the one source, so today a copy can grow, shrink, or
//! rename a member and nothing goes red. This is the lockstep test that closes that gap, mirroring
//! `ir_version_tests.rs`'s approach for the IR version contract: read every copy's own source file
//! as text — via `std::fs`, never `include_str!` of a file outside this crate's package root,
//! which would break `cargo package`/`cargo publish` for these published crates — and assert they
//! all agree. Every comparison is a full-vector equality (order-insensitive, via a sorted
//! normalization), never a membership subset check, so a rename, a removal, *and* an addition are
//! all caught; checking only `contains("on_failure")` or only element `[0]` would stay green
//! through a silent widening, which is the false-green trap `ir_version_tests.rs`'s
//! `extract_all_quoted_after` doc already warns about.
//!
//! Eight independent representations are pinned here:
//!
//!  1. `core/src/compile.rs`'s `GUARD_VOCABULARY` array — the upstream source of truth.
//!  2. `dispatcher/vercel/src/emit.rs`'s (this crate's) own `GUARD_VOCABULARY` array copy.
//!  3. `dispatcher/claude-code-cli/src/conditional.rs`'s `evaluate_guard` match arms.
//!  4. ...that same file's "unknown guard" error-message prose list (`"closed vocabulary:
//!     on_failure, on_flag, on_missing"`) — a *second*, independent representation living beside
//!     #3 that could drift from it without `core` ever changing. Pinned both against `core` and
//!     directly against #3, so the pairing itself is enforced, not just each half separately.
//!  5. `dispatcher/claude-agent-sdk/src/conditional.ts`'s `evaluateGuard` switch cases.
//!  6. ...that file's thrown-error prose list — the TS mirror of #4, pinned the same way against
//!     #5.
//!  7. `docs/spec/ir-schema.md`'s `guard`/`target` table.
//!  8. `docs/spec/authoring.md`'s `when.guard`/`when.target` table.
//!
//! Excluded, deliberately: the prose mentions in `core/src/lib.rs`'s invariants doc comment and
//! `core/src/model.rs`'s `WhenGuard` doc comment. Both sit directly beside the code that *defines*
//! the vocabulary (`compile::GUARD_VOCABULARY` and the `WhenGuard` struct, respectively) inside the
//! same crate — a member rename there breaks compilation or leaves an obviously stale doc comment
//! in the very same diff, so they self-guard the same way `ir_version_tests.rs` excludes `core`'s
//! own doctest and `compile_tests.rs`. `docs/site/docs/reference/ir-schema.md` is excluded too: it
//! is generated from `docs/spec/ir-schema.md` by `npm run gen:reference` and already has its own
//! drift check (that generation step diffed against committed output), so pinning it here would be
//! pinning a derivative of #7, not an independent copy.

use std::path::Path;

/// Every `"..."`-quoted string on the line containing `needle`, in order. Deliberately extracts
/// *all* of them, not just the first, so a silently widened array (e.g. a fourth member appended)
/// is caught by a changed count rather than missed by only reading index `[0]`.
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

/// The leading `"..."`-quoted token on every line containing `line_marker`, in the order the lines
/// appear in the file. Used for match arms / switch cases spread across multiple lines, unlike the
/// single-line array constants above. `line_marker` must be specific enough to select only genuine
/// vocabulary arms and never an unrelated comparison that happens to mention the same guard name —
/// e.g. `" => Ok("` selects only `evaluate_guard`'s three match arms in `conditional.rs`, not the
/// `when.guard != "on_failure"` comparison a few lines below in the same file, which has no
/// `=> Ok(` on its line.
fn extract_quoted_tokens_on_lines_containing(haystack: &str, line_marker: &str) -> Vec<String> {
    haystack
        .lines()
        .filter(|l| l.contains(line_marker))
        .map(|l| {
            let start = l
                .find('"')
                .unwrap_or_else(|| panic!("no quoted token on line matching `{line_marker}`: {l}"));
            let tail = &l[start + 1..];
            let end = tail.find('"').unwrap_or_else(|| {
                panic!("unterminated quote on line matching `{line_marker}`: {l}")
            });
            tail[..end].to_string()
        })
        .collect()
}

/// The comma-separated bare-word list on the line containing `needle` (e.g. `on_failure, on_flag,
/// on_missing` inside `"... (closed vocabulary: on_failure, on_flag, on_missing)"`), with each
/// token trimmed of surrounding punctuation (quotes, backticks, parens, trailing commas) so it
/// works unmodified across both the Rust (`"..."`) and TS (`` `...` ``) string-literal syntaxes.
/// Used for the prose list inside each back-end's "unknown guard" error message — a second,
/// independent representation of the vocabulary living in the same file as its match/switch arms,
/// which could drift from those arms even when `core` never changes.
fn extract_csv_after(haystack: &str, needle: &str) -> Vec<String> {
    let line = haystack
        .lines()
        .find(|l| l.contains(needle))
        .unwrap_or_else(|| panic!("no line containing `{needle}`"));
    let after = &line[line
        .find(needle)
        .expect("needle is a substring of line by construction")
        + needle.len()..];
    after
        .split(',')
        .map(|tok| {
            tok.trim()
                .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

/// Every backtick-quoted `on_*` token appearing on or after the line containing `anchor`, up to
/// (not including) the next blank line — used for the two spec docs' three-row `guard`/`target`
/// tables, whose data rows are shaped like `` | `on_failure` | an upstream step name | ... | ``.
/// Filtering to tokens starting with `on_` skips the tables' own `` `guard` ``/`` `target` ``/
/// `` `when.guard` ``/`` `when.target` `` header cells without needing to hardcode a row count, so
/// a row added or removed still shows up as a token-count change here.
fn extract_backtick_on_tokens_from(haystack: &str, anchor: &str) -> Vec<String> {
    let lines: Vec<&str> = haystack.lines().collect();
    let start = lines
        .iter()
        .position(|l| l.contains(anchor))
        .unwrap_or_else(|| panic!("no line containing `{anchor}`"));
    let mut out = Vec::new();
    for line in &lines[start..] {
        if line.trim().is_empty() {
            break;
        }
        let mut rest = *line;
        while let Some(open) = rest.find('`') {
            let tail = &rest[open + 1..];
            let Some(close) = tail.find('`') else { break };
            let token = &tail[..close];
            if let Some(stripped) = token.strip_prefix("when.") {
                if stripped.starts_with("on_") {
                    out.push(stripped.to_string());
                }
            } else if token.starts_with("on_") {
                out.push(token.to_string());
            }
            rest = &tail[close + 1..];
        }
    }
    out
}

/// Sorted clone, for order-insensitive comparison — a copy re-declaring the same three members in
/// a different order isn't a drift this test cares about; a different *set* of members is.
fn sorted(v: &[String]) -> Vec<String> {
    let mut out = v.to_vec();
    out.sort();
    out
}

/// Asserts `actual` and `canonical` are the same set of guard names, and names the disagreeing
/// `label`, plus both sides' actual contents, on failure — someone hitting this in CI should not
/// have to go read this test to know what to fix.
fn assert_lockstep(label: &str, actual: &[String], canonical: &[String]) {
    assert_eq!(
        sorted(actual),
        sorted(canonical),
        "{label} has drifted from core::compile::GUARD_VOCABULARY (the upstream source of truth) — \
this copy has {actual:?}, core has {canonical:?}"
    );
}

fn read(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

#[test]
fn when_guard_vocabulary_is_in_lockstep_across_all_runtime_copies() {
    let crate_dir = env!("CARGO_MANIFEST_DIR");
    let root = Path::new(crate_dir).join("../..");
    let root = root.to_str().expect("repo root path is valid UTF-8");

    // 1. core: the upstream source of truth.
    let core_path = format!("{root}/core/src/compile.rs");
    let core_src = read(&core_path);
    let canonical = extract_all_quoted_after(&core_src, "const GUARD_VOCABULARY");
    assert_eq!(
        canonical.len(),
        3,
        "core/src/compile.rs's own GUARD_VOCABULARY should declare exactly 3 members, found {canonical:?} — \
if this is a deliberate vocabulary change, every independent copy this test pins must be updated in the same PR"
    );

    // 2. dispatcher/vercel (this crate)'s own copy.
    let vercel_path = format!("{crate_dir}/src/emit.rs");
    let vercel_src = read(&vercel_path);
    let vercel_copy = extract_all_quoted_after(&vercel_src, "const GUARD_VOCABULARY");
    assert_lockstep(
        &format!("{vercel_path}'s GUARD_VOCABULARY"),
        &vercel_copy,
        &canonical,
    );

    // 3 & 4. dispatcher/claude-code-cli: match arms, and the error-prose list, pinned against core
    // AND directly against each other (so that internal pair can't drift even if both happened to
    // drift from core in the same accidental way).
    let cli_path = format!("{root}/dispatcher/claude-code-cli/src/conditional.rs");
    let cli_src = read(&cli_path);
    let cli_arms = extract_quoted_tokens_on_lines_containing(&cli_src, "\" => Ok(");
    let cli_prose = extract_csv_after(&cli_src, "closed vocabulary: ");
    assert_lockstep(
        &format!("{cli_path}'s evaluate_guard match arms"),
        &cli_arms,
        &canonical,
    );
    assert_lockstep(
        &format!("{cli_path}'s \"unknown guard\" error-message vocabulary list"),
        &cli_prose,
        &canonical,
    );
    assert_lockstep(
        &format!(
            "{cli_path}: evaluate_guard's match arms vs its own \"unknown guard\" error-message list"
        ),
        &cli_arms,
        &cli_prose,
    );

    // 5 & 6. dispatcher/claude-agent-sdk (TS): switch cases, and the error-prose list, pinned the
    // same way.
    let ts_path = format!("{root}/dispatcher/claude-agent-sdk/src/conditional.ts");
    let ts_src = read(&ts_path);
    let ts_arms = extract_quoted_tokens_on_lines_containing(&ts_src, "case \"");
    let ts_prose = extract_csv_after(&ts_src, "closed vocabulary: ");
    assert_lockstep(
        &format!("{ts_path}'s evaluateGuard switch cases"),
        &ts_arms,
        &canonical,
    );
    assert_lockstep(
        &format!("{ts_path}'s \"unknown guard\" error-message vocabulary list"),
        &ts_prose,
        &canonical,
    );
    assert_lockstep(
        &format!(
            "{ts_path}: evaluateGuard's switch cases vs its own \"unknown guard\" error-message list"
        ),
        &ts_arms,
        &ts_prose,
    );

    // 7. docs/spec/ir-schema.md's `guard`/`target` table.
    let ir_schema_path = format!("{root}/docs/spec/ir-schema.md");
    let ir_schema_src = read(&ir_schema_path);
    let ir_schema_table =
        extract_backtick_on_tokens_from(&ir_schema_src, "| `guard` | `target` | Meaning |");
    assert_lockstep(
        &format!("{ir_schema_path}'s guard/target table"),
        &ir_schema_table,
        &canonical,
    );

    // 8. docs/spec/authoring.md's `when.guard`/`when.target` table.
    let authoring_path = format!("{root}/docs/spec/authoring.md");
    let authoring_src = read(&authoring_path);
    let authoring_table = extract_backtick_on_tokens_from(
        &authoring_src,
        "| `when.guard` | `when.target` | Meaning |",
    );
    assert_lockstep(
        &format!("{authoring_path}'s when.guard/when.target table"),
        &authoring_table,
        &canonical,
    );
}
