# Releasing

This document is Warble's external version contract: what a version number promises, what it
doesn't yet, and how a release is cut. It is aimed at anyone depending on Warble as a library, a
binary, or an IR consumer — not just at people cutting the release.

## Pre-1.0

Warble is pre-1.0 (`0.x`). Per [Semantic Versioning](https://semver.org/#spec-item-4), **nothing
is guaranteed stable while the major version is `0`** — any `0.x` → `0.(x+1)` bump may include
breaking changes to any public API, CLI flag, or file format, without a major version increment.
Once the project reaches `1.0.0`, ordinary SemVer guarantees apply going forward.

## One version, shared across the workspace

The Rust workspace (all published crates), the `warble` binary, and both TypeScript back-end npm
packages share a single version number and bump together — there is one release, not one release
per artifact. Concretely:

- Every crate in the Cargo workspace uses `version.workspace = true` against the
  `[workspace.package]` version in the root `Cargo.toml`.
- The npm packages `@warble/claude-agent-sdk` (`dispatcher/claude-agent-sdk/package.json`) and
  `@warble/codex-local` (`dispatcher/codex-local/package.json`) are both bumped to the same version
  number in the same release, even though neither is part of the Cargo workspace.
- `just publish-check` enforces that lockstep rather than leaving it to the
  [bump procedure](#bump-procedure): both npm packages must carry the Cargo workspace version, and
  must be publishable at all (not `private`, `publishConfig.access: public`, and `license`,
  `repository` and `files` present).

This shared version communicates release cadence and compatibility as one unit, not per-crate
independence. It is the assumption a future cargo-dist–based release pipeline for this repository
is built around.

### `@warble/ir-spec` is not part of this lockstep

`@warble/ir-spec` (`packages/ir-spec/package.json`) is a third TypeScript package, but it is
**deliberately excluded** from the shared-version rule above: its version *is* the IR version, not
the workspace version. See [IR version vs. crate version](#ir-version-vs-crate-version) below and
[`docs/spec/ir-schema.md`](docs/spec/ir-schema.md#ir-version-to-npm-version-mapping) for the mapping.
`just publish-check` validates that it is publishable (not `private`, `publishConfig.access:
public`, and `license`, `repository` and `files` present) the same way it does for the two
dispatchers, but it does **not** fold `@warble/ir-spec` into the Cargo-workspace-version lockstep
loop — asserting that would be wrong, since the two version lines move independently by design.

### The seven published crates

| Crate | What it is |
| --- | --- |
| `warble` | The front-end compiler (`core/`). |
| `warble-cli` | The `warble` binary (`compile · dispatch · render · manifest · eval · blast-radius · mcp-serve`). |
| `warble-mdl-context` | The semantic-layer context adapter. |
| `warble-claude-code` | The Claude Code CLI back-end. |
| `warble-vercel` | The Vercel back-end. |
| `warble-eval-compare` | Result-set comparison for eval scoring. |
| `warble-eval-runner` | The eval Pareto runner (golden-question replay + scoring). |

All seven share the workspace version and move together. **`warble-eval-runner`'s public API was
shaped for this repository's own eval tooling, not designed as a general-purpose library
interface** — expect it to change more readily than the others even within the pre-1.0 caveat
above. Treat it as the least stable of the seven if you depend on it directly.

## IR version vs. crate version

The IR (`warble_ir_version`, currently `0.6`) is a **separate version line from the crate/package
version above** — it is the wire contract between the compiler and any back-end, with its own
compatibility rules.

The full compatibility contract — which version each back-end accepts, how that agreement is
enforced and lockstep-tested, and the rule for when the IR version itself must change — is defined
once, in [`docs/spec/ir-schema.md`](docs/spec/ir-schema.md#ir-version-compatibility). This document
doesn't restate that definition; it only places it in the release picture.

The released `0.1.0` artifacts produce and expect `warble_ir_version 0.3`, the `0.2.0` artifacts
`0.5`, and the `0.3.0` artifacts `0.6`. Because back-ends exact-match the IR version, each of
those steps invalidates every stored artifact from the one before it: saved IR, bundles, and
manifests built by `0.2.0` must be regenerated before a `0.3.0` back-end will accept them, and
`0.1.0` artifacts likewise before `0.2.0`.

An IR version bump and the workspace/package version bump **land together in one release change**.
The IR and package versions remain distinct contracts, but a changed IR may not ship under the same
workspace or TypeScript package version as an earlier IR.

Both dispatchers declare a `peerDependencies` range on `@warble/ir-spec` (`0.6.x` today) plus an
advisory `"warble": { "irVersion": "0.6" }` field — so the IR a published dispatcher speaks is
visible in the npm dependency graph without opening the package. Neither dispatcher imports
`@warble/ir-spec`; it exists to be a resolvable npm node, not a runtime dependency. When
`warble_ir_version` changes, `@warble/ir-spec` gets its own new npm version (mapped `x.y` ->
`x.y.0`) and both dispatchers' peer ranges move with it — this is one of the sixteen locations
`core/tests/ir_version_lockstep_tests.rs` checks (see
[`docs/spec/ir-schema.md`](docs/spec/ir-schema.md#ir-version-compatibility)), and it is separate
from, and does not replace, the shared-workspace-version bump in step 3 of the
[bump procedure](#bump-procedure) below.

## Bump procedure

1. Decide the new version per the pre-1.0 policy above (any `0.x` bump is fair game for breaking
   changes; use judgment on `x` vs. `y` in `0.x.y` to signal size of change to users, even though
   SemVer doesn't require it below `1.0.0`).
2. If the change touches the IR, follow the bump rule and touch every location listed in
   [`docs/spec/ir-schema.md`](docs/spec/ir-schema.md#ir-version-compatibility) — this includes
   regenerating any compiled artifact stored from a previous IR version. The IR bump and the version
   bumps in steps 3–4 must land together; do not leave an IR change at an existing release version.
3. Run `just release-bump <version> <YYYY-MM-DD>`. The tested command synchronizes the workspace
   version, every internal path-dependency requirement, all seven workspace entries in `Cargo.lock`,
   both TypeScript package manifests and lockfiles, and the changelog heading/compare links. It
   validates every expected surface before writing, so a newly added package cannot produce a
   partial bump.
4. Curate the newly dated changelog section. The command moves the existing Unreleased content
   under the new version heading but cannot decide which changes are notable or how to explain
   compatibility. Update the IR compatibility paragraph above when the release changes the IR.
5. Before tagging, build the release binary and run every package gate: `just lint`, `just test`,
   `just release`, `just doc`, `just publish-check`, `just install-ts`, `just lint-ts`,
   `just test-ts`, `just build-ts`, `just install-codex-ts`, `just lint-codex-ts`,
   `just test-codex-ts`, and `just build-codex-ts`. All must pass.
6. Tag the exact release commit and wait for the cargo-dist GitHub Release workflow to finish.
   cargo-dist builds and uploads binary archives, checksums, the shell installer, and an npm-wrapper
   tarball; it does **not** publish any workspace crate or npm package to a registry.
7. Publish the seven crates from that same tagged commit, one at a time in dependency order:
   `warble`, `warble-mdl-context`, `warble-claude-code`, `warble-vercel`,
   `warble-eval-compare`, `warble-eval-runner`, then `warble-cli`. Use
   `cargo publish --locked -p <package>` and wait until crates.io resolves the new version before
   publishing a dependent package. A successful upload response alone is not propagation evidence.
8. Publish a public npm package only when that release's approved scope explicitly includes it.
   The generated `warble-cli-npm-package.tar.gz` GitHub Release asset is not an npm-registry
   publication and does not change this gate. When the scope does include them, publish both
   dispatchers from that same tagged commit, after their `dist/` is built by `just build-ts` and
   `just build-codex-ts`:

   ```bash
   (cd dispatcher/claude-agent-sdk && npm publish --access public)
   (cd dispatcher/codex-local && npm publish --access public)
   ```

   Neither dispatcher is an npm workspace member — this repository has no root `package.json` —
   so they publish from their own directory, the same way every `*-ts` recipe in the `justfile`
   drives them. Run the install recipes first: `claude-agent-sdk` has a `prepublishOnly` that
   re-runs its type check, build and tests, and it fails outright in a checkout whose
   `node_modules` is absent.

   Both carry the release version already; `just publish-check` fails the release if either has
   drifted from the Cargo workspace.

9. Publish `@warble/ir-spec` **before** either dispatcher, whenever its IR version has changed
   since the last publish (it is not part of every release — see the section above). Publish
   ordering matters here, not just tidiness: both dispatchers declare a `peerDependencies` range
   naming a specific `@warble/ir-spec` version, and an *unresolvable* peer (a version absent from
   the registry) is a hard install failure under every package manager's default configuration.
   `just publish-check` validates `packages/ir-spec/package.json` is publishable the same way it
   does for the dispatchers, but — deliberately — does not check it against the Cargo workspace
   version (see above).

   ```bash
   (cd packages/ir-spec && npm publish --access public)
   ```

### v0.4.0 publication scope

The `v0.4.0` release includes the private repository's cargo-dist GitHub Release, all seven Rust
crates on crates.io, and — for the first time — **both npm dispatchers**,
`@warble/claude-agent-sdk` and `@warble/codex-local`, on the public npm registry. This reverses the
deferral recorded for v0.2.0 and v0.3.0 below.

The reason is a consumer, not tidiness: GenBI's attested launch flow required a Warble git checkout
plus a Rust toolchain, because the dispatcher existed only as source. A published package is what
lets a GenBI developer install a version-pinned dispatcher instead of building one, and it makes a
version mismatch an install-time failure rather than something the launch gate discovers later.

`@warble/codex-local` was `private` until v0.4.0. It is published alongside its sibling so the
"one version, shared across the workspace" contract holds for every artifact it names, even though
GenBI's attested flow does not yet accept a Codex runtime.

The fresh public-repository launch remains deferred, unchanged by this entry.

### v0.3.0 publication scope

The `v0.3.0` release includes the private repository's cargo-dist GitHub Release and all seven
Rust crates on crates.io. Publishing `@warble/claude-agent-sdk`, `@warble/cli`, or any other npm
package remains deferred, as does the fresh public-repository launch.

### v0.2.0 publication scope

The `v0.2.0` release includes the private repository's cargo-dist GitHub Release and all seven Rust
crates on crates.io. Publishing `@warble/claude-agent-sdk`, `@warble/cli`, or any other npm package
is explicitly deferred, as is the fresh public-repository launch.
