# driftwood-agent — answer_query over the driftwood semantic layer

A minimal profile mounting `answer_query` against [`../driftwood-wren`](../driftwood-wren)
(the deliberately messy semantic-layer project). Dispatch injects the compiled schema digest and
selects whether authoritative business rules are embedded, so MDL-only vs MDL+Knowledge is a
controlled runtime-binding experiment over one project.

```sh
warble compile examples/driftwood-agent -o ir.json
warble dispatch ir.json --target claude-code:headless --out dispatched-mdl \
  --strong sonnet --cheap haiku --context-injection mdl-only
warble dispatch ir.json --target claude-code:headless --out dispatched-knowledge \
  --strong sonnet --cheap haiku --context-injection mdl+knowledge \
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
