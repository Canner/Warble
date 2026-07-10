# driftwood-wren — a deliberately messy semantic-layer project

Driftwood Outfitters is a synthetic outdoor-gear e-commerce company built as an eval
substrate: a schema where cheap and strong LLMs genuinely disagree, and where the semantic
layer (MDL + knowledge) measurably closes the gap. Where `jaffle-wren` is the clean
minimal example, driftwood is the adversarial one.

**Narrative:** launched on a self-built legacy platform in 2019, migrated platforms during
2023 (dual-write window — migrated orders exist in BOTH systems), launched a subscription
product in 2024, sells in the US and Europe (multi-currency), and runs a February-start
fiscal year. Every dirty detail is a consequence of that history, not injected noise.

## The 15 traps

Each trap maps 1:1 to a golden tag (`eval/golden/driftwood/cases.yaml`) and to a canonical
rule in `knowledge/rules/` — that pairing is the point (see "eval design" below).
`TRAPS.md` documents each with a validation SQL + the expected value.

| # | tag | trap |
| --- | --- | --- |
| T1 | cross-system-union | historical metrics span legacy + new platform |
| T2 | dedup-migration | migrated orders exist in both systems |
| T3 | unit-cents | `legacy_orders.amt_c` is integer cents |
| T4 | same-name-diff-meaning | `payments.amount` (net) vs `orders.order_total` (gross) |
| T5 | refund-double-count | refunds exist as a `refunds` row AND a negative payment |
| T6 | test-and-deleted | `is_test` / `deleted_at` inflate naive counts |
| T7 | enum-drift | multiple spellings per canonical channel/status value |
| T8 | semi-additive | MRR / inventory snapshots must not be summed across time |
| T9 | fiscal-calendar | fiscal year starts Feb 1 |
| T10 | timezone | legacy timestamps are naive America/Los_Angeles local time |
| T11 | currency | multi-currency sums need FX; `fx_rates` is weekdays-only |
| T12 | sentinel-null | legacy `ship_dt` uses a `1970-01-01` sentinel |
| T13 | identity-dedup | same humans in both systems; xref covers only ~87% |
| T14 | grain-mismatch | header total ≠ Σ line items on ~8% of orders |
| T15 | returns-vs-refunds | merchandise returns ≠ monetary refunds |

## Generating the data

The DuckDB is **not** committed (22 MB); the generator is, and it is deterministic:

```sh
cd examples/driftwood-wren
uv run generate.py          # ~4 min → driftwood.duckdb (18 tables, ~693k rows, seed 42)
```

Same seed → identical query results across runs (stdlib `random.Random(42)` only — no
faker, no `datetime.now()`; "today" is pinned to 2026-06-30). File bytes may differ;
golden truths depend on query results, which do not.

To query it through the `wren` CLI, register a duckdb profile whose `url` is this
directory (the project binds `profile: driftwood` in `wren_project.yml`), then
`wren context build`.

## Eval design: MDL vs knowledge is the experiment axis

- **MDL column descriptions carry only *local* facts** — units (cents), timezones,
  sentinels, net-vs-gross, snapshot grain. Regenerate with `uv run scaffold_models.py`
  (descriptions are embedded there and cross-checked against `schema_dump.csv`).
- **Global business rules live only in `knowledge/rules/`** — canonical revenue formula,
  cross-system dedup, test-account exclusion, UTC reporting timezone, fiscal calendar,
  units-sold definition.

Stripping `knowledge/rules/` (keeping the MDL) yields the "MDL-only" control; the full
project is "MDL+Knowledge". Measured with `warble eval run` over the 43 goldens
(`answer_query` via headless Claude Code):

| accuracy (cost) | MDL-only | MDL + Knowledge |
| --- | --- | --- |
| **haiku (cheap)** | 0.23 ($1.60) | **0.60** ($2.38) |
| **sonnet (strong)** | 0.44 ($8.36) | **0.93** ($7.10) |

A cheap model with knowledge beats a strong model without it — and unlike on jaffle
(where every tier scores 100%), the tier gap here is real, so the eval loop produces a
non-trivial tier decision.

**Golden discipline learned the hard way:** golden truths must apply the project's own
knowledge rules (the v1 goldens didn't; the stronger model followed the rules and was
marked wrong). Any new golden's truth SQL must honor every canonical rule, and top-N
goldens must be checked for rank ties.

## Project shape (wren CLI v5)

This project is authored in the current wren CLI project shape — keyed `relationships:`
mapping and per-cube `cubes/<name>/metadata.yml` (with a root `cubes.yml` mirror) — so it
also serves as the in-repo integration fixture for that adapter path (`jaffle-wren`
covers the older bare-list shape).
