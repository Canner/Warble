# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/) once released (see [RELEASING.md](RELEASING.md)
for the pre-1.0 policy).

## [0.7.0](https://github.com/Canner/Warble/compare/v0.6.0...v0.7.0) (2026-09-01)


### ⚠ BREAKING CHANGES

* **cli:** fetch Hub components from a central release over the network ([#151](https://github.com/Canner/Warble/issues/151))

### Features

* **release:** attach Hub component library to GitHub Releases ([#149](https://github.com/Canner/Warble/issues/149)) ([858ccdb](https://github.com/Canner/Warble/commit/858ccdb15295dd74679e46ab5f90a8e9380e61e1))


### Bug Fixes

* **cli:** fetch Hub components from a central release over the network ([#151](https://github.com/Canner/Warble/issues/151)) ([437ec22](https://github.com/Canner/Warble/commit/437ec221152c32dae9abf80d5f44c58b924f1ffa))
* make monitor_freshness's assess_severity step reachable ([#148](https://github.com/Canner/Warble/issues/148)) ([d2a282c](https://github.com/Canner/Warble/commit/d2a282c7cb0a4c169b471fcadd6f10800318ba10))

## [0.6.0](https://github.com/Canner/Warble/compare/v0.5.1...v0.6.0) (2026-08-28)


### Features

* **release:** publish @warble/cli to npm with the IR-version binding ([#144](https://github.com/Canner/Warble/issues/144)) ([3b56389](https://github.com/Canner/Warble/commit/3b563892d945a119cffa6d439b3486ec45de6f44))


### Bug Fixes

* **ci:** an expression in an input description made GitHub reject the workflow ([#145](https://github.com/Canner/Warble/issues/145)) ([f686a42](https://github.com/Canner/Warble/commit/f686a42dab320cd4acf5da34d9ec3aef8774de42))

## [0.5.1](https://github.com/Canner/Warble/compare/v0.5.0...v0.5.1) (2026-08-28)


### Bug Fixes

* **release:** make the release PR title parseable back into a release ([#140](https://github.com/Canner/Warble/issues/140)) ([c05d784](https://github.com/Canner/Warble/commit/c05d7845605ca4d486b47af2cc3d2783e9752a57))
* **release:** stop naming a component the grouped release branch cannot carry ([#141](https://github.com/Canner/Warble/issues/141)) ([3e82419](https://github.com/Canner/Warble/commit/3e824190647ca0df3897db36e5d9db162f3a234f))

## [0.5.0](https://github.com/Canner/Warble/compare/v0.4.0...v0.5.0) (2026-08-27)


### Features

* **dispatch:** let a native session enter at the scope instead of one agent ([#134](https://github.com/Canner/Warble/issues/134)) ([8746a25](https://github.com/Canner/Warble/commit/8746a25a858181b4cdac42c4354001b424d00c89))
* **ir-spec:** publish the IR version as its own npm package ([#136](https://github.com/Canner/Warble/issues/136)) ([7b4108d](https://github.com/Canner/Warble/commit/7b4108dcf1bea4b0e9111d91769d7cadb2dccfd9))

## [Unreleased]

## [0.4.0] - 2026-08-26

### Changed

- **BREAKING — the native session entry is declared by the caller, not chosen by a built-in table;
  `NATIVE_SCOPE_VERSION` is now `3`.** The dispatcher previously recognized its consumers by name:
  an internal table listed which profiles were dispatchable and which verb was each one's entry
  point. A product-neutral dispatcher cannot dispatch a profile it has never been told about, and a
  consumer renaming its own component broke it. The caller now names the entry in the session scope
  descriptor and the dispatcher validates it structurally against the compiled IR.

  A scope descriptor written by a `0.3.0` host is rejected loudly at preflight. Hosts must emit
  `version: "3"` and carry the entry themselves. The `welcome_prompt()` hook and the profile-name
  and entry-verb allowlists are gone with it.

### Removed

- **The bundled product profiles are no longer part of this repository.** The four `genbi-*`
  profiles have moved to their consuming product's own repository, per the repo-topology rule that
  product profiles belong to the product and only generic components stay in the Hub. `hub/` is
  unchanged — no component was moved or deleted — and every profile still compiles unmodified from
  wherever it now lives.

  If you depended on a profile directory in this repository, point at the consumer's copy instead.
  Nothing about the profile format changed.

### Added

- **Conformance fixtures the framework owns.** Dispatcher conformance was previously anchored on a
  consumer's flagship profile, so this repository's own tests could not survive that profile leaving.
  `examples/analysis-agent` gives the Hub a multi-component base, and `examples/provision-agent` and
  `examples/propose-apply-agent` cover the setup and enrichment shapes with their own realization-kind
  mixes. `examples/monitor-agent` now also serves as the scheduled/assertive fixture.

- **Both TypeScript back-ends are publishable, and the version lockstep is enforced.**
  `@warble/codex-local` is no longer `private`, and `just publish-check` now fails the release if
  either dispatcher's manifest has drifted from the Cargo workspace version, or if either is missing
  `publishConfig.access`, `license`, `repository` or `files`. See `RELEASING.md` for which artifacts
  a given release's approved scope actually publishes.

- **`llms.txt` for the documentation site**, generated from every page's frontmatter so AI tooling
  has a single index of the docs.

### Fixed

- **`warble dispatch` no longer fails when an interactive output root does not yet exist** — the
  missing directory is created rather than reported as an error.

## [0.3.0] - 2026-08-24

### Added

- **Differentiated per-tier model binding in `warble eval run`** — `--models-config` plus inline
  `--strong` / `--cheap` / `--orchestrator`, matching `warble dispatch`'s own flag names and
  precedence. Eval could previously bind one model to all three LLM tiers or none, so on a back-end
  that dispatches live from IR (`claude-agent-sdk`) every strong step silently ran on the same model
  the flat binding named. The resolved binding threads through to the back-end adapter as a
  first-class flat-or-tiered override.

- **A `--max-turns` knob for the SDK back-end**, so turn count can be isolated as a variable when
  comparing back-ends with different defaults. The trace cache key grows only when the flag is
  present, keeping existing uncapped entries valid, and the flag loud-fails against a back-end with
  no turn-budget knob rather than being silently ignored.

- **Output-level instability, not just verdict flips.** Repeated sampling now reports an
  `output_unstable_cases` aggregate distinct from `flaky_cases`, and surfaces the answer
  distribution for output-unstable cases too — a question that returns a different wrong answer
  every run but never flips its (failing) verdict was previously invisible. On the one repeated-
  sampling dataset available, verdict flips were 1/15 while output divergence was 5/15.

- **Ask components on the `codex-local` back-end** in eval, with table rows normalized before
  comparison so formatting differences don't read as wrong answers.

### Removed

- **`config.tier_policy` — removed, and `warble_ir_version` bumped to `0.6`.** The profile-level
  `config` block no longer accepts `tier_policy`, and the IR emits `"config": {}`. The field was
  inert: no back-end ever read it, its value was never validated against any vocabulary, and
  compiling the same profile with `cost_sensitive`, `null`, or an invented string produced
  byte-identical dispatch output — so a profile declaring it advertised cost control it did not
  have. All eleven bundled profiles dropped the key; none changes behavior.

  It was removed rather than wired up because the rule it needs does not exist and the obvious
  rule is measurably wrong: eval shows a blanket downgrade of `answer_query` is free on a clean
  schema (no accuracy lost, ~3× cheaper) and costly on a messy one (execution accuracy 0.93 →
  0.60). Which steps are safe to downgrade is a property of the bound context, not of the profile.
  Use a mount's `tier_overrides` for per-step control; see `docs/spec/ir-schema.md`
  (`config` — emptied in 0.6) for the full rationale.

  The `config` block itself stays, empty, so future profile-level config is an additive change
  rather than the reintroduction of a removed key.

- **Every stored `0.5` artifact must be regenerated.** Per the IR version contract, back-ends
  exact-match `warble_ir_version`: a committed `ir.golden.json`, `vercel` bundle, or `codex-local`
  manifest built against `0.5` is now rejected loudly at load time. All in-tree goldens, fixtures,
  bundles, and manifests are regenerated in this change.

### Fixed

- **A per-step LLM tier is now honored regardless of realization kind.** `llm:per_step_tier` was
  derived only when a component's `realization_kind` was `skill`, so a `gated-tool` or `tool`
  component declaring divergent step tiers had its authored tiers silently collapsed by every
  back-end — 3 of the 8 shared hub components (`bootstrap_mdl`, `edit_pipeline`,
  `enrich_knowledge`) were affected in practice. Both the capability derivation and the per-step
  split predicate are now driven purely by IR shape in all three back-ends.

- **A failed `claude-code-cli` eval invocation says why it failed.** The adapter collapsed "the
  process never started" and "the process exited non-zero" into an empty reason, discarding the
  spawn error and the CLI's stderr. An environment failure — an expired credential, a binary
  missing from the run PATH, a refused workspace — therefore reached the committed report as every
  case scoring 0.000 against a 1.000 baseline, indistinguishable from the model answering
  everything wrong, with the actual cause recorded nowhere.

- **The bundled jaffle example declares its three relationships again.** Its `relationships.yml`
  was still the original bare list, and the two shapes do not degrade equally against the `wren`
  CLI's keyed `relationships:` mapping: an older CLI ignores a bare list silently — reporting
  success while emitting a manifest with zero relationships — and a newer one rejects it as a hard
  validation error. The three joins (orders→customers, raw_orders→raw_customers,
  raw_orders→raw_items) are restored in the keyed form, which builds on both.

## [0.2.0] - 2026-08-16

### Added

- **Codex local back-end** — a fourth dispatch target backed by the Codex app-server protocol,
  with persistent sessions, model-catalog discovery, IR-driven multi-agent Ask and dashboard
  execution, Setup and context-enrichment flows, and typed event/render contracts. The package
  remains private and is versioned in lockstep with the rest of the workspace.

- **Native interactive sessions** — Claude Code and Codex launch specifications now carry an
  explicit purpose, bounded scope, least-privilege Wren/MCP discovery, typed Setup recovery, and
  retained answer/dashboard delivery. Emitted agents receive one profile-level session envelope,
  scope prompt, and `RUN.md`, with deterministic snapshots guarding the complete emitted tree.

- **Runtime semantic-context injection** — dispatchers can receive schema plus knowledge at run
  time without rebuilding the compiled profile. A new `genbi-enrich-context` profile provides
  read-only inspection and host-mediated enrichment proposals, while `genbi-monitor` adds
  scheduled freshness checks.

- **Expanded eval tooling** — back-end-aware runner adapters, repeated sampling, trace caching,
  compliance-version validation, live freshness-pair scoring, pinned Driftwood fixtures, and
  committed GenBI/Driftwood goldens. Pull requests that change emitted agent context are covered
  by a byte-for-byte structural snapshot without forcing paid model calls on every dispatcher PR.

- **Provider composition and authenticated model catalogs** — capabilities are resolved from
  provider fragments instead of target-specific component names, with consistent loud-fail walls
  across Rust, Claude Agent SDK, and Codex back-ends.

- **`warble_ir_version` bumped to `0.4`** — `bind:` values authored on a profile mount now actually
  reach the IR. Each component node gains an additive `binds` facet (present only when the
  component has at least one profile-bound param) carrying the *effective* value for every such
  param: the mount-supplied value, or else the param's declared `default`. `context_precondition[].args`
  may reference a bound param with `$param:<name>`, which compile now resolves to that effective
  value before evaluating the predicate (previously this template was never substituted, so
  `binding_mode: pinned` was unimplemented). An unsupplied optional bind with no default resolves
  to nothing, which loud-fails the referencing precondition as unanswerable rather than evaluating
  against an empty value; `$param:` naming an undeclared param is a compile-time error.
  `model_has_timestamp` now honors a pinned `args.model` the same way `metric_additive` honors a
  pinned metric, instead of only ever answering existentially.

- **Components may now author an optional `brief`** — a free-form string shared across every step
  of a component, rendered with the same `{{project}}` / `{{project_name}}` placeholder
  substitution as step prompts and emitted once on the IR node (not per-step). Every back-end that
  assembles a system prompt places it in the same spot — after the machine-generated preamble,
  before the body — on the driver and on every subagent; the `vercel` back-end carries it onto
  `AgentBundle.brief` for the harness to place. A profile mount may override a component's `brief`
  wholesale (`components[].brief`, never merged). A component with no `brief` compiles to IR
  byte-identical to before this field existed. Since `component.yml` is parsed with
  `deny_unknown_fields`, a component that authors `brief` will **loud-fail on an older warble
  binary** that does not yet recognize the field — see `docs/spec/authoring.md`.

- **`warble_ir_version` bumped to `0.5`** — the `brief` addition above is a shape change to the
  IR (a new optional field on the component node), and per the IR version contract in
  `docs/spec/ir-schema.md`, any change to the IR shape requires a version bump, including a purely
  additive one. Every lockstep-checked location (`core`'s emitted literal, every back-end's
  `SUPPORTED_IR_VERSION(S)` and advisory `MIN`/`MAX_SUPPORTED_IR_VERSION` pair, and this spec
  document's own title) now names `0.5`, and every committed golden IR, conformance fixture, and
  emitted bundle/manifest snapshot has been regenerated against it. Anything built against a
  compiled `0.4` IR (a saved `ir.golden.json`, a `vercel` bundle, a `codex-local` manifest) must be
  regenerated — a stale `0.4` artifact will be rejected by every back-end, loudly, at load time.

- **`@warble/claude-agent-sdk` is now publishable to npm** — first-publication metadata
  (`publishConfig.access: public`, `repository.directory`, `homepage`, `bugs`, `keywords`,
  `engines.node`), a `prepublishOnly` script gating `check-types` + `build` + `test` so a
  stale/missing `dist/` can never ship, and a clearer, actionable error when the `warble` binary
  isn't found on `PATH` (names `cargo install warble-cli`, the one channel that's genuinely public
  and needs no authentication — `@warble/claude-agent-sdk` deliberately does not depend on
  `@warble/cli`, which is unpublished and would need an authenticated GitHub Release download from
  this private-until-launch repo). No `npm publish` has been run yet; this only makes the package
  ready to publish.

### Fixed

- Native interactive output is presented conversationally while preserving structured answers and
  dashboard artifacts for follow-ups. Setup terminals now enforce their exact JSON and string-slot
  contracts, and test-only transport timeouts no longer race the runner's production timeouts.
- Interactive context-enrichment proposals now use the host submission channel without changing
  the byte-exact headless JSON delivery contract or granting project-write authority.
- Profile-level scope artifacts are emitted exactly once, and generated `RUN.md` files no longer
  diverge between components.
- **`dispatcher/vercel`** — a `when` guard on a conditional step whose guard string falls outside
  the closed vocabulary (`on_failure`/`on_flag`/`on_missing`), or a step declaring
  `conditional: true` with no `when` at all (or vice versa), now fails loudly at emit time instead
  of being silently folded into a realization it doesn't match (invariant #1). Guard shapes already
  in the closed vocabulary — including `on_flag`/`on_missing` and non-adjacent `on_failure`, which
  realize as `GuardedSkip` — are unaffected.
- **`claude-agent-sdk`: a `wren`-prefixed compound Bash command could hide a `.env` read past the
  read-only guard** (e.g. `wren --version && cat .env`), on both the runtime (`guardrails.ts`) and
  `emit --standalone`'s inlined copy of the same guard. The runtime path is now enforced through a
  `PreToolUse` hook (`canUseTool` alone does not see an in-cwd `Read` in the real SDK), and the
  inlined `--standalone` guard now carries the same dotenv-read denylist, checked first. A
  behavioral test (`tests/guard-drift.test.ts`) now runs both guard implementations against a
  shared case table and fails if either one falls out of sync with the other, or if the runtime
  guard grows new denial behavior the standalone copy hasn't caught up to.

## [0.1.0] - 2026-07-30

Initial public release. Warble compiles a declarative profile (components + guardrails + config,
bound to a semantic context) into a language-neutral IR, then dispatches that IR onto a runtime
target through a thin, swappable back-end.

### Added

- **Front-end compiler** (`core`) — parses a profile + its mounted components + a context binding,
  merges component defaults with profile overrides, validates the result, and emits the IR
  (`warble_ir_version: 0.3`). Sans-IO: the host supplies file contents through a `ContextLoader`
  trait, which is what lets the same compiler target native, WASM, and language bindings unchanged.
- **`warble` CLI** (`cli`) — `compile · dispatch · render · manifest · eval · blast-radius ·
  mcp-serve`.
- **Two Rust back-ends**, each consuming the same IR:
  - `claude-code-cli` — emits static Claude Code agent files (`.claude/agents/*.md`); the v1
    reference back-end, folded into the `warble` binary.
  - `vercel` — emits a deployable bundle for a serverless host, composed from provider fragments.
- **One TypeScript back-end**, `claude-agent-sdk` (npm package `@warble/claude-agent-sdk`) — drives
  the Claude Agent SDK's in-loop `query()` at runtime from the same IR, with no Rust dependency.
- **MDL (Modeling Definition Language) context adapter** (`bindings/mdl-context`) — loads a
  semantic-layer project into the context manifest the compiler consumes; the only crate in the
  workspace with a published (non-dev) dependency on a semantic-format library.
- **Hub component library** (`hub/components/`) — eight reusable, portable components shared across
  profiles: `answer_query`, `bootstrap_mdl`, `edit_pipeline`, `enrich_knowledge`, `explain_change`,
  `explore_model`, `generate_dashboard`, `monitor_freshness`.
- **Two shipped profiles** — `genbi-default` (the flagship profile, mounting its components from the
  Hub rather than owning its own component library) and `genbi-setup` (agentic onboarding: connects
  a new data source and builds its semantic layer, ahead of `genbi-default`).
- **Fine-grained context binding** — the compiler evaluates each component's declared
  `context_precondition`s against the bound semantic layer (not just vocabulary membership), and
  the IR carries both the introspection result and the per-predicate evaluation outcome.
- **`blast_radius` analysis** — transitive downstream lineage closure over the semantic layer,
  exposed as read-only analysis and as an enforcement gate on mutating changes.
- **Typed render contract** — a stdlib of render-block types (`kpi_card`, `table`, `chart`,
  `narrative`, `diff`) with a reference HTML renderer and a markdown degrade path.
- **Eval tooling** (`eval/compare`, `eval/runner`) — result-set comparison against golden
  expectations, and a Pareto runner that replays golden questions through a dispatched agent under
  tier→model bindings.
- **IR version enforcement** — every back-end validates the incoming `warble_ir_version` against
  its own supported version and loud-fails, naming both the rejected and the supported version, on
  a mismatch. See [`docs/spec/ir-schema.md`](docs/spec/ir-schema.md#ir-version-compatibility) and
  [RELEASING.md](RELEASING.md) for the versioning policy this enforces.

### Known limitations

- **No Windows support.** The `warble` binary is not built, released, or supported on Windows.
  Two concrete gaps in the current code make this more than a missing CI leg:
  `dispatcher/claude-code-cli/src/emit/hybrid.rs` emits Unix shebangs and `.sh` wrapper scripts
  into runtime artifacts, and `eval/runner/src/lib.rs`'s `Command::new("claude")` doesn't resolve
  the `.cmd` shim npm installs on Windows. Both would need real portability work, not just a build
  target, before a Windows release could ship.
- **No static `musl` binaries.** Only glibc Linux targets
  (`x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`) are built. A static-linked `musl`
  target (e.g. `x86_64-unknown-linux-musl`) hasn't been evaluated against this workspace's
  dependencies (notably the DataFusion-based crates) and isn't part of the current release surface.

[Unreleased]: https://github.com/Canner/Warble/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Canner/Warble/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Canner/Warble/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Canner/Warble/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Canner/Warble/releases/tag/v0.1.0
