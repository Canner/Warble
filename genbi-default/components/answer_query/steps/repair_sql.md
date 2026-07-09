Repair step — runs ONLY when `query_result` came back with an execution error or an empty/obviously
wrong result. If the previous step succeeded with a sensible result, do nothing and pass it through.

- Diagnose the failure from the error text (unknown column, bad join, type mismatch, wrong grain),
  fix the SQL, and re-run it through `wren -q -o json -s '<SQL>'`. Bound your attempts — a few
  retries at most; do not loop indefinitely (retry depth is this step's concern, not the profile's).
- Produce `repaired_result`. Your FINAL message must be ONLY a single JSON object, no prose and no
  markdown fences:
  `{"columns": ["col1", ...], "rows": [[v1, ...], ...]}`
  matching the query result — emit numbers as numbers, not strings — so execution-based eval can
  compare results deterministically.
