# Blast radius — current design (as built)

> **Status:** the query is implemented in Phase 2 (`core/src/context.rs` + `bindings/mdl-context/`);
> Phase 4a wires it as a **mutating guardrail** (§6) — the read-path query now *gates* an
> `edit_pipeline` apply, with the decision policy living back-end/CLI-side so `core/` is unchanged.
> This is the *as-built* companion to [`capability-model.md`](./capability-model.md) §7.1,
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

**Node id conventions** (stable, queryable): `model:<name>`, `rel:<name>`, `cube:<name>`,
`metric:<cube>.<measure>`, `dim:<cube>.<dimension>`, `view:<name>`. (`column:<model>.<col>` is
reserved by the scheme but not emitted yet — see §7.)

---

## 3. Graph construction (`bindings/mdl-context/src/lineage.rs::build`)

The DAG is built **purely from structural references — no SQL is executed or expanded.** From a wren
`Manifest`:

| Source in MDL | Nodes | Edges (upstream → downstream) |
| --- | --- | --- |
| each model | `model:<name>` (Model) | — |
| each relationship | `rel:<name>` (Relationship) | `model:<member>` → `rel:<name>` for **every** member model |
| each cube | `cube:<name>` (Cube) | `model:<base_object>` → `cube:<name>` |
| cube measures | `metric:<cube>.<measure>` (Metric) | `cube:<name>` → `metric:…` |
| cube dimensions + time dimensions | `dim:<cube>.<dim>` (Dimension) | `cube:<name>` → `dim:…` |
| each view | `view:<name>` (View) | `model:<name>` → `view:<name>` for each model whose name appears **as a whole word** in the view statement |

Notes:
- A relationship node is **downstream of both** joined models; there is no edge back out to the
  other model. So a model's radius includes the relationships it participates in, but **not** its
  join partners (a partner is an upstream sibling, not downstream).
- View → model detection is a naive whole-word token match on the view's `statement` (guards against
  `orders` matching inside `raw_orders`), **not** SQL parsing.
- A dangling reference (a relationship member / cube base object / view table naming a model that
  does not exist) still produces an edge whose `from` endpoint is absent from the node set — which
  is exactly what `LineageGraph::is_resolvable` detects (it backs the `lineage_resolvable`
  precondition predicate: every edge endpoint must be a declared node).

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
| `blast_radius("metric:revenue.total_revenue")` | *(empty)* | **None** | a metric is a leaf in this graph (see §7 — consumers aren't modelled) |

(Asserted in `bindings/mdl-context/tests/jaffle_wren.rs`.)

---

## 6. How it is consumed

- **Today (Phase 2): read-path / dry-run analysis only.** The result is computed and queryable; it
  does not gate anything yet. `capability-model.md` unblocks `blast_radius` for any target that
  provides fine-grained binding (a `ContextLoader`); the `requires: fine_grained_binding` loud-fail
  now fires only for a coarsely-bound target.
- **Phase 4a (built): mutating guardrail.** A mutating component (`edit_pipeline`) computes the
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
  not parse/expand SQL. Raw→mart is captured only where a *relationship* happens to connect them.
- **No consumer nodes (dashboards / saved queries).** These are not in the MDL manifest, so a
  metric is a **leaf** — the "N dashboards depend on this metric" layer that motivates the whole
  feature is not yet in the graph. The current radius is "impact **within** the semantic layer."
- **No column-level lineage.** The id scheme reserves `column:…` and `node_severity` classifies a
  Column as `Structural`, but `build` does not emit column nodes/edges. Impact is model/metric-grained.
- **Whole-word view matching, not SQL analysis** — a view referencing a model only via an alias or a
  computed subquery may be missed.

Extending any of these (SQL-based model lineage, consumer nodes from a project's saved artifacts,
column-level edges) is a matter of enriching `build` in the adapter; the core query and severity
model are unaffected.

---

## 8. Summary

`blast_radius` today = **the forward transitive closure of a node over the MDL structural DAG, plus
the worst downstream severity** (a downstream metric ⇒ `Semantic`, the most dangerous). It already
computes something a generic runtime cannot, and it is owned by core so every adapter reuses it. Its
reach is currently the semantic layer's internal structure; connecting it to raw-model SQL lineage
and to real consumers is the work that takes it from "can analyse" to "can gate a production change."
