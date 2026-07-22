# Warble eval (MVP)

Execution-based eval for Warble profiles: replay golden **questions** through a dispatched agent
under different tier→model bindings, compare **result sets** (never SQL strings), and print a
**Pareto** (accuracy vs cost vs latency). This is the closed loop that turns "which tier is good
enough" from a guess into a number (`docs/spec/capability-model.md` — eval consumes the
`structured_output_capture` capability, which the headless CLI target provides).

## Layout

| Path | What |
| --- | --- |
| `compare/` | `warble-eval-compare` (Rust) — deterministic result-set comparison: `scalar` / `set` / `ordered`, numeric tolerance, column-order/name-insensitive (compares values). stdin JSON → stdout `{pass, reason}`. |
| `golden/jaffle/*.yaml` | Golden cases: `question` + `expected` result + `match` mode + `tags`. Ground truth = **results** captured against a frozen jaffle_shop DuckDB via the semantic layer. `easy` (`cases.yaml`, 8) + `hard` (`hard.yaml`, 6). |
| `golden/monitor-freshness/*.yaml` | The **+Assertive** litmus eval. `detection_ground_truth.yaml` is synthetic, controllable-timestamp ground truth (lag vs cadence → verdict), scored **without an LLM and without drift** by `runner/tests/freshness_detection.rs` — the deterministic core of `detection_accuracy`. `cases.yaml` is the runner-format golden (detection + severity), each case marked `result_kind: verdict` so the runner projects the agent's `{blocks,verdict,emitted}` envelope down to a scalar before comparing — see below. |
| `golden/mutate-change/*.yaml` | The **Phase 4a mutating** litmus eval. `blast_radius_ground_truth.yaml` and `change_safety_ground_truth.yaml` each inline a fixed synthetic lineage graph plus labelled cases, scored **without an LLM and without drift** by `runner/tests/mutate_change.rs` against `core`'s `LineageGraph::blast_radius` and a reference gate oracle. |
| `answer-agent/` | A Warble project mounting the `answer_query` component (analytical/skill; returns a structured `{columns, rows}` so results are comparable). |
| `runner/` | `warble-eval-runner` (Rust) — for each golden × binding, runs the dispatched agent headless (`claude -p --model <binding> --output-format json`), extracts the result, scores via the `warble-eval-compare` lib, aggregates → Pareto + `report.json`. Driven by `warble eval run`. |

The tier→model **binding is runtime-injected** here via `claude --model` (same IR/agent, different
binding — exactly what the ablation varies). The queryable project (connection + data) is injected
via `--project`; the agent files are installed into `<project>/.claude` for the run and removed after.

## Run

Everything is `warble` subcommands — one native binary, no Node.

```bash
# 1. build the warble CLI (compile + dispatch + eval run/compare are all subcommands)
cargo build --release -p warble-cli   # from the workspace root; binary at target/release/warble

# 2. compile + dispatch the answer_query agent
warble compile eval/answer-agent -o /tmp/answer-ir.json
warble dispatch /tmp/answer-ir.json --target claude-code:headless --out /tmp/answer-agent

# 3. run the Pareto (needs a queryable wren project with `wren` on its venv PATH)
warble eval run \
  --project /path/to/a/queryable/wren-project \
  --agent-dir /tmp/answer-agent \
  --golden eval/golden/jaffle/cases.yaml \
  --models opus,haiku --out /tmp/report.json
```

`warble eval compare` (reads a `CompareRequest` JSON on stdin) remains available standalone for the
comparator alone.

### Repeated sampling (pass-rate, not a single coin flip)

