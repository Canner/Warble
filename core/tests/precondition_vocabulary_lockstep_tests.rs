//! The compiler owns the closed precondition vocabulary; the authoring spec must expose the same set.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn workspace_file(relative: &str) -> String {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("core crate has a workspace parent");
    let path: PathBuf = workspace.join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn compiler_vocabulary(source: &str) -> BTreeSet<String> {
    let marker = "const PRECONDITION_VOCABULARY: &[&str] = &[";
    let after_marker = source
        .split_once(marker)
        .unwrap_or_else(|| panic!("find `{marker}` in core/src/compile.rs"))
        .1;
    let array = after_marker
        .split_once("];")
        .unwrap_or_else(|| panic!("find closing `];` for `{marker}`"))
        .0;

    array
        .split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect()
}

fn documented_vocabulary(spec: &str) -> Vec<String> {
    let marker = "#### Authoritative predicate table";
    let table = spec
        .split_once(marker)
        .unwrap_or_else(|| panic!("find `{marker}` in docs/spec/authoring.md"))
        .1;

    table
        .lines()
        .skip_while(|line| !line.starts_with("| Predicate |"))
        .skip(2)
        .take_while(|line| line.starts_with('|'))
        .map(|line| {
            let predicate = line
                .split('|')
                .nth(1)
                .expect("predicate table row has a first cell")
                .trim()
                .strip_prefix('`')
                .and_then(|value| value.strip_suffix('`'))
                .unwrap_or_else(|| panic!("predicate cell must be backticked: {line}"));
            predicate.to_owned()
        })
        .collect()
}

#[test]
fn documented_precondition_vocabulary_is_in_lockstep_with_the_compiler() {
    let compiler = compiler_vocabulary(&workspace_file("core/src/compile.rs"));
    let documented_list = documented_vocabulary(&workspace_file("docs/spec/authoring.md"));
    let documented: BTreeSet<_> = documented_list.iter().cloned().collect();

    assert_eq!(
        documented.len(),
        documented_list.len(),
        "the authoritative predicate table contains duplicate entries: {documented_list:?}"
    );

    let missing_from_spec: Vec<_> = compiler.difference(&documented).cloned().collect();
    let absent_from_compiler: Vec<_> = documented.difference(&compiler).cloned().collect();
    assert!(
        missing_from_spec.is_empty() && absent_from_compiler.is_empty(),
        "PRECONDITION_VOCABULARY and docs/spec/authoring.md disagree; missing from spec: \
         {missing_from_spec:?}; absent from compiler: {absent_from_compiler:?}"
    );
}
