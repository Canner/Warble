# explain_change eval goldens

Synthetic ground truth for the `explain_change` component. Two metrics:

## `driver_correctness` — deterministic (`drivers.yaml`)

`regional_sales.csv` is engineered so a metric change has one **known** dominant driver: total
revenue rises 400 → 500 between Q1 and Q2, and the per-region contributions to that +100 delta are
`west +95, north +5, east +2, south −2` (they sum to the total delta — `revenue` is additive across
`region`). `drivers.yaml` asserts explain_change surfaces those contributions in the right rank with
the right numbers (ordered result-set comparison). Because the driver is true by construction, this
needs no judge.

## `additivity_guard` — deferred assertion (NOT a runner golden)

The guard: explain_change must **not** present an exact decomposition of a **non-additive** metric
(a ratio / average / distinct-count) as if it were exact. On this dataset the non-additive probe is
*"average revenue per region"* — decomposing an average by summing per-region deltas is invalid, so
the expected behavior is a **refusal or an explicit "attribution is approximate; additivity not
enforced" caveat in the narrative**, never a clean ranked decomposition.

This is specified as an assertion rather than a `{columns, rows}` golden because:

1. its pass condition is a property of the narrative text (contains the caveat / declines), not a
   result set the execution comparator can diff; and
2. **Warble does not yet enforce additivity.** The `metric_additive` precondition is declared and
   carried into the IR, but the front-end does not evaluate it against MDL at compile time (coarse
   binding — see `docs/spec/ir-schema.md`). Compile-time rejection of a non-additive metric waits on
   the Phase 2 ContextLoader. Until then the guard lives in the step prompt (runtime degrade + the
   required caveat) and this documented assertion — honest about being unenforced.

Both paths' live-run is gated on the `wren` CLI + a queryable project built from `regional_sales.csv`
(a runtime prereq orthogonal to Warble).
