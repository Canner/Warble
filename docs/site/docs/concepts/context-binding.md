---
title: Context binding
description: "How a profile binds a Wren project, raw source, or external context through a host-selected ContextLoader."
---

Every component declares only the *shape* of context it needs. A profile's context binding supplies
the actual context and its `kind`; the selected adapter answers each mounted component's
preconditions. That context can be an existing Wren project, a constitutive component's raw input,
or an external layer the local compiler deliberately does not inspect.

## What it's pointed at

`context.project` in `profile.yml` points indirectly at a binding file. The default kind is an
existing Wren project:

```yaml
# context/binding.yml
kind: wren_project       # default when omitted
project: ../jaffle-wren
```

That coarse project path is what back-ends need at runtime — the `wren` CLI has to be pointed at an
actual project directory to answer questions. But the compiler doesn't stop at "this path exists."

The other natively resolved kind is a raw-source directory, used before an MDL exists:

```yaml
kind: raw_source
project: ../raw
```

It must contain `schema.json`; a `docs/` directory with at least one file additionally makes the
`raw_docs_readable` probe answer true. `kind: external` instead treats `project` as an opaque
locator, performs no local I/O, and cannot answer any precondition.

## Fine-grained binding

At compile time, a `ContextLoader` is selected for the binding kind. For `wren_project`, the MDL
adapter (`bindings/mdl-context`, over `wren-core-base`) introspects the bound MDL: it resolves
declared metrics and their additivity, dimensions (including which are temporal), grains, and
builds a lineage graph over models, relationships, cubes, and views. The compiler then **evaluates**
every component's `context_precondition` entries against that introspection, not just against a
closed vocabulary of predicate names.

This is a meaningful upgrade from "the project parses." A component that declares
`{ predicate: has_metric }` doesn't just need *a* wren project — it needs one where that predicate
is actually true. Evaluation has three outcomes, and only one of them lets the IR emit:

- **pass** — recorded in `precondition_result.checks`.
- **fail** (answerable-and-false) — the predicate is decidable but doesn't hold → loud compile fail.
- **unanswerable** — the semantic format can't express the answer at all (e.g. `metric_additive`
  with no declared metric anywhere) → a distinct loud fail, never a silent false.

The current closed vocabulary has eleven predicates: `mdl_parseable`, `has_metric`,
`has_queryable_dimension`, `has_time_dimension`, `has_groupable_dimension`, `metric_additive`,
`model_has_timestamp`, `lineage_resolvable`, `wren_project_exists`, `source_introspectable`, and
`raw_docs_readable`. The ordinary existence predicates evaluate **loose for existence, strict for
semantics**: `has_metric` and the `has_*_dimension` family are satisfied by either a declared cube
member *or* a plain model column. `metric_additive` is only decidable over an explicitly declared
metric, because additivity isn't a property a bare column has. The two raw-shape predicates are
answerable only by a raw-source context adapter; an MDL-only adapter reports them as unanswerable.

## Coarse and fine-grained, together

For `wren_project`, the fine-grained result lands in the IR as `context_binding.resolved` — metrics,
dimensions, time dimensions, models, and a lineage summary (`{ nodes, edges, resolvable }`) —
alongside the retained coarse `project` path. A raw-source adapter emits an empty semantic
inventory (so semantic existence predicates answer false) while separately answering its two
raw-shape probes; `external` omits `resolved` entirely and makes any declared predicate
unanswerable. Fine-grained binding is additive, not a replacement: a back-end
that only needs to point `wren` at a directory still can, and richer analysis (like
`blast_radius`) reads the resolved block on top.

:::note
For a `wren_project`, `blast_radius` — the transitive downstream closure of a lineage node, with a worst-severity rollup
— is built on the resolved lineage graph. It's the one capability Warble provides natively rather
than borrowing from a runtime. See the [blast radius reference](/reference/blast-radius).
:::

## Where to go next

For the full predicate vocabulary, the resolved-block shape, and the loud-fail matrix, see the
`context_binding` section of the [IR schema reference](/reference/ir-schema). For how Warble's
other binding, resolved at dispatch — tier name to concrete model — works, see the
[tier-to-model binding spec](/reference/binding-spec) and [blast radius](/reference/blast-radius)
for what the resolved lineage graph unlocks.
