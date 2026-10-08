---
title: Binding a context
description: "Bind a host-prepared snapshot, raw source, or external context when a behavior needs one, and validate its declared preconditions."
---

Components declare the *shape* of context they need. A profile may omit `context` when none of its
behaviors needs one; start with the [single-file tutorial](/getting-started/first-profile) for that
path. Missing context never satisfies a declared requirement.

For a behavior that needs context, select a kind and locator, and `warble compile` evaluates its
preconditions against the information supplied by the context loader. The CLI reads prepared
snapshots or raw-source files; it does not inspect a database or semantic format itself. For the
underlying model and the host's responsibilities, see
[Context binding](/concepts/context-binding); for the resolved IR shape, see the
[IR schema reference](/reference/ir-schema).

**1. Point the profile at the binding file**

```yaml
# profile.yml
context:
  project: ./context/binding.yml
```

This is indirection, not the path itself — the actual project path lives in the binding file.

**2. Declare the kind and point at the layer**

```yaml
# context/binding.yml
kind: prepared                     # required — there is no default
project: ../jaffle-wren            # the bound layer's identity
document: context/context.json     # the projection its owner wrote
```

`kind` is required: Warble will not guess it. `project` is the coarse locator back-ends need at
runtime — a query tool has to be pointed at something real to answer questions — and it is what
`{{project}}` renders into prompts. `document` names a prepared-context document, resolved relative
to the Warble project dir (**not** to the binding file). Warble reads no semantic format itself, so
whoever owns the layer writes that document; that is how any format binds without Warble speaking it.

The document follows the [prepared-context contract](/reference/profile-schema#43-prepared--the-host-resolved-it).
The host owns the facts and their freshness. Keep `project` as the layer's identity and `document`
as the snapshot path; a missing, malformed or incompatible snapshot is an error.

Older bindings using `kind: wren_project` are rejected by the CLI with migration guidance. Have
the host read the project and produce the snapshot, then use `kind: prepared` and `document` as
above. Changing the kind alone does not produce the required snapshot.

For a constitutive component whose input predates the semantic layer, bind a raw-source directory
instead:

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

**4. Compile and evaluate the preconditions**

```bash
warble compile <project-dir> -o ir.json
```

For `kind: prepared`, Warble loads the supplied projection — including any metrics, additivity,
dimensions, grains, lineage and impact analysis the host provided — and evaluates each declared
predicate against it. A passing check validates the snapshot's declared facts; it does not query
the underlying data or prove that the snapshot is current.

## Pass, fail, or unanswerable

Evaluation has exactly three outcomes, and only one lets the IR emit:

- **pass** — the predicate holds; recorded in `precondition_result.checks`.
- **fail (answerable-and-false)** — the predicate is decidable but doesn't hold on this project →
  loud compile fail (`context precondition '<name>' not satisfied by the bound semantic layer`).
- **unanswerable** — the context loader cannot answer the predicate from the supplied information → a distinct loud fail
  (`… cannot be evaluated … Refusing rather than answering wrongly.`), never a silent false.

The ordinary existence predicates evaluate **loose for existence, strict for semantics**:
`has_metric` and the `has_*_dimension` family are satisfied by either a declared cube member *or*
a plain model column, so a cube-less project can still answer ordinary data questions.
`metric_additive` is unanswerable when there is no declared metric. `source_introspectable` and
`raw_docs_readable` are unanswerable when the bound context adapter cannot answer raw-source shape
questions. A prepared snapshot can supply the corresponding raw-source flags; when they are
absent those predicates are unanswerable. A raw-source loader obtains them from the source files.

```yaml
# existential — passes if the layer declares at least one additive metric
- { predicate: metric_additive }

# pinned — the named metric specifically must be a declared, additive measure
- { predicate: metric_additive, args: { metric: total_revenue } }
```

:::note
An unreadable or invalid prepared document fails during loading. A valid document that reports
`parseable: false` fails before predicate evaluation. The latter diagnostic retains the historical
wording `not a parseable wren project`; it describes the supplied context's parseability and does
not mean Warble inspected a Wren project.
:::

## What lands in the IR

A passing prepared-context compile carries the host's projection forward in `context_binding.resolved` —
`metrics`, `dimensions`, `time_dimensions`, `models`, and a `lineage` summary
(`{ nodes, edges, resolvable }`) — alongside the retained `project` identity. For `blast_radius`,
the host also supplies the impact analysis: affected downstream nodes and severity ranks. Warble
uses that supplied analysis rather than deriving it from a semantic format. See the
[blast radius reference](/reference/blast-radius).

A raw-source binding emits an empty semantic inventory (so semantic existence predicates answer
false) and separately answers its two raw-shape probes. An external binding omits
`context_binding.resolved` entirely and makes any declared precondition unanswerable.

## Gotchas

- `project` remains available to prompts and back-ends as the bound layer's identity. A binding
  does not install a query tool, grant access or create a database connection.
- `metric_additive`, `source_introspectable`, and `raw_docs_readable` can be unanswerable. The
  latter two need raw-source flags, supplied by a prepared snapshot or the raw-source loader.
- A precondition that fails or is unanswerable aborts the whole compile — there's no partial IR to
  inspect and no way to "compile around" it.

- **[Context binding](/concepts/context-binding)** — What a context loader supplies and how predicates use it.
- **[IR schema](/reference/ir-schema)** — The full `context_binding` / `precondition_result` shape and loud-fail matrix.
