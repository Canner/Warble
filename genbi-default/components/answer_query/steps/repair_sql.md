Repair step — runs ONLY when `query_result` came back with an execution error or an empty/obviously
wrong result. If the previous step succeeded with a sensible result, do nothing and pass it through.

- Diagnose the failure from the error text (unknown column, bad join, type mismatch, wrong grain),
  fix the SQL, and re-run it through `wren -q -o json -s '<SQL>'`. Bound your attempts — a few
  retries at most; do not loop indefinitely (retry depth is this step's concern, not the profile's).
- **If the result still cannot be validated, REFUSE.** Do not fabricate a number. Emit
  `{"verified": false, "refused": true, "reason": "<why it could not be verified>"}` and stop.
- Produce `repaired_result`. On success your FINAL message must be ONLY a single JSON object, no
  prose and no markdown fences, carrying the answer plus its verify facet and shallow definition:
  ```
  {"columns": ["col1", ...], "rows": [[v1, ...], ...],
   "verified": true,
   "definition": {"sql": "<the exact SQL you ran>", "source_tables": ["..."], "filters": ["..."]}}
  ```
  Emit numbers as numbers, not strings. Set `"verified": true` ONLY when a query ran and its result
  set passed validation. The `definition` is run-level provenance only (the query behind this
  answer) — do not invent unit/owner/formal-metric lineage (that is Phase 2).
