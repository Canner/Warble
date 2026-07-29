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

# Structural pre-publish checks for the crates.io-bound crates (warble, warble-mdl-context,
# warble-claude-code, warble-vercel, warble-cli). `cargo publish --dry-run` can only validate
# `warble` itself before the others exist on the registry (their path+version deps on each other
# can't resolve pre-publish) — this recipe covers what `--dry-run` can't yet: none of them may
# depend, even transitively or optionally, on an eval crate; every internal path dependency carries
# a real version requirement (not just a bare path); and each carries the metadata crates.io
# requires.
publish-check:
    #!/usr/bin/env bash
    set -euo pipefail
    publishable="warble warble-mdl-context warble-claude-code warble-vercel warble-cli"
    fail=0
    meta=$(cargo metadata --no-deps --format-version 1)

    # `cargo metadata --no-deps` reads dependency reqs straight off each crate's own manifest, so
    # a default-off `optional = true` dep on an eval crate shows up here even though it's invisible
    # to `cargo tree` without `--all-features` (an optional dep gated behind a feature isn't part of
    # the default dependency graph `cargo tree` walks).
    echo "== no eval-crate dependency, direct, regardless of optional/feature state =="
    for crate in $publishable; do
        pkg=$(echo "$meta" | jq -e --arg n "$crate" '.packages[] | select(.name == $n)')
        hits=$(echo "$pkg" | jq -r '.dependencies[] | select(.name | startswith("warble-eval")) | .name')
        if [ -n "$hits" ]; then
            echo "FAIL: $crate declares a dependency on an eval crate:" >&2
            echo "$hits" >&2
            fail=1
        fi
    done

    # Belt-and-suspenders: also walk the transitive graph with every feature turned on, so an eval
    # crate pulled in indirectly (via some other dependency's optional feature) is caught too, not
    # just a direct declaration on the crate itself.
    echo "== no eval-crate dependency, transitive, all features enabled =="
    for crate in $publishable; do
        deps=$(cargo tree -p "$crate" -e normal,build --all-features --prefix none | awk '{print $1}' | sort -u)
        hits=$(echo "$deps" | grep '^warble-eval' || true)
        if [ -n "$hits" ]; then
            echo "FAIL: $crate transitively depends on an eval crate (all-features):" >&2
            echo "$hits" >&2
            fail=1
        fi
    done

    # Every internal (path) dependency must carry a real version requirement — a bare
    # `path = "..."` with no `version` strips to nothing resolvable once packaged, and that only
    # fails at actual `cargo publish` time. A missing version shows up here as `req == "*"`.
    echo "== internal path dependencies carry a real version requirement =="
    for crate in $publishable; do
        pkg=$(echo "$meta" | jq -e --arg n "$crate" '.packages[] | select(.name == $n)')
        bad=$(echo "$pkg" | jq -r '.dependencies[] | select(.path != null) | select(.req == "*" or .req == null) | .name')
        if [ -n "$bad" ]; then
            echo "FAIL: $crate has internal path dependency(ies) with no version requirement:" >&2
            echo "$bad" >&2
            fail=1
        fi
    done

    echo "== required publish metadata present =="
    for crate in $publishable; do
        pkg=$(echo "$meta" | jq -e --arg n "$crate" '.packages[] | select(.name == $n)')
        for field in description repository license readme; do
            val=$(echo "$pkg" | jq -r --arg f "$field" '.[$f] // empty')
            if [ -z "$val" ]; then
                echo "FAIL: $crate is missing '$field'" >&2
                fail=1
            fi
        done
        if [ "$(echo "$pkg" | jq '.keywords | length')" -eq 0 ]; then
            echo "FAIL: $crate has no keywords" >&2
            fail=1
        fi
        if [ "$(echo "$pkg" | jq '.categories | length')" -eq 0 ]; then
            echo "FAIL: $crate has no categories" >&2
            fail=1
        fi
    done

    echo "== cargo package --list sanity =="
    for crate in $publishable; do
        if ! cargo package --list -p "$crate" --allow-dirty > /dev/null; then
            echo "FAIL: cargo package --list failed for $crate" >&2
            fail=1
        fi
    done

    if [ "$fail" -ne 0 ]; then
        echo "publish-check: FAILED" >&2
        exit 1
    fi
    echo "publish-check: all checks passed"

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
