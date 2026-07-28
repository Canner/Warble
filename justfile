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
# every hardcoded docs/spec/*.md link's version tag matches [workspace.package] version.
doc:
    #!/usr/bin/env bash
    set -euo pipefail
    tmpdir=$(mktemp -d)
    trap 'rm -rf "$tmpdir"' EXIT
    RUSTDOCFLAGS="-D warnings" CARGO_TARGET_DIR="$tmpdir" cargo doc --workspace --no-deps
    version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
    mismatched=$(grep -rhoE 'https://github\.com/Canner/Warble/blob/v[^/]+/docs/spec/[A-Za-z0-9_.-]+\.md' \
        --include='*.rs' . | sort -u | grep -v "/v${version}/" || true)
    if [ -n "$mismatched" ]; then
        echo "error: docs/spec link tag != [workspace.package] version (v${version}):" >&2
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
