# Warble — top-level dev tasks. All Rust (compiler, claude-code back-end, CLI, eval comparator)
# is one Cargo workspace rooted here; the eval runner is Node. Run `just <recipe>`.

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
