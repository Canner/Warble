# driftwood-agent — answer_query over the driftwood semantic layer

A minimal profile mounting `answer_query` against [`../driftwood-wren`](../driftwood-wren)
(the deliberately messy semantic-layer project). Dispatch injects the compiled schema digest;
the project's authoritative business rules in `knowledge/rules/` are *not* embedded by dispatch,
so this profile exercises the agent against a messy layer it must reason about from the digest.

The recorded schema-only vs schema+knowledge comparison in
[`../driftwood-wren`](../driftwood-wren#eval-design-mdl-vs-knowledge-is-the-experiment-axis) was measured with a dispatch-time
knowledge-injection mode that the CLI no longer offers; the numbers stand as history, but the
`schema+knowledge` half is not reproducible with this command.

```sh
warble compile examples/driftwood-agent -o ir.json
warble dispatch ir.json --target claude-code:headless --out dispatched-schema \
  --strong sonnet --cheap haiku
warble eval run \
  --project examples/driftwood-wren \
  --agent-dir dispatched-schema \
  --golden eval/golden/driftwood/cases.yaml \
  --models haiku,sonnet
```

Prerequisites for the eval: generate the DuckDB (`uv run generate.py` in driftwood-wren),
register the `driftwood` wren profile, and `wren context build`. The compile/golden path
needs none of that — the committed `ir.golden.json` compiles from the MDL alone
(`cli/tests/golden.rs::golden_driftwood_agent_matches_exactly`).
