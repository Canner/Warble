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

## Native interactive targets

`warble dispatch <ir.json> --target claude-code:interactive --out <existing-cwd>` materializes
Claude Code artifacts. `--target codex:interactive` materializes repo-scoped `AGENTS.md` and
`.agents/skills/genbi-enrich-context/SKILL.md` for the native Codex TUI. Pass the closed
`--purpose analysis|setup|context_enrichment` allowlist to opt into the native Sessions v2 launch
contract together with `--native-scope <server-issued.json>`; it verifies the matching profile and
requires an immutable server bootstrap or bound-project scope plus a server-resolved Wren runtime
closure. The descriptor's canonical `cwd`
must exactly match `--out`; bound-project descriptors also carry opaque project identity,
generation, and revision for the GenBI runtime's stale-binding check.
Both targets write a versioned `.warble/interactive-launch.json`; callers launch the fixed
executable in its canonical `cwd` and own the PTY, process, transcript, prompts, and session
lifecycle. Native enrichment materializes only inspect/draft read-only work. `apply_enrichment`
has no headless handoff and loud-fails unless
an enforceable approval-capable target is added.

The thesis: **one data-native front-end + a thin, swappable back-end per runtime, with the IR as
the seam.** The contract — profile schema + capability manifest + IR — is the product; prompts,
agent config, and each runtime's back-end are derived or commodity.

> **New to Warble?** Start with the [documentation site's getting-started
> path](./docs/site/docs/getting-started/introduction.md) for a guided walkthrough. The
> authoritative contract itself — profiles, components, context binding, tiers, guardrails, and the
> render contract, with worked examples — lives in [`docs/spec/authoring.md`](./docs/spec/authoring.md).

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
                       language. MVP + Assertive + Mutating built (second reference back-end).
  codex-local/         TS  — drives isolated Codex one-shot/persistent sessions from the same IR;
                       realizes Setup plus named-agent Ask parity through exact MCP allowlists.
  vercel/              Rust — emits a deployable bundle for a serverless host; composed with
                       `--provider` domain fragments instead of the file target's
                       render-flavor/model-tier knobs.
```

The compiler core is **sans-IO** (no file/network access — the host injects file contents), which is
what lets it target native, WASM, and language bindings unchanged.

## Layout

```
Cargo.toml             workspace root (all Rust crates)
bindings/
  mdl-context/         MDL adapter (raw wren project → context manifest); the only crate
                       allowed to depend on `wren-core-base`
cli/                   `warble` binary — compile · dispatch · render · manifest · eval ·
                       blast-radius · mcp-serve
core/                  sans-IO compiler lib (crate `warble`)
dispatcher/
  claude-code-cli/     Rust back-end (IR → agent files) + reference renderer + manifest projection
  claude-agent-sdk/    TS back-end (IR → in-loop query() loop); own npm package, not in the Cargo workspace
  codex-local/         TS back-end (IR → isolated local Codex CLI); Setup + named-agent Ask parity
  vercel/              Rust back-end emitting a deployable serverless bundle, composed from
                       `--provider` domain fragments
eval/
  compare/             Rust result-set comparator (also `warble eval compare`)
  runner/              Rust Pareto runner (live-run orchestration; `warble eval run`)
  bird-interact/       BIRD-Interact `a-interact` adapter (TS; own npm package) — Warble drives the
                       official benchmark's port-6000 system agent, its pinned user simulator and
                       scorer stay authoritative; opt-in, five-task Query subset, not a BIRD score
genbi-default/         flagship GenBI profile, mounting components (explore_model · answer_query ·
                       generate_dashboard · explain_change) from the Hub; bound to jaffle-wren
genbi-setup/           agentic onboarding profile: connects a new data source and builds its
                       semantic layer, ahead of genbi-default
genbi-monitor/         assertive freshness-monitoring profile, mounting monitor_freshness from the
                       Hub — a resident scheduled check, not a one-shot render; bound to jaffle-wren
hub/                   shared, portable component library that profiles mount components from
examples/              example projects, incl. jaffle-wren (bundled MDL + DuckDB; no connection
                       wired, so not queryable as-shipped)
