# driftwood-agent — answer_query over the driftwood semantic layer

A minimal profile mounting `answer_query` against [`../driftwood-wren`](../driftwood-wren)
(the deliberately messy semantic-layer project). The step prompt instructs the agent to
read `wren context instructions` first and treat the knowledge rules as authoritative —
which is what makes the MDL-only vs MDL+Knowledge comparison a controlled experiment
(same prompt, only the project's knowledge differs).

```sh
warble compile examples/driftwood-agent -o ir.json
warble dispatch ir.json --target claude-code:headless --out dispatched --strong sonnet --cheap haiku
warble-eval run \
  --project examples/driftwood-wren \
  --agent-dir dispatched \
  --golden eval/golden/driftwood/cases.yaml \
  --models haiku,sonnet
```

Prerequisites for the eval: generate the DuckDB (`uv run generate.py` in driftwood-wren),
register the `driftwood` wren profile, and `wren context build`. The compile/golden path
needs none of that — the committed `ir.golden.json` compiles from the MDL alone
(`cli/tests/golden.rs::golden_driftwood_agent_matches_exactly`).
