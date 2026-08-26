# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Warble is

Warble is a **data behavior framework**: you declare *what a data agent should do* as a
git-authoritative **profile** (components + guardrails + config, bound to a semantic context); the
front-end compiles it to a language-neutral **IR**, and a thin per-target back-end legalizes the IR
onto a runtime and emits a native agent.

```
profile + components + context  ──►  warble compile  ──►  IR JSON  ──►  warble dispatch  ──►  native agent
   (declarative YAML + prompts)       (front-end, Rust)   (the seam)    (per-target back-end)
```

**The contract — profile schema + capability manifest + IR — is the product.** Prompts, agent
config, and each runtime's back-end are derived or commodity. Start with
[`docs/spec/authoring.md`](../docs/spec/authoring.md); the authoritative contracts live in `docs/spec/`
(`capability-model.md`, `ir-schema.md`, `blast-radius.md`, `binding-spec.md`, `glossary.md`).

## Commands

Rust is one Cargo workspace at the repo root; the TS back-end is a **separate npm package, not in the
workspace**. Prefer the `just` recipes.

| Task | Rust workspace | TS back-end (`dispatcher/claude-agent-sdk`) | Docs site (`docs/site/`) |
| --- | --- | --- | --- |
| build | `just build` | `just build-ts` | `npm run build` |
| test | `just test` (`cargo test`) | `just test-ts` (`npm test`, node:test) | — |
| lint | `just lint` (`clippy -D warnings` + `fmt --check`) | `just lint-ts` (`tsc --strict`) | — |
| format | `just fmt` | — | — |
| release binary | `just release` (builds `warble-cli` → `target/release/warble`) | — | — |
| install deps | (cargo handles it) | `just install-ts` (`npm install`) | `npm install` |
| gen reference docs | — | — | `npm run gen:reference` (`docs/spec/*.md`→`reference/*.md` + `docs/roadmap.md`→`community/roadmap.md`; edit source only) |
| gen all site content | — | — | `npm run gen:site` (reference/roadmap pages + `static/llms.txt`) |

- **Single Rust test**: `cargo test -p <crate> <name>` — e.g. `cargo test -p warble-claude-code handler_wall_hit_cases`.
- **Single TS test**: `cd dispatcher/claude-agent-sdk && node --import tsx --test tests/<file>.test.ts`.
- **The TS render tests are skipped unless the release binary exists** — run `just release` first (they shell out to `target/release/warble render`). "2 skipped" in `test-ts` with no release build is expected, not a failure.

## Architecture

Three parts, joined by language-neutral seams so back-ends are swappable:

- **A. front-end compiler** — `core/` (crate `warble`). Parses profile/component/context → merges
  defaults ⊕ overrides → validates → emits IR. **It is sans-IO**: no file/network access; the host
  injects file contents via the `ContextLoader` trait (`core/src/context.rs`). This is what lets the
  same compiler target native, WASM, and language bindings unchanged — **do not add I/O to `core/`.**
- **B. back-ends (per target)** — `dispatcher/`. Each consumes the *same* `ir.json`:
  - `claude-code-cli/` — **Rust**, emits static Claude Code agent files (`.claude/agents/*.md`); folds
    into the `warble` binary (v1 reference back-end). CLI target = files → Rust.
  - `vercel/` — **Rust**, emits a deployable bundle (`bundle.json`) for a serverless host; composed
    with domain provider fragments rather than the file target's render-flavor/model-tier knobs.
  - `claude-agent-sdk/` — **TS**, drives the SDK's in-loop `query()` at runtime. SDK target = runtime
    loop → TS. It links no Rust and consumes the same IR — which is what proves the IR is a real
    cross-language seam. Also exposes its own `manifest` subcommand: a display-only, structural
    snapshot of the resolved profile for this target, shaped like the vercel bundle so a consumer can
    source a display from whichever back-end actually runs.
- **C. UI** — future.

`cli/` is the `warble` binary: `compile · dispatch · render · manifest · eval · blast-radius ·
mcp-serve`. `bindings/mdl-context/` is the MDL adapter (loads raw wren-project yml → manifest).
`hub/` is the shared, portable component library; product profiles that mount Hub components (an
agentic onboarding profile, an assertive freshness-monitoring profile mounting
`monitor_freshness` — a resident scheduled check rather than a one-shot render, etc.) now live in
the consuming product's own repo, not here; `examples/` holds example projects (incl.
`examples/jaffle-wren/`, a bundled MDL + `jaffle_shop.duckdb`) and litmus profiles such as
`examples/monitor-agent/`.

## Invariants — preserve these when changing anything

These are load-bearing and not obvious from any single file. Breaking one is a design regression even
if tests pass:

1. **Dispatchers are enum-keyed** on the three IR enums `(realization_kind, outcome.kind,
   trigger.kind)` — **never branch on a component's id/verb** (`if verb == "…"`). An enum arm a target
   doesn't support must **loud-fail ("wall-hit")**, never silently emit something wrong. New component
   families are added by realizing an enum arm, not by special-casing a component.
