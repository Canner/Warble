---
title: Components
description: "A component is the reusable behavior unit (a \"data verb\") a profile mounts — a manifest and prompt templates carrying a type and a required realization_kind."
---

A component is one reusable "data verb" — `generate_dashboard`, `answer_query`, `explain_change` —
packaged as a directory: a declarative manifest (`component.yml`) and one prompt template per LLM
step (`steps/*.md`). The current component manifest schema has no field for a hook or sibling code
file; adding one is rejected as an unknown manifest field. Imperative runtime integration is not an
authoring surface of `component.yml` today.

A component never contains a concrete binding like `analytics.orders` — it only declares the shape
of context it needs (`context_requirements`, `context_precondition`). The profile that mounts it
supplies the concrete context, bind values, and supported mount fields. That's what makes a component shareable: the
same `generate_dashboard` component can be mounted, unmodified, by any profile over any semantic
layer that satisfies its preconditions.

## Type and required `realization_kind`

`type` classifies *what kind of behavior* a component is. `realization_kind` says how it connects
to the LLM and must be authored explicitly in every `component.yml`; the parser does not derive a
default from `type`.

| `type` | conventional `realization_kind` | why | v1 |
| --- | --- | --- | --- |
| `analytical` | `skill` | read-only query/render; the driver runs it in-loop | implemented |
| `assertive` | `tool` | monitoring: its own tier + an alerting boundary | implemented |
| `mutating` | `gated-tool` | edits: a tool call plus a hard human-approval gate | implemented |
| `constitutive` | `gated-tool` | reads raw input and proposes a scoped semantic-context mutation | implemented |
| `orchestrating` | `skill` | routes to sub-agents, called as tools | scaffolded |

Shipped components conventionally use `skill` (in-loop instructions the driver follows directly),
`tool` (its own tier-bound call), or `gated-tool` (a tool call behind an approval gate). A profile
mount may replace the authored `realization_kind`; the compiler does not infer it from `type`.
`analytical`, `assertive`, `mutating`, and `constitutive` have shipped compiler and dispatcher paths
(subject to each target's wall-hit matrix); `orchestrating` remains a
documented, loud-failing extension point — dispatching it today is a clean wall-hit, never a wrong
agent.

## Component anatomy: four IR positions, one set of fields

A component's "anatomy" — the thing that varies across the five families — is really just **four IR
positions**: `type`, `realization_kind`, `trigger.kind` (what starts it — `one_shot`/`scheduled`
implemented; `event` scaffolded), and `effect.outcome.kind` (what it produces — `none` for
render-only, plus `assertion`/`mutation`/`dispatch` for the other three types). Every component
family, whatever its type, reuses the exact same `component.yml` shape and the same `steps/*.md`
convention. Nothing about authoring a `mutating` component is structurally different from
authoring an `analytical` one — only the values in those four positions change, plus the guardrails
that go with them (a `mutating` component carries a `human_approval` guardrail; an `analytical`
one carries `read_only_execution`).

The constitutive family is the important inversion: its input is a `kind: raw_source` binding and
its output is the semantic context. It uses the same `mutation` outcome arm with `target: context`,
plus a path-scoped `context_write_authz` guardrail. The shipped `bootstrap_mdl` and
`enrich_knowledge` components exercise the `source_introspectable` and `raw_docs_readable`
preconditions respectively.

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
`generate_dashboard`, `explain_change` — all `analytical`/`skill`. `explore_model` and
`answer_query` require only `mdl_parseable`; the dashboard and change-explanation components declare
no compile-time data-shape precondition. Richness checks such as groupability and additivity belong
to the sub-agent/runtime path, not these component mounts.

## Where to go next

- **[Tiers & model binding](/concepts/tiers-and-model-binding)** — How an authored tier becomes a concrete model at dispatch time.
- **[Capabilities & guardrails](/concepts/capabilities-and-guardrails)** — What a component asks of its runtime, and what it can never be talked out of.

For the exact `component.yml` field list, see the [profile & component schema reference](/reference/profile-schema).
