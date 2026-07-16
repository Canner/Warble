---
title: Blast radius
description: "The as-built blast-radius query over the semantic lineage graph — types, construction, the algorithm, worked examples, and current limitations."
---

> **Status:** the query is implemented (`core/src/context.rs` + `bindings/mdl-context/`); it is
> additionally wired as a **mutating guardrail** (§6) — the read-path query *gates* an
> `edit_pipeline` apply, with the decision policy living back-end/CLI-side so `core/` is unchanged.
> This is the *as-built* companion to [`capability-model`](/reference/capability-model) §7.1,
> which frames `blast_radius` at the capability level (why it is `provided_by: warble`, the ideal
> `raw → … → dashboards` DAG, and its eventual use as a mutating guardrail). This document records
> what the code actually computes today and where it deliberately stops.

`blast_radius` answers one question over the semantic layer:

> **If I change node X, what is transitively downstream of it, and how bad is the worst impact?**

A generic runtime/sandbox cannot answer this — it only sees "a file was written." Computing it
requires reading the semantic graph, which is why it is the one capability Warble *builds* rather
than borrows (the data-native wedge showing up in enforcement, not just declarations).

---

## 1. Ownership split

- **The graph type and the query live in `core`** (`LineageGraph` and its `blast_radius` method) —
  Warble-owned, adapter-agnostic, pure, sans-IO.
- **Building the graph lives in an adapter** (`bindings/mdl-context/src/lineage.rs`) — it reads a
  bound semantic layer and fills the Warble-owned type. A future non-MDL adapter (e.g. OSI) builds
  the same `LineageGraph`; the query does not change.

So the traversal/severity logic is defined once in core and reused by every adapter; only *graph
construction* is source-specific.

---

## 2. The types (`core/src/context.rs`)

```rust
struct LineageNode { id: String, kind: LineageKind }   // kind ∈ Model | Column | Relationship
                                                        //        | Cube | Metric | Dimension | View
                                                        //        | Query | Dashboard
struct LineageEdge { from: String, to: String }        // oriented upstream → downstream:
                                                        // `from` is depended on, `to` is the dependent
struct LineageGraph { nodes: Vec<LineageNode>, edges: Vec<LineageEdge> }

enum Severity { None, Compatibility, Structural, Semantic }   // derive(Ord): None < … < Semantic

struct BlastRadius {
    seed: String,             // the node the query started from
    downstream: Vec<String>,  // its transitive downstream closure (sorted, excludes seed)
    severity: Severity,       // the worst impact class over `downstream`
}
```

`Query` and `Dashboard` are **consumer kinds** — artifacts outside the semantic layer (a confirmed
saved query, a dashboard spec) that depend on it. They are always sinks: nothing is downstream of a
consumer.

**Node id conventions** (stable, queryable): `model:<name>`, `rel:<name>`, `cube:<name>`,
`metric:<cube>.<measure>`, `dim:<cube>.<dimension>`, `view:<name>`, `query:<slug>`,
`dashboard:<name>`. (`column:<model>.<col>` is reserved by the scheme but not emitted yet — see §7.)

---

## 3. Graph construction (`bindings/mdl-context/src/lineage.rs`)

The DAG is built **from structural references — no SQL is executed or expanded.** SQL *text* (a view
statement, a consumer query) is parsed with `sqlparser` only to discover which relations it
references; a statement that fails to parse degrades to a whole-word token scan, and every such
degradation is recorded in the context's `lineage_diagnostics` and surfaced into the IR's resolved
lineage summary (no silent caps).

From a wren `Manifest` (`build`):

| Source in MDL | Nodes | Edges (upstream → downstream) |
| --- | --- | --- |
| each model | `model:<name>` (Model) | — |
| each relationship | `rel:<name>` (Relationship) | `model:<member>` → `rel:<name>` for **every** member model |
| each cube | `cube:<name>` (Cube) | `model:<base_object>` → `cube:<name>` |
| cube measures | `metric:<cube>.<measure>` (Metric) | `cube:<name>` → `metric:…` |
| cube dimensions + time dimensions | `dim:<cube>.<dim>` (Dimension) | `cube:<name>` → `dim:…` |
| each view | `view:<name>` (View) | `model:<name>` → `view:<name>` for each model the view statement references (parsed; whole-word fallback) |

From the project's **consumer artifacts** (`extend_with_consumers` — these never enter the MDL
manifest; they ride `ProjectSources` and only enrich the graph):

