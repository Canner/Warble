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
| `bird-interact/` | Official-orchestrator-compatible BIRD-Interact `a-interact` adapter: Warble owns the port-6000 system agent and nine-tool ledger; Wren plans Query SQL; the pinned official user simulator, DB environment, and scorer remain authoritative. See its [runbook](bird-interact/README.md). |
| `bird-interact/agents/baseline/` | Dedicated external-context Warble profile for BIRD-Interact, tracked inside the adapter package it serves; it exposes no free filesystem, shell, web, generic SQL, or Wren-context tools. It is a **baseline** — the least profile that can play the protocol, never tuned against a score — and it is meant to be beaten, not edited: copy it and pass `--profile`, see [Bring your own agent](bird-interact/README.md#bring-your-own-agent). |

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

The gate *logic* runs anywhere (locally, pre-push). Its *automation* is `.github/workflows/eval.yml`.
It installs the `wren` CLI, `wren context build`s the in-repo `examples/jaffle-wren` project (its
`target/mdl.json` is generated, not committed), replays `eval/golden/jaffle/cases.yaml` under haiku at
`--samples 3 --no-cache`, and fails on a regression vs `eval/golden/jaffle/baseline.json`. It is
**manual-dispatch only** — no pull request ever triggers it, because every run spends real model
calls. The job skips cleanly (neutral green) without the **`CLAUDE_CODE_OAUTH_TOKEN`** secret rather
than producing a credential-related false failure.
`--no-cache` forces a real run every time: the trace cache keys on the raw project sources, but the
agent queries the compiled `target/mdl.json`, so a stale cache could mask a regression that only
shows in the compiled artifact.

For local eval preparation, run:

```bash
./eval/build-jaffle-context.sh
```

`examples/jaffle-wren/wren_project.yml` is an authored source manifest;
`examples/jaffle-wren/target/mdl.json` is generated. The helper copies the authored fixture to a
temporary directory, runs `wren context build` there, and writes only the ignored MDL artifact back
to `target/`. This isolates any Wren CLI normalization, including a machine-local named connection
`profile`, from tracked project sources. The fixture-local `examples/jaffle-wren/README.md` documents
the manifest's engine namespace fields.

**Refresh the baseline** when a score change is legitimate: re-run the blessed command above against
`examples/jaffle-wren` and commit the new `baseline.json` in the same PR. (Note: the eval queries the
compiled `target/mdl.json`; a PR that edits raw sources without rebuilding it won't be reflected —
the CI job rebuilds it, so CI always scores the current sources.)

With `--samples > 1`, the gate's case-level check has three outcomes, not two: a fully passing
baseline case that still passes every candidate sample is fine; one that passes *some* but not all
candidate samples is **flaky** — listed in its own section so it's visible without failing the
build, since it isn't a hard regression (the case can still pass, just not every time). Any case
with non-zero baseline capability — including a partially passing baseline case — that now fails
every sample is a named **regression** and fails the gate. Overall and per-tag gate metrics use
non-zero pass coverage over the baseline's case set, so the same flaky case cannot fail indirectly
through an aggregate. A report produced before this feature
existed (no per-sample data) gates cleanly too — `warble eval gate` migrates it in place (treating
its single recorded run as one sample) before comparing.

#### What the accuracy gate does not watch — and what does

This suite watches nothing automatically: it is `workflow_dispatch` only, because every run spends
real model calls. Earlier it ran on a `paths:` filter covering `hub/**`, `examples/**`, `eval/**` and
`**/profile.yml`, which still omitted **`dispatcher/**`** — the most-touched tree in the repo.

That omission left a real hole, since dispatch decides what an emitted agent *reads*: its system
prompt, its inventory of sibling agents, its permission envelope, the always-loaded project memory.
A dispatcher-only pull request once added an always-loaded scope prompt to every emitted agent
directory, and this gate never ran on it. Nothing was broken by it — measured after the fact — but
nothing would have caught it either. Removing the path filter in favour of manual dispatch widens
that hole to the whole repo by design, so the structural gate below is now the only automatic one.

The hole is closed structurally rather than by paying for accuracy on any PR:
**`dispatcher/claude-code-cli/tests/dispatch_snapshot_tests.rs`** asserts the whole emitted tree,
byte for byte, against a committed snapshot for both file targets. It runs inside `just test`, so on
every pull request, with no path filter to get wrong, no credential and no model call. Its snapshot
diff is the review artifact: it shows exactly what every future agent in that scope will read.

| Question | Gate | Cost | Runs on |
| --- | --- | --- | --- |
| Did the emitted context change at all? | `dispatch_snapshot_tests` | none | every PR |
| Did accuracy move? | this workflow | model calls | manual dispatch only |

So when a snapshot diff appears in review, treat it as the prompt to decide whether accuracy needs
measuring, and run this suite by hand (Actions → **eval-gate** → Run workflow → `jaffle`) rather than
assuming — that hand-run is now the only way it ever runs. Refresh a snapshot deliberately, never reflexively:

```bash
UPDATE_DISPATCH_SNAPSHOT=1 cargo test -p warble-claude-code --test dispatch_snapshot_tests
```

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

### Live driftwood freshness pair

The runtime-gated half is now a reproducible manual suite in `.github/workflows/eval.yml`:
`monitor-freshness`. It downloads and SHA-256-verifies the versioned seed-42 clean fixture,
copies it, injects `stopped_updates` without regenerating the base, and builds
the same driftwood MDL for both, registers each database in turn as the project's pinned
`driftwood` Wren profile, fail-fast queries its maximum snapshot date, dispatches
`examples/monitor-driftwood-agent`, and runs two one-case verdict goldens:

- `driftwood-clean.yaml` queries the actual maximum `subscription_snapshots.snapshot_date` and must
  report `fresh=true` against the generator's pinned `2026-06-30T00:00:00Z` reference time.
- `driftwood-stopped-updates.yaml` runs the identical question against the injected database and
  must report `fresh=false` (critical at the manifest's 730h cadence).

Both runs use `--record-answers`, preserving the raw `{blocks, verdict, emitted, verified}` envelope
in the ordinary runner report (and preserving malformed final output when extraction fails). The
suite pins the whole live run to Sonnet: the dispatched single-agent target must both execute the
query and obey the strict envelope contract, while the component's cheap-tier severity step remains
an architectural binding rather than a separately invoked subagent on this target. `warble eval
monitor-report --manifest … --clean-report …
--injected-report …` then joins those reports with the injection manifest and emits a second report
whose `by_tag` contains `recall`, `precision`, `false_alarm_rate`, and `attribution_accuracy` with
their numerator/denominator evidence. The hard line is: both runner goldens pass, both envelopes are
verified, the injected entity is detected, the clean half produces zero false anomalies, and the
manifest severity matches. Attribution is reported but does not gate this first live scenario;
calibrating its coarse keyword matcher across the other three anomaly families remains explicitly
deferred.

Run it from Actions with **eval-gate → Run workflow → monitor-freshness**. The reports are uploaded
as the `monitor-freshness-report` artifact. Ordinary pull requests continue to run only the smaller
jaffle gate.

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

## BIRD-Interact eval (external benchmark — `bird-interact/`)

Everything above scores Warble against Warble's *own* goldens. `bird-interact/` runs the opposite
check: it drops a Warble agent into an **external third-party benchmark** — BIRD-Interact's
`a-interact` protocol — and lets that benchmark's own user simulator and scorer grade it. A task
there starts deliberately under-specified, and the agent buys its way to an answer with
**bird-coins** from a fixed budget (`ask_user` 2, `submit_sql` 3, schema/knowledge lookups 0.5–1),
across a phase-1 query and a phase-2 follow-up sharing the same remaining budget; only an explicit
`submit_sql` counts as an answer, and an exhausted budget forces one.

The adapter replaces **only** the official system agent on port 6000. The pinned official
orchestrator, user simulator (6001), DB environment/scorer (6002), PostgreSQL data, and ground truth
all stay authoritative — so what is measured is the agent, not a re-implemented benchmark. Warble
owns the session loop and the nine-tool budget ledger; Wren plans Query SQL before the official DB
service executes or scores it, while management SQL bypasses Wren and reaches it unchanged. The
agent under test is the `bird-interact/agents/baseline/` profile: external context, and no
filesystem, shell, web, generic-SQL, or Wren-context tools.

That profile is a **baseline, not Warble's best**: one component, one step, one prompt naming the
nine tools and their prices, never tuned against a score. Any number from this package is that
baseline's floor, so quote it with the profile that produced it — and see
[Bring your own agent](bird-interact/README.md#bring-your-own-agent) for running the benchmark
against your own: copy the baseline into a new profile and pass `--profile`, which keeps the
baseline untouched and lands your run beside it rather than on top of it.

```bash
just install-bird-eval
just prepare-bird-eval --gt <gated-gt.jsonl> --wren-bin <wren>           # → data/runtime
just smoke-bird-eval --oracle-only --python-bin <py> --wren-bin <wren>   # official oracle; no creds
just smoke-bird-eval --python-bin <py> --wren-bin <wren>                 # the live a-interact run
```
