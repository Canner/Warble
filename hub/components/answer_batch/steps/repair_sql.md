Repair step — runs ONLY in one of these cases:

- When `batch_result` is `{"status": "error", "code": "step_failed", "reason":
  "terminal_unparseable: …", "text": …}`, the previous answers are in `text`; when `batch_result`
  is otherwise not valid JSON (prose around it, an unterminated string, a stray reasoning tag),
  the previous answers are that raw text. Re-emit those SAME answers as one JSON array in the canonical
  shape below, citing each query by its `query_id` (or, when its tool result carried none,
  `{"sql": "<the exact SQL you ran>", "source_tables": ["..."]}`).
  Run no new query, and put nothing else in the message.
- `batch_result` came back as a batch-level failure (no query executed, an execution error that
  stopped the run, or an obviously wrong result across the batch).

If the previous step produced a valid array — even one with `unanswerable` entries — do nothing and
pass it through unchanged.

- For a failure: diagnose the failure from the error text (unknown column, bad join, type mismatch, wrong grain),
  fix the affected queries, and re-run them through the bound query capability, still under the
  batch's shared preamble and each slot's `max_rows`. Bound your attempts — a few retries at most;
  do not loop indefinitely (retry depth is this step's concern, not the profile's).
- A slot whose result still cannot be validated becomes
  `{"slot_id": "<id>", "status": "unanswerable", "reason": "<why it could not be verified>"}`.
  Do not fabricate a number.
- **If nothing in the batch can be validated, REFUSE.** Emit
  `{"verified": false, "refused": true, "reason": "<why the batch could not be answered>"}` and stop.
- Produce `repaired_batch`. On success return exactly the same canonical array shape as
  `generate_sql`: one entry per slot, in the order received, each either the verified tabular shape
  ```
  {"slot_id": "<the slot's id>",
   "columns": ["col1", ...], "rows": [[v1, ...], ...],
   "summary": "<a concise prose answer grounded only in the returned rows>",
   "verified": true,
   "definition": {"query_id": "<the query_id the tool result returned>"}}
  ```
  or the `unanswerable` entry above, with no extra keys. Object-shaped rows are also valid;
  preserve their values exactly and emit numbers as numbers. Set `verified: true` only when the
  repaired query ran and its result set passed validation. The `definition` is run-level provenance
  only (the query behind that answer) — do not invent unit/owner/formal-metric lineage.
  Cite each answer's query by the `query_id` the tool result returned; never copy SQL, filters or
  source tables into `definition`. If the tool result carries no `query_id`, cite
  `{"sql": "<the exact SQL you ran>", "source_tables": ["..."]}` and nothing else. No shape of `definition` has a
  `filters` key.
  Your final message is the JSON array (or the refusal object) and nothing else: no heading, no
  sentence before or after it, no Markdown fence, no reasoning tags. Every string closed and every
  bracket matched; it must parse as JSON.
