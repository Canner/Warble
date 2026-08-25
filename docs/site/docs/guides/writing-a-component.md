---
title: Writing a component
description: "Author a component.yml from its identity spine through llm_steps, guardrails, required_capabilities, and effect, plus the prompt files it points at."
---

A component is a directory: a declarative `component.yml` manifest plus one prompt file per LLM
step. It declares a reusable behavior — never a concrete dataset — so the same component can be
mounted by any profile whose bound context satisfies its preconditions. This guide walks through
authoring one field group at a time. For the type/realization_kind mental model, see
[Components](/concepts/components); for the exhaustive field list, see the
[profile schema reference](/reference/profile-schema).

**1. Lay out the directory**

```
components/answer_query/
├── component.yml
└── steps/
    ├── resolve_intent.md
    └── generate_sql.md
```

`component.yml` is pure data. The current manifest schema has no field that points at sibling hook
code; a hook-related manifest field is rejected as unknown. Keep this authoring directory to the
manifest and its prompt files unless a future schema explicitly adds a supported hook surface.

**2. Declare the identity spine**

```yaml
id: answer_query
verb: answer_query
type: analytical            # analytical | assertive | mutating | constitutive | orchestrating
realization_kind: skill     # required; shipped components conventionally use skill | tool | gated-tool
binding_mode: runtime_selected   # runtime_selected | pinned
```

`realization_kind` is required; the parser does not default it from `type`. Shipped components
conventionally pair `analytical` and `orchestrating` with `skill` (in-loop instructions),
`assertive` with `tool`, and `mutating`/`constitutive` with `gated-tool`. `analytical`, `assertive`,
`mutating`, and `constitutive` have shipped compiler and dispatcher paths; `orchestrating` remains a documented, loud-failing extension
point — dispatching it is a clean wall-hit, never a wrong agent.
See
[Components](/concepts/components) for what changes (and what doesn't) across the five families.

**3. Declare context requirements**

```yaml
context_requirements:
  - "a wren project (semantic layer) to query"
context_precondition:
  - { predicate: mdl_parseable }
```

`context_requirements` is free-text prose for discoverability — not compile-checked.
`context_precondition` is structured and machine-checked: each `predicate` must be a member of a
closed eleven-name vocabulary — `mdl_parseable`, `has_metric`, `has_queryable_dimension`,
`has_time_dimension`, `has_groupable_dimension`, `metric_additive`, `model_has_timestamp`,
`lineage_resolvable`, `wren_project_exists`, `source_introspectable`, and `raw_docs_readable` —
and `warble compile` evaluates it against whatever context the mounting profile binds. See
[Binding a context](/guides/binding-context) for how that evaluation works.

**4. Declare params**

```yaml
params:
  - { name: topic_default, bind: optional, default: "overview" }
  - { name: connection,     source: runtime-injected }
```

Each entry declares exactly one of `bind` (profile-supplied — `required` or `optional` with a
`default`) or `source: runtime-injected` (supplied by the runtime at dispatch/run time, never
committed to git). Declaring both, or neither, is a compile error.

**5. Write llm_steps and their prompts**

```yaml
llm_steps:
  - { name: resolve_intent, tier: cheap, prompt_ref: steps/resolve_intent.md,
      produces: query_intent }
  - { name: generate_sql, tier: strong, prompt_ref: steps/generate_sql.md,
      consumes: [query_intent], produces: query_result }
```

Each step names a `tier` (`strong`/`cheap` are the standard core; the vocabulary is open) — an
abstract capability class, never a concrete model — plus a `prompt_ref` pointing at a markdown file
under `steps/`, and named `consumes`/`produces` I/O slots. A step can also be `conditional: true`
with a `when` guard (`on_failure`, `on_flag`, or `on_missing`) naming why it only sometimes runs;
declaring `conditional` without `when`, or `when` without `conditional: true`, is a compile error.

**6. Declare guardrails**

```yaml
guardrails:
  - { name: read_only_execution, locked: true }
  - { name: verbosity, overridable: true }
```

Declare exactly one of `locked` or `overridable` per guardrail. `locked: true` is a safety floor no
mounting profile can weaken; `overridable: true` normalizes to `locked: false` in the IR. A profile
mount may patch only that `locked` value for a guardrail that is not already locked. It cannot tune
a threshold, cadence, routing target, or other guardrail data.

**7. Declare required_capabilities and effect**

```yaml
required_capabilities:
  - sql_execution:read_only
  - llm:per_step_tier
  - llm:strong
  - llm:cheap
borrowed_actions: []
effect:
  render_blocks: [chart, table, kpi_card]
  outcome:
    kind: none          # none | assertion | mutation | dispatch
```

`required_capabilities` is what the component needs of its runtime — resolved at dispatch as
native, realize-via, degrade, or fail. `effect.render_blocks` lists the typed output blocks this
component emits (Warble ships a small stdlib: `kpi_card`, `table`, `chart`, `narrative`, `diff`).
`effect.outcome.kind` stays the stable four-value union; an `analytical` component is almost always
`none`.

## The five component families, briefly

| `type` | conventional `realization_kind` | why |
| --- | --- | --- |
| `analytical` | `skill` | read-only query/render, run in-loop |
| `assertive` | `tool` | monitoring: its own tier + an alerting boundary |
| `mutating` | `gated-tool` | edits: a tool call behind a hard human-approval gate |
| `constitutive` | `gated-tool` | reads `kind: raw_source` input and proposes a scoped context mutation |
| `orchestrating` | `skill` | routes to sub-agents, called as tools |

Every family reuses the exact same `component.yml` shape — only the values in these four positions
(and the preconditions/guardrails that go with them) change. Constitutive components use
`source_introspectable` or `raw_docs_readable`, emit `effect.outcome.kind: mutation` with
`target: context`, and rely on a scoped `context_write_authz` guardrail; the mounting profile binds
their input through a `kind: raw_source` context binding. See [Components](/concepts/components) for
the full anatomy.

## Gotchas

- `component.yml` is checked with `deny_unknown_fields`: any field the schema doesn't recognize is
  a compile-time loud fail, never silently dropped.
- `manifest` is never an authoring field — it's a projection `warble manifest` derives from the
  compiled IR.
- `eval` (`{ template_ref, metrics: [...] }`) is optional; omit it entirely rather than authoring
  an empty block.

- **[Components](/concepts/components)** — The type / realization_kind / trigger / outcome anatomy.
- **[Profile schema](/reference/profile-schema)** — Every component field, exhaustively.