2. **`core/` is sans-IO** (see above) and **`core/` + components stay transitively zero-wren** — only
   `bindings/mdl-context` may depend on `wren-core-base`. This portability is the moat; verify with
   `cargo tree`.
3. **No DSL in the composition layer** — conditionals/loops live in step prompts/hooks, not in
   profile/IR structure. IR growth must be *additive* (a new optional facet), never a mechanism.
4. **IR is runtime-agnostic** — no mechanism names (cron, subagent, Slack, …) leak into it. Those
   resolve at the capability layer via `realize-via`.
5. **Borrow generic capabilities; build only data-native ones.** The single `provided_by: warble`
   capability is `blast_radius` (semantic lineage). Approval, VCS/rollback, scheduling, subagent
   dispatch, schema introspection are all **borrowed** (realize-via runtime/MCP).

## Capability model & enforcement

- Each capability resolves **native / realize-via / degrade / fail**, gated by criticality +
  `provided_by` (`docs/spec/capability-model.md`).
- **`blast_radius`** = forward downstream closure over the MDL lineage DAG; severity ordered
  `None < Compatibility < Structural < Semantic` (a downstream metric = Semantic = worst). It is
  read-path (analysis) *and* an enforcement gate for mutating changes (`cli/src/gate.rs`:
  Allow/Escalate/Block). See `docs/spec/blast-radius.md`.
- **Four enforcement points**, independently authorized: `read_only_execution` (analytical/assertive),
  `artifact_write` (render, scoped), `data_write` (mutating), `context_write` (constitutive, scoped).
- **Safety-critical capabilities never silently degrade.** e.g. `human_approval` on a headless target
  is a **compile-time loud-fail**, not a skipped step.

## Component anatomy (concept that spans files)

A component's "anatomy" is four IR positions — `type` (analytical / assertive / mutating /
orchestrating), `realization_kind`, `trigger.kind`, `outcome.kind` — but every family reuses the
**same** `component.yml` / `profile.yml` / `steps/*.md` fields. Per-step **tier** (`cheap`/`strong`)
is git-static in the component; the concrete model/provider is a runtime-injected layer-3 binding
(this is what makes hybrid local+cloud possible without touching the IR).

## Conventions

- Conventional commits: `feat` / `fix` / `chore` / `refactor` / `test` / `docs`.
- **Branch names describe the change, never an external tracker.** `feat/bind-value-resolution`, not
  `feat/issue-123-bind-values`. A branch name is not scrubbable after the fact the way a commit
  message is: it stays visible in the pull request's compare header and merge metadata even once the
  branch is deleted. Name it for what it does and the constraint takes care of itself.
- **`just doc` is its own gate — `just lint` and `just test` do not cover it.** It runs rustdoc under
  `-D warnings`; an intra-doc link to a private item is a build failure, not a warning. Rustdoc links
  to `docs/spec/*.md` use stable canonical `main` URLs so package releases do not rewrite source
  comments. A green lint-plus-test run is no evidence at all about this gate.
- **Docs-site CI regenerates and builds the site.** It catches generated-content drift, release-doc
  drift, and broken links. Run `npm run build` in `docs/site/` before pushing so those failures stay
  local; `onBrokenLinks: 'throw'` makes the production build the link check.
- Doc regeneration: `docs/spec/*.md` → `docs/site/docs/reference/*.md` (except `cli.md`) and
  `docs/roadmap.md` → `docs/site/docs/community/roadmap.md` are both generated by
  `npm run gen:reference` in `docs/site/` — edit the source, never the generated page, and commit
  both in the same PR. `npm run gen:reference && git diff --exit-code docs/reference
  docs/community/roadmap.md` is the drift check.
- AI index regeneration: `npm run gen:llms` derives `docs/site/static/llms.txt` from every docs
  page's frontmatter. `npm run gen:site` runs both generators and is what prestart/prebuild and CI
  use; commit the generated index with the pages it describes.
- `.github/workflows/eval.yml` is the **G4 eval gate**, and it is `workflow_dispatch` **only** — no
  pull request triggers it, because every run spends real model calls. Run the jaffle smoke suite by
  hand (Actions → eval-gate → Run workflow → `jaffle`) when a change looks capable of moving
  accuracy, and before a release. It fails on a capability regression vs the committed
  `eval/golden/jaffle/baseline.json` and skips cleanly — neutral pass — without the
  `CLAUDE_CODE_OAUTH_TOKEN` secret. The PR-time substitute is `dispatch_snapshot_tests` in
  `just test` plus the `fixture-contract` job in `ci.yml`. Refresh the baseline in the same PR when a score
  change is legitimate. The manual `monitor-freshness` suite is the heavier clean-vs-injected live
  assertion eval; do not add it to every PR by default. Its clean Driftwood input is a
  checksum-pinned GitHub Release asset fetched through `examples/driftwood-wren/fixture.py`;
  fixture failures must fail loudly, never trigger an implicit cold generation.