docs/
  spec/                THE CONTRACT — authoring.md (profiles/components) · ir-schema.md · capability-model.md ·
                       blast-radius.md · binding-spec.md · enforcement-seam.md · glossary.md
  roadmap.md           (narrative: findings + phasing)
  site/                Docusaurus documentation site (getting-started · concepts · guides ·
                       reference · community)
```

`genbi-default/` is the flagship profile: it mounts the four consuming GenBI components from the
Hub (`hub/components/`) and is a compiler golden. `examples/demo-agent/` and
`examples/render-demo/` are smaller example projects, also used as compiler goldens.

## The `warble` CLI

One native binary spans the whole CLI-target path (no Node required). Install a released binary —
see [Installation](./docs/site/docs/getting-started/installation.md) for the shell installer,
prebuilt tarballs, and `cargo install warble-cli` — or build it from source in this checkout:

```bash
cargo build --release --locked -p warble-cli    # or: just release  → target/release/warble

warble compile examples/render-demo -o ir.json                # project → IR
warble dispatch ir.json --target claude-code:headless --out agent \
        [--render-flavor programmatic|prompt] \
        [--context-injection schema-only|schema+knowledge]   # IR → Claude Code agent files
warble dispatch ir.json --target vercel --out bundle \
        --provider providers/genbi.yaml                       # IR → vercel bundle (+ domain provider)
warble manifest ir.json                                       # IR → capability manifest (stdout)
warble render result.json --out dashboard.html                # captured envelope → deterministic HTML
warble blast-radius examples/mutate-agent --node model:orders \
        --max-severity structural                             # lineage blast radius (+ apply gate)
warble mcp-serve --steps agent/mcp-steps.json                  # stdio MCP server for hybrid local_infer
warble eval compare < request.json                            # result-set comparison (eval loop)
```

Running an emitted agent needs the `wren` CLI on a queryable wren project; see the generated `RUN.md`.

### Render flavors
The render contract has two flavors (`docs/spec/ir-schema.md` §v0.3): **programmatic** (default — the
agent stays read-only and emits a `{blocks}` envelope; `warble render` produces HTML
deterministically) and **prompt** (`--render-flavor prompt` — the agent writes the file itself).

## Build & test

Prereqs: Rust (cargo) — the eval runner is a Rust workspace member too. Node is only needed for
the TS back-ends and the Docusaurus docs site.
[`just`](https://github.com/casey/just) wraps the flows: `just build`, `just test`, `just lint`
(Rust workspace); `just install-ts`, `just lint-ts`, `just test-ts` (the `claude-agent-sdk` package).
The Codex target has parallel `just install-codex-ts`, `just lint-codex-ts`,
`just test-codex-ts`, and `just build-codex-ts` recipes.
`cargo test` at the root covers the whole workspace (compiler, back-end, comparator, CLI).

## Status

v1 realizes three behavior tiers in **both** reference back-ends — **MVP** (`skill` realization,
`render`/`none` outcome, `one_shot` trigger), **+Assertive** (`tool` realization, `assertion`
outcome, `scheduled` trigger), and **+Mutating** (`gated-tool` realization, `mutation` outcome,
blast-radius-gated human approval) — proven end-to-end on the Claude Code CLI and validated against
their eval goldens. The only remaining wall-hits are **+Orchestrating**'s `dispatch` outcome and the
`event` trigger: documented, loud-failing **extension points**. Adding one is additive (+1 handler),
never a rewrite. See `docs/roadmap.md` for the full stage table and what each tier unlocks.

A second reference back-end, `claude-agent-sdk` (TS, in-loop `query()`), realizes the same MVP +
Assertive + Mutating surface on a non-file runtime — proving the IR is a real cross-language seam
and closing three file-target wall-hits (per-step tier in-loop, runtime guardrail enforcement,
per-step trace). See `dispatcher/claude-agent-sdk/README.md`.

Deferred: **+Orchestrating**, the Rust bindings (`wasm`/`py`/`napi`), and the UI.
