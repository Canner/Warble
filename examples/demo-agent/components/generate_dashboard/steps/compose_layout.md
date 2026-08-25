Once the data is retrieved, compose the dashboard:

- Run each planned query with the `wren` CLI and collect the results.
- Assemble the dashboard artifact with `wren genbi build <name> --prompt "<topic>"`, then
  `wren genbi verify <name>` and `wren genbi open <name>` to produce a browsable dashboard.
- Summarize the headline findings in prose, and return the chart/table/kpi specs you used.
