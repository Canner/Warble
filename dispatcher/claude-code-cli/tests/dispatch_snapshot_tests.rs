//! The emitted-output snapshot gate.
//!
//! Dispatch decides what an agent *sees*: its system prompt, its inventory of siblings, its
//! permission envelope, the always-loaded project memory. A change to any of that changes the
//! agent's behavior — and until this file existed, nothing observed it. The accuracy suite is
//! filtered to profile/component/eval paths, so a dispatcher-only change never triggered it; lint,
//! test, doc and review can all be green while what the model reads changed underneath. That is
//! exactly how an always-loaded scope prompt reached every emitted agent directory unmeasured.
//!
//! So this asserts the whole emitted tree against a committed snapshot, byte for byte. It runs in
//! `just test` on every pull request — no path filter to get wrong, no credential, no model call.
//! It cannot say whether a change *helps*; it guarantees no such change lands silently. Deciding
//! whether a diff here warrants running the paid accuracy suite is then a human's call, made with
//! the diff in front of them.
//!
//! **When this test fails, read the diff before refreshing it.** A failure is the gate working: it
//! means the emitted context changed. Refresh deliberately with
//! `UPDATE_DISPATCH_SNAPSHOT=1 cargo test -p warble-claude-code --test dispatch_snapshot_tests`,
//! then commit the snapshot change in the same PR so a reviewer sees precisely what every future
//! agent will now read.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use warble_claude_code::ir::WarbleIr;
use warble_claude_code::{emit_claude_code, RenderFlavor};

const GENBI_DEFAULT_IR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../genbi-default/ir.golden.json"
);

fn snapshot_root(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/snapshots")
        .join(name)
}

/// Paths whose content is a property of *where* the output was written rather than of what was
/// emitted. Only the interactive launch spec qualifies: it records the canonical cwd, artifact root
/// and handoff path as absolute paths, by design — a caller needs them to start the session. Its
/// schema is pinned byte-for-byte by `cli/tests/native_interactive_dispatch.rs` instead.
const POSITION_DEPENDENT: &[&str] = &[".warble/interactive-launch.json"];

fn read_tree(root: &Path) -> BTreeMap<String, String> {
    fn walk(dir: &Path, base: &Path, into: &mut BTreeMap<String, String>) {
        let mut entries = fs::read_dir(dir)
            .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
            .map(|entry| entry.expect("dir entry").path())
            .collect::<Vec<_>>();
        entries.sort();
        for path in entries {
            if path.is_dir() {
                walk(&path, base, into);
                continue;
            }
            let relative = path
                .strip_prefix(base)
                .expect("path under base")
                .to_string_lossy()
                .replace('\\', "/");
            if POSITION_DEPENDENT.contains(&relative.as_str()) {
                continue;
            }
            let contents = fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            into.insert(relative, contents);
        }
    }
    let mut tree = BTreeMap::new();
    if root.is_dir() {
        walk(root, root, &mut tree);
    }
    tree
}

fn write_snapshot(root: &Path, tree: &BTreeMap<String, String>) {
    if root.exists() {
        fs::remove_dir_all(root).expect("clear stale snapshot");
    }
    for (relative, contents) in tree {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().expect("snapshot parent")).expect("create snapshot dir");
        fs::write(&path, contents).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
    }
}

/// Compare one dispatch against its snapshot, or rewrite the snapshot when explicitly asked.
fn assert_snapshot(name: &str, target: &str, flavor: RenderFlavor) {
    let raw = fs::read_to_string(GENBI_DEFAULT_IR).expect("read genbi-default golden IR");
    let ir: WarbleIr = serde_json::from_str(&raw).expect("golden IR deserializes");
    let out = tempfile::tempdir().expect("tempdir");
    emit_claude_code(&ir, out.path(), target, flavor).expect("emit succeeds");
    let emitted = read_tree(out.path());
    assert!(
        !emitted.is_empty(),
        "dispatch emitted nothing — the snapshot would pass vacuously"
    );

    let root = snapshot_root(name);
    if std::env::var_os("UPDATE_DISPATCH_SNAPSHOT").is_some() {
        write_snapshot(&root, &emitted);
        return;
    }

    let committed = read_tree(&root);
    assert!(
        !committed.is_empty(),
        "no committed snapshot at {} — create it with UPDATE_DISPATCH_SNAPSHOT=1",
        root.display()
    );

    let refresh = "UPDATE_DISPATCH_SNAPSHOT=1 cargo test -p warble-claude-code --test dispatch_snapshot_tests";
    let added: Vec<&String> = emitted
        .keys()
        .filter(|k| !committed.contains_key(*k))
        .collect();
    let removed: Vec<&String> = committed
        .keys()
        .filter(|k| !emitted.contains_key(*k))
        .collect();
    assert!(
        added.is_empty(),
        "dispatch now emits {added:?} into every {target} agent directory, which the snapshot has \
never seen. Every session in that scope will read it — confirm that is intended, then refresh:\n  \
{refresh}"
    );
    assert!(
        removed.is_empty(),
        "dispatch no longer emits {removed:?} for {target}; if that is intended, refresh:\n  {refresh}"
    );
    for (relative, committed_contents) in &committed {
        let emitted_contents = &emitted[relative];
        assert_eq!(
            committed_contents, emitted_contents,
            "the emitted content of {relative} changed for {target}. This is what every agent in \
that scope will read — review the change on its merits (and consider whether it warrants a manual \
accuracy run) before refreshing:\n  {refresh}"
        );
    }
}

/// The file target's full emitted tree: four component agents plus their per-step subagents, the
/// session envelope, the data-layer config, the scope prompt, the run document and both reports.
#[test]
fn headless_dispatch_output_matches_the_committed_snapshot() {
    assert_snapshot(
        "genbi-default-headless",
        "claude-code:headless",
        RenderFlavor::Programmatic,
    );
}

/// The same profile on the interactive target, which resolves capabilities differently — the render
/// contract degrades here, and the scope prompt and run document say so. A snapshot of only one
/// target would let the other's wording drift unobserved.
#[test]
fn interactive_dispatch_output_matches_the_committed_snapshot() {
    assert_snapshot(
        "genbi-default-interactive",
        "claude-code:interactive",
        RenderFlavor::Programmatic,
    );
}
