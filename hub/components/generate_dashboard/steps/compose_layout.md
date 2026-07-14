Given the `dashboard_plan`, run each panel's query and compose the dashboard.

- Run each planned panel query with the `wren` CLI (`wren -q -o json -s '<SQL>'`) and collect the
  results — these are the `panel_results` you consume. (This inlines the query behavior; it does not
  call a separate query component.)
- Assemble each panel into a typed render block conforming to the render contract:
  `kpi_card` for headline numbers, `chart` for trends/breakdowns, `table` for detail.
- Produce `dashboard`: follow the "Render output" instructions the dispatcher appends below for the
  active render flavor — emit the `{ blocks, summary }` envelope (programmatic) or write the HTML
  (prompt). The blocks must carry real values from `panel_results`, not placeholders.
