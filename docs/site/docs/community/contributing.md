---
title: Contributing
description: "How to build, test, and lint Warble, plus the load-bearing invariants a change must preserve — enum-keyed dispatch, a sans-IO/zero-wren core, and an additive, runtime-agnostic IR."
---

Warble is one data-native front-end compiler plus a thin, swappable back-end per runtime, with the
IR as the seam between them. Most contributions land in exactly one of those pieces — a component,
a compiler validation, or a back-end handler — without touching the others. This page covers the
repo layout, the `just` recipes, and the invariants that keep that separation real.

## Project layout

```
profile + components + context  ──►  warble compile  ──►  IR JSON  ──►  warble dispatch  ──►  native agent
   (declarative YAML + prompts)       (front-end, Rust)   (the seam)    (per-target back-end)
```

- **`core/`** — the front-end compiler (crate `warble`). Parses profile/component/context, merges
  component defaults with profile overrides, validates, and emits IR. It is sans-IO: no file or
  network access — the host injects file contents via the `ContextLoader` trait
  (`core/src/context.rs`).
- **`dispatcher/`** — back-ends, each consuming the same `ir.json`:
  - `claude-code-cli/` — Rust, emits static Claude Code agent files (`.claude/agents/*.md`); folds
    into the `warble` binary (the v1 reference back-end).
  - `claude-agent-sdk/` — TypeScript, drives the SDK's in-loop `query()` at runtime. It links no
    Rust and consumes the same IR, which is what proves the IR is a real cross-language seam.
  - `vercel/` — Rust, emits a deployable bundle for a serverless host.
- **`cli/`** — the `warble` binary: `compile · dispatch · render · manifest · eval · blast-radius ·
  mcp-serve`.
- **`bindings/mdl-context/`** — the MDL adapter (loads a raw semantic project into a manifest).
- **`genbi-default/`** — the flagship profile, which mounts its components from the Hub
  (`hub/components/`) rather than owning its own component library.
- **`genbi-setup/`** — the agentic onboarding profile (connects a new data source and builds its
  semantic layer, ahead of `genbi-default`).
- **`hub/`** — the shared, portable component library.
- **`examples/`** — example projects, including `examples/jaffle-wren/`, a bundled MDL + DuckDB
  project.

The authoritative contracts live in `docs/spec/` — start with `docs/spec/authoring.md` if you're
changing anything about how profiles or components are authored, or the [reference section](/reference/ir-schema)
for the rendered version of those contracts.

## Building and testing

Rust is one Cargo workspace at the repo root. The TypeScript back-end
(`dispatcher/claude-agent-sdk`) is a **separate npm package, not in the workspace**. Prefer the
`just` recipes over calling `cargo`/`npm` directly.

| Task | Rust workspace | TS back-end (`dispatcher/claude-agent-sdk`) | Docs site (`docs/site/`) |
| --- | --- | --- | --- |
| build | `just build` | `just build-ts` | `npm run build` |
| test | `just test` (`cargo test`) | `just test-ts` (`npm test`, `node:test`) | — |
| lint | `just lint` (`clippy -D warnings` + `fmt --check`) | `just lint-ts` (`tsc --noEmit`, strict mode) | — |
| format | `just fmt` | — | — |
| release binary | `just release` (builds `warble-cli` → `target/release/warble`) | — | — |
| install deps | (cargo handles it) | `just install-ts` (`npm install`) | `npm install` |
| dev server | — | — | `npm start` |
| regenerate reference docs | — | — | `npm run gen:reference` (`docs/spec/*.md` → `docs/reference/*.md`) |

Running a single test:

- **Rust**: `cargo test -p <crate> <name>` — for example `cargo test -p warble-claude-code
  handler_wall_hit_cases`.
- **TypeScript**: `cd dispatcher/claude-agent-sdk && node --import tsx --test tests/<file>.test.ts`.

The TS render tests are **skipped unless the release binary exists** — run `just release` first,
since they shell out to `target/release/warble render`. Seeing "2 skipped" in `test-ts` with no
release build is expected, not a failure.

Before opening a pull request, make sure `just lint` and `just test` are green (and the TS
equivalents, if you touched the TS back-end).

## Invariants — preserve these

:::warning
These are load-bearing and not obvious from any single file. **Breaking one is a design regression
even if tests pass.** If a change seems to require breaking one, open an issue to discuss first
rather than working around it locally.

1. **Dispatchers are enum-keyed** on the three IR enums `realization_kind`, `outcome.kind`, and
   `trigger.kind` — never branch on a component's id or verb (no `if verb == "…"`). An enum arm a
   target doesn't support must **loud-fail** (a wall-hit), never silently emit something wrong. New
   component families are added by realizing an enum arm, not by special-casing a component.
2. **`core/` is sans-IO**, and `core/` plus every component stay transitively free of any
   semantic-format dependency — only `bindings/mdl-context` may depend on `wren-core-base`. Verify
   this with `cargo tree`. Do not add I/O to `core/`.
3. **No DSL in the composition layer** — conditionals and loops live in step prompts/hooks, not in
   profile or IR structure. IR growth must be *additive* (a new optional facet), never a new
   mechanism.
4. **IR is runtime-agnostic** — no mechanism names (cron, subagent, Slack, …) leak into it. Those
   resolve at the capability layer via `realize-via`.
5. **Borrow generic capabilities; build only data-native ones.** Approval, VCS/rollback,
   scheduling, subagent dispatch, and schema introspection are all borrowed (`realize-via`
   runtime/MCP) rather than built into Warble.
:::

See [How Warble works](/concepts/how-warble-works) for why this split exists, and
[Adding a new back-end](/community/adding-a-backend) if your change is a new dispatch target rather
than a component or compiler fix.

## Commit and pull-request conventions

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat` / `fix` / `chore` /
  `refactor` / `test` / `docs`.
- Keep commit messages focused on *why* the change is needed, not just *what* changed.
- Keep pull requests scoped to one logical change; include tests for new behavior.
- If your change touches the IR or a spec contract, update the relevant doc in `docs/spec/` in the
  same PR. The [reference section](/reference/ir-schema) pages (except `cli.md`) are **generated**
  from `docs/spec/*.md` — after editing a spec, run `npm run gen:reference` in `docs/site/` and
  commit the regenerated pages in the same PR. `npm run gen:reference && git diff --exit-code
  docs/reference` is the drift check (clean = in sync). See `docs/site/README.md`.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
