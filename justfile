# Warble — top-level dev tasks. All Rust (compiler, claude-code back-end, CLI, eval comparator, eval
# runner) is one Cargo workspace rooted here; Node is only needed for the claude-agent-sdk TS
# back-end and the docs site. Run `just <recipe>`.

# Build the whole Rust workspace.
build:
    cargo build --workspace --locked

# Test everything (compiler, claude-code back-end, eval comparator, CLI).
test:
    cargo test --workspace --locked

# Lint: clippy across the workspace + format check.
lint:
    cargo clippy --workspace --all-targets --locked -- -D warnings
    cargo fmt --all --check

# Format the Rust sources.
fmt:
    cargo fmt --all

# Rustdoc lint gate. Specification links use the stable canonical `main` URLs, so cutting a
# package release never requires editing distributed Rust source comments.
doc:
    #!/usr/bin/env bash
    set -euo pipefail
    tmpdir=$(mktemp -d)
    trap 'rm -rf "$tmpdir"' EXIT
    RUSTDOCFLAGS="-D warnings" CARGO_TARGET_DIR="$tmpdir" cargo doc --workspace --no-deps

# Synchronize every mechanical release-version surface and scaffold the dated changelog section.
# Release notes still require human curation after this command.
release-bump version date:
    node scripts/release-bump.mjs "{{version}}" "{{date}}"

release-bump-test:
    node --test scripts/release-bump.test.mjs

# Build the release `warble` binary.
release:
    cargo build --release --locked -p warble-cli

# Download and verify the pinned synthetic Driftwood base once, then print
# its content-addressed local cache path. Never falls back to generation.
driftwood-fixture:
    python3 examples/driftwood-wren/fixture.py fetch

