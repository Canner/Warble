# Warble

**Warble is a data behavior framework.** You declare *what a data agent should do* as a
composable, git-authoritative **profile** (components + guardrails + config, bound to a semantic
context). Warble's front-end compiles that profile into a language-neutral **IR**, and a thin,
replaceable back-end legalizes the IR onto a runtime target and emits a native agent.

```
profile + components + context      IR (the seam)         native agent
  (declarative YAML + prompts) ──►  warble compile  ──►  warble dispatch  ──►  .claude/agents/… ──► claude -p --agent …
        authored, git-diffable       (front-end)          (claude-code-cli       (Claude Code CLI      (answers via the
                                                            back-end)             agent files)         `wren` semantic layer)
```

The thesis: **one data-native front-end + a thin, swappable back-end per runtime, with the IR as
the seam.** The contract — profile schema + capability manifest + IR — is the product; prompts,
agent config, and each runtime's back-end are derived or commodity.

> **New to Warble?** Start with [`docs/spec/authoring.md`](./docs/spec/authoring.md) — it explains profiles,
> components, context binding, tiers, guardrails, and the render contract with worked examples.

## Architecture

Three parts, three language-neutral seams (IR JSON / SDK / MCP):

| Part | What | Language |
| --- | --- | --- |
| **A. front-end compiler** | parse profile/component/context → merge defaults ⊕ overrides → validate → emit IR | **Rust** (`core/`) |
| **B. back-ends (per target)** | IR → a runtime's native agent | per target (see below) |
| **C. UI** | authoring + results surface | web (future) |

**Back-ends are organized by target, and each target's language follows what it needs:**

```
dispatcher/
  claude-code-cli/     Rust — emits static Claude Code agent files. No SDK needed, so it is native
                       Rust and folds into the `warble` binary (v1 reference back-end).
  claude-agent-sdk/    TS  — drives the SDK's in-loop query() at runtime; bound to the SDK's
                       language. MVP built (second reference back-end).
```

The compiler core is **sans-IO** (no file/network access — the host injects file contents), which is
what lets it target native, WASM, and language bindings unchanged.

## Layout

```
Cargo.toml             workspace root (all Rust crates)
cli/                   `warble` binary — compile · dispatch · render · manifest · eval
core/                  sans-IO compiler lib (crate `warble`)
dispatcher/
  claude-code-cli/     Rust back-end (IR → agent files) + reference renderer + manifest projection
  claude-agent-sdk/    TS back-end (IR → in-loop query() loop); own npm package, not in the Cargo workspace
eval/
  compare/             Rust result-set comparator (also `warble eval compare`)
  runner/              Rust Pareto runner (live-run orchestration; `warble eval run`)
genbi-default/         flagship GenBI profile + its component library (explore_model · answer_query ·
                       generate_dashboard · explain_change), bound to jaffle-wren
examples/              example projects + jaffle-wren MDL (semantic layer only)
docs/
  spec/                THE CONTRACT — authoring.md (profiles/components) · ir-schema.md · capability-model.md ·
                       blast-radius.md · binding-spec.md · enforcement-seam.md · glossary.md
  roadmap.md           (narrative: findings + phasing)
```

`genbi-default/` is the flagship profile: it mounts the four consuming GenBI components (its own
`components/<id>/` library) and is a compiler golden. `examples/demo-agent/` and
`examples/render-demo/` are smaller example projects, also used as compiler goldens.

## The `warble` CLI

One native binary spans the whole CLI-target path (no Node required):

```bash
cargo build --release -p warble-cli    # or: just release  → target/release/warble

warble compile examples/render-demo -o ir.json                # project → IR
warble dispatch ir.json --target claude-code:headless --out agent \
        [--render-flavor programmatic|prompt]                 # IR → Claude Code agent files
warble manifest ir.json                                       # IR → capability manifest (stdout)
warble render result.json --out dashboard.html                # captured envelope → deterministic HTML
warble eval compare < request.json                            # result-set comparison (eval loop)
```

Running an emitted agent needs the `wren` CLI on a queryable wren project; see the generated `RUN.md`.

### Render flavors
The render contract has two flavors (`docs/spec/ir-schema.md` §v0.3): **programmatic** (default — the
agent stays read-only and emits a `{blocks}` envelope; `warble render` produces HTML
deterministically) and **prompt** (`--render-flavor prompt` — the agent writes the file itself).

## Build & test

Prereqs: Rust (cargo), plus Node for the eval runner and the TS SDK back-end.
[`just`](https://github.com/casey/just) wraps the flows: `just build`, `just test`, `just lint`
(Rust workspace); `just install-ts`, `just lint-ts`, `just test-ts` (the `claude-agent-sdk` package).
`cargo test` at the root covers the whole workspace (compiler, back-end, comparator, CLI).

## Status

v1 realizes the **MVP** behavior tier — `skill` / `render` / `one_shot` — proven end-to-end on the
Claude Code CLI. The not-yet-implemented arms (`tool`/`gated-tool`, `assertion`/`mutation`/`dispatch`,
`scheduled`/`event`) are documented, loud-failing **extension points**: adding one is additive
(+1 handler), never a rewrite. See `docs/roadmap.md`.

A second reference back-end, `claude-agent-sdk` (TS, in-loop `query()`), realizes the same MVP slice
on a non-file runtime — proving the IR is a real cross-language seam and closing three file-target
wall-hits (per-step tier in-loop, runtime guardrail enforcement, per-step trace). See
`dispatcher/claude-agent-sdk/README.md`.

Deferred: the Rust bindings (`wasm`/`py`/`napi`) and the UI.