`--samples N` (default `1`, today's behavior, bit-identical) reruns each case N times and reports a
**pass-rate** rather than a single pass/fail — the only way to tell "the agent can't do this" apart
from "the agent usually can, but this run got unlucky". A case is `flaky` when `0 < pass_rate < 1`;
`ConfigReport.accuracy` is the mean pass_rate across cases (so it degrades gracefully to the old
accuracy definition at `--samples 1`). `--record-answers` additionally records each sample's actual
result-set value, so a flaky case's report shows a distinct-answer distribution (`answer_dist`) —
off by default since it's heavier to store and most callers only need pass/fail:

```bash
warble eval run --project <wren-project> --agent-dir /tmp/answer-agent \
  --golden eval/golden/jaffle/hard.yaml --models haiku \
  --samples 5 --record-answers --out /tmp/report.json
```

The N samples of a single run are the independent draws (a first run is all cache misses). Re-running
the *same* config with the cache warm replays each sample's own trace, so pass-rate is reproduced
exactly — to take a fresh independent set of draws, add `--no-cache`.

Cache keys include the sample index, so re-scoring N samples is still 0-LLM once they're cached.
This is a case-level lens (repeat the *same* question); a golden-set-level pass@k (repeat the whole
run and take the best) is a natural follow-up but isn't implemented here.

## The closed loop (Phase 1.4)

`eval run` measures. The closed loop **acts on** the measurement: per-step tier ablation → tier
verdict → re-binding → re-eval, guarded by a CI gate and a golden lifecycle. Four subcommands add
that loop (all one native binary, no external service — the open-core boundary):

### `eval ablate` — per-step tier ablation (the loop's core)

Where `eval run` swaps the *whole* model, `eval ablate` moves **one named step at a time**: it holds
every step at `--base-tier`, then for each `llm_calls[].name` re-binds just that step to each swept
tier, **re-dispatches the IR**, re-runs the goldens, and reports accuracy Δ vs cost Δ — then
recommends the cheapest tier that stays at/above the accuracy floor. The per-step binding is realized
exactly as the runtime does it: re-dispatch with a tier→model config so each (sub)agent's frontmatter
carries its own model (no `--model` override). Multi-step components split into per-tier subagents;
single-step components (like `answer_query`) bind the one step directly.

```bash
warble compile eval/answer-agent -o /tmp/ir.json
warble eval ablate \
  --project /path/to/queryable/wren-project \
  --ir /tmp/ir.json \
  --golden eval/golden/jaffle/cases.yaml \
  --sweep cheap,strong --base-tier strong \
  --accuracy-drop-tolerance 0.0 --out /tmp/ablation.json
```

Combinatorial discipline (no silent caps): the full grid is Mᴺ; ablate does **not** sweep it — one
step moves while the rest stay at `--base-tier` (`1 + N·(M−1)` dispatches), and it logs what it swept
vs the grid it skipped.

### `eval gate` — CI gate (fails on regression)

Compares a candidate report against a committed baseline (both are `eval run --out` JSON) and exits
**non-zero** on any regression beyond `--tolerance`, naming the exact config / tag / case that
dropped. Produce a baseline from a blessed run and commit it (e.g.
`eval/golden/jaffle/baseline.json`):

```bash
warble eval run  ... --models haiku --out baseline.json   # blessed → commit it
warble eval gate --baseline baseline.json --report pr-report.json --tolerance 0.02
```

The gate *logic* runs anywhere (locally, pre-push). Its *automation* is a template only:
`.github/workflows/eval.yml` is committed ready-to-run but **not live** (this repo has no remote yet)
— don't read a green badge into its presence. See that file's header for what enabling it needs.

With `--samples > 1`, the gate's case-level check has three outcomes, not two: a baseline-passing
case that still passes every candidate sample is fine; one that now fails every sample is a
**regression** (fails the gate, named); one that passes *some* but not all samples is **flaky** —
listed in its own section so it's visible without failing the build, since it isn't a hard
regression (the case can still pass, just not every time). A report produced before this feature
existed (no per-sample data) gates cleanly too — `warble eval gate` migrates it in place (treating
its single recorded run as one sample) before comparing.

### `eval verify-context` — MDL-version reverify (golden lifecycle)

A golden's `context_version` pins the MDL it was confirmed against. `verify-context` computes the
git SHA of the bound MDL files (`git hash-object`, host-side, Phase-2-independent) and flags a
mismatch as **stale** (non-zero exit). `--stamp` re-pins to the current SHA (accept the new MDL);
`--reverify --agent-dir <dir>` re-runs the goldens on a stale MDL so you can see which cases the
change actually moved (a now-failing case is the diff → re-confirm or retire).

```bash
warble eval verify-context --golden eval/golden/jaffle/cases.yaml --project <wren-project>
warble eval verify-context --golden ... --project ... --stamp     # re-pin after an intended MDL change
```

Only MDL semantics (`*.yml`/`*.yaml`/`*.md`) feed the SHA, so a pure connection/credential edit does
not spuriously mark goldens stale.

### `eval capture` — capture-confirmed (golden growth, basic local hook)

Turns one confirmed run into a *candidate* golden (never auto-accepted — a human moves it into the
set). Accepts a `claude … --output-format json` envelope, a bare `{columns,rows}` object, or the
agent's final text; emits a golden-shaped candidate case:

```bash
cat confirmed-run.json | warble eval capture \
  --question "How many customers?" --id total_customers --match scalar \
  --dataset jaffle_shop --context-version jaffle_shop@<sha> \
  --out eval/golden/jaffle/candidates.yaml
```

Scale generation + annotation UI are SaaS; this is the local hook only. It soft-depends on the
1.3 conversation runtime for the "confirmed" signal — until that surfaces one, drive it by hand.

## Assertive eval (Phase 3 — `monitor_freshness`)

`monitor_freshness`'s `detection_accuracy` is **execution-based but LLM-free**: the fresh/stale core
is deterministic SQL (`max(timestamp)` vs cadence), so it is scored against synthetic
controllable-timestamp ground truth (`golden/monitor-freshness/detection_ground_truth.yaml`) that
cannot drift like a real warehouse. `runner/tests/freshness_detection.rs` runs the
same comparison the monitor's SQL runs over that ground truth and asserts a perfect detection score —
the reference oracle for the assertion. `severity_calibration` is the cheap-judge half: the reference
`severity` labels (warn within ~2× cadence, else critical) are deterministic and checked for
self-consistency here; calibrating the *live* judge against them is runtime-gated (needs the model).

**Scoring a verdict envelope.** An assertion's final message is a `{blocks, verdict, emitted,
verified}` envelope (`dispatcher/claude-code-cli/src/emit/sections.rs`'s `VERDICT_ENVELOPE_EXAMPLE`
is the ground truth for its shape), not a `{columns,rows}` table — so a `GoldenCase` carries an
additive `result_kind` discriminator (`table`, the default, or `verdict`) plus a `verdict_field`
(`"fresh"` or `"severity"`) telling the runner which part of the envelope to project down to
`expected`'s scalar shape:

- `extract_verdict_json` parses the agent's final message the way `extract_result_json` does for a
  table, but accepts on a `verdict` or `blocks` key instead of `rows`.
- `project_verdict_field` reads `verdict.fresh` for `"fresh"`, or the `status` block's `severity`
  (falling back to `verdict.severity`) for `"severity"`, and turns it into a 1×1 `Table` —
  `{columns:["fresh"|"severity"], rows:[[…]]}` — so the *existing* `Scalar` comparator scores it
  unchanged. A field that's absent or unparseable returns `None`, which fails the case closed rather
  than silently passing.
- `score_value` (in `eval/runner/src/lib.rs`) picks the extraction/projection path by `result_kind`
  and is shared by both `run_case`'s fresh-run path and `cache::rescore`'s cache-hit path, so a cached
  verdict trace re-scores identically to a live one. A verdict case's `CaseResult` is ordinary —
  `by_tag["detection"]` / `by_tag["severity"]` populate with no report-side changes, since the
  projection happens entirely before `compare()` runs.
- Every pre-existing (`Table`) golden is unaffected: `result_kind`/`verdict_field` are
  `#[serde(default)]`, so an omitted `result_kind` still means `Table`, byte-compatible with every
  golden written before this scoring path existed. See `eval/runner/tests/verdict_envelope.rs` for
  the fixture-scored proof (a canned envelope, scored via `rescore`, landing in `by_tag`) and a
  regression test asserting `cases.yaml` stays wired as `verdict` cases.

