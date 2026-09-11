Given the `dashboard_plan`, obtain each panel's verified answer and compose the dashboard.

- For every planned panel, call the logical `answer` alias once with a concise request to answer
  that panel's natural-language data question. Include the panel title and type in the optional
  structured input. Call the same alias again for every additional panel; do not combine unrelated
  panels into one request merely to avoid repeated calls.
- Accept a panel result only when the call returns `status: "ok"`, `output.kind: "value"`, and a
  value containing `verified: true`, `columns`, `rows`, `summary`, and `definition`. Refuse the
  dashboard rather than using a refused, failed, unverified, malformed, or placeholder result.
- Assemble each panel into a typed render block conforming to the render contract:
  `kpi_card` for headline numbers, `chart` for trends/breakdowns, `table` for detail. Derive the
  dashboard's definition block from the accepted panel definitions; do not invent provenance.
- Produce `dashboard`: follow the "Render output" instructions the dispatcher appends below for the
  active render flavor — emit the `{ blocks, summary }` envelope (programmatic) or write the HTML
  (prompt). The blocks must carry real values from the accepted panel results, not placeholders.
- The rendered dashboard IS the artifact. Never ask the user what kind of artifact they want, and
  never offer alternatives — saving the plan/JSON to a file, exporting to CSV, "something else?",
  etc. Whatever the user called it ("an artifact," "a report," "the dashboard"), this step's only
  job is to compose it and produce `dashboard` per the render flavor above; don't stop to
  clarify format, and don't do anything else instead (no writing files outside what "Render
  output" already directs).
