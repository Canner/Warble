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
  - `codex-local/` — **TypeScript**, drives a local Codex process and MCP client. It also consumes
    the same IR without linking Rust.
  - `vercel/` — **Rust**, emits a Vercel harness bundle.
- **`cli/`** — the `warble` binary: `compile · dispatch · render · manifest · eval · blast-radius · mcp-serve`.
- **`bindings/mdl-context/`** — the MDL adapter (loads a raw semantic project into a manifest).
- **`genbi-setup/`** — the agentic onboarding profile (connects a new data source and builds its
  semantic layer, ahead of any analysis profile mounted over it).
- **`hub/`** — the shared, portable component library.
- **`examples/`** — example projects (including `examples/jaffle-wren/`, a bundled MDL + DuckDB).

The authoritative contracts live in [`docs/spec/`](docs/spec/) — start with
[`docs/spec/authoring.md`](docs/spec/authoring.md).

## Building and testing

Rust is one Cargo workspace at the repo root. The two TypeScript back-ends are **separate npm
packages, not in the workspace**. Prefer the `just` recipes.

| Task | Rust workspace | Claude Agent SDK (`dispatcher/claude-agent-sdk`) | Codex local (`dispatcher/codex-local`) | Docs site (`docs/site/`) |
| --- | --- | --- | --- | --- |
| build | `just build` | `just build-ts` | `just build-codex-ts` | `npm run build` |
| test | `just test` (`cargo test`) | `just test-ts` (`npm test`, node:test) | `just test-codex-ts` (`npm test`, node:test) | — |
| lint | `just lint` (`clippy -D warnings` + `fmt --check`) | `just lint-ts` (`tsc --noEmit`; strict mode set in `tsconfig.json`) | `just lint-codex-ts` (`tsc --noEmit`; strict mode set in `tsconfig.json`) | — |
| format | `just fmt` | — | — | — |
| release binary | `just release` (builds `warble-cli` → `target/release/warble`) | — | — | — |
| install deps | (cargo handles it) | `just install-ts` (`npm ci`) | `just install-codex-ts` (`npm ci`) | `npm ci` |
| dev server | — | — | — | `npm start` |
| regenerate reference/roadmap docs | — | — | — | `npm run gen:reference` (`docs/spec/*.md`→`docs/reference/*.md`; `docs/roadmap.md`→`docs/community/roadmap.md`) |
| regenerate all generated site content | — | — | — | `npm run gen:site` (reference/roadmap docs + `static/llms.txt`) |

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
  same PR; if it changes project status/phasing, update `docs/roadmap.md`. Two source→output
  mappings feed the docs site, and neither's output may be edited directly:
  `docs/site/docs/reference/*.md` (except `cli.md`) from `docs/spec/*.md`, and
  `docs/site/docs/community/roadmap.md` from `docs/roadmap.md`. Always edit the source and
  regenerate — `npm run gen:reference` in `docs/site/` — then commit the regenerated page(s) in
  the same PR. `npm run gen:reference && git diff --exit-code docs/reference
  docs/community/roadmap.md` is the drift check (clean = in sync). See `docs/site/README.md`.
- If your change touches the IR shape at all — including a purely additive field — it requires a
  `warble_ir_version` bump; see [`docs/spec/ir-schema.md`](docs/spec/ir-schema.md#ir-version-compatibility)
  for what "any change" covers and why, and every location the bump touches. Record every release
  in [`CHANGELOG.md`](CHANGELOG.md); the version and compatibility policy itself lives in
  [`RELEASING.md`](RELEASING.md).

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE).
