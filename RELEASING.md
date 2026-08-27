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
  [release procedure](#release-procedure): both npm packages must carry the Cargo workspace
  version, and must be publishable at all (not `private`, `publishConfig.access: public`, and
  `license`, `repository` and `files` present).

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
`x.y.0`) and both dispatchers' peer ranges move with it — this is one of the eighteen locations
`core/tests/ir_version_lockstep_tests.rs` checks (see
[`docs/spec/ir-schema.md`](docs/spec/ir-schema.md#ir-version-compatibility)), and it is separate
from, and does not replace, the shared-workspace-version bump described in the
[release procedure](#release-procedure) below. See also
["ir-spec version discipline"](#ir-spec-version-discipline).

## Release procedure

Versioning and tagging are automated by [release-please](https://github.com/googleapis/release-please)
(`.github/workflows/release-please.yml`, `release-please-config.json`,
`.release-please-manifest.json`). There is no manual version-bump command to run — the version
number, the changelog, and the tag are all derived from conventional commits on `main` and applied
by merging a bot-maintained pull request. `scripts/release-bump.mjs` (the hand-driven predecessor
to this flow) no longer exists.

1. **Decide nothing by hand — use the right commit type.** release-please computes the version
   from commit history, not from a human typing a number:
   - `fix:`, `perf:`, `refactor:`, and similar non-`feat` types bump the patch component.
   - `feat:` bumps the *minor* component even pre-1.0 (`bump-minor-pre-major: true` in
     `release-please-config.json`) — this workspace has not opted a `BREAKING CHANGE:` footer down
     to a patch bump either, so a breaking change also bumps minor, consistent with the
     [pre-1.0 policy](#pre-1.0) that any `0.x` bump is fair game for breaking changes.
   - Only commits whose paths fall under `packages/ir-spec/` affect that component's own version;
     everything else affects the shared workspace version. Both live in the same release pull
     request (`separate-pull-requests: false`), but they remain two independently computed version
     lines.
2. If the change touches the IR, follow the bump rule in
   [`docs/spec/ir-schema.md`](docs/spec/ir-schema.md#ir-version-compatibility) and touch every
   location it lists, including `packages/ir-spec/package.json`'s own version (IR `x.y` maps to npm
   `x.y.0` — never a nonzero patch). Type that commit `feat(ir-spec): ...` (or add a
   `BREAKING CHANGE:` footer) so release-please proposes the matching minor npm bump; never
   `fix(ir-spec): ...` alone for an actual IR change, since that would propose a patch bump instead.
   See ["ir-spec version discipline"](#ir-spec-version-discipline) for what happens if this is
   gotten wrong anyway.
3. Push conventional commits to `main` through the normal PR review flow. There is no separate
   "prepare a release" step: `release-please.yml` opens or updates a single release pull request
   after every push to `main`, accumulating every unreleased change into it.
4. Review the release PR before merging. Read the changelog it proposes (the `CHANGELOG.md` diff,
   and `packages/ir-spec`'s own changelog if that component changed) and confirm the proposed
   version bump matches what step 1–2 above intended. Update the
   [IR compatibility paragraph](#ir-version-vs-crate-version) in this document by hand when the
   release changes the IR — release-please has no way to know to do that.
5. **Do not merge a red release PR.** The same CI that gates every other pull request — `just
   lint`, `just test` (including `core/tests/ir_version_lockstep_tests.rs`), `just doc`, `just
   publish-check` (including `node scripts/check-release-surfaces.mjs`), and both TypeScript gate
   sets — runs on the release PR itself. A red `ir_version_lockstep_tests` run here is exactly the
   ["ir-spec version discipline"](#ir-spec-version-discipline) mechanism doing its job. Note how
   those checks get there: release-please opens the PR as `github-actions[bot]`, and GitHub will
   not fire `pull_request` workflows for it, so `ci.yml` also triggers on pushes to
   `release-please--**` and the run against the release branch head shows up on the pull request
   instead. No repository secret is involved — see the comment beside that branch pattern in
   `ci.yml`. If a release PR ever shows *no* checks at all, that is the signal that this wiring
   has broken; merging on that silence defeats the point of this step.
6. Merge the release PR as an ordinary merge (release-please's own commit message already
   summarizes the release; there is nothing to squash or reword). Merging:
   - Bumps every surface listed in `release-please-config.json`'s workspace `extra-files`
     (`Cargo.toml`, `Cargo.lock`, both dispatcher `package.json`/`package-lock.json` pairs) to the
     new workspace version, and `packages/ir-spec/package.json` to the new ir-spec version, in one
     commit. `node scripts/check-release-surfaces.mjs` (run as part of `just publish-check`) is what
     keeps that surface list itself complete — a newly added crate, internal path dependency, or
     dispatcher package that nobody adds to `extra-files` fails this check rather than bumping
     silently wrong.
   - Creates the corresponding tag(s): `vX.Y.Z` for the workspace always, and independently
     `ir-spec-vX.Y.Z` only in a release that also changed `packages/ir-spec` — it is release-please's
     own separately versioned component, matching this project's IR-package binding (a
     `peerDependencies` range, not a version pin — see
     [IR version vs. crate version](#ir-version-vs-crate-version)).
   - Triggers `.github/workflows/v-release.yml` (cargo-dist) on the `vX.Y.Z` tag push only. Its
     trigger pattern requires a literal leading `v` specifically so an `ir-spec-vX.Y.Z` tag push
     does not also spin up a Cargo/binary release for a TypeScript-only component — see
     ["Keeping cargo-dist's workflow generated"](#keeping-cargo-dists-workflow-generated) for how
     that is arranged without hand-editing generated output. cargo-dist then builds
     and uploads binary archives, checksums, the shell installer, and an npm-wrapper tarball to the
     GitHub Release; it does **not** publish any workspace crate or npm package to a registry.
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

   **On an IR bump this has to happen before the bump lands, not merely before the dispatchers
   publish.** The moment a dispatcher's peer range names a version that is not on the registry,
   `npm ci` fails for it — so the pull request that bumps the IR sits with red `install-ts` /
   `install-codex-ts` jobs until `@warble/ir-spec` is published, and its lockfiles cannot be
   regenerated either. Publish the spec package first, then regenerate both lockfiles in the bump
   change itself. Allow some lead time: a consumer running a minimum-release-age policy (pnpm's,
   for instance) will refuse a version published minutes earlier, so an IR bump whose spec package
   is seconds old can be uninstallable downstream even though every check here is green.

   ```bash
   (cd packages/ir-spec && npm publish --access public)
   ```

### ir-spec version discipline

`packages/ir-spec` is release-please's own component (`release-type: node`), so release-please
computes its proposed version from conventional commits scoped to that path exactly as it would for
any npm package — it has no idea that this particular package's version is supposed to equal
`warble_ir_version` mapped `x.y` -> `x.y.0`, and nothing stops a `fix(ir-spec): ...` commit (a
typo fix, a comment, a build-script tweak — none of which changed the IR) from proposing an
ordinary patch bump like `0.6.0` -> `0.6.1`.

That proposal does not ship unnoticed: `core/tests/ir_version_lockstep_tests.rs` asserts that
`packages/ir-spec/package.json`'s `"version"` field equals `warble_ir_version` mapped through the
same `x.y` -> `x.y.0` rule, and `cargo test` runs that assertion as part of `just test`, which runs
in CI on every pull request, **including the release PR itself** (see step 5 above). A release PR
that bumped `packages/ir-spec` to `0.6.1` without a corresponding `warble_ir_version` change fails
that test immediately — a patch-level ir-spec version is rejected before merge, not discovered
after a tag has already been pushed. This protection is only as good as step 5's CI-on-the-release-PR
guarantee, which in turn depends on the `RELEASE_PLEASE_TOKEN` repository secret existing (see
`.github/workflows/release-please.yml`) — without it this test still exists and still runs on
ordinary pull requests, but not on the release PR that would actually carry the bad version.

### Prerelease versions

**Prerelease releases (`-alpha`, `-beta`, `-rc`, etc.) are not supported end-to-end and have not
been dry-run against this configuration.** Neither package entry in `release-please-config.json`
opts into release-please's prerelease mode, so nothing here proposes a prerelease version on its
own. Until someone does the same dry-run verification for a prerelease flow that the stable flow
received (a disposable clone, `npx release-please release-pr --dry-run`, checked against this
repository's actual tag history and workspace shape), a releaser must not:

- Hand-push a tag like `v0.5.0-beta.1` expecting a safe, non-publishing dry run. It still matches
  `.github/workflows/v-release.yml`'s tag trigger (the trailing `*` in `v**[0-9]+.[0-9]+.[0-9]+*` matches
  a prerelease suffix too), and cargo-dist's own header comment says a prerelease-style suffix only
  changes whether the resulting GitHub Release is *labeled* prerelease — the full build-and-publish
  pipeline still runs.
- Manually edit a merged release PR's proposed version to add a prerelease suffix before merging,
  or hand-edit `.release-please-manifest.json` to a prerelease value between releases. Both leave
  release-please's next computed version out of sync with what actually shipped.

If a prerelease is genuinely needed, treat it as new work: verify it against a disposable clone
first, the way the three mechanisms this stable configuration relies on (workspace version
inheritance, tag topology, and ir-spec's IR-derived version) were each verified before being
committed here, and record the outcome in this section.

### Keeping cargo-dist's workflow generated

`.github/workflows/v-release.yml` is generated by `dist init` / `dist generate`. **Do not hand-edit
it.** cargo-dist's own `plan` job re-runs the generator and fails the build if the committed file
differs from what it would produce, so a hand edit is not merely fragile — it turns every pull
request red until it is reverted.

The tag trigger nevertheless has to require a literal leading `v`, so that pushing an
`ir-spec-vX.Y.Z` tag does not also start a Cargo and binary release for a TypeScript-only
component. That is arranged through configuration rather than editing: `tag-namespace = "v"` in
`dist-workspace.toml` makes the generator emit `'v**[0-9]+.[0-9]+.[0-9]+*'`. The tags this project
pushes are unchanged — they already begin with `v`.

Two consequences worth knowing. The setting also renames the generated workflow, which is why the
file is `v-release.yml` rather than `release.yml`; a regeneration writes the new name and leaves any
old one behind, so delete it by hand if that ever happens again. And `allow-dirty = ["ci"]` would
have been the other way to keep a hand edit — it silences the freshness check — but it also stops
cargo-dist updating the workflow at all, which trades a red build today for a workflow that quietly
rots across future cargo-dist upgrades.

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