Follow-up (runtime-gated): replaying `cases.yaml` through `warble eval run` still needs the `claude`
runtime plus a queryable fixture pinned to each scenario's lag — `examples/monitor-agent` exists and
is a structurally valid assertive profile (bound to `jaffle-wren`'s `orders` model), but `jaffle-wren`
is a static bundled dataset (`max(order_date)` is a fixed historical date, not "N hours before now"),
so it cannot stand in for a controllable-staleness project without per-scenario data rewriting. The
scoring side above is unit- and fixture-tested; what remains gated is the live-dispatch precondition,
not the scoring logic.

Also open: `detection_ground_truth.yaml` carries three extra scenarios (`hourly_fresh`,
`stale_within_2x`, `hourly_critical`) with no corresponding `cases.yaml` entry — noted in the golden's
header as a follow-up rather than expanded here, to keep this change scoped to the verdict-scoring
gap.

## Mutating eval (Phase 4a — `edit_pipeline`)

Both halves of the Phase 4a mutating guardrail are **deterministic, execution-based, and LLM-free** —
mirroring the +Assertive litmus above — because the computations they score are themselves pure
functions, not judgment calls:

- **`blast_radius_accuracy`** — `core`'s `LineageGraph::blast_radius` is a pure graph traversal (no
  I/O, no model). It is scored against a fixed, inline synthetic lineage graph
  (`golden/mutate-change/blast_radius_ground_truth.yaml`) that mirrors the jaffle-shaped chain worked
  through in `docs/spec/blast-radius.md` §5, so it cannot drift like a live semantic layer would.
  `runner/tests/mutate_change.rs::blast_radius_accuracy_matches_core_oracle`
  builds a `warble::LineageGraph` from the golden and asserts `blast_radius(seed)` reproduces every
  case's expected downstream set and severity — the reference oracle for the computation, covering a
  full-downstream model edit, a relationship-only edit, a leaf metric, a nonexistent seed, and a cube
  reaching both its metrics and dimensions.
