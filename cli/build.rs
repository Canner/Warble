//! Generates `EMBEDDED_HUB_FILES`, a compile-time snapshot of `cli/embedded-hub/` baked into the
//! `warble` binary via `include_bytes!`. This is what lets every distribution channel (npm, the
//! shell installer, GitHub Release archives, `cargo install warble-cli`) carry a working Hub
//! component library — see `cli/src/lib.rs`'s `hub_source_dir` for how it is used at runtime.
//!
//! `cli/embedded-hub/` is a checked-in copy of the top-level `hub/components/` (the single
//! source of truth); `scripts/check-embedded-hub.mjs` guards against the two drifting apart.
//!
//! Kept dependency-free (`std` only) deliberately: this is the first build script in the
//! workspace, and a build script is exactly the wrong place to introduce a new external crate
//! given the network restriction on fetching anything not already vendored/cached.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"));
    let embedded_hub_dir = manifest_dir.join("embedded-hub");

    let mut entries = Vec::new();
    collect_files(&embedded_hub_dir, &embedded_hub_dir, &mut entries);
    entries.sort();

    // Per-file `rerun-if-changed`, not just the directory: a content-only edit to an existing
    // embedded file doesn't reliably change the directory's own mtime, so without this a rebuild
    // could silently keep serving the previous content.
    for (_, abs_path) in &entries {
        println!("cargo:rerun-if-changed={abs_path}");
    }
    println!("cargo:rerun-if-changed={}", embedded_hub_dir.display());

    let mut code = String::new();
    code.push_str("pub(crate) static EMBEDDED_HUB_FILES: &[(&str, &[u8])] = &[\n");
    for (rel_path, abs_path) in &entries {
        code.push_str(&format!(
            "    ({rel_path:?}, include_bytes!({abs_path:?})),\n"
        ));
    }
    code.push_str("];\n");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by cargo"));
    fs::write(out_dir.join("embedded_hub.rs"), code).expect("failed to write embedded_hub.rs");
}

/// Recursively collects `(relative_path, absolute_path)` pairs for every file under `dir`,
/// relative to `root`. `rel_path` uses forward slashes even on Windows so the generated map keys
/// match the `Path`-joined lookups `cli/src/lib.rs` performs at runtime.
fn collect_files(root: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
    let entries =
        fs::read_dir(dir).unwrap_or_else(|e| panic!("failed to read {}: {e}", dir.display()));
    for entry in entries {
        let entry = entry.expect("failed to read embedded-hub dir entry");
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, out);
        } else {
            let rel = path
                .strip_prefix(root)
                .expect("walked path is under root")
                .to_string_lossy()
                .replace('\\', "/");
            out.push((rel, path.to_string_lossy().into_owned()));
        }
    }
}
