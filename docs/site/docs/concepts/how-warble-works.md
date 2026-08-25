---
title: How Warble works
description: "The end-to-end mental model: a declarative profile compiles through a language-neutral IR to a thin per-target back-end that emits a native agent."
---

Warble splits a data agent into two things that change at very different rates: **what the agent
does** (behavior, authored as data) and **how that behavior runs on a given runtime** (mechanism,
owned by a back-end). Everything about the pipeline follows from keeping those two apart.

## The pipeline

```
profile + components + context      IR (the seam)         native agent
  (declarative YAML + prompts) ──►  warble compile  ──►  warble dispatch  ──►  .claude/agents/… ──► claude -p --agent …
        authored, git-diffable       (front-end)          (back-end)          (native agent files)   (answers via `wren`)
```

- **Front-end compiler** (`core/`, Rust) receives the deserialized profile, mounted components, and
  adapter-provided context; resolves component fields with supported mount fields; validates everything (missing binds,
  weakened guardrails, unresolvable context preconditions all loud-fail here); and emits one IR
  document.
- **Back-end / dispatcher** (per target) legalizes that IR onto a specific runtime — reading its
  enums, binding tiers to concrete models, and emitting whatever that runtime needs (static agent
  files, an in-loop `query()` driver, …).
- **Native agent/runtime** executes the materialized behavior against its bound context and host
  capabilities.

## Why the IR is the seam

Every back-end consumes the *same* `ir.json` — there is no back-channel where a dispatcher reads
`profile.yml` directly, and no dispatcher-specific dialect of the IR. That single seam is what lets
back-ends stay thin and swappable: the Claude Code file target, Vercel bundle target, Agent SDK
driver, and standalone Codex-local peer all consume the same compiled contract without importing
one another. Adding another target means writing a new
consumer of `ir.json` — never touching the compiler or any other back-end.

This is also why the IR is deliberately **runtime-agnostic**: it never names a mechanism like
"cron" or "subagent" or "Slack." A component declares *what it needs* (`required_capabilities`,
tiers, a render contract); each back-end decides *how* to realize that on its own runtime. When a
target can't realize an IR arm, it loud-fails — a **wall-hit** — rather than silently emitting
something wrong. See [Targets & wall-hits](/concepts/targets-and-wall-hits).

## The zero-wren boundary

The compiler core and every component stay **transitively wren-free**. The only place a dependency
on `wren-core-base` is allowed to enter the workspace is the MDL adapter
(`bindings/mdl-context`) — the `ContextLoader` implementation that introspects a wren project at
compile time. Everything else (`core/`, every dispatcher, the CLI) is portable by construction, not
by convention; that boundary is what lets the same front-end target native, WASM, and future
language bindings unchanged.

:::note
`core/` is also **sans-IO**: it never touches the filesystem or network directly. The host injects
already-resolved context answers through the `ContextLoader` trait, which is what makes the zero-wren boundary and the
cross-language portability possible at the same time.
:::

## Where to go next

- **[The IR](/concepts/ir)** — What the compiled seam actually carries, and why it grows only additively.
- **[Targets & wall-hits](/concepts/targets-and-wall-hits)** — How a back-end legalizes the IR onto a runtime, and what happens when it can't.

For the exact JSON shape the compiler emits, see the [IR schema reference](/reference/ir-schema).
