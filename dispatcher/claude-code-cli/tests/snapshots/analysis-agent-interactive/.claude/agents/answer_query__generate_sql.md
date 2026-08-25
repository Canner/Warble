---
name: answer_query__generate_sql
description: '''generate_sql'' step of `answer_query` (tier: strong).'
tools:
- Read
- Bash(wren:*)
model: opus
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

Given the resolved `query_intent`, write and execute the query through the semantic layer.

- Query ONLY through the wren CLI, which returns JSON: `wren -q -o json -s '<SQL>'`. Never
  hand-write SQL against raw tables outside the model — always go through the semantic layer.
- Respect the guardrails: read-only only, keep within the row limit, and prefer a deterministic
  ordering when the question implies a ranking or a top-N.
- **Verify the result set (deterministic gate — required before answering).** After the query runs,
  check it is legitimate: it actually executed (no error), it is non-empty where a value is expected,
  the types/units are sane, and the grain matches the question. Record whether it passed.
- On success, produce `query_result` as exactly one object with this shape and no extra keys:
  ```
  {"columns": ["col1", ...], "rows": [[v1, ...], ...],
   "summary": "<a concise prose answer grounded only in the returned rows>",
   "verified": true,
   "definition": {"sql": "<the exact SQL you ran>", "source_tables": ["..."], "filters": ["..."]}}
  ```
  Object rows from `wren` are also valid; preserve their values exactly. Emit numbers as numbers.
  Set `verified: true` only after both execution and the deterministic result-set validation pass.
  The summary must state the useful conclusion, not merely describe the columns or claim that the
  query succeeded. `definition` is run-level provenance only; do not invent formal lineage.
- On failure, keep the attempted SQL, execution/validation evidence, and stable non-secret error in
  `query_result` so the declared repair step can diagnose it. Never mark a failed result verified.

<!-- warble: consumes [query_intent] / produces query_result -->
