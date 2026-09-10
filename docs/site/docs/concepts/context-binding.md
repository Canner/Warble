---
title: Context binding
description: "How a profile binds a Wren project, raw source, or external context through a host-selected ContextLoader."
---

Every component declares only the *shape* of context it needs. A profile's context binding supplies
the actual context and its `kind`; the selected adapter answers each mounted component's
preconditions. That context can be an existing Wren project, a constitutive component's raw input,
or an external layer the local compiler deliberately does not inspect.

## What it's pointed at

`context.project` in `profile.yml` points indirectly at a binding file, which must declare its
`kind` — there is no default. The usual kind is a semantic layer its own owner has already resolved:

```yaml
# context/binding.yml
kind: prepared
project: ../jaffle-wren            # the layer's identity
document: context/context.json     # the projection the host wrote
```

That coarse `project` locator is what back-ends need at runtime — a query tool has to be pointed at
something real to answer questions — and it is what `{{project}}` renders into prompts. But the
compiler doesn't stop at "this path exists."

Warble reads no semantic format itself. The `document` is the seam: a host that speaks MDL, dbt, OSI
or anything else reads its own layer and writes out the narrow projection the compiler probes, so a
format Warble has never heard of binds without teaching Warble about it.

The other natively resolved kind is a raw-source directory, used before a semantic layer exists:

```yaml
kind: raw_source
project: ../raw
```

It must contain `schema.json`; a `docs/` directory with at least one file additionally makes the
`raw_docs_readable` probe answer true. `kind: external` instead treats `project` as an opaque
locator, performs no local I/O, and cannot answer any precondition.

## Fine-grained binding

At compile time, a `ContextLoader` is selected for the binding kind. For `prepared`, the document
supplies the projection: declared metrics and the additivity the producer inferred, dimensions
(including which are temporal), grains, a lineage graph over models, relationships, cubes and views,
and an impact analysis. The compiler then **evaluates** every component's `context_precondition`
entries against that projection, not just against a closed vocabulary of predicate names.

This is a meaningful upgrade from "the project parses." A component that declares
`{ predicate: has_metric }` doesn't just need *a* bound layer — it needs one where that predicate is
actually true. Evaluation has three outcomes, and only one of them lets the IR emit:

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
answerable only by a raw-source binding; a semantic-layer projection reports them as unanswerable.

## Coarse and fine-grained, together

For `prepared`, the fine-grained result lands in the IR as `context_binding.resolved` — metrics,
dimensions, time dimensions, models, and a lineage summary (`{ nodes, edges, resolvable }`) —
alongside the retained coarse `project` locator. A raw-source binding emits an empty semantic
inventory (so semantic existence predicates answer false) while separately answering its two
raw-shape probes; `external` omits `resolved` entirely and makes any declared predicate
unanswerable. Fine-grained binding is additive, not a replacement: a back-end that only needs a
project locator still gets one, and richer analysis (like `blast_radius`) reads the resolved block
on top.

:::note
`blast_radius` — the downstream closure of a lineage node with a worst-severity rollup — is
**supplied by the layer's owner**, not computed here, and Warble's contribution is the gate: a
threshold authored beside the behaviour and enforced at dispatch, refusing the apply outright when
no analysis was supplied. It's still the one capability Warble provides rather than borrowing from a
runtime, for that reason rather than for the arithmetic. See the
[blast radius reference](/reference/blast-radius).
:::

## Where to go next

For the full predicate vocabulary, the resolved-block shape, and the loud-fail matrix, see the
`context_binding` section of the [IR schema reference](/reference/ir-schema). For how Warble's
other binding, resolved at dispatch — tier name to concrete model — works, see the
[tier-to-model binding spec](/reference/binding-spec) and [blast radius](/reference/blast-radius)
for what the resolved lineage graph unlocks.
