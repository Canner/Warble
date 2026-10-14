Repair step. It runs ONLY when `dashboard` is an error product, that is, when the previous
`compose_layout` output was rejected for violating the render contract. If `dashboard` is a valid
result, do nothing and pass it through unchanged.

- The error product has `reason`, which names the exact render-contract violation (for example a
  field of the wrong type or a value outside the allowed set), and `text`, which is the previous
  output.
- Fix ONLY the structure. Re-emit the same dashboard from the panel results already present in
  `text`: the same panels, the same order, and every value copied exactly. Change only what the
  violation names, plus anything else that breaks the render contract, such as a `kpi_card` `label`
  that is not a string, a `chart_type` outside `bar|line|pie|area|scatter`, or table rows that are
  not arrays of scalar values in the declared column order.
- Make no new `answer` calls and run no queries. Invent nothing: no new panels, numbers, labels
  or provenance. Copy `sql`, `source_tables` and `filters` into the definition block only as
  they already appear in the previous output.
- If a conforming dashboard cannot be produced from those values, refuse the dashboard: emit the
  same refusal shape `compose_layout` uses, and do not fabricate a layout.
- Produce `repaired_dashboard` with exactly the same output contract as `compose_layout`'s
  `dashboard`. Follow the "Render output" instructions the dispatcher appends below for the active
  render flavor: emit the `{ blocks, summary }` envelope (programmatic) or write the HTML (prompt).
  The final message rules are identical to `compose_layout`'s: no extra commentary, and never ask
  the user what kind of artifact they want.
