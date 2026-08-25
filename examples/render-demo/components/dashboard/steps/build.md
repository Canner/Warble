Answer the user's topic over the `{{project_name}}` wren project (a semantic layer at
`{{project}}`).

- Discover available models, columns, and cubes **at query time** using the `wren` CLI
  (`wren --sql ...`, `wren cube list`, `wren cube describe <cube>`); do not assume the schema.
- Every query goes through the semantic layer via `wren`, read-only — never write to the
  warehouse.
- Return the data for the declared render blocks (KPI cards, a table, a chart) as structured
  JSON, not prose.
