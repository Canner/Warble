//! MDL-version reverify — golden lifecycle (roadmap Phase 1.4 step 6).
//!
//! A golden's `context_version` pins the Wren fixture's schema+knowledge context it was confirmed
//! against. When the bound MDL changes, the golden's ground truth may have silently rotted. This module
//! computes the **git SHA of the bound MDL files** (host-side, content-addressed via
//! `git hash-object` — no ContextLoader, Phase-2-independent), compares it to the
//! golden's pin, and flags a mismatch as `stale`. Stale goldens can be re-stamped (accept the new
//! MDL) or re-verified (re-run to see which cases the MDL change actually moved).
//!
//! Only the MDL semantics travel into the SHA (`*.yml`/`*.yaml`/`*.md` under the project), so a pure
//! connection/credential edit that leaves the models untouched does not spuriously mark goldens stale.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Whether a golden's pinned `context_version` still matches the bound MDL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Freshness {
    /// Pin is a SHA and matches the current MDL SHA (exact or abbreviated prefix).
    Fresh,
    /// Pin is a SHA but the MDL has since changed — ground truth may have rotted.
    Stale,
    /// Pin is symbolic (not a SHA), so it can't be checked; stamp it to start tracking.
    Unpinned,
}

#[derive(Debug, Clone, Serialize)]
pub struct VerifyResult {
    pub freshness: Freshness,
    /// The pin recorded in the golden's `context_version` (the part after `@`, or the whole value).
    pub pinned: String,
    /// The dataset prefix (the part before `@`), when present.
    pub dataset: Option<String>,
    /// The freshly computed MDL SHA.
    pub current_sha: String,
    pub detail: String,
}

/// Split a `context_version` (`<dataset>@<pin>`) into its dataset prefix and pin. With no `@`, the
/// whole value is the pin and there is no dataset.
pub fn parse_context_version(cv: &str) -> (Option<String>, String) {
    match cv.split_once('@') {
        Some((dataset, pin)) => (Some(dataset.to_string()), pin.to_string()),
        None => (None, cv.to_string()),
    }
}

/// A pin looks like a git SHA when it is 7–64 hex chars (git's abbreviated..full range).
pub fn is_sha_like(pin: &str) -> bool {
    let len = pin.len();
    (7..=64).contains(&len) && pin.chars().all(|c| c.is_ascii_hexdigit())
}

/// Classify a pin against a freshly computed MDL SHA.
pub fn classify(pin: &str, current_sha: &str) -> Freshness {
    if !is_sha_like(pin) {
        Freshness::Unpinned
    } else if current_sha == pin || current_sha.starts_with(pin) {
        Freshness::Fresh
    } else {
        Freshness::Stale
    }
}

/// Collect the MDL files under `project` (`*.yml`/`*.yaml`/`*.md`), sorted by relative path, skipping
/// runtime dirs (`.git`, `.claude`, `.venv`) that are not part of the semantic definition.
fn mdl_files(project: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    collect(project, &mut out)?;
    out.sort();
    Ok(out)
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if matches!(name.as_ref(), ".git" | ".claude" | ".venv" | "node_modules") {
                continue;
            }
            collect(&path, out)?;
        } else if matches!(
            path.extension().and_then(|e| e.to_str()),
            Some("yml") | Some("yaml") | Some("md")
        ) {
            out.push(path);
        }
    }
    Ok(())
}

