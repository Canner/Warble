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
