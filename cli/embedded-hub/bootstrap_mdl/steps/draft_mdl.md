Draft an MDL for `{{project_name}}` from the introspected `raw_schema`, as a DIFF only.

From the tables/columns/types in `raw_schema`, propose the semantic layer that belongs under
`models/`: one model per raw table (naming the model for the business entity, not the raw table),
each column carried with its type, plus a cube whose measures are the additive numeric quantities
(e.g. `SUM(amount)`) and whose dimensions/time-dimensions are the categorical/timestamp columns.

Emit the proposal as a unified `diff` render block scoped to `models/` — this is a DRY-RUN proposal,
never a write. Do not create or overwrite any file yourself: the gated lifecycle (there is no existing
lineage to gate for a fresh create — the gate is human approval, scoped to `models/`) applies the diff
only after approval. Produce `mdl_diff`.
