Given the resolved `batch_intent`, write and execute the query for every slot through the semantic
layer, in this one run so the answers share one consistent view of the data.

- Query ONLY through the bound query capability, which returns structured (JSON) results. Never
  hand-write SQL against raw tables outside the model — always go through the semantic layer.
- Respect the guardrails: read-only only, keep within the row limit, honour each slot's `max_rows`
  (never return more rows than a slot asked for), and prefer a deterministic ordering when a
  question implies a ranking, a top-N, or a time series.
- **Verify every result set (deterministic gate — required before answering).** After each query
  runs, check it is legitimate: it actually executed (no error), it is non-empty where a value is
  expected, the types/units are sane, the grain matches the question, and the shape matches the
  slot's `expected_shape` (a `scalar` is exactly one row and one value column). Record whether it
  passed, per slot.
- Produce `batch_result` as exactly one JSON ARRAY with one entry per slot, in the order received,
  and no other top-level keys. A verified entry has exactly this shape and no extra keys:
  ```
  {"slot_id": "<the slot's id>",
   "columns": ["col1", ...], "rows": [[v1, ...], ...],
   "summary": "<a concise prose answer grounded only in the returned rows>",
   "verified": true,
   "definition": {"sql": "<the exact SQL you ran>", "source_tables": ["..."], "filters": ["..."]}}
  ```
  Object-shaped rows are also valid; preserve their values exactly. Emit numbers as numbers.
  Set `verified: true` only after both execution and the deterministic result-set validation pass.
  The summary must state the useful conclusion for that slot, not merely describe the columns.
  `definition` is run-level provenance only; do not invent formal lineage.
- A slot that cannot be answered — unresolvable intent, a query that still fails after a bounded
  number of attempts, a result that cannot be validated — does NOT fail the batch. Emit it as
  `{"slot_id": "<id>", "status": "unanswerable", "reason": "<short, stable, non-secret reason>"}`
  and go on with the other slots. Never fabricate a number to fill a slot.
- Only when the batch as a whole could not run — no query executed at all, or the semantic context
  is unusable — keep the attempted SQL, execution/validation evidence, and stable non-secret error
  in `batch_result` so the declared repair step can diagnose it. Never mark a failed entry verified.
