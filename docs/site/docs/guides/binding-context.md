---
title: Binding a context
description: "Bind a Wren project, raw source, or external context and declare preconditions that compile evaluates as pass, fail, or unanswerable."
---

Every component declares only the *shape* of context it needs. Binding is what turns that shape
requirement into a real, checked answer: select a context kind and locator, and `warble compile`
evaluates every mounted component's preconditions through the matching adapter. For the underlying
model — what a `ContextLoader` introspects and what `blast_radius` builds on top of it — see
[Context binding](/concepts/context-binding); for the resolved IR shape, see the
[IR schema reference](/reference/ir-schema).

**1. Point the profile at the binding file**

```yaml
# profile.yml
context:
  project: ./context/binding.yml
```

This is indirection, not the path itself — the actual project path lives in the binding file.

**2. Set the binding file's project path**

```yaml
# context/binding.yml
kind: wren_project       # default when omitted
project: ../jaffle-wren
```

`project` is a relative path to a wren project directory, resolved relative to the Warble project
dir. This is the coarse path back-ends need at runtime — the `wren` CLI has to be pointed at an
actual directory to answer questions.

For a constitutive component whose input predates the MDL, bind a raw-source directory instead:

```yaml
kind: raw_source
project: ../raw
```

The directory must contain `schema.json`. If `docs/` contains at least one regular file,
`raw_docs_readable` answers true; with no such file it answers false. `kind: external`
accepts an opaque locator and performs no local I/O, so every declared precondition is
unanswerable.

**3. Declare context_precondition on a component**

```yaml
# components/generate_dashboard/component.yml
context_precondition:
  - { predicate: has_metric }
  - { predicate: has_groupable_dimension }
```

`predicate` must be one of exactly eleven closed-vocabulary names: `mdl_parseable`, `has_metric`,
`has_queryable_dimension`, `has_time_dimension`, `has_groupable_dimension`, `metric_additive`,
`model_has_timestamp`, `lineage_resolvable`, `wren_project_exists`, `source_introspectable`, or
`raw_docs_readable`. An unknown predicate name is a compile-time loud fail on its own, before
evaluation even runs.

**4. Compile and let it prove the preconditions**

```bash
warble compile <project-dir> -o ir.json
```

For `kind: wren_project`, the injected `ContextLoader` introspects the bound MDL — metrics and their additivity,
dimensions (including which are temporal), grains, and a lineage graph — and evaluates each
declared predicate against that introspection.

## Pass, fail, or unanswerable

Evaluation has exactly three outcomes, and only one lets the IR emit:

- **pass** — the predicate holds; recorded in `precondition_result.checks`.
- **fail (answerable-and-false)** — the predicate is decidable but doesn't hold on this project →
  loud compile fail (`context precondition '<name>' not satisfied by the bound semantic layer`).
- **unanswerable** — the semantic format can't express the answer at all → a distinct loud fail
  (`… cannot be evaluated … Refusing rather than answering wrongly.`), never a silent false.

The ordinary existence predicates evaluate **loose for existence, strict for semantics**:
`has_metric` and the `has_*_dimension` family are satisfied by either a declared cube member *or*
a plain model column, so a cube-less project can still answer ordinary data questions.
`metric_additive` is unanswerable when there is no declared metric. `source_introspectable` and
`raw_docs_readable` are unanswerable when the bound context adapter cannot answer raw-source shape
questions (for example, an MDL-only adapter). A raw-source adapter instead evaluates each to pass
or fail.

```yaml
# existential — passes if the layer declares at least one additive metric
- { predicate: metric_additive }

# pinned — the named metric specifically must be a declared, additive measure
- { predicate: metric_additive, args: { metric: total_revenue } }
```

:::note
A missing or unparseable project still fails at the coarser level, before any predicate
evaluation runs: `context precondition failed: bound project '<path>' is not a parseable wren
project …`.
:::

## What lands in the IR

A passing `wren_project` compile carries the introspection result forward in `context_binding.resolved` —
`metrics`, `dimensions`, `time_dimensions`, `models`, and a `lineage` summary
(`{ nodes, edges, resolvable }`) — alongside the retained coarse `project` path. This is what
unlocks `blast_radius`: the transitive downstream closure of a lineage node, with a worst-severity
rollup. See the [blast radius reference](/reference/blast-radius).

A raw-source binding emits an empty semantic inventory (so semantic existence predicates answer
false) and separately answers its two raw-shape probes. An external binding omits
`context_binding.resolved` entirely and makes any declared precondition unanswerable.

## Gotchas

- Fine-grained binding is additive, not a replacement — a back-end that only needs to point `wren`
  at a directory still can, via the retained coarse `project` path.
- `metric_additive`, `source_introspectable`, and `raw_docs_readable` can be unanswerable. The
  latter two require a raw-source context adapter; other predicates are answerable by inspection.
- A precondition that fails or is unanswerable aborts the whole compile — there's no partial IR to
  inspect and no way to "compile around" it.

- **[Context binding](/concepts/context-binding)** — What a `ContextLoader` introspects and how it's kept fine-grained.
- **[IR schema](/reference/ir-schema)** — The full `context_binding` / `precondition_result` shape and loud-fail matrix.