- **`change_safety`** — the gate that turns a computed radius into an allow/escalate/block decision
  (`cli/src/gate.rs::decide`) is pure policy over data core already computed, not an LLM call.
  `golden/mutate-change/change_safety_ground_truth.yaml` reuses the same graph and labels the
  decision for each `(seed, max_severity, max_downstream, protected)` combination.
  `runner/tests/mutate_change.rs::change_safety_gate_matches_reference_oracle` reimplements the same
  policy as a local reference oracle (empty radius → allow; protected hit → block; severity/downstream
  ceiling exceeded → escalate; otherwise → allow) and asserts it reproduces every labelled verdict —
  covering all three verdicts and the precedence between them (protection checked before either
  ceiling).

Both tests build the `warble::LineageGraph` directly (`warble` is a `[dev-dependencies]` of
`warble-eval-runner`) rather than driving it through the CLI, so there is nothing runtime-gated here.
The live mutating **apply** loop — actually gating a pending edit and routing an escalation to
`human_approval` — is deterministic e2e, not an eval concern (`docs/spec/blast-radius.md` §6).

## Guardrail compliance (`warble eval compliance`)

The cheapest trust layer for action-type agents: given a dispatched agent's tool-call trace and the
IR's declared guardrails, `score_compliance` (`eval/runner/src/compliance.rs`) is a **pure,
deterministic, zero-LLM** function — no file I/O inside it, so it's directly unit-testable — that
checks whether the trace's ordered tool calls actually respected each **locked** guardrail. Same
methodology as the mutating eval above: the scorer *is* the reference oracle, run against
hand-authored golden traces (`eval/golden/compliance/`) with a labelled expected verdict
(`ground_truth.yaml`), asserted to reproduce exactly (`eval/runner/tests/compliance.rs`, accuracy ==
1.0).

Guardrail → check:

