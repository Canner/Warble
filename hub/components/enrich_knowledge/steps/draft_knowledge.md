Draft knowledge-layer entries for `{{project_name}}` from `doc_facts`, as a DIFF only.

Turn the extracted `doc_facts` into the business-semantics Context that belongs under `knowledge/`:
column units, enum-value glosses, and metric/segment definitions. Emit the proposal as a unified
`diff` render block scoped to `knowledge/` — a DRY-RUN proposal, never a write. Do not write any file
yourself; the gated lifecycle applies the approved diff, scoped to `knowledge/` only. Produce
`knowledge_diff`.