| Consumer source | Nodes | Edges (upstream → downstream) |
| --- | --- | --- |
| `knowledge/sql/<slug>.md` — the wren CLI's confirmed NL→SQL store (YAML frontmatter; its `sql:` field is what lineage reads) | `query:<slug>` (Query) | each referenced **model/view** → `query:<slug>`; a referenced **cube** → `query:<slug>`, plus `metric:`/`dim:` → `query:<slug>` for each of that cube's members the SQL mentions |
| `dashboards.yml` — minimal declarative dashboard spec: `dashboards[].name` + `panels[].sql` *or* `panels[].cube` + `measures` | `dashboard:<name>` (Dashboard) | a `sql` panel: same discovered-reference rules as a query; a `cube` panel: `cube:<cube>` → `dashboard:…` and `metric:<cube>.<measure>` → `dashboard:…` for each listed measure |

Notes:
- A relationship node is **downstream of both** joined models; there is no edge back out to the
  other model. So a model's radius includes the relationships it participates in, but **not** its
  join partners (a partner is an upstream sibling, not downstream).
- **Discovered vs declared references.** References found by reading SQL (views, queries, `sql`
  panels) bind only to nodes that exist — an unknown relation (a CTE, a raw table) produces
  nothing. References *declared* in a spec (`panels[].cube` + `measures`) always produce an edge;
  naming a missing cube/measure leaves a dangling edge, exactly like a dangling relationship member
  or cube `base_object` — which is what `LineageGraph::is_resolvable` detects (it backs the
  `lineage_resolvable` precondition predicate: every edge endpoint must be a declared node).
- A malformed consumer file (unparseable frontmatter/YAML, a missing `sql:` field, a panel with
  neither `sql` nor `cube`) is skipped **and recorded** in `lineage_diagnostics`.

---

## 4. The query (`LineageGraph::blast_radius`)

```
blast_radius(seed):
    downstream = {}                       # BTreeSet → sorted, de-duplicated
    stack = [seed]
    while stack not empty:
        current = stack.pop()
        for edge where edge.from == current:
            if edge.to != seed and downstream.insert(edge.to):   # first time seen
                stack.push(edge.to)
    severity = max(node_severity(id) for id in downstream)  or None if empty
    return { seed, downstream, severity }
```

- **Forward transitive closure** along `from → to` edges.
- **Cycle-safe**: the `downstream` set doubles as a visited set, so even a malformed cyclic graph
  terminates.
- **Unknown or leaf seed → empty radius** (`severity = None`).

**Severity of a single downstream node** (`node_severity`, by kind) — least → most dangerous:

| kind | Severity | why |
| --- | --- | --- |
| Relationship, Cube, Dimension | `Compatibility` | a type/grain concern |
| Model, View, Column | `Structural` | a downstream object breaks — queries **error loudly** |
| **Metric** | **`Semantic`** | a downstream metric's numbers **silently shift** for every consumer — the most dangerous because it does **not** error |

The radius's overall severity is the **max** over its downstream set. The ordering encodes "the
quieter the failure, the more dangerous": a silent number shift outranks a loud query break.

---

## 5. Worked example (`examples/jaffle-wren`)

Given models `customers, orders, raw_*`; relationship `orders_customers (orders, customers)`; and a
cube `revenue` on `orders` with measures `total_revenue = SUM(amount)`, `avg_order_value =
AVG(amount)`, dimension `status`, time dimension `order_date`, `build` produces (orders neighbourhood):

```
model:orders ─▶ rel:orders_customers
model:customers ─▶ rel:orders_customers
model:orders ─▶ cube:revenue ─▶ metric:revenue.total_revenue
                              ─▶ metric:revenue.avg_order_value
                              ─▶ dim:revenue.status
                              ─▶ dim:revenue.order_date
```

| query | downstream | severity | reading |
| --- | --- | --- | --- |
| `blast_radius("model:orders")` | rel:orders_customers, cube:revenue, metric:revenue.total_revenue, metric:revenue.avg_order_value, dim:revenue.status, dim:revenue.order_date | **Semantic** | changing `orders` can silently shift `total_revenue` for every consumer |
| `blast_radius("model:customers")` | rel:orders_customers | **Compatibility** | smaller radius, no metric downstream → lower severity |
| `blast_radius("metric:revenue.total_revenue")` | *(empty)* | **None** | jaffle carries no consumer artifacts, so its metrics are leaves |

