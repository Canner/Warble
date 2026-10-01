Repair step — runs ONLY in one of these cases:

- `query_result` is not valid JSON (prose around it, an unterminated string, a stray reasoning
  tag). Re-emit the SAME answer as one JSON object in the canonical shape below, citing its query
  by its `query_id` (or, when its tool result carried none, `{"sql": "<the exact SQL you ran>", "source_tables": ["..."]}`).
  Run no new query, and put nothing else in the message.
- `query_result` came back with an execution error or an empty/obviously wrong result.

If the previous step succeeded with a sensible result, do nothing and pass it through.

- Diagnose the failure from the error text (unknown column, bad join, type mismatch, wrong grain),
  fix the SQL, and re-run it through the bound query capability. Bound your attempts — a few
  retries at most; do not loop indefinitely (retry depth is this step's concern, not the profile's).
- **If the result still cannot be validated, REFUSE.** Do not fabricate a number. Emit
  `{"verified": false, "refused": true, "reason": "<why it could not be verified>"}` and stop.
- Produce `repaired_result`. On success return exactly the same canonical rich result shape as
  `generate_sql`, with no extra keys:
  ```
  {"columns": ["col1", ...], "rows": [[v1, ...], ...],
   "summary": "<a concise prose answer grounded only in the returned rows>",
   "verified": true,
   "definition": {"query_id": "<the query_id the tool result returned>"}}
  ```
  Object-shaped rows are also valid; preserve their values exactly and emit numbers as numbers.
  Set `verified: true` only when the repaired query ran and its result set passed validation. The
  summary must state the useful conclusion grounded only in those rows. The `definition` is
  run-level provenance only (the query behind this answer) — do not invent unit/owner/formal-metric
  lineage (out of scope for this run-level card). Cite the query by the `query_id` the tool result
  returned; never copy SQL, filters or source tables into the message. If the tool result carries
  no `query_id`, cite `{"sql": "<the exact SQL you ran>", "source_tables": ["..."]}` and nothing else. No
  shape of `definition` has a `filters` key.