# Structural pre-publish checks for all seven crates.io-bound crates (warble,
# warble-mdl-context, warble-claude-code, warble-vercel, warble-cli, warble-eval-compare,
# warble-eval-runner). `cargo publish --dry-run` can only validate `warble` itself before the
# others exist on the registry (their path+version deps on each other can't resolve
# pre-publish) — this recipe covers what `--dry-run` can't yet: every crate must be publishable
# to crates.io (`publish` unset, not `false` and not restricted to another registry); every
# internal path dependency carries a real version requirement (not just a bare path); and each
# carries the metadata crates.io requires.
publish-check:
    #!/usr/bin/env bash
    set -euo pipefail
    node --test scripts/release-bump.test.mjs
    publishable="warble warble-mdl-context warble-claude-code warble-vercel warble-cli warble-eval-compare warble-eval-runner"
    fail=0
    meta=$(cargo metadata --no-deps --format-version 1)

    # `cargo metadata`'s `publish` field is `null` when publishing is unrestricted (the only
    # shape that reaches crates.io), a list of registry names when restricted to specific
    # (non-crates.io) registries, or `[]` when `publish = false`. Both non-null shapes are
    # equally unpublishable to crates.io, so require exactly `null` rather than only excluding `[]`.
    echo "== every crate is publishable to crates.io (publish == null) =="
    for crate in $publishable; do
        pkg=$(echo "$meta" | jq -e --arg n "$crate" '.packages[] | select(.name == $n)')
        if ! echo "$pkg" | jq -e '.publish == null' > /dev/null; then
            echo "FAIL: $crate is not publishable to crates.io (publish = $(echo "$pkg" | jq -c '.publish'))" >&2
            fail=1
        fi
    done

    # Every internal (path) dependency must carry a real version requirement — a bare
    # `path = "..."` with no `version` strips to nothing resolvable once packaged, and that only
    # fails at actual `cargo publish` time. A missing version shows up here as `req == "*"`.
    # Path-only dev-dependencies are exempt: cargo strips dev-deps from the packaged manifest
    # entirely, so a bare path with no version there is legitimate (and already proven to
    # `cargo publish --dry-run` clean).
    echo "== internal path dependencies carry a real version requirement =="
    for crate in $publishable; do
        pkg=$(echo "$meta" | jq -e --arg n "$crate" '.packages[] | select(.name == $n)')
        bad=$(echo "$pkg" | jq -r '.dependencies[] | select(.path != null) | select(.kind != "dev") | select(.req == "*" or .req == null) | .name')
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

    # RELEASING.md's central promise is that the Cargo workspace, the binary, and both npm
    # packages carry ONE version and bump together. Until now nothing enforced the npm half of
    # that, so the two package.json files could silently drift from the workspace and a release
    # would ship a dispatcher whose version disagreed with the binary it is contracted to match.
    echo "== npm packages are version-locked to the Cargo workspace =="
    workspace_version=$(echo "$meta" | jq -r '.packages[] | select(.name == "warble-cli") | .version')
    for pkg_dir in dispatcher/claude-agent-sdk dispatcher/codex-local; do
        pkg_version=$(jq -r '.version' "$pkg_dir/package.json")
        if [ "$pkg_version" != "$workspace_version" ]; then
            echo "FAIL: $pkg_dir is $pkg_version, workspace is $workspace_version" >&2
            fail=1
        fi
    done

    # A package left `private` or without `publishConfig.access: public` cannot reach npm at all,
    # and a scoped package defaults to restricted — both fail only at publish time, which is the
    # worst moment to discover them. `packages/ir-spec` is included here even though it is exempt
    # from the Cargo-workspace version lockstep above: it still needs to be publishable.
    echo "== npm packages carry the metadata a public publish needs =="
    for pkg_dir in dispatcher/claude-agent-sdk dispatcher/codex-local packages/ir-spec; do
        if [ "$(jq -r '.private // false' "$pkg_dir/package.json")" != "false" ]; then
            echo "FAIL: $pkg_dir is marked private" >&2
            fail=1
        fi
        if [ "$(jq -r '.publishConfig.access // empty' "$pkg_dir/package.json")" != "public" ]; then
            echo "FAIL: $pkg_dir has no publishConfig.access = public" >&2
            fail=1
        fi
        for field in license repository files; do
            if [ -z "$(jq -r --arg f "$field" '.[$f] // empty' "$pkg_dir/package.json")" ]; then
                echo "FAIL: $pkg_dir is missing '$field'" >&2
                fail=1
            fi
        done
    done

    # packages/ir-spec/ir-schema.md is a bundled *snapshot* of docs/spec/ir-schema.md, not a link —
    # deliberately: the npm package's version is immutable once published, so a snapshot of the spec
    # as it stood at that IR version is worth more than a link to `main`, which points at whatever the
    # spec later became. But docs/spec/ir-schema.md is edited often (it's the IR spec itself), and
    # nothing else compares the two, so an edit there silently goes stale here and would be published
    # as the authoritative spec for that IR version. Catch it at the point that already validates the
    # package is fit to publish, since publishing is exactly when this drift becomes irreversible.
    echo "== packages/ir-spec/ir-schema.md matches docs/spec/ir-schema.md (bundled snapshot, not a link) =="
    if ! diff -q docs/spec/ir-schema.md packages/ir-spec/ir-schema.md > /dev/null; then
        echo "FAIL: packages/ir-spec/ir-schema.md has drifted from docs/spec/ir-schema.md" >&2
        echo "  fix: cd docs/site && npm run gen:reference (it syncs the snapshot)" >&2
        fail=1
    fi

    if [ "$fail" -ne 0 ]; then
        echo "publish-check: FAILED" >&2
        exit 1
    fi
    echo "publish-check: all checks passed"

# --- claude-agent-sdk back-end (TS/Node; not in the Cargo workspace) ---

sdk_dir := "dispatcher/claude-agent-sdk"

# Install the TS back-end's deps (npm ci: fails loudly on lockfile drift instead of silently
# rewriting package-lock.json to match a loosened package.json range).
install-ts:
    cd {{sdk_dir}} && npm ci

# Type-check the TS back-end (tsc --strict, no emit).
lint-ts:
    cd {{sdk_dir}} && npm run check-types

# Test the TS back-end (node:test; render test needs `just release` first).
test-ts:
    cd {{sdk_dir}} && npm test

# Build the TS back-end to dist/ (embeddable library + CLI bin).
build-ts:
    cd {{sdk_dir}} && npm run build

# --- Codex local back-end (TS/Node; standalone peer target) ---

codex_dir := "dispatcher/codex-local"

install-codex-ts:
    cd {{codex_dir}} && npm ci

lint-codex-ts:
    cd {{codex_dir}} && npm run check-types

test-codex-ts:
    cd {{codex_dir}} && npm test

build-codex-ts:
    cd {{codex_dir}} && npm run build
