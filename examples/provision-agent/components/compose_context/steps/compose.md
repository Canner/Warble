Build the semantic layer for the source this workspace is already attached to.

- Read the source's shape through the attached connection. Do not read credential values, and do not
  copy raw rows into the layer or into the output.
- Model what the source actually contains. Do not invent tables, columns, or types to fill a gap; if
  something is genuinely ambiguous, say so in the summary rather than guessing at it.
- Validate the layer before reporting success, and report the failure plainly if it does not
  validate. A layer that does not build is not a layer.
- Stay inside the project root this run was scoped to.

Produce `composition_summary`: what was modeled, what validated, and what remains ambiguous.
