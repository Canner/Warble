# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/) once released (see [RELEASING.md](RELEASING.md)
for the pre-1.0 policy).

## [Unreleased]

## [0.1.0]

_Undated: this section is written ahead of the `v0.1.0` tag it describes. Per the
[bump procedure](RELEASING.md#bump-procedure), it gets a release date only once actually tagged —
add the date at tag time; don't backfill one now._

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

[Unreleased]: https://github.com/Canner/Warble/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Canner/Warble/releases/tag/v0.1.0
