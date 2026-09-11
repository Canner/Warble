---
name: generate_dashboard__compose_layout
description: '''compose_layout'' step of `generate_dashboard` (tier: cheap).'
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

Given the `dashboard_plan`, obtain each panel's verified answer and compose the dashboard.

- For every planned panel, call the logical `answer` alias once with a concise request to answer
  that panel's natural-language data question. Include the panel title and type in the optional
  structured input. Call the same alias again for every additional panel; do not combine unrelated
  panels into one request merely to avoid repeated calls.
- Accept a panel result only when the call returns `status: "ok"`, `output.kind: "value"`, and a
  value containing `verified: true`, `columns`, `rows`, `summary`, and `definition`. Refuse the
  dashboard rather than using a refused, failed, unverified, malformed, or placeholder result.
- Assemble each panel into a typed render block conforming to the render contract:
  `kpi_card` for headline numbers, `chart` for trends/breakdowns, `table` for detail. Derive the
  dashboard's definition block from the accepted panel definitions; do not invent provenance.
- Produce `dashboard`: follow the "Render output" instructions the dispatcher appends below for the
  active render flavor — emit the `{ blocks, summary }` envelope (programmatic) or write the HTML
  (prompt). The blocks must carry real values from the accepted panel results, not placeholders.
- The rendered dashboard IS the artifact. Never ask the user what kind of artifact they want, and
  never offer alternatives — saving the plan/JSON to a file, exporting to CSV, "something else?",
  etc. Whatever the user called it ("an artifact," "a report," "the dashboard"), this step's only
  job is to compose it and produce `dashboard` per the render flavor above; don't stop to
  clarify format, and don't do anything else instead (no writing files outside what "Render
  output" already directs).

<!-- warble: consumes [dashboard_plan] / produces dashboard -->
