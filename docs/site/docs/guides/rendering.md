---
title: Rendering results into a dashboard
description: "How to turn a captured result envelope into a deterministic HTML dashboard with warble render, and the difference between the programmatic and prompt render flavors."
---

`warble render` turns a captured agent result — a `{blocks}` envelope — into a self-contained
`dashboard.html`. This page covers the command and the two render flavors that decide who produces
that envelope in the first place. For the block-type contract itself, see
[Render contract](/concepts/render-contract).

**1. Run the dispatched agent and capture its output**

```bash
claude -p "How many customers do we have by status?" --agent dashboard \
    --output-format json > result.json
```

The agent's final message is a structured envelope, not prose — a list of typed block instances
plus optional prose:

```jsonc
{ "blocks": [
    { "type": "kpi_card", "label": "Total customers", "value": 100 },
    { "type": "table", "columns": ["status", "orders"], "rows": [["completed", 67]] }
  ],
  "summary": "…prose…" }
```

**2. Render it**

```bash
warble render result.json --out dashboard.html
```

`input` also accepts `-` for stdin, so the two steps can pipe together. `warble render` unwraps the
`--output-format json` result object automatically and tolerates a model that fences or
prose-wraps the envelope — you don't need to pre-clean the capture. Add `--title` for a custom
dashboard heading.

## Programmatic vs. prompt: who writes the file

The IR itself is flavor-agnostic — `effect.render_blocks` just declares which typed blocks a
component produces. Which flavor runs is a dispatch-time choice
(`warble dispatch --render-flavor programmatic|prompt`), and it changes who actually writes
`dashboard.html`:

- **programmatic** (default) — the emitted agent stays fully read-only: no `Write` tool at all. It
  emits the `{blocks}` envelope as its final message, and `warble render` turns that envelope into
  HTML **deterministically** — inline SVG charts, no clock or RNG, so the same envelope always
  produces identical bytes. This is the two-step flow shown above.
- **prompt** (`--render-flavor prompt`) — for a target with no post-step to run a renderer, the
  dispatcher bakes the block contract and a "write `dashboard.html`" instruction into the prompt
  itself, and grants the agent a scoped `artifact_write`. The agent produces the HTML directly, so
  the result is LLM-authored and not byte-for-byte reproducible.

:::warning
Rendering writes a file, but the component underneath is still `read_only_execution` — these are
two separate enforcement points, not one. `data:read_only` (never mutate the warehouse) holds
unconditionally; `artifact:write` (scoped to the output directory) is only ever granted on the
prompt flavor, since programmatic never hands the agent a write tool in the first place.
:::

## Typed blocks

Warble ships a small stdlib of block types, each with its own field schema: `kpi_card`, `table`,
`chart`, `narrative` (prose output, e.g. for `explain_change`), and `diff` (a mutating component's
dry-run proposal, rendered as escaped unified-diff text — presentational only, it doesn't apply
anything). A renderer that doesn't recognize a block type degrades to markdown or loud-fails,
following the same resolution as any other capability. See the
[IR schema reference](/reference/ir-schema) for the full field schemas and envelope shape,
including the optional `verified` and per-block `definition` provenance fields.
