---
title: Introduction
description: "Warble is a data behavior framework — you declare what a data agent should do, and Warble compiles it into a native agent for your runtime."
slug: /
---

**Warble is a data behavior framework.** You declare *what a data agent should do* as a
composable, git-authoritative **profile** — components plus guardrails plus config, bound to a
semantic context. Warble's front-end compiles that profile into a language-neutral **IR**, and a
thin, replaceable back-end legalizes the IR onto a runtime target and emits a native agent.

```
profile + components + context      IR (the seam)          native agent
  (declarative YAML + prompts) ──►  warble compile  ──►  warble dispatch  ──►  .claude/agents/…
        authored, git-diffable       (front-end)          (back-end)          (runs via `wren`)
```

## The thesis

**One data-native front-end, a thin swappable back-end per runtime, with the IR as the seam.**

The contract — profile schema + capability manifest + IR — is the product. Prompts, agent config,
and each runtime's back-end are *derived or commodity*. That inversion is what lets the same
declared behavior target Claude Code, an in-loop agent SDK, or a serverless bundle without rewriting
the behavior.

- **Declarative & git-authoritative** — Behavior is authored YAML + prompts you can diff, review, and version — not code buried in an agent loop.
- **Runtime-agnostic IR** — The compiler emits one language-neutral IR; every back-end consumes the same JSON. No runtime mechanism names leak into it.
- **Capability-gated & safe** — Each behavior declares what it needs of its runtime. Safety-critical capabilities loud-fail rather than silently degrade.
- **Semantic-layer native** — Profiles bind to a semantic context (a wren project / MDL), so agents answer through a governed model — not raw SQL over raw tables.

## How it fits together

Three parts, joined by language-neutral seams so back-ends stay swappable:

| Part | What it does | Language |
| --- | --- | --- |
| **Front-end compiler** | parse profile/component/context → merge defaults ⊕ overrides → validate → emit IR | Rust (`core/`) — sans-IO |
| **Back-end / dispatcher** | legalize the IR onto one runtime → emit a native agent | per target |
| **UI** | authoring + results surface | future |

The compiler core is **sans-IO** — no file or network access; the host injects file contents. That
is what lets the same front-end target native binaries, WASM, and language bindings unchanged.

## When to use Warble

- You want a data agent's behavior to be **reviewable and versioned**, not an opaque prompt.
- You need the **same behavior across more than one runtime** (e.g. an interactive CLI agent and a
  headless serverless one).
- You care about **guardrails and blast radius** — knowing, and gating, what a mutating change would
  touch downstream in your semantic model.

## Next steps

- **[Installation](/getting-started/installation)** — Build the `warble` binary and check your toolchain.
- **[Quickstart](/getting-started/quickstart)** — Compile and dispatch an example agent end-to-end in ~5 minutes.
- **[How Warble works](/concepts/how-warble-works)** — The mental model: front-end, IR, back-end, and why the contract is the product.
- **[Glossary](/reference/glossary)** — The load-bearing terms in one place.
