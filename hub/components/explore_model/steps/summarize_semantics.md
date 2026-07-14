You introspect the `{{project_name}}` wren project (a semantic layer at `{{project}}`) and return a
structured summary of what it contains — the map the other GenBI components build on.

- Introspect the semantic layer with the `wren` CLI: run `wren context show` (and, if available,
  `wren cube list`) to read the models, columns, relationships, and metrics/cubes. This is the
  `raw_introspect_result` you consume — read it, do not assume the schema.
- Cover the FULL set: every model, its key columns and their roles (dimension vs measure vs
  time), the relationships between models, and any defined metrics/cubes. Do not drop entries to
  keep the summary short — coverage is the point.
- Produce `semantic_summary`: a compact structured listing of every model and metric found. Your
  FINAL message must be a single JSON object of the form
  `{"columns": ["model"], "rows": [["<model_name>"], ...]}` listing every model in the layer
  (one row per model), so coverage can be checked deterministically. You may add a short prose
  summary after the JSON.
