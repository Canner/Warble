---
title: Components
description: "A component is the reusable behavior unit (a \"data verb\") a profile mounts — a manifest plus optional tool/hook code, carrying a type and a realization_kind."
---

A component is one reusable "data verb" — `generate_dashboard`, `answer_query`, `explain_change` —
packaged as a directory: a declarative manifest (`component.yml`), one prompt template per LLM step
(`steps/*.md`), and optionally a sibling code file (`hooks.rs`/`.ts`/`.py`) for the one place
imperative logic is allowed to live. The manifest is pure data; code is a file it *points at*, never
inlined — so "the manifest is data, the mechanism is code" stays a clean split you can see at a
glance.

A component never contains a concrete binding like `analytics.orders` — it only declares the shape
of context it needs (`context_requirements`, `context_precondition`). The profile that mounts it
supplies the concrete context, params, and any tuning. That's what makes a component shareable: the
same `generate_dashboard` component can be mounted, unmodified, by any profile over any semantic
layer that satisfies its preconditions.

## Four types, each with a default `realization_kind`

`type` classifies *what kind of behavior* a component is, and picks a default for *how it connects
to the LLM* (`realization_kind`):

| `type` | default `realization_kind` | why | v1 |
| --- | --- | --- | --- |
| `analytical` | `skill` | read-only query/render; the driver runs it in-loop | implemented |
| `assertive` | `tool` | monitoring: its own tier + an alerting boundary | scaffolded |
| `mutating` | `gated-tool` | edits: a tool call plus a hard human-approval gate | scaffolded |
| `orchestrating` | `skill` | routes to sub-agents, called as tools | scaffolded |

`realization_kind` is one of exactly three values — `skill` (in-loop instructions the driver
follows directly), `tool` (its own tier-bound call), or `gated-tool` (a tool call behind an
approval gate). It's defaulted from `type` but a profile mount may override it. v1 realizes the
`analytical` / `skill` path end to end; the other three types are documented, loud-failing
extension points — dispatching one today is a clean wall-hit, never a wrong agent.

## Component anatomy: four IR positions, one set of fields

A component's "anatomy" — the thing that varies across the four types — is really just **four IR
positions**: `type`, `realization_kind`, `trigger.kind` (what starts it — `one_shot` in v1;
`scheduled`/`event` scaffolded), and `effect.outcome.kind` (what it produces — `none` for
render-only, plus `assertion`/`mutation`/`dispatch` for the other three types). Every component
family, whatever its type, reuses the exact same `component.yml` shape and the same `steps/*.md`
convention. Nothing about authoring a `mutating` component is structurally different from
authoring an `analytical` one — only the values in those four positions change, plus the guardrails
that go with them (a `mutating` component carries a `human_approval` guardrail; an `analytical`
one carries `read_only_execution`).

## Steps and tiers are git-static

Each `llm_steps[]` entry names a **tier** — `strong` or `cheap`, an abstract capability class, not
a concrete model — alongside its prompt template and named `consumes`/`produces` I/O slots. That
tier assignment is authored, committed data: it lives in `component.yml` and is visible in a diff
like anything else. What tier a step runs at is fixed at author time (a profile may retune a
specific step via `tier_overrides`); *which concrete model* that tier becomes is a separate,
runtime-injected decision made only at dispatch — never in the component or the profile. This is
what lets the same component run `strong→opus` in one dispatch and `strong→haiku` in the next
without changing a single authored file.

## The flagship library

`genbi-default/` mounts four consuming components — `explore_model`, `answer_query`,
`generate_dashboard`, `explain_change` — all `analytical`/`skill`, each illustrating the same
anatomy against real preconditions (a groupable dimension, a declared additive metric, …) over the
bundled `jaffle-wren` semantic layer.

## Where to go next

- **[Tiers & model binding](/concepts/tiers-and-model-binding)** — How an authored tier becomes a concrete model at dispatch time.
- **[Capabilities & guardrails](/concepts/capabilities-and-guardrails)** — What a component asks of its runtime, and what it can never be talked out of.

For the exact `component.yml` field list, see the [profile & component schema reference](/reference/profile-schema).
