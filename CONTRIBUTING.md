# Contributing to Warble

Thanks for your interest in Warble. This guide covers how to build, test, and make changes
that fit the project's design.

## Project layout

Warble is one data-native front-end compiler plus a thin, swappable back-end per runtime, with a
language-neutral **IR** as the seam between them.

```
profile + components + context  ──►  warble compile  ──►  IR JSON  ──►  warble dispatch  ──►  native agent
   (declarative YAML + prompts)       (front-end, Rust)   (the seam)    (per-target back-end)
```

- **`core/`** — the front-end compiler (crate `warble`). Parses profile/component/context → merges
  defaults with overrides → validates → emits IR. It is **sans-IO**: no file or network access; the
  host injects file contents via the `ContextLoader` trait (`core/src/context.rs`).
- **`dispatcher/`** — back-ends, each consuming the *same* `ir.json`:
  - `claude-code-cli/` — **Rust**, emits static Claude Code agent files (`.claude/agents/*.md`); folds
    into the `warble` binary (the v1 reference back-end).
  - `claude-agent-sdk/` — **TypeScript**, drives the SDK's in-loop `query()` at runtime. It links no
    Rust and consumes the same IR — which is what proves the IR is a real cross-language seam.
  - `wrenai/` — **Rust**, emits a WrenAI harness bundle.
- **`cli/`** — the `warble` binary: `compile · dispatch · render · manifest · eval · blast-radius · mcp-serve`.
- **`bindings/mdl-context/`** — the MDL adapter (loads a raw semantic project into a manifest).
- **`genbi-default/`** — the flagship profile and its component library.
- **`hub/`** — the shared, portable component library.
- **`examples/`** — example projects (including `examples/jaffle-wren/`, a bundled MDL + DuckDB).

The authoritative contracts live in [`docs/spec/`](docs/spec/) — start with
[`docs/spec/authoring.md`](docs/spec/authoring.md).

## Building and testing

Rust is one Cargo workspace at the repo root. The TypeScript back-end is a **separate npm package,
not in the workspace**. Prefer the `just` recipes.

| Task | Rust workspace | TS back-end (`dispatcher/claude-agent-sdk`) |
| --- | --- | --- |
| build | `just build` | `just build-ts` |
| test | `just test` (`cargo test`) | `just test-ts` (`npm test`, node:test) |
| lint | `just lint` (`clippy -D warnings` + `fmt --check`) | `just lint-ts` (`tsc --noEmit`; strict mode set in `tsconfig.json`) |
| format | `just fmt` | — |
| release binary | `just release` (builds `warble-cli` → `target/release/warble`) | — |
| install deps | (cargo handles it) | `just install-ts` (`npm install`) |

- **Single Rust test**: `cargo test -p <crate> <name>` — e.g. `cargo test -p warble-claude-code handler_wall_hit_cases`.
- **Single TS test**: `cd dispatcher/claude-agent-sdk && node --import tsx --test tests/<file>.test.ts`.
- The TS render tests are **skipped unless the release binary exists** — run `just release` first (they
  shell out to `target/release/warble render`). Seeing "2 skipped" in `test-ts` with no release build is
  expected, not a failure.

Before opening a pull request, make sure `just lint` and `just test` (and the TS equivalents, if you
touched the TS back-end) are green.

## Invariants — preserve these

These are load-bearing and not obvious from any single file. **Breaking one is a design regression
even if tests pass.** If a change seems to require breaking one, open an issue to discuss first.

1. **Dispatchers are enum-keyed** on the three IR enums `(realization_kind, outcome.kind,
   trigger.kind)` — **never branch on a component's id/verb** (`if verb == "…"`). An enum arm a target
   doesn't support must **loud-fail ("wall-hit")**, never silently emit something wrong. New component
   families are added by realizing an enum arm, not by special-casing a component.
2. **`core/` is sans-IO**, and `core/` plus components stay transitively free of any semantic-format
   dependency — only `bindings/mdl-context` may depend on `wren-core-base`. This portability is the
   point; verify with `cargo tree`. **Do not add I/O to `core/`.**
3. **No DSL in the composition layer** — conditionals/loops live in step prompts/hooks, not in
   profile/IR structure. IR growth must be *additive* (a new optional facet), never a mechanism.
4. **IR is runtime-agnostic** — no mechanism names (cron, subagent, Slack, …) leak into it. Those
   resolve at the capability layer via `realize-via`.
5. **Borrow generic capabilities; build only data-native ones.** Approval, VCS/rollback, scheduling,
   subagent dispatch, and schema introspection are all borrowed (realize-via runtime/MCP).

## Commit and pull-request conventions

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat` / `fix` / `chore` /
  `refactor` / `test` / `docs`.
- Keep commit messages focused on *why* the change is needed, not just *what* changed.
- Keep pull requests scoped to one logical change; include tests for new behavior.
- If your change touches the IR or a spec contract, update the relevant doc in `docs/spec/` in the
  same PR.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE).