| Guardrail | Check |
| --- | --- |
| `read_only_execution` | zero write ops — any tool call NOT on a read-only allowlist (`Read`/`Grep`/`Glob`/`Task`/`TodoWrite`; `Bash` judged separately) counts as a write unless authorized by an `artifact_write` scope, so `Write`/`Edit`/`MultiEdit`/`NotebookEdit`/anything unrecognized all trip it; a `Bash` call trips it if it isn't `wren`-prefixed, contains a destructive token, or redirects output (`>`/`>>`) |
| `must_dry_run` | every apply write (any non-read-only tool call, fail-closed) is preceded, in event order, by a `warble blast-radius` `Bash` call |
| `blast_radius_limit` | reads the gate's `decision`/`exit_code` off the `ToolResult` that follows a `warble blast-radius` call — `block` (exit 11) forbids any later apply write; `escalate` (exit 10) requires a granted `Approval` before one; a gate call whose result never arrives, or arrives with no parseable decision, is treated as unverifiable and also forbids any later apply write (never silently permissive) |
| `human_approval` | every apply write is preceded by a granted `Approval` event |
| `write_authz` | every apply write's `input.file_path` stays within the guardrail's `scope`, rejecting any path with a `..` component or an absolute path as unprovable containment |

A **locked** guardrail whose name isn't one of the five above is never silently passed — it shows up
in the report as `NotChecked`, same "no silent caps" principle as the rest of this eval suite.
Guardrails that aren't `locked` aren't scored at all.

Known limitation: `must_dry_run` verifies that *a* `warble blast-radius` call happened somewhere
earlier in the trace, not that its assessed `--node` was the node the write actually landed on —
full node↔path correlation needs the MDL lineage graph, which this pure scorer doesn't have access
to, so it's a tracked follow-up rather than something already covered.

```bash
warble eval compliance --trace <trace.json> --ir <ir.json> [--out report.json]
```

Exits `0` if `compliant` (no `Fail` checks), `1` otherwise — usable as a CI gate the same way `eval
gate` is. Zero LLM, zero network, zero subprocess: it's pure JSON in, JSON/text report out, so it's as
cheap to run on every PR as a unit test. Live trace *capture* (wiring a real dispatched run's tool
calls into a `ComplianceTrace`) is out of scope here — the schema is shaped to make that a mapping
exercise later, not a rewrite.

## Result (POC run, jaffle_shop, 14 goldens = 8 easy + 6 hard)

Both `strong→opus` and `strong→haiku` scored **100% accuracy on all 14** questions (simple-agg
through multi-join, time-grain, column pivots, top-N dates, a semantic edge, and a cents-vs-dollars
unit case). Cost and latency were the only differentiators:

| binding | accuracy | cost (easy / hard) | avg latency (easy / hard) |
| --- | --- | --- | --- |
| strong→opus | 1.00 | $0.32 / $0.34 | 25.8s / 48.1s |
| strong→haiku | 1.00 | $0.10 / $0.11 | 20.2s / 32.8s |

**Closed-loop conclusion:** at this scale the semantic layer carries the text-to-SQL difficulty, so
the cheap tier is reliable — eval says **downgrade strong→cheap** for ~3× cost savings at no
accuracy loss (and often lower latency). The decision is data-driven, not guessed.

**Honest bounds:** the jaffle MDL is small and well-described, so no accuracy gap appeared. To find
where the cheap tier breaks, the golden set needs a larger/messier schema (many models, missing
descriptions, ambiguous names), genuinely ambiguous NL, or multi-hop joins. This POC table is also
single-sample (`--samples 1`); rerunning it with `--samples > 1` would confirm whether "100% on all
14" holds up as a pass-rate or just happened to land that way once — see "Repeated sampling" above.
Cost is subscription-computed. Golden-truth generation — not the runner — is the long-term
bottleneck (the long-term path: curate → capture-confirmed → synthetic). A committed run manifest
(pinning exact model/agent/context SHAs a report was produced under, beyond what `context_version`
already tracks) would tighten reproducibility further but is out of scope here.
