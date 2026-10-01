Given the resolved `query_intent`, write and execute the query through the semantic layer.

- Query ONLY through the bound query capability, which returns structured (JSON) results. Never
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
   "definition": {"query_id": "<the query_id the tool result returned>"}}
  ```
  Object-shaped rows are also valid; preserve their values exactly. Emit numbers as numbers.
  Set `verified: true` only after both execution and the deterministic result-set validation pass.
  The summary must state the useful conclusion, not merely describe the columns or claim that the
  query succeeded. `definition` is run-level provenance only; do not invent formal lineage.
- Cite each answer's query by the `query_id` the tool result returned; never copy SQL, filters
  or source tables into `definition`. If the tool result carries no `query_id`, cite
  `{"sql": "<the exact SQL you ran>", "source_tables": ["..."]}` and nothing else. No shape
  of `definition` has a `filters` key.
- On failure, keep the attempted SQL, execution/validation evidence, and stable non-secret error in
  `query_result` so the declared repair step can diagnose it. Never mark a failed result verified.
- Your final message is `query_result` as JSON and nothing else: no heading, no sentence before or
  after it, no Markdown fence, no reasoning tags. Every string closed and every bracket matched; it
  must parse as JSON.
