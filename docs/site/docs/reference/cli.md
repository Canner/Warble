---
title: CLI reference
description: "Every warble subcommand, its flags, and what it emits — compile, dispatch, render, manifest, blast-radius, mcp-serve, and the eval subcommand family."
---

`warble` is a single native binary. This page lists every subcommand and flag; for how they fit
together in a workflow, see the guides linked from each section.

## `warble compile`

```bash
warble compile <project-dir> -o ir.json [--component-dir <path>]... [--hub-dir <path>]
```

Merges component defaults, profile overrides, and the bound context into a compiled IR document.

| Flag | Description |
| --- | --- |
| `<project-dir>` | A Warble project directory (contains `profile.yml`) |
| `-o, --out <path>` | Where to write the compiled IR JSON |
| `--component-dir <path>` | An additional Local component source (repeatable) |
| `--hub-dir <path>` | Override the Hub root used for fallback resolution |

See [Authoring a profile](/guides/authoring-a-profile) and
[Mounting components](/guides/mounting-components).

## `warble dispatch`

```bash
warble dispatch <ir.json> --target <target> --out <dir> [flags]
```

Legalizes a compiled IR onto one runtime target, emitting that target's native agent.

| Flag | Description |
| --- | --- |
| `<ir.json>` | Path to a compiled IR document |
| `--target <name>` | `claude-code:headless` (default), `claude-code:interactive`, `vercel`, `vercel:headless`, `vercel:interactive` |
| `--out <dir>` | Output directory for the emitted agent/bundle |
| `--render-flavor <programmatic\|prompt>` | `claude-code:*` only — who writes the rendered dashboard |
| `--provider <path>` | `vercel` only — a domain provider fragment (repeatable) |
| `--strong <model>` | Model bound to the `strong` tier |
| `--cheap <model>` | Model bound to the `cheap` tier |
| `--orchestrator <model>` | Model bound to the `orchestrator` tier |
| `--models-config <path>` | A YAML file binding tiers to models/providers, in place of the flags above |
| `--hybrid-realization <bash-script\|mcp-server>` | How a hybrid local step is realized (`bash-script` default) |

See [Dispatching to a target](/guides/dispatching) and
[Hybrid inference](/guides/hybrid-inference). For the full `--models-config` shape, see the
[Tier-to-model binding spec](/reference/binding-spec).

## `warble render`

```bash
warble render <input> --out dashboard.html [--title <text>]
```

Turns a captured `{blocks}` result envelope into a self-contained HTML dashboard. `<input>` accepts
`-` for stdin. See [Rendering results into a dashboard](/guides/rendering).

## `warble manifest`

```bash
warble manifest <ir.json>
```

Prints the derived manifest projection of a compiled IR — a read-only summary, never an authoring
input.

## `warble blast-radius`

```bash
warble blast-radius <project-dir> --node <id> \
    [--max-severity <level>] [--max-downstream <n>] [--protected <ids>]
```

Computes a lineage node's downstream closure and prints an `Allow`/`Escalate`/`Block` decision,
also carried in the exit code (`0`/`10`/`11`). See
[Enforcing safe mutations](/guides/enforcing-mutations) and the
[blast radius reference](/reference/blast-radius).

## `warble mcp-serve`

```bash
warble mcp-serve --steps <mcp-steps.json>
```

Runs as a stdio MCP server realizing hybrid local steps. Not run directly in normal use — spawned
automatically by `claude` from the `.mcp.json` a `--hybrid-realization mcp-server` dispatch emits.
See [Hybrid inference](/guides/hybrid-inference).

## `warble eval`

| Subcommand | Purpose |
| --- | --- |
| `warble eval run` | Replay golden cases against one or more `--models` bindings; prints a Pareto comparison |
| `warble eval compare` | Compare a single actual result set against expected, via a `CompareRequest`/`CompareResult` JSON pair over stdin/stdout |
| `warble eval ablate` | Ablation runs across tier/model bindings for the CI eval gate |
| `warble eval verify-context` | Validate a golden set's assumed context against a bound project |
| `warble eval capture` | Capture a dispatched agent's run into the trace cache |
| `warble eval gate` | The CI gate entry point — wires `compare`/`ablate` into a pass/fail exit code |

See [Evaluating a profile](/guides/evaluating) for the day-to-day `run`/`compare` loop.