/// One `git hash-object <file>` blob SHA (content-addressed; works outside a repo, stable across
/// machines — the property we want for a pin).
fn blob_sha(file: &Path) -> Result<String, String> {
    let output = Command::new("git")
        .arg("hash-object")
        .arg(file)
        .output()
        .map_err(|e| format!("git hash-object {}: {e}", file.display()))?;
    if !output.status.success() {
        return Err(format!(
            "git hash-object {} failed: {}",
            file.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Hash an arbitrary string to a stable 40-hex git blob SHA (content-addressed; no repo needed).
/// Written via a temp file rather than a `--stdin` pipe, matching [`blob_sha`]. Shared by the MDL
/// SHA, the agent-artifact SHA, and the trace-cache key hash — same content → same hash on any
/// machine, which is exactly the property a cache key wants.
pub(crate) fn hash_str(s: &str) -> Result<String, String> {
    let tmp = tempfile::NamedTempFile::new().map_err(|e| format!("tempfile: {e}"))?;
    std::fs::write(tmp.path(), s).map_err(|e| format!("write hash input: {e}"))?;
    blob_sha(tmp.path())
}

/// Build a `<relpath> <blob-sha>\n` manifest over `files` (already sorted), relative to `root`.
fn file_manifest(root: &Path, files: &[PathBuf]) -> Result<String, String> {
    let mut manifest = String::new();
    for file in files {
        let rel = file.strip_prefix(root).unwrap_or(file);
        manifest.push_str(&format!("{} {}\n", rel.display(), blob_sha(file)?));
    }
    Ok(manifest)
}

/// Compute a single stable SHA over all MDL files: hash each file's content (git blob SHA), build a
/// sorted `<relpath> <sha>` manifest, and hash the manifest. Any content or path change moves it.
pub fn compute_mdl_sha(project: &Path) -> Result<String, String> {
    let files = mdl_files(project)?;
    if files.is_empty() {
        return Err(format!(
            "no MDL files (*.yml/*.yaml/*.md) under {}",
            project.display()
        ));
    }
    hash_str(&file_manifest(project, &files)?)
}

/// Compute a stable SHA over every file under `dir` (all extensions, recursive), the same way
/// [`compute_mdl_sha`] hashes MDL files. Used for the **agent-artifact SHA**: the dispatched agent
/// dir (`.claude/agents/*.md`, `settings.json`, `.mcp.json`, …) fully determines the agent's
/// behavior, so hashing it gives the `agent_sha` component of the trace-cache key — a change to any
/// emitted file (prompt, tier binding, settings) moves the SHA and correctly misses the cache.
pub(crate) fn compute_dir_sha(dir: &Path) -> Result<String, String> {
    let mut files = Vec::new();
    all_files(dir, &mut files)?;
    if files.is_empty() {
        return Err(format!("no files under {}", dir.display()));
    }
    files.sort();
    hash_str(&file_manifest(dir, &files)?)
}

/// Collect every regular file under `dir` recursively, skipping the same runtime dirs as
/// [`collect`] (`.git`, `.venv`, `node_modules`) so build/VCS noise stays out of the SHA.
fn all_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if matches!(name.as_ref(), ".git" | ".venv" | "node_modules" | "target") {
                continue;
            }
            all_files(&path, out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}

/// Verify a golden's `context_version` against the bound project's current MDL SHA.
pub fn verify_context(
    golden_context_version: Option<&str>,
    project: &Path,
) -> Result<VerifyResult, String> {
    let current_sha = compute_mdl_sha(project)?;
    let cv = golden_context_version.unwrap_or("");
    let (dataset, pinned) = parse_context_version(cv);
    let freshness = if cv.is_empty() {
        Freshness::Unpinned
    } else {
        classify(&pinned, &current_sha)
    };
    let detail = match freshness {
        Freshness::Fresh => format!("pin '{pinned}' matches current MDL SHA"),
        Freshness::Stale => format!(
            "pin '{pinned}' != current MDL SHA {current_sha} — MDL changed; ground truth may be stale"
        ),
        Freshness::Unpinned => {
            if cv.is_empty() {
                format!("golden has no context_version; current MDL SHA is {current_sha}")
            } else {
                format!("pin '{pinned}' is symbolic (not a SHA); current MDL SHA is {current_sha}")
            }
        }
    };
    Ok(VerifyResult {
        freshness,
        pinned,
        dataset,
        current_sha,
        detail,
    })
}

/// Rewrite a golden YAML's `context_version:` line to `<dataset>@<sha>`, preserving the dataset
/// prefix when the golden already had one (else falling back to `fallback_dataset`). Line-based so
/// comments and formatting survive. Returns the new document text.
pub fn stamp_context_version(
    golden_text: &str,
    sha: &str,
    fallback_dataset: Option<&str>,
) -> Result<String, String> {
    let mut lines: Vec<String> = golden_text.lines().map(str::to_string).collect();
    let idx = lines
        .iter()
        .position(|l| l.trim_start().starts_with("context_version:"));

    // Derive the dataset prefix from the existing value, else the golden's `dataset:`, else none.
    let existing_dataset = idx.and_then(|i| {
        let after = lines[i].split_once("context_version:")?.1.trim();
        // strip trailing inline comment
        let value = after
            .split_once('#')
            .map(|(v, _)| v.trim())
            .unwrap_or(after);
        parse_context_version(value).0
    });
    let dataset = existing_dataset.or_else(|| fallback_dataset.map(str::to_string));
    let new_value = match &dataset {
        Some(d) => format!("{d}@{sha}"),
        None => sha.to_string(),
    };
    let new_line = format!(
        "context_version: {new_value}      # stamped by `warble eval verify-context --stamp`"
    );

    match idx {
        Some(i) => lines[i] = new_line,
        None => {
            // Insert after `dataset:` if present, else at the top.
            let insert_at = lines
                .iter()
                .position(|l| l.trim_start().starts_with("dataset:"))
                .map(|i| i + 1)
                .unwrap_or(0);
            lines.insert(insert_at, new_line);
        }
    }
    Ok(format!("{}\n", lines.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parse_splits_dataset_and_pin() {
        assert_eq!(
            parse_context_version("jaffle_shop@a1b2c3d"),
            (Some("jaffle_shop".into()), "a1b2c3d".into())
        );
        assert_eq!(parse_context_version("bareword"), (None, "bareword".into()));
    }

    #[test]
    fn sha_like_detection() {
        assert!(is_sha_like("a1b2c3d")); // 7 hex
        assert!(is_sha_like("ce013625030ba8dba906f756967f9e9ca394464a")); // 40 hex
        assert!(!is_sha_like("frozen-poc")); // has '-'
        assert!(!is_sha_like("abc")); // too short
    }

    #[test]
    fn classify_fresh_stale_unpinned() {
        let sha = "ce013625030ba8dba906f756967f9e9ca394464a";
        assert_eq!(classify(sha, sha), Freshness::Fresh);
        assert_eq!(
            classify("ce01362", sha),
            Freshness::Fresh,
            "abbrev prefix matches"
        );
        assert_eq!(classify("deadbeef", sha), Freshness::Stale);
        assert_eq!(classify("frozen-poc", sha), Freshness::Unpinned);
    }

    #[test]
    fn mdl_change_moves_the_sha_and_marks_stale() {
        // The deliverable: an MDL edit must move the SHA → stale detection fires.
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("models")).unwrap();
        fs::write(
            dir.path().join("wren_project.yml"),
            "catalog: c\nschema: s\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("models/orders.yml"),
            "name: orders\ncolumns: [id, amount]\n",
        )
        .unwrap();

        let sha_before = compute_mdl_sha(dir.path()).unwrap();
        assert_eq!(sha_before.len(), 40, "40-hex git sha");

        // A pin equal to the pre-change SHA is Fresh…
        assert_eq!(classify(&sha_before, &sha_before), Freshness::Fresh);

        // …edit an MDL file…
        fs::write(
            dir.path().join("models/orders.yml"),
            "name: orders\ncolumns: [id, amount, discount]\n",
        )
        .unwrap();
        let sha_after = compute_mdl_sha(dir.path()).unwrap();
        assert_ne!(sha_before, sha_after, "MDL change must move the SHA");

        // …and the old pin is now Stale against the new MDL.
        let verify = verify_context(Some(&format!("jaffle@{sha_before}")), dir.path()).unwrap();
        assert_eq!(verify.freshness, Freshness::Stale);
        assert_eq!(verify.current_sha, sha_after);
    }

    #[test]
    fn adding_a_model_file_moves_the_sha() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.yml"), "x: 1\n").unwrap();
        let before = compute_mdl_sha(dir.path()).unwrap();
        fs::write(dir.path().join("b.yml"), "y: 2\n").unwrap();
        let after = compute_mdl_sha(dir.path()).unwrap();
        assert_ne!(before, after, "adding an MDL file changes the manifest SHA");
    }

    #[test]
    fn context_report_or_prompt_change_moves_the_agent_sha() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".claude/agents")).unwrap();
        fs::write(
            dir.path().join(".claude/agents/answer.md"),
            "Context injection mode: schema-only\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("context-report.json"),
            r#"{"mode":"schema-only"}"#,
        )
        .unwrap();
        let schema_only = compute_dir_sha(dir.path()).unwrap();

        fs::write(
            dir.path().join(".claude/agents/answer.md"),
            "Context injection mode: schema+knowledge\nRULE\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("context-report.json"),
            r#"{"mode":"schema+knowledge"}"#,
        )
        .unwrap();
        let with_knowledge = compute_dir_sha(dir.path()).unwrap();

        assert_ne!(
            schema_only, with_knowledge,
            "context identity must miss cache"
        );
    }

    #[test]
    fn stamp_rewrites_pin_preserving_dataset_and_comments() {
        let golden = "# header\ndataset: jaffle_shop\ncontext_version: jaffle_shop@frozen-poc   # pin\ncases: []\n";
        let stamped = stamp_context_version(golden, "abc1234def", None).unwrap();
        assert!(stamped.contains("context_version: jaffle_shop@abc1234def"));
        assert!(stamped.contains("# header"), "comments preserved");
        assert!(stamped.contains("cases: []"));
        assert!(!stamped.contains("frozen-poc"), "old pin replaced");
    }

    #[test]
    fn stamp_inserts_when_absent_using_fallback_dataset() {
        let golden = "dataset: shop\ncases: []\n";
        let stamped = stamp_context_version(golden, "abc1234", Some("shop")).unwrap();
        assert!(stamped.contains("context_version: shop@abc1234"));
    }
}
