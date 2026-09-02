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
`core/tests/ir_version_lockstep_tests.rs` checks (now also covering `@warble/cli`'s declarations,
via the checked-in `cli/npm-metadata.json` described below — see
[`docs/spec/ir-schema.md`](docs/spec/ir-schema.md#ir-version-compatibility)), and it is separate
from, and does not replace, the shared-workspace-version bump described in the
[release procedure](#release-procedure) below. See also
["ir-spec version discipline"](#ir-spec-version-discipline).

### Installing `warble`: shell installer vs. npm package

cargo-dist ships the `warble` binary two ways from the same release, and only one of them carries
the IR-version binding described above:

- **Shell installer** (`curl ... | sh`, pulling the install script from the GitHub Release). This
  puts the `warble` binary on `PATH` directly — there is no `package.json`, so there is nothing
  for a `peerDependencies` declaration to attach to. This route carries **no** IR-version binding.
  Anyone pinning IR compatibility this way has to compare the installed binary's own
  `warble_ir_version` (visible via its emitted IR, or a dispatcher's own compatibility check)
  against whatever dispatcher package they install alongside it, by hand.
- **npm package** (`@warble/cli`, published to the public npm registry — see step 8 below). This
  is cargo-dist's generated npm-wrapper package (`postinstall` downloads the platform binary from
  the release, the same as it always has), with `peerDependencies` on `@warble/ir-spec` and the
  advisory `"warble": { "irVersion": ... }` field merged in before publish, the same shape the two
  dispatcher packages already carry. This route **does** carry the binding.

  Installing `@warble/cli` alongside a dispatcher package whose declared `@warble/ir-spec` peer
  range doesn't overlap is what turns an IR mismatch into an **install-time** failure instead of a
  runtime one — but only to the extent the package manager in use enforces an unsatisfiable peer
  range as a hard failure by default, which is not universal:

  - **npm** (v7+, the default on this repository's own CI and in `publish-warble-*.yml`) installs
    peer dependencies automatically and fails the install outright on an unsatisfiable or
    conflicting peer range. No configuration is needed for the guarantee to hold.
  - **pnpm** does not fail, and `strictPeerDependencies` does not change that. Measured against
    the real published packages on pnpm 11: a conflicting `@warble/ir-spec` peer range is reported
    as `[WARN] Issues with peer dependencies found` and `pnpm add` exits 0 — with the setting off
    *and* with it on. Do not rely on it; the obvious configuration does not buy what its name
    suggests.

    What does work is a separate step: **`pnpm peers check` exits 1 on a conflicting tree and 0 on
    a clean one**, and names both sides of the conflict. A pnpm consumer wanting the guarantee npm
    gives for free should run it after install in CI.

    One trap if you do set the flag anyway: pnpm 11 reads it from `pnpm-workspace.yaml`
    (`strictPeerDependencies: true`), not from `.npmrc` — `pnpm config get
    strict-peer-dependencies` reports `undefined` for the `.npmrc` spelling.
  - **Yarn (Berry, v2+)** also does not fail by default — a peer conflict surfaces only as a
    `YN0002`/`YN0060` warning in `yarn install` output, and unlike pnpm, Yarn has no equivalent
    strict-mode setting that turns that warning into a nonzero exit code. Getting an install-time
    failure under Yarn currently means treating those warning codes as errors explicitly in
    whatever CI step runs the install — `set -o pipefail; yarn install --immutable 2>&1 | tee
    out.log; grep -qE 'YN0002|YN0060' out.log && exit 1` — not a single config value. Note the
    alternation: `YN000[26]0` matches `YN00020` and `YN00060`, neither of which exists, so a guard
    written that way never fires. And without `pipefail`, `$?` after the pipe is `tee`'s status,
    not Yarn's.

  **The npm and pnpm rows above are measured against the real published packages; the Yarn row is
  documented behaviour, not demonstrated.** The npm measurement has one caveat worth stating: the
  mismatched pair used to test it named an `@warble/ir-spec` version that does not exist on the
  registry, so npm failed with `ETARGET` rather than `ERESOLVE`. Both are hard failures, but a
  conflict between two ranges that are each individually satisfiable has still never been
  exercised — it needs a second IR version published, which has not happened.

  The older note that this contrast was undemonstrated no longer applies to npm and pnpm: `@warble/cli` is on the
  registry and both were measured against it.

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
   - `packages/ir-spec` is **not** a release-please component (`exclude-paths` in
     `release-please-config.json` keeps its commits out of the workspace version computation too,
     so a commit under `packages/ir-spec/` alone proposes no bump at all). Its version is a
     hand-maintained projection of `warble_ir_version`, set by hand in the same commit that changes
     the IR literal — see ["ir-spec version discipline"](#ir-spec-version-discipline).
2. If the change touches the IR, follow the bump rule in
   [`docs/spec/ir-schema.md`](docs/spec/ir-schema.md#ir-version-compatibility) and touch every
   location it lists, **by hand, in the same commit**, including `packages/ir-spec/package.json`'s
   own version (IR `x.y` maps to npm `x.y.0` — never a nonzero patch). release-please does not
   compute or propose this bump — see ["ir-spec version discipline"](#ir-spec-version-discipline)
   for the rule and the test that enforces it. The commit type (`feat:`, `fix:`, etc.) still follows
   step 1 for the *workspace* version as normal; it has no effect on `packages/ir-spec`.
3. Push conventional commits to `main` through the normal PR review flow. There is no separate
   "prepare a release" step: `release-please.yml` opens or updates a single release pull request
   after every push to `main`, accumulating every unreleased change into it.
4. Review the release PR before merging. Read the changelog it proposes (the `CHANGELOG.md` diff)
   and confirm the proposed version bump matches what step 1 above intended. If the change touched
   the IR, confirm `packages/ir-spec/package.json`'s version was already bumped by hand per step 2
   — release-please does not generate a changelog for it and will not catch a missed bump beyond
   what the lockstep test asserts. Update the
   [IR compatibility paragraph](#ir-version-vs-crate-version) in this document by hand when the
   release changes the IR — release-please has no way to know to do that.
5. **Do not merge a red release PR — or a checkless one.** The same CI that gates every other pull
   request — `just lint`, `just test` (including `core/tests/ir_version_lockstep_tests.rs`), `just
   doc`, `just publish-check` (including `node scripts/check-release-surfaces.mjs`), and both
   TypeScript gate sets — is meant to run on the release PR itself. A red
   `ir_version_lockstep_tests` run here is exactly the
   ["ir-spec version discipline"](#ir-spec-version-discipline) mechanism doing its job. It only gets
   there because `release-please.yml` passes the action a token backed by the
   `RELEASE_PLEASE_TOKEN` repository secret: GitHub does not fire `pull_request`-triggered
   workflows for anything a pull request opened with the default token, so without a real token
   the release PR would be the one pull request `ci.yml` never ran on (see the comment on the
   `token:` line in `release-please.yml`). That secret is provisioned outside this repository's
   own workflows and can lapse or go missing without any workflow turning red — release-please
   still opens the PR either way. Read "the release PR has checks on it" as the actual health
   signal for this credential; if a release PR ever shows *no* checks at all, that is the signal,
   and it means this step's guarantee currently does not hold — treat it as a stop, not as
   something to merge past.
6. Merge the release PR as an ordinary merge (release-please's own commit message already
   summarizes the release; there is nothing to squash or reword). Merging:
   - Bumps every surface listed in `release-please-config.json`'s workspace `extra-files`
     (`Cargo.toml`, `Cargo.lock`, both dispatcher `package.json`/`package-lock.json` pairs) to the
     new workspace version, in one commit. `packages/ir-spec/package.json` is **not** in that list
     and is not touched here — it must already carry the correct version by the time this PR is
     merged, set by hand per step 2. `node scripts/check-release-surfaces.mjs` (run as part of `just
     publish-check`) is what keeps the `extra-files` surface list itself complete — a newly added
     crate, internal path dependency, or dispatcher package that nobody adds to `extra-files` fails
     this check rather than bumping silently wrong.
   - Creates the workspace tag `vX.Y.Z`. There is no separate `ir-spec-vX.Y.Z` tag — `packages/ir-spec`
     is not a release-please component and never gets its own tag, matching this project's
     IR-package binding (a `peerDependencies` range, not a version pin — see
     [IR version vs. crate version](#ir-version-vs-crate-version)). release-please also creates a
     **draft** GitHub Release for the `vX.Y.Z` tag (`draft` / `force-tag-creation` in
     `release-please-config.json`) with the generated changelog as its notes — see the next bullet
     for why draft matters.
   - Triggers `.github/workflows/v-release.yml` (cargo-dist) on the `vX.Y.Z` tag push only — this
     fires at all only because the tag was pushed using the `RELEASE_PLEASE_TOKEN`-backed token
     rather than the default `GITHUB_TOKEN` (the same token-scoped recursion guard as step 5's
     checks; see the comment on the `token:` line in `release-please.yml`). The trigger pattern also
     requires a literal leading `v` specifically so an `ir-spec-vX.Y.Z` tag push does not also spin
     up a Cargo/binary release for a TypeScript-only component — see
     ["Keeping cargo-dist's workflow generated"](#keeping-cargo-dists-workflow-generated) for how
     that is arranged without hand-editing generated output, and for what `create-release = false`
     in the same file does with the draft release from the bullet above. cargo-dist builds and
     uploads binary archives, checksums, the shell installer, and an npm-wrapper tarball to that
     same release, then undrafts it; it does **not** publish any workspace crate or npm package to a
     registry.
7. **Publishing the seven crates to crates.io is automated.** Merging the release PR pushes to
   `main`, which is what `.github/workflows/release-please.yml` reacts to: once the release-please
   step reports the workspace (`.`) component created a release, its `publish-crates` job invokes
   `.github/workflows/publish-warble-crates.yml`. That workflow checks out the exact release tag
   and publishes `warble`, `warble-mdl-context`, `warble-claude-code`, `warble-vercel`,
   `warble-eval-compare`, `warble-eval-runner`, then `warble-cli` — one at a time, in that
   dependency order — using `cargo publish --locked --manifest-path <path>` and crates.io
   Trusted Publishing (OIDC; no static token). Before publishing each crate it checks whether that
   exact version is already on the registry (so a re-run after a partial failure does not re-attempt
   an already-published crate), and after publishing it polls the public crates.io API
   (`.github/scripts/wait-for-crate.sh`) until the new version actually resolves before moving on
   to the next crate — a successful `cargo publish` upload response alone is not treated as
   propagation evidence, matching this document's long-standing rule above. **A releaser's job is
   to watch this workflow run to green**, not to run any of these commands by hand.
8. **Publishing `@warble/ir-spec`, both dispatchers, and `@warble/cli` to the public npm registry
   is automated**, gated on the single workspace (`.`) component's release:
   - `.github/workflows/publish-warble-ir-spec.yml` (the `publish-ir-spec` job in
     `release-please.yml`) runs on every workspace release (not only one that changed the IR — see
     the workflow's own header comment for why: even a release that only bumps the dispatchers
     still needs to confirm the IR version they declare as a peer dependency actually exists on the
     registry). It publishes `@warble/ir-spec` only if its checked-out `package.json` version — set
     by hand per step 2 above, not computed by release-please — is not already resolvable on npm,
     then polls until it is, before the job is considered done.
   - `.github/workflows/publish-warble-npm.yml` runs once the workspace (`.`) component's release
     has been created **and** the `ir-spec` job above has succeeded — so a dispatcher never
     publishes while naming an IR peer version that isn't resolvable yet. It builds each
     dispatcher's `dist/` (`claude-agent-sdk` via `npm publish`'s own `prepublishOnly`, which
     re-runs its type check, build and tests unbypassed; `codex-local` explicitly via
     `just build-codex-ts`, since it has no `prepublishOnly`/`prepare` hook of its own), publishes
     each with the same already-published skip check.

     It does **not** apply the `ir-<x.y>` dist-tag. Trusted publishing authenticates `npm publish`
     and nothing else, so a dist-tag step would need a stored credential this pipeline
     deliberately does not have — and it would fail between the two dispatchers, leaving the
     second one unpublishable on every re-run. Apply the tag by hand after a release if you want
     it (`npm dist-tag add <pkg>@<version> ir-<x.y>`, with the IR version from that package's
     `warble.irVersion` field); it is a convenience for consumers tracking the IR line rather
     than the release line, and nothing depends on it.

   - `.github/workflows/publish-warble-cli.yml` runs under the same gate as
     `publish-warble-npm.yml` above (workspace component released, and `ir-spec` job succeeded
     first) — `@warble/cli` peer-depends on `@warble/ir-spec` the same way both dispatchers do, so
     it needs the same ordering. It differs from the dispatcher publish in one structural way:
     there is no checked-in `package.json` for `@warble/cli` to bump, because cargo-dist generates
     that package fresh at build time from the `warble-cli` crate (see the "Installing `warble`"
     section above). So this workflow runs `dist build --artifacts=global` to produce cargo-dist's
     generated npm-wrapper package, then runs `node scripts/patch-cli-npm-package.mjs` to merge in
     the `peerDependencies`/`warble.irVersion` fields from the checked-in `cli/npm-metadata.json`
     fragment — the same fragment `core/tests/ir_version_lockstep_tests.rs` checks against core's
     emitted IR version — **before** publishing. The patcher script refuses to run (and the
     workflow fails, rather than publishing an under-specified package) if cargo-dist's generated
     `package.json` doesn't match the expected name/version shape, or already carries either field
     from some future cargo-dist version. Same already-published skip check as the other two.

   The generated `warble-cli-npm-package.tar.gz` GitHub Release asset (cargo-dist's own build
   artifact, attached to the GitHub Release) and the `@warble/cli` npm-registry package published
   by `publish-warble-cli.yml` are two different things built from two different `dist build`
   invocations: the Release asset is whatever cargo-dist produced as part of the tag-triggered
   `v-release.yml` run, unpatched; the registry publish reruns `dist build --artifacts=global`
   independently inside `publish-warble-cli.yml` and patches that output before `npm publish` ever
   sees it. Don't confuse "the tarball is attached to the Release" with "the package carries the
   IR binding" — only the patched, separately-built copy that actually reaches the registry does.

   A releaser's job is to watch both workflow runs to green. **Registry lead time for
   `@warble/ir-spec` (AC#14):** some npm consumers (this repo's own `RELEASING.md` history
   surfaced pnpm's `minimumReleaseAge` supply-chain setting rejecting a version published only
   moments earlier as "immature") reject a dependency whose version was just published. When a
   release changes the IR, dispatch it by hand from **Actions → "Release Please" → Run workflow →
   tick `publish_ir_spec`**, against `main`, **at least 15 minutes before merging**
   the release PR that bumps the dispatchers' peer dependency to the new IR version. Fifteen
   minutes is comfortably longer than crates.io/npm CDN propagation lag and is a wait a human
   releaser can actually hold during a release, while still being enough separation to clear a
   `minimumReleaseAge` policy set in the tens-of-minutes range; raise it if a consumer's policy is
   known to require more. This step is optional — the automatic path above still publishes
   `@warble/ir-spec` at merge time if it wasn't pre-published — but skipping it means any
   `minimumReleaseAge`-gated consumer is blocked until that consumer's own window elapses on its
   own, off this project's schedule.

   **Credentials this automation needs (one-time setup, not run per release):**
   - A `crates-io` GitHub Environment on `Canner/Warble`, configured as each of the seven crates'
     crates.io Trusted Publisher (crate settings → Trusted Publishing → GitHub Actions → repo
     `Canner/Warble`, workflow **`release-please.yml`**, environment `crates-io`). No
     `CARGO_REGISTRY_TOKEN` secret is stored anywhere for this.
   - **npm trusted publishing**, configured per package on npmjs.com rather than as a stored
     token. All four packages — `@warble/ir-spec`, `@warble/claude-agent-sdk`,
     `@warble/codex-local`, `@warble/cli` — use organization `Canner`, repository `Warble`,
     workflow **`release-please.yml`**, no environment, and allow the `npm publish` action. No
     `NPM_TOKEN` secret is stored anywhere. `@warble/cli` registers exactly the same way as the
     other three despite having no checked-in `package.json` to point at on npmjs.com's
     registration form — the trusted-publisher relationship is keyed by package name plus
     repo/workflow, not by any file in the repository, so the absence of a committed
     `cli/package.json` has no bearing on it.

     **The workflow named is the caller, not the file containing `npm publish`.** Both registries
     read the filename out of the OIDC `workflow_ref` claim, and that claim always names the
     top-level workflow; a reusable workflow reached through `workflow_call` never appears in it.
     Registering `publish-warble-npm.yml` looks right and fails at publish time with `ENEEDAUTH`.
     This is also why the manual spec pre-publish is an input on `release-please.yml` rather than
     a second trigger on the workflow that does the publishing: each package accepts exactly one
     trusted publisher, so every path has to enter through the same top-level file.

     Two things bite here. npm does **not** validate a trusted publisher when you save it, so a
     typo surfaces only as `ENEEDAUTH` at publish time — the fields are case-sensitive and the
     workflow filename is the filename alone, extension included, no path. And trusted publishing
     needs npm 11.5.1 or newer, which is why both workflows upgrade npm before touching a package
     rather than trusting the runner image's bundled 10.x.

     A side effect worth knowing: publishing over OIDC from a public repository attaches
     provenance automatically, with no `--provenance` flag. That is desirable here and needs no
     action, but it does mean the published packages carry an attestation they did not before.
   - The existing `RELEASE_PLEASE_TOKEN` (see `release-please.yml`'s own comment) is unrelated to
     registry publishing but remains required for the release PR and tag to exist at all.

   Both npm packages already carry the release version by the time any of this runs; `just
   publish-check` fails the release earlier, before merge, if either has drifted from the Cargo
   workspace.

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

10. **Publishing the Hub component library archive to the GitHub Release is automated**, gated the
    same way `publish-crates` is (step 7 above): once release-please reports the workspace (`.`)
    component created a release, `release-please.yml`'s `publish-hub-asset` job invokes
    `.github/workflows/publish-warble-hub.yml`. That workflow checks out the release tag, packs
    `hub/components/` into `hub-<version>.tar.gz` (component directories at the top level —
    `answer_query/component.yml`, not `components/answer_query/component.yml` — so an explicit
    entry list is passed to `tar`, not `-C hub/components .`, which would otherwise add a leading
    `./` to every path), computes `hub-<version>.tar.gz.sha256` with `sha256sum -b` (the same
    `<hexdigest> *<filename>` binary-mode format every other checksum on this repo's releases
    uses — verify with `sha256sum -c hub-<version>.tar.gz.sha256`), and uploads both to the release
    with `gh release upload --clobber`, so a re-run after a partial failure overwrites cleanly
    instead of failing on "asset already exists".

    Unlike the crates/npm publishes above, this is not a registry publish and needs no Trusted
    Publisher setup or OIDC token — the archive is attached to the same GitHub Release cargo-dist
    (step 6) and the crates/npm workflows never touch. It also carries no independent version to
    bump: `hub/components/` has no checked-in manifest of its own (the same posture
    `cli/npm-metadata.json`-less `@warble/cli` npm-wrapper build has — see step 8), so
    `scripts/check-release-surfaces.mjs` has nothing to add here; the archive is keyed purely by
    the release tag it ships alongside. **A releaser's job is to confirm both `hub-<version>.tar.gz`
    and `hub-<version>.tar.gz.sha256` appear as assets on the published release**, not to build or
    upload them by hand.

### ir-spec version discipline

`packages/ir-spec` is **not** a release-please component: it has no entry under `packages` in
`release-please-config.json`, and the root `.` component's `exclude-paths` keeps commits under
`packages/ir-spec/` from affecting the workspace version either. Nothing about its version is
computed from conventional commits.

**`@warble/ir-spec`'s version changes only in the same commit that changes `warble_ir_version` in
`core/src/compile.rs`.** Bumping it is a manual edit to `packages/ir-spec/package.json` (IR `x.y`
maps to npm `x.y.0` — never a nonzero patch), made by the person or PR changing the IR literal, per
step 2 above. There is no commit-type trick (`feat(ir-spec):`, `fix(ir-spec):`, or otherwise) that
bumps it, because nothing reads that path for version computation.

This used to be release-please's job: an earlier version of this workflow declared `packages/ir-spec`
as its own independently versioned component, and release-please computed its version from
conventional commits scoped to that path like any other npm package. That component had no idea
this particular package's version was supposed to equal `warble_ir_version`, and nothing stopped an
unrelated `fix(ir-spec): ...` commit (a typo fix, a comment, a build-script tweak — none of which
changed the IR) from proposing an ordinary patch bump. That is exactly what happened in practice: a
docs-only change under `packages/ir-spec/` still got release-please to bump the component from
`0.6.0` to `0.7.0`, breaking the lockstep test on the resulting release PR. The component was
removed from `release-please-config.json` for this reason; see the git history of this file and of
`release-please-config.json` for that change.

The guard against getting the hand-edit wrong (forgetting it, or bumping ir-spec without an IR
change) is `core/tests/ir_version_lockstep_tests.rs`, which asserts that
`packages/ir-spec/package.json`'s `"version"` field equals `warble_ir_version` mapped through the
`x.y` -> `x.y.0` rule. `cargo test` runs that assertion as part of `just test`, which runs in CI on
every pull request, **including the release PR itself** (see step 5 above) — a release PR that
changed the IR without bumping `packages/ir-spec` (or vice versa) fails that test immediately,
before merge, not after a tag has already been pushed. This protection is only as good as step 5's
CI-on-the-release-PR guarantee, which in turn depends on the `RELEASE_PLEASE_TOKEN` repository
secret being current (see `.github/workflows/release-please.yml`) — if it lapses or is never
created, release-please still opens the release PR (it falls back to the default token), so this
failure mode is silent: the PR looks the same, it simply carries no checks, including this one.

### Adopting release-please: the ir-spec anchor tag

**Historical, and now permanently moot.** `packages/ir-spec` was a release-please component only
briefly; it has since been removed from `release-please-config.json` (see ["ir-spec version
discipline"](#ir-spec-version-discipline)) and, per the design this document describes, will not be
re-added — its version is a hand-maintained projection of the IR, not something release-please
computes. This section is kept as a record of the one-time adoption process below, in case a
similar anchor-tag situation ever arises for a *different* component; it does not describe anything
that still applies to `packages/ir-spec` today.

release-please computes each component's next proposed version from the tag it treats as that
component's last release. `packages/ir-spec` had already shipped npm versions before this workflow
existed (see [IR version vs. crate version](#ir-version-vs-crate-version)), but adopting
release-please for it starts from a git history with no `ir-spec-vX.Y.Z` tag anywhere in it to
anchor from. A real dry run against this branch (`npx release-please release-pr --dry-run`, before
`release-please-config.json` carried an anchor) showed exactly the resulting failure mode: alongside
a correct `warble` proposal, it proposed treating `packages/ir-spec`'s entire commit history as
unreleased and bumping it to a version well past `packages/ir-spec/package.json`'s actual current
value — which would have put the published package ahead of `warble_ir_version`, precisely the
mismatch the [ir-spec version discipline](#ir-spec-version-discipline) lockstep test above exists to
catch, and from the release tooling itself rather than from a stray commit.

The fix is a one-time tag, `ir-spec-v<current-package-version>`, matching `packages/ir-spec`'s
actual last-published version, pushed once to give release-please something to compute from. Once
it exists, every subsequent ir-spec version is computed from it exactly like any other component's
tag; it is not part of the ongoing release procedure above and is not pushed again.

**Pushing that tag is an outward-facing action on this repository's history, not an implementation
detail — creating and pushing it is handled separately from this packet, outside this document's
authorship.** What belongs here is the ordering trap: **this tag must be pushed only after the
`v-release.yml` rename (`tag-namespace = "v"`, see
["Keeping cargo-dist's workflow generated"](#keeping-cargo-dists-workflow-generated)) has landed on
`main`, never before.** Before that rename, cargo-dist's generated tag trigger matched any
semver-looking tag regardless of prefix, so pushing `ir-spec-v0.6.0` against the pre-rename trigger
would start a cargo-dist run that fails trying to resolve `ir-spec-v` as a package name — a broken
release run over what is supposed to be a quiet, one-time bookkeeping tag. Confirm the rename is
live on `main` (the trigger requires a literal leading `v` with nothing before it) before pushing
the anchor tag.

Pushing the tag does not, by itself, correct a release pull request that is already open. That PR
was computed before the tag existed and will keep proposing an `ir-spec` bump until something makes
release-please recompute — the next push to `main`, or re-running the Release Please workflow by
hand. Do that, then re-read the proposal, rather than assuming the tag fixed what you are looking
at.

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

A third `dist-workspace.toml` setting, `create-release = false`, changes what the generated `host`
job's final step does: instead of `gh release create` — which would fail outright, since a release
for that tag already exists by the time this workflow runs — it uploads build artifacts with
`gh release upload` and then undrafts the release with `gh release edit --draft=false`. This exists
specifically because release-please, not cargo-dist, owns creating the GitHub Release for each tag
(see step 6 above): without `create-release = false`, the two workflows would race to create the
same release and one of them would fail. It only works paired with release-please's `draft: true` /
`force-tag-creation: true` (`release-please-config.json`) — cargo-dist's own docs describe
`create-release = false` as expecting a pre-existing **draft** release with artifacts still to
attach, and `force-tag-creation` matters because GitHub does not create a draft release's tag until
the release is published, and release-please needs that tag to exist immediately to compute the
next version from it.

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
