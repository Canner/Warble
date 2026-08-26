---
name: answer_query__repair_sql
description: '''repair_sql'' step of `answer_query` (tier: strong).'
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

Repair step — runs ONLY when `query_result` came back with an execution error or an empty/obviously
wrong result. If the previous step succeeded with a sensible result, do nothing and pass it through.

- Diagnose the failure from the error text (unknown column, bad join, type mismatch, wrong grain),
  fix the SQL, and re-run it through `wren -q -o json -s '<SQL>'`. Bound your attempts — a few
  retries at most; do not loop indefinitely (retry depth is this step's concern, not the profile's).
- **If the result still cannot be validated, REFUSE.** Do not fabricate a number. Emit
  `{"verified": false, "refused": true, "reason": "<why it could not be verified>"}` and stop.
- Produce `repaired_result`. On success return exactly the same canonical rich result shape as
  `generate_sql`, with no extra keys:
  ```
  {"columns": ["col1", ...], "rows": [[v1, ...], ...],
   "summary": "<a concise prose answer grounded only in the returned rows>",
   "verified": true,
   "definition": {"sql": "<the exact SQL you ran>", "source_tables": ["..."], "filters": ["..."]}}
  ```
  Object rows from `wren` are also valid; preserve their values exactly and emit numbers as numbers.
  Set `verified: true` only when the repaired query ran and its result set passed validation. The
  summary must state the useful conclusion grounded only in those rows. The `definition` is
  run-level provenance only (the query behind this answer) — do not invent unit/owner/formal-metric
  lineage (out of scope for this run-level card).

<!-- warble: consumes [query_result] / produces repaired_result -->
