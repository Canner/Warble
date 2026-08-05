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
