# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/) once released (see [RELEASING.md](RELEASING.md)
for the pre-1.0 policy).

## [Unreleased]

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

[Unreleased]: https://github.com/Canner/Warble/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Canner/Warble/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Canner/Warble/releases/tag/v0.1.0
