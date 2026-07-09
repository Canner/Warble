Given the resolved `query_intent`, write and execute the query through the semantic layer.

- Query ONLY through the wren CLI, which returns JSON: `wren -q -o json -s '<SQL>'`. Never
  hand-write SQL against raw tables outside the model — always go through the semantic layer.
- Respect the guardrails: read-only only, keep within the row limit, and prefer a deterministic
  ordering when the question implies a ranking or a top-N.
- Produce `query_result`: the executed result set. Your output for this step is the raw
  `{columns, rows}` returned by `wren`, plus a note of whether the execution succeeded or errored
  (the error text, if any) so the repair step can decide whether it must run.
