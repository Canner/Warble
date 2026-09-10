---
title: "Blast radius"
description: "The as-built blast-radius query over the semantic lineage graph — types, construction, the algorithm, worked examples, and current limitations."
---

<!-- @generated from docs/spec/blast-radius.md by scripts/gen-reference.mjs — do not edit; edit the spec and re-run `npm run gen:reference` -->

> **Status:** the gate is implemented (`core/src/context.rs` types + `cli/src/gate.rs` policy) and
> wired as a **mutating guardrail** (§6) — a supplied impact analysis *gates* an `edit_pipeline`
> apply, with the decision policy living CLI-side so `core/` stays sans-IO.
> This is the *as-built* companion to [`capability-model`](/reference/capability-model) §7.1,
> which frames `blast_radius` at the capability level (why it is `provided_by: warble`, the ideal
> `raw → … → dashboards` DAG, and its use as a mutating guardrail). This document records what the
> code actually does today and where it deliberately stops.

`blast_radius` answers one question over the semantic layer:

> **If I change node X, what is transitively downstream of it, and how bad is the worst impact?**

Answering it requires reading the semantic graph, which Warble does not do. **The layer's owner
answers it; Warble enforces a declared policy over the answer.** That division is the whole of §1,
and why this stays the one capability Warble builds rather than borrows is argued in
[`capability-model`](/reference/capability-model) §7.1 — including the objection that comparing a
number you do not interpret looks like doing very little.

---

## 1. Ownership split

- **The shapes live in `core`** — `LineageGraph`, `HostImpact`, `RankedSeverity`: Warble-owned,
  format-agnostic, pure, sans-IO.
- **Reading a semantic format happens outside this repo.** There is no adapter crate here. Whoever
  owns the format builds the graph *and* classifies the impact, then supplies both in a
  prepared-context document (§3).
- **Enforcing the policy lives in `cli/src/gate.rs`** — it turns a supplied impact plus an authored
  threshold into `allow` / `escalate` / `block`.

The split is deliberate and it moved: Warble used to compute the closure and name the severity.
Classifying impact is a judgement about what the layer's objects *mean* — that a shifting metric is
worse than a broken query is a claim about metrics, not about graphs — so it belongs to whoever owns
the format. Warble compares a **rank** on the layer's own scale and never reads the name beside it.

One residue is worth naming rather than hiding: `ContextLoader::host_analysis` has a **default** that
derives an analysis by traversing `lineage()` (§4), so an in-process loader which can build a graph
but has classified nothing still answers. A host that owns its format overrides it. The enforcement
path always reads `host_analysis`, never a traversal of its own.

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

The shapes the wire actually carries, and what the gate reads:

```rust
struct RankedSeverity { rank: u32, name: String }  // rank: the layer's own scale, higher is worse
                                                    // name: for humans; Warble never branches on it
struct HostImpact { downstream: Vec<String>, severity: RankedSeverity }
struct HostAnalysis { impact: BTreeMap<String, HostImpact>, /* + node counts */ }
```

