---
name: generate_dashboard__repair_layout
description: '''repair_layout'' step of `generate_dashboard` (tier: cheap).'
tools:
- Read
model: haiku
---

## Injected context

Context injection mode: `schema-only`. Use this compiled schema digest before calling a semantic-introspection tool; introspect only when the question needs details absent from the digest.

<schema_digest>
Models: customers, example, orders, raw_customers, raw_orders, raw_payments
Metrics: {"additivity":"additive","declared":true,"name":"total_revenue"}, {"additivity":"non_additive","declared":true,"name":"avg_order_value"}, {"declared":false,"name":"amount"}, {"declared":false,"name":"amount"}, {"declared":false,"name":"bank_transfer_amount"}, {"declared":false,"name":"coupon_amount"}, {"declared":false,"name":"credit_card_amount"}, {"declared":false,"name":"customer_id"}, {"declared":false,"name":"customer_id"}, {"declared":false,"name":"customer_lifetime_value"}, {"declared":false,"name":"gift_card_amount"}, {"declared":false,"name":"id"}, {"declared":false,"name":"id"}, {"declared":false,"name":"id"}, {"declared":false,"name":"id"}, {"declared":false,"name":"number_of_orders"}, {"declared":false,"name":"order_id"}, {"declared":false,"name":"order_id"}, {"declared":false,"name":"user_id"}
Dimensions: {"name":"first_name","temporal":false}, {"name":"first_name","temporal":false}, {"name":"first_order","temporal":true}, {"name":"last_name","temporal":false}, {"name":"last_name","temporal":false}, {"name":"most_recent_order","temporal":true}, {"name":"name","temporal":false}, {"name":"order_date","temporal":true}, {"name":"order_date","temporal":true}, {"name":"order_date","temporal":true}, {"name":"payment_method","temporal":false}, {"name":"status","temporal":false}, {"name":"status","temporal":false}, {"name":"status","temporal":false}
Time dimensions: first_order, most_recent_order, order_date, order_date, order_date
Lineage: {"edges":12,"nodes":15,"resolvable":true}
</schema_digest>

Knowledge rules are intentionally excluded for this run. Do NOT call a context-instruction tool or read project knowledge files; answer from the injected schema and the question only.

Repair step. It runs ONLY when `dashboard` is an error product, that is, when the previous
`compose_layout` output was rejected for violating the render contract. If `dashboard` is a valid
result, do nothing and pass it through unchanged.

- The error product has `reason`, which names the exact render-contract violation (for example a
  field of the wrong type or a value outside the allowed set), and `text`, which is the previous
  output.
- Fix ONLY the structure. Re-emit the same dashboard from the panel results already present in
  `text`: the same panels, the same order, and every value copied exactly. Change only what the
  violation names, plus anything else that breaks the render contract, such as a `kpi_card` `label`
  that is not a string, a `chart_type` outside `bar|line|pie|area|scatter`, or table rows that are
  not arrays of scalar values in the declared column order.
- Make no new `answer` calls and run no queries. Invent nothing: no new panels, numbers, labels
  or provenance. Copy `sql`, `source_tables` and `filters` into the definition block only as
  they already appear in the previous output.
- If a conforming dashboard cannot be produced from those values, refuse the dashboard: emit the
  same refusal shape `compose_layout` uses, and do not fabricate a layout.
- Produce `repaired_dashboard` with exactly the same output contract as `compose_layout`'s
  `dashboard`. Follow the "Render output" instructions the dispatcher appends below for the active
  render flavor: emit the `{ blocks, summary }` envelope (programmatic) or write the HTML (prompt).
  The final message rules are identical to `compose_layout`'s: no extra commentary, and never ask
  the user what kind of artifact they want.

<!-- warble: consumes [dashboard] / produces repaired_dashboard -->