(Asserted in `bindings/mdl-context/tests/jaffle_wren.rs`.)

With consumer artifacts (`examples/driftwood-wren`: two `knowledge/sql/` confirmed queries + a
`dashboards.yml` with an `exec-weekly` dashboard), a metric stops being a leaf:

| query | downstream | severity | reading |
| --- | --- | --- | --- |
| `blast_radius("metric:mrr_metrics.mrr")` | dashboard:exec-weekly, query:mrr-trend | **Semantic** | "this metric is depended on by 1 dashboard and 1 confirmed query" — the motivating sentence, now in the graph |
| `blast_radius("model:subscription_snapshots")` | cube:mrr_metrics, its members, dashboard:exec-weekly, query:mrr-trend | **Semantic** | `--protected dashboard:exec-weekly` hard-blocks this change (exit 11) |

(Asserted in `bindings/mdl-context/tests/consumer_lineage.rs` and `cli/tests/consumer_gate_e2e.rs`.)

---

## 6. How it is consumed

- **Read path: dry-run analysis.** The result is computed and queryable; as analysis alone it
  does not gate anything. `capability-model.md` unblocks `blast_radius` for any target that
  provides fine-grained binding (a `ContextLoader`); the `requires: fine_grained_binding` loud-fail
  now fires only for a coarsely-bound target.
- **Mutating guardrail (built).** A mutating component (`edit_pipeline`) computes the
  radius of its intended change at dry-run and gates the *apply*. The `blast_radius_limit` guardrail
  carries a `threshold` (`{ max_severity, max_downstream?, protected? }`); the gate decides over the
  computed radius: an empty radius → **allow** (e.g. editing a description); touching a `protected`
  asset → **block**; severity above the ceiling or downstream count above the cap → **escalate to
  `human_approval`**; else allow. It is exposed as `warble blast-radius <project> --node <id>
  [--max-severity …] [--max-downstream …] [--protected …]` (exit 0/10/11 = allow/escalate/block),
  which the emitted gated-tool lifecycle calls between dry-run and apply. Analysis (read) gates
  action (write); auto-trigger ≠ auto-apply. The gate reasons over the **current** radius (§7's
  limitations still bound its reach — 4a gates on what the radius sees today, it does not extend it);
  the decision policy lives back-end/CLI-side over core's `BlastRadius`, so `core/` is unchanged.

---

## 7. Deliberate limitations (what the current radius does **not** reach)

These bound how far a radius extends today. All are additive future work, not design dead-ends.

- **No raw → mart model lineage.** A mart model (`orders`) built from `raw_orders` produces **no**
  `model → model` edge, because that lineage lives in the model's SQL and `build` deliberately does
  not parse/expand model-definition SQL. Raw→mart is captured only where a *relationship* happens to
  connect them.
- **No column-level lineage.** The id scheme reserves `column:…` and `node_severity` classifies a
  Column as `Structural`, but `build` does not emit column nodes/edges. Impact is model/metric-grained.
- **Consumer coverage is git-native only.** Consumer nodes come from files in the project repo
  (`knowledge/sql/`, `dashboards.yml`); dashboards that live only in an external BI tool or SaaS API
  are not seen (that is a sync-layer concern, not a graph concern).
- **Reference discovery is name-based.** SQL is parsed for relation names (with a recorded
  whole-word fallback when it does not parse), but a reference hidden behind e.g. dynamic SQL
  construction may still be missed. Metric/dimension mentions inside a cube query are matched by
  whole-word token, not by expression analysis.

Two earlier limitations are now closed: **consumer nodes** (dashboards / saved queries) are in the
graph — a metric is no longer a leaf — and **view matching** is SQL parsing with an honest
whole-word fallback rather than a bare token scan. Extending the rest (SQL-based model lineage,
column-level edges) remains a matter of enriching construction in the adapter; the core query and
severity model are unaffected.

---

## 8. Summary

`blast_radius` today = **the forward transitive closure of a node over the MDL structural DAG plus
the project's git-native consumers, with the worst downstream severity** (a downstream metric *or
consumer* ⇒ `Semantic`, the most dangerous). It already computes something a generic runtime cannot,
and it is owned by core so every adapter reuses it. Its reach is the semantic layer's structure plus
the confirmed queries and dashboard specs that consume it — the gate can now refuse a change because
"N dashboards depend on this metric." Connecting raw-model SQL lineage and column-level edges is the
remaining work on the same axis.
