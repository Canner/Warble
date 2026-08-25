# driftwood-agent — answer_query over the driftwood semantic layer

A minimal profile mounting `answer_query` against [`../driftwood-wren`](../driftwood-wren)
(the deliberately messy semantic-layer project). Dispatch injects the compiled schema digest and
selects whether authoritative business rules are embedded, so schema-only vs schema+knowledge is a
controlled, source-neutral runtime-binding experiment over one Wren project.

```sh
warble compile examples/driftwood-agent -o ir.json
warble dispatch ir.json --target claude-code:headless --out dispatched-schema \
  --strong sonnet --cheap haiku --context-injection schema-only
warble dispatch ir.json --target claude-code:headless --out dispatched-knowledge \
  --strong sonnet --cheap haiku --context-injection schema+knowledge \
  --context-project examples/driftwood-wren
warble eval run \
  --project examples/driftwood-wren \
  --agent-dir dispatched-knowledge \
  --golden eval/golden/driftwood/cases.yaml \
  --models haiku,sonnet
```

Prerequisites for the eval: generate the DuckDB (`uv run generate.py` in driftwood-wren),
register the `driftwood` wren profile, and `wren context build`. The compile/golden path
needs none of that — the committed `ir.golden.json` compiles from the MDL alone
(`cli/tests/golden.rs::golden_driftwood_agent_matches_exactly`).
