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

The Rust workspace (all published crates), the `warble` binary, and the TypeScript back-end's npm
package share a single version number and bump together — there is one release, not one release
per artifact. Concretely:

- Every crate in the Cargo workspace uses `version.workspace = true` against the
  `[workspace.package]` version in the root `Cargo.toml`.
- The npm package `@warble/claude-agent-sdk` (`dispatcher/claude-agent-sdk/package.json`) is bumped
  to the same version number in the same release, even though it is not part of the Cargo
  workspace.
- There is currently no automated check tying the npm package's version to the Cargo workspace
  version — keeping them aligned is a step in the [bump procedure](#bump-procedure) below, not
  something CI enforces today.

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

The IR (`warble_ir_version`, currently `0.3`) is a **separate version line from the crate/package
version above** — it is the wire contract between the compiler and any back-end, and versions
independently of how often the surrounding crates release. The full compatibility contract —
which version each back-end accepts, how that agreement is enforced and lockstep-tested, and the
rule for when the IR version itself must change — is defined once, in
[`docs/spec/ir-schema.md`](docs/spec/ir-schema.md#ir-version-compatibility). This document doesn't
restate that definition; it only places it in the release picture: today, `warble_ir_version 0.3`
is what every crate at the current `0.1.0` workspace version produces and expects, and an IR bump
is recorded in `CHANGELOG.md` like any other change, but it is not, by itself, required to move the
crate version to a new minor or major number pre-1.0.

## Bump procedure

1. Decide the new version per the pre-1.0 policy above (any `0.x` bump is fair game for breaking
   changes; use judgment on `x` vs. `y` in `0.x.y` to signal size of change to users, even though
   SemVer doesn't require it below `1.0.0`).
2. If the change touches the IR, follow the bump rule and touch every location listed in
   [`docs/spec/ir-schema.md`](docs/spec/ir-schema.md#ir-version-compatibility) — this includes
   regenerating any compiled artifact stored from a previous IR version. Do this as its own step
   before the crate version bump below; the two are independent decisions that may or may not land
   in the same release.
3. Bump `[workspace.package].version` in the root `Cargo.toml`. Also update the pinned `version =`
   on each internal path dependency under `[workspace.dependencies]` — these are separate literal
   version requirements needed for publishing and are not derived automatically from
   `[workspace.package].version`.
4. Bump `version` in `dispatcher/claude-agent-sdk/package.json` to match.
5. Move the `## [Unreleased]` section in `CHANGELOG.md` to a new `## [x.y.z]` section dated for the
   release, and start a fresh empty `## [Unreleased]` above it.
6. Run `just lint`, `just test`, `just lint-ts`, `just test-ts`, `just doc`, and
   `just publish-check`; all must pass before tagging.
7. Tag the release and publish the crates and the npm package.
