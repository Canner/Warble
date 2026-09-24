Given `report_plan` — the layout from the previous step, with the verified values already
materialised into its blocks by the host — write the report's summary and per-block notes and
produce `report`.

- Each block in `report_plan.blocks` now arrives in one of two states:
  - **filled**: it carries the fields its type renders — a `kpi_card` has `value` (and `unit`
    when known), a `chart` has `x`, `series` and `rows`, a `table` has `columns` and `rows`, a
    `narrative` has `text` — plus its `slot_id`;
  - **unavailable**: it carries `"status": "unavailable"` and a `reason_category` instead of a
    value, because its answer was refused or could not be given.
  The plan may also carry `definition` blocks the host attached as provenance.
- **Never alter a value.** Copy every `value`, `unit`, `x`, `series`, `rows`, `columns` and `text`
  into the output exactly as materialised — same numbers, same rows, same order. Do not compute
  totals, deltas, ratios or growth rates that are not already in a block, do not round, and do not
  drop or add rows. Do not fill an unavailable cell with an estimate, a recollection or a
  placeholder number. If a value looks wrong, say so in its `note`; do not fix it.
- Write `summary`: a few sentences addressing `summary_brief`, grounded only in the materialised
  values, naming the preamble's period and currency. Where a cell is unavailable, say so plainly and
  name its reason category; never speculate about what the value would have been.
- Write a short `note` on each filled `kpi_card`, `chart` and `table` block: the useful reading of
  that cell, grounded only in its own values. You may adjust a block's `label` or `title` for
  clarity; you may not change its type, `slot_id` or position.
- Map each unavailable block to an `unavailable` block:
  `{"type": "unavailable", "label": "<the block's label or title>", "block_type": "<its original
    type>", "reason_category": "<as materialised>", "slot_id": "<as materialised>",
    "note": "<optional one-line explanation>"}`. Keep it in the block's original position.
- Pass every `definition` block through unchanged. Do not write one yourself.
- Produce `report`: follow the "Render output" instructions the dispatcher appends below for the
  active render flavor — emit the `{ blocks, summary, verified }` envelope (programmatic), where
  `verified` is true only if every filled block came from a verified answer. The rendered report IS
  the artifact: never ask the user what kind of artifact they want, and never offer alternatives.
