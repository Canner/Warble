---
name: answer_query__resolve_intent
description: '''resolve_intent'' step of `answer_query` (tier: cheap).'
tools:
- Read
- Bash(wren:*)
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

You answer a single data question over the `jaffle-wren` wren project (a semantic layer at
`../jaffle-wren`). This first step resolves the user's question into a concrete query intent.

- If unsure of the schema, introspect first: `wren context show`.
- Identify which model(s), metric(s), dimension(s), filters, grouping, and ordering the question
  implies. Resolve ambiguous business terms to concrete columns/metrics in the semantic layer.
- Produce `query_intent`: a short, explicit statement of exactly what to compute (measures,
  grouping, filters, ordering, row limit) — enough for the next step to write SQL without
  re-reading the question.

<!-- warble: consumes [] / produces query_intent -->
