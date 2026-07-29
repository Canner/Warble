# Warble — top-level dev tasks. All Rust (compiler, claude-code back-end, CLI, eval comparator, eval
# runner) is one Cargo workspace rooted here; Node is only needed for the claude-agent-sdk TS
# back-end and the docs site. Run `just <recipe>`.

# Build the whole Rust workspace.
build:
    cargo build

# Test everything (compiler, claude-code back-end, eval comparator, CLI).
test:
    cargo test

# Lint: clippy across the workspace + format check.
lint:
    cargo clippy --all-targets -- -D warnings
    cargo fmt --all --check

# Format the Rust sources.
fmt:
    cargo fmt --all

# Rustdoc lint gate (fresh target dir, so stale artifacts can't hide a warning) + a check that
# every hardcoded docs/spec/*.md link is pinned to [workspace.package] version (catches both a
# wrong tag and an unpinned ref like `main`/a branch name — either would 404 or silently drift on
# docs.rs, which keeps every published version's page forever).
doc:
    #!/usr/bin/env bash
    set -euo pipefail
    tmpdir=$(mktemp -d)
    trap 'rm -rf "$tmpdir"' EXIT
    RUSTDOCFLAGS="-D warnings" CARGO_TARGET_DIR="$tmpdir" cargo doc --workspace --no-deps
    # Extract `version` scoped to the `[workspace.package]` table only — a line-anchored
    # `version = "..."` search over the whole file would also match `[workspace.dependencies]`
    # entries if one is ever added above this table.
    version=$(awk '/^\[workspace\.package\]/{f=1; next} /^\[/{f=0} f' Cargo.toml \
        | sed -n 's/^version = "\(.*\)"/\1/p' | head -1)
    expected="v${version}"
    # Match *any* ref (not just `v...`), so an unpinned `blob/main/...` or branch-name URL is
    # caught and reported instead of silently passing through unmatched.
    mismatched=$(grep -rhoE 'https://github\.com/Canner/Warble/blob/[^/]+/docs/spec/[A-Za-z0-9_.-]+\.md' \
        --include='*.rs' . | sort -u | grep -vF "/${expected}/" || true)
    if [ -n "$mismatched" ]; then
        echo "error: docs/spec link ref != [workspace.package] version (${expected}):" >&2
        echo "$mismatched" >&2
        exit 1
    fi

# Build the release `warble` binary.
release:
    cargo build --release -p warble-cli

# --- claude-agent-sdk back-end (TS/Node; not in the Cargo workspace) ---

sdk_dir := "dispatcher/claude-agent-sdk"

# Install the TS back-end's deps.
install-ts:
    cd {{sdk_dir}} && npm install

# Type-check the TS back-end (tsc --strict, no emit).
lint-ts:
    cd {{sdk_dir}} && npm run check-types

# Test the TS back-end (node:test; render test needs `just release` first).
test-ts:
    cd {{sdk_dir}} && npm test

# Build the TS back-end to dist/ (embeddable library + CLI bin).
build-ts:
    cd {{sdk_dir}} && npm run build
