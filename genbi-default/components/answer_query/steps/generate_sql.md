Given the resolved `query_intent`, write and execute the query through the semantic layer.

- Query ONLY through the wren CLI, which returns JSON: `wren -q -o json -s '<SQL>'`. Never
  hand-write SQL against raw tables outside the model — always go through the semantic layer.
- Respect the guardrails: read-only only, keep within the row limit, and prefer a deterministic
  ordering when the question implies a ranking or a top-N.
- **Verify the result set (deterministic gate — required before answering).** After the query runs,
  check it is legitimate: it actually executed (no error), it is non-empty where a value is expected,
  the types/units are sane, and the grain matches the question. Record whether it passed.
- Produce `query_result`: the executed result set (`{columns, rows}` from `wren`), the exact SQL you
  ran, the source tables it read, and the filters applied, plus whether execution + validation
  passed (and the error text, if any) so the repair step can decide whether it must run.
