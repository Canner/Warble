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
  number in the same release, even though neither is part of the Cargo workspace. `codex-local` is
  private today, but its package version remains part of the lockstep release contract.
- There is currently no automated check tying either npm package's version to the Cargo workspace
  version — keeping all three version declarations aligned is a step in the
  [bump procedure](#bump-procedure) below, not something CI enforces today.

This shared version communicates release cadence and compatibility as one unit, not per-crate
independence. It is the assumption a future cargo-dist–based release pipeline for this repository
is built around.

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

The IR (`warble_ir_version`, currently `0.5`) is a **separate version line from the crate/package
version above** — it is the wire contract between the compiler and any back-end, with its own
compatibility rules.

The full compatibility contract — which version each back-end accepts, how that agreement is
enforced and lockstep-tested, and the rule for when the IR version itself must change — is defined
once, in [`docs/spec/ir-schema.md`](docs/spec/ir-schema.md#ir-version-compatibility). This document
doesn't restate that definition; it only places it in the release picture.

The released `0.1.0` artifacts produce and expect `warble_ir_version 0.3`. The `0.2.0` artifacts
produce and expect `warble_ir_version 0.5`; saved IR, bundles, and manifests from `0.1.0` must be
regenerated before a `0.2.0` back-end will accept them.

An IR version bump and the workspace/package version bump **land together in one release change**.
The IR and package versions remain distinct contracts, but a changed IR may not ship under the same
workspace or TypeScript package version as an earlier IR.

## Bump procedure

1. Decide the new version per the pre-1.0 policy above (any `0.x` bump is fair game for breaking
   changes; use judgment on `x` vs. `y` in `0.x.y` to signal size of change to users, even though
   SemVer doesn't require it below `1.0.0`).
2. If the change touches the IR, follow the bump rule and touch every location listed in
   [`docs/spec/ir-schema.md`](docs/spec/ir-schema.md#ir-version-compatibility) — this includes
   regenerating any compiled artifact stored from a previous IR version. The IR bump and the version
   bumps in steps 3–4 must land together; do not leave an IR change at an existing release version.
3. Bump `[workspace.package].version` in the root `Cargo.toml`. Also update the pinned `version =`
   on each internal path dependency under `[workspace.dependencies]` — these are separate literal
   version requirements needed for publishing and are not derived automatically from
   `[workspace.package].version`.
4. Bump `version` in both `dispatcher/claude-agent-sdk/package.json` and
   `dispatcher/codex-local/package.json` to match.
5. Move the `## [Unreleased]` section in `CHANGELOG.md` to a new `## [x.y.z]` section dated for the
   release, and start a fresh empty `## [Unreleased]` above it. (For the first release, `v0.1.0`,
   there is nothing to move — that section already exists, undated, as noted at its top; just add the
   release date there and start the fresh `## [Unreleased]` section above it.)
6. Before tagging, build the release binary and run every package gate: `just lint`, `just test`,
   `just release`, `just doc`, `just publish-check`, `just install-ts`, `just lint-ts`,
   `just test-ts`, `just build-ts`, `just install-codex-ts`, `just lint-codex-ts`,
   `just test-codex-ts`, and `just build-codex-ts`. All must pass.
7. Tag the exact release commit and wait for the cargo-dist GitHub Release workflow to finish.
   cargo-dist builds and uploads binary archives, checksums, the shell installer, and an npm-wrapper
   tarball; it does **not** publish any workspace crate or npm package to a registry.
8. Publish the seven crates from that same tagged commit, one at a time in dependency order:
   `warble`, `warble-mdl-context`, `warble-claude-code`, `warble-vercel`,
   `warble-eval-compare`, `warble-eval-runner`, then `warble-cli`. Use
   `cargo publish --locked -p <package>` and wait until crates.io resolves the new version before
   publishing a dependent package. A successful upload response alone is not propagation evidence.
9. Publish a public npm package only when that release's approved scope explicitly includes it.
   The generated `warble-cli-npm-package.tar.gz` GitHub Release asset is not an npm-registry
   publication and does not change this gate.

### v0.2.0 publication scope

The `v0.2.0` release includes the private repository's cargo-dist GitHub Release and all seven Rust
crates on crates.io. Publishing `@warble/claude-agent-sdk`, `@warble/cli`, or any other npm package
is explicitly deferred, as is the fresh public-repository launch.
