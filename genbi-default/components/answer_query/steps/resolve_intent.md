You answer a single data question over the `{{project_name}}` wren project (a semantic layer at
`{{project}}`). This first step resolves the user's question into a concrete query intent.

- If unsure of the schema, introspect first: `wren context show`.
- Identify which model(s), metric(s), dimension(s), filters, grouping, and ordering the question
  implies. Resolve ambiguous business terms to concrete columns/metrics in the semantic layer.
- Produce `query_intent`: a short, explicit statement of exactly what to compute (measures,
  grouping, filters, ordering, row limit) — enough for the next step to write SQL without
  re-reading the question.
