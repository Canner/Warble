Introspect the bound raw source `{{project}}` and report its shape.

Read the raw schema (tables, columns, and column types) through the borrowed schema-introspection
capability (e.g. `wren`/dlt) — never guess it. For each table list its columns and their types, and
flag any column that looks like a timestamp (a candidate time dimension) or a numeric measure
candidate (a candidate additive metric).

Produce `raw_schema`: the introspected tables/columns/types, plus your candidate annotations. Do NOT
write any file in this step — this is read-only introspection that feeds the MDL draft.