`Severity` and `BlastRadius` above are what the in-core traversal produces (§4); `HostAnalysis` is
what a producer supplies and what [`gate.rs`](https://github.com/Canner/Warble/blob/main/cli/src/gate.rs) evaluates. A supplied `rank` is
compared against the authored `max_severity_rank` ceiling; nothing compares names.

`Query` and `Dashboard` are **consumer kinds** — artifacts outside the semantic layer (a confirmed
saved query, a dashboard spec) that depend on it. They are always sinks: nothing is downstream of a
consumer.

**Node id conventions** (stable, queryable): `model:<name>`, `rel:<name>`, `cube:<name>`,
`metric:<cube>.<measure>`, `dim:<cube>.<dimension>`, `view:<name>`, `query:<slug>`,
`dashboard:<name>`. (`column:<model>.<col>` is reserved by the scheme but not emitted yet — see §7.)

---

## 3. What a producer supplies

Warble reads no semantic format, so the graph and the impact analysis arrive in the
prepared-context document. Its `lineage` section carries `nodes` (each an `id` plus a `kind` from
the vocabulary in §2) and `edges` oriented upstream → downstream; its `impact` section maps a node
id to that node's `downstream` closure and a `RankedSeverity`.

What Warble requires of that data:

- **Node ids follow the conventions in §2** — they are the surface an author writes in
  `protected:` and reads in a gate decision, so they are a stable contract, not an internal detail.
- **Every edge endpoint must be a declared node.** `LineageGraph::is_resolvable` checks this and
  backs the `lineage_resolvable` precondition predicate; a dangling edge is a producer bug and is
  reported rather than silently traversed.
- **Ranks are ordered, not named.** Higher is worse, on whatever scale the layer uses. Warble never
  interprets the accompanying name, so a producer may use as many or as few levels as its format
  justifies.
- **Degradations are declared, not inferred.** A producer that could not resolve something — SQL it
  could not parse, a reference it could not bind — records it in `lineage_diagnostics`, which
  surfaces into the IR's resolved lineage summary. Warble cannot detect a silently truncated graph,
  so an undeclared gap is indistinguishable from a genuinely small radius. This is the one place the
  contract depends on the producer's honesty.
- **An absent analysis is not an empty one.** Supplying no `impact` at all makes the gate fail
  loudly (§6); supplying an analysis in which a node has nothing downstream is a real answer.

How a *particular* format maps onto these nodes and edges — which MDL manifest structures become a
`cube:` or a `metric:`, how a view statement's references are discovered, how confirmed queries and
dashboard specs enter as consumer sinks — is the producer's business and is documented wherever that
producer lives. It deliberately no longer appears here: pinning one format's mapping into Warble's
own spec is what made the neutrality claim false the first time.

---

## 4. The in-core traversal (`LineageGraph::blast_radius`)

This is what `host_analysis`'s default computes for a loader that supplied a graph but no analysis
(§1). It is **not** what the gate runs against a host-owned layer — that reads the supplied
`HostAnalysis` — and the severity table below is therefore Warble's own fallback classification, not
a scale any producer is obliged to share.

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

(Asserted end-to-end in `cli/tests/blast_radius.rs`, against the jaffle-wren layer as
`examples/monitor-agent` binds it.)

With consumer artifacts (`examples/driftwood-wren`: two `knowledge/sql/` confirmed queries + a
`dashboards.yml` with an `exec-weekly` dashboard), a metric stops being a leaf:

| query | downstream | severity | reading |
| --- | --- | --- | --- |
| `blast_radius("metric:mrr_metrics.mrr")` | dashboard:exec-weekly, query:mrr-trend | **Semantic** | "this metric is depended on by 1 dashboard and 1 confirmed query" — the motivating sentence, now in the graph |
| `blast_radius("model:subscription_snapshots")` | cube:mrr_metrics, its members, dashboard:exec-weekly, query:mrr-trend | **Semantic** | `--protected dashboard:exec-weekly` hard-blocks this change (exit 11) |

(Asserted in `cli/tests/consumer_gate_e2e.rs`.)

---

## 6. How it is consumed

- **Read path: dry-run analysis.** The result is computed and queryable; as analysis alone it
  does not gate anything. `capability-model` unblocks `blast_radius` for any target that
  provides fine-grained binding (a `ContextLoader`); the `requires: fine_grained_binding` loud-fail
  now fires only for a coarsely-bound target.
- **Mutating guardrail (built).** A mutating component (`edit_pipeline`) computes the
  radius of its intended change at dry-run and gates the *apply*. The `blast_radius_limit` guardrail
  carries a `threshold` (`{ max_severity, max_downstream?, protected? }`); the gate decides over the
  computed radius: an empty radius → **allow** (e.g. editing a description); touching a `protected`
  asset → **block**; severity above the ceiling or downstream count above the cap → **escalate to
  `human_approval`**; else allow. It is exposed as `warble blast-radius <project> --node <id>
  [--max-severity-rank …] [--max-downstream …] [--protected …]` (exit 0/10/11 = allow/escalate/block),
  which the emitted gated-tool lifecycle calls between dry-run and apply. Analysis (read) gates
  action (write); auto-trigger ≠ auto-apply. The gate reasons over the **current** radius (§7's
  limitations still bound its reach — 4a gates on what the radius sees today, it does not extend it);
  the decision policy lives CLI-side over the supplied `HostAnalysis`, so `core/` stays sans-IO.

---

## 7. Deliberate limitations (what a radius does **not** reach)

These bound how far a radius extends in practice. They are now **a producer's limitations, not
Warble's** — Warble traverses and gates whatever graph it is given, so closing any of them means a
richer document, not a change here. They are recorded because they shape what a gate decision
actually means, and an author reading `downstream: []` deserves to know which of these could be the
reason.

- **Raw → mart model lineage is usually absent.** A mart model built from a raw one leaves no
  `model → model` edge unless the producer parses model-definition SQL; most do not, so raw→mart is
  captured only where a *relationship* happens to connect the two.
- **Column-level lineage is usually absent.** The id scheme reserves `column:…` (§2), but producers
  typically emit model- and metric-grained nodes only.
- **Consumer coverage is whatever the producer can see.** Consumer nodes come from artifacts the
  producer reads — confirmed queries, dashboard specs in the repo. A dashboard living only in an
  external BI tool or SaaS API is invisible to it, which is a sync-layer concern rather than a graph
  one.
- **Reference discovery is name-based.** A producer that parses SQL for relation names will still
  miss a reference hidden behind dynamic SQL construction, and typically matches metric or dimension
  mentions by whole-word token rather than by expression analysis.

The load-bearing consequence: **an empty radius is not proof of safety**, only of nothing having
been reported. That is why `lineage_diagnostics` (§3) is part of the contract — a producer that hit
one of these is expected to say so, and Warble cannot tell a truncated graph from a small one.

Two earlier limitations are now closed: **consumer nodes** (dashboards / saved queries) are in the
graph — a metric is no longer a leaf — and **view matching** is SQL parsing with an honest
whole-word fallback rather than a bare token scan. Extending the rest (SQL-based model lineage,
column-level edges) remains a matter of enriching construction in the adapter; the core query and
severity model are unaffected.

---

## 8. Summary

`blast_radius` today = **a declared threshold, enforced at dispatch against an impact analysis the
bound layer supplied.** The analysis names each node's downstream closure and a severity rank;
Warble compares ranks and counts, checks protected ids, and decides `allow` / `escalate` / `block`.
A layer that supplied no analysis is refused, not allowed.

What Warble contributes is not the closure — the layer's owner computes that, because reading a
semantic format and judging what a change to it *means* are the same skill. What Warble contributes
is that the limit is authored beside the behaviour it constrains, compiled into the IR, and enforced
without anyone remembering to check. That is why the gate can refuse a change because "N dashboards
depend on this metric" while knowing nothing about metrics.

Remaining work on this axis is a producer's, not Warble's: reaching raw-model SQL lineage and
column-level edges means a richer graph arriving in the document, and Warble's side of that is
already written.
