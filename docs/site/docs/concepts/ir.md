---
title: The IR
description: "The IR is the language-neutral intermediate representation the front-end emits and every back-end consumes — carrying resolved prompts, per-step tiers, guardrails, the render contract, and required capabilities."
---

The IR is what `warble compile` emits and what every back-end reads — one JSON document, currently
`warble_ir_version: 0.6`. It exists so the compiler and a back-end never need to agree on anything
beyond this one document: the front-end doesn't know which runtime will consume its output, and a
back-end doesn't need to parse YAML, resolve overrides, or evaluate context preconditions — all of
that is already done by the time the IR reaches it. See [How Warble works](/concepts/how-warble-works)
for where this fits in the pipeline.

## What it carries

Each resolved component node in the IR carries everything a back-end needs to realize that
component, and nothing it needs to guess:

- **Resolved prompts** — `prompt_fragment` (all steps joined, for an in-loop runtime) and each
  step's own rendered `prompt` (for a runtime that must realize a step in isolation), with
  placeholders already substituted.
- **Per-step tier + I/O contract** — each `llm_calls[]` entry carries its `tier` name, its
  `conditional`/`when` guard, and its named `consumes`/`produces` slots — enough for a back-end to
  either run steps in-loop or marshal state across an isolated call, without the IR ever naming
  *how*.
- **Guardrails** — each guardrail retains its `name` and any authored `scope` or `threshold` for
  target enforcement. The authoring-time `locked`/`overridable` split normalizes to one `locked`
  boolean, which is the IR's single source of truth for whether that guardrail is locked; it is not
  the only guardrail field a downstream consumer may use.
- **The render contract** — `effect.render_blocks`, typed block schemas (`kpi_card`, `table`,
  `chart`, …) a component's output must conform to.
- **Required capabilities** — a flat list of what the component needs of its runtime
  (`sql_execution:read_only`, `llm:per_step_tier`, `render_contract`, …), resolved per target at
  dispatch, never assumed.
- **Context binding** — the coarse locator plus the adapter-dependent fine-grained result. Wren
  projects carry metrics/dimensions/lineage, raw sources carry an empty semantic inventory while
  answering raw-shape probes, and external bindings omit `context_binding.resolved`. See
  [Context binding](/concepts/context-binding).

## Runtime-agnostic by construction

No mechanism name ever appears in the IR — no `cron`, no `subagent`, no `Slack`. A component that
needs a scheduler declares `required_capabilities: [scheduler]`; it never says *which* scheduler or
*how* one gets wired up. That resolution — native / realize-via / degrade / fail — happens later,
per target, at the capability layer. This is deliberate: it's what keeps the IR meaningful to a
back-end that hasn't been written yet, and what keeps today's back-ends — static Claude Code agent
files, a deployable serverless bundle, an in-loop Agent SDK driver — from leaking each other's
implementation details into the contract they all read.

The same discipline applies to tiers: the IR carries `strong`/`cheap` (or a custom name) as an
open-vocabulary string, never a concrete model. Binding tier to model is a separate,
dispatch-time step — see [Tiers & model binding](/concepts/tiers-and-model-binding).

## Growth is additive, never a rewrite

Every field the IR has gained since the first version — `context_precondition`, `params[].source`,
`llm_calls[].when`, the typed `render_blocks` contract — arrived as a new optional facet, not a
breaking rewrite of an existing one. That is an architectural rule, not an exception to versioning:
under the current exact-match policy, **every IR shape change requires a version bump, including an
additive optional field or unused enum arm**. A consumer may deliberately add support for a new
facet after it has adopted the new version, but it must not silently receive an IR whose shape it
did not accept. This keeps the composition layer from growing a data-flow DSL: the IR grows
*wider*, not *smarter*, while each wider contract remains explicit.

## Where to go next

- **[How Warble works](/concepts/how-warble-works)** — Where the IR sits between the compiler and a back-end.
- **[Targets & wall-hits](/concepts/targets-and-wall-hits)** — What happens when a target can't realize an IR arm.

For the byte-for-byte shape, every field's resolution rule, and the full loud-fail table, see the
[IR schema reference](/reference/ir-schema).
