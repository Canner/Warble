# Warble POC — findings

End-to-end result of the UI-less vertical slice: **it works.** A declarative Warble project was
compiled to IR, dispatched to a Claude Code agent, installed, and used headless — and the agent
answered a real data question through the `wren` semantic layer.

## What ran

```
examples/demo-agent/ ──warble compile──▶ ir.json ──warble dispatch──▶ .claude/agents/generate_dashboard.md ──claude -p --agent──▶ answer
```

- **compile**: `warble compile <project> -o ir.json` — IR byte-identical to the committed golden. Loud-fail checks (bind-required / locked-guardrail / precondition) covered by tests.
- **dispatch**: `warble dispatch ir.json --target claude-code` — emitted a valid Claude Code subagent (`model: opus`, `tools: [Read, Bash(wren:*)]`), plus `settings.json`, `.wren/config.json` (strict_mode), `RUN.md`. Enum-keyed; unsupported enum values fail loudly.
- **use** (headless, `claude -p --agent generate_dashboard --allowedTools Read "Bash(wren:*)"` against the jaffle_shop DuckDB project): the agent ran `wren --sql` through the semantic layer and returned real numbers — 100 customers, 99 orders, $1,672 revenue, plus a status breakdown and the query specs it used. Read-only held (only `wren` + `Read` were permitted).

## Wall-hits (the value of the POC — where the static-file back-end runs out)

| # | Wall-hit | Observed | Implication |
| --- | --- | --- | --- |
| 1 | **per-step tier** — ✅ **addressed in v0.2** (see below) | v0.1: single `model: opus` (collapse). v0.2: realized as driver + per-tier subagents. | Solved runtime-generally without a programmatic dispatcher. |
| 2 | **render blocks** — ✅ **implemented (both flavors)** | v0.1: markdown only. v0.3: typed block contract + guardrail split. **prompt-fallback**: the `render-demo` agent wrote a real `dashboard.html` (KPI cards + table + chart, correct numbers) end-to-end via `claude -p`. **programmatic (default)**: the agent stays fully read-only and emits a `{ blocks, summary }` envelope; the Warble reference renderer (`warble render`) turns it into a self-contained `dashboard.html` **deterministically** (same envelope ⇒ identical bytes). | Typed blocks + `artifact_write` (scoped Write, separate from data read-only) + render_contract resolved to realize-via(html). Programmatic flavor moves the write off the agent entirely: the model only produces JSON, the dispatcher renders — deterministic HTML + a genuinely read-only agent. |
| 3 | **guardrail enforcement** | read-only was enforced via the tool allowlist + wren `strict_mode`, not by anything semantic (e.g. blast-radius). Fine here (read-only), but it's syntactic. | Mutating components would need policy-layer enforcement the file target can't provide. |
| 4 | **permission model** | Headless needs an explicit allowlist. `--permission-mode bypassPermissions` is (correctly) gated by the harness. `--allowedTools "Read" "Bash(wren:*)"` is the right, scoped way. | Dispatcher should emit settings that Claude Code auto-loads (see follow-up 1) so no manual flags are needed. |
| 5 | **trigger ≠ one&#95;shot** | not exercised (only `one_shot`). | `scheduled` / `event` can't be expressed as a static agent file at all — known boundary. |
| 6 | **observability / trace** — 📊 **has a consumer now** (`eval/`) | headless `--output-format json`/stream-json DOES expose per-run cost/latency (the `structured_output_capture` capability). The eval MVP consumes it to produce a Pareto. | Trace is available on the headless target; eval turns it into a tier decision. Per-step (vs per-run) trace still needs the programmatic path. |

## v0.2 — wall-hit #1 (per-step tier) resolved runtime-generally

The per-step-tier wall-hit was closed **without** falling back to a programmatic dispatcher, and
**without** leaking any Claude-Code concept into the IR.

- **IR (runtime-agnostic)**: `llm_calls[]` now carry per-step `tier` + a named I/O contract
  (`consumes`/`produces`) + the per-step rendered `prompt`; the component declares the generic
  requirement `required_capabilities: [llm:per_step_tier]`. The word "subagent" never appears.
- **Back-end realization (claude-code)**: since a static agent file can't vary model in-loop, the
  dispatcher satisfies `llm:per_step_tier` via *isolated invocation* — it emits a **driver**
  (`model: sonnet`, tools `[Task, Read]`) + **one subagent per step** (`plan_dashboard`→opus,
  `compose_layout`→haiku), and wires state from each call's `consumes`/`produces`.
- **Stronger than predicted**: earlier we noted subagent delegation is "prompt-driven, not
  guaranteed." Giving the driver **no data tools** (no `Bash`) makes delegation *structurally
  forced* — the driver physically cannot query `wren` itself, so any data access must go through a
  tier-bound subagent. Tier routing is enforced by tool topology, not prompt adherence.
- **Live evidence**: `claude -p --agent generate_dashboard` (stream-json) showed the driver
  delegating to both `generate_dashboard__plan_dashboard` (opus) and
  `generate_dashboard__compose_layout` (haiku); init event confirmed the driver's tools were
  `["Task","Read"]` only; final answer was correct (100 customers / 99 orders / $1,672).
- **Runtime-general**: the same IR runs in-loop on runtimes that *can* vary tier per call
  (Agent SDK `query({options})`, LangGraph nodes) with no subagent split — isolation is a
  back-end choice driven by the target's capability, not authored. See `docs/ir-schema.md` §v0.2.
- **Residual cost**: subagents duplicate context (fresh system prompt) + add round-trips; the tier
  saving is only a net win when a step is expensive and self-contained enough to hand off. This is
  a realization trade-off, not an expressiveness gap.

## Runtime prerequisite (not a framework issue)

- Decision #6 ("cross into `wren genbi`") was **not** achieved in this run: the installed `wren`
  build lacked the `genbi` and `cube` subcommands (it had `query`/`--sql`/`context`/`memory`/`profile`).
  The agent gracefully fell back to `wren --sql` and emitted panel specs. To exercise genbi,
  install a current `wrenai` (PyPI) that ships `genbi`/`cube`. This is a runtime version prereq,
  orthogonal to Warble.

## Follow-ups (small, concrete)

1. **`warble dispatch`**: emit permission settings to `.claude/settings.json` (not `settings.json`
   at out-root) so Claude Code auto-loads the allowlist. Done on the v0.2 split path; the v0.1
   single-agent path still writes root `settings.json` — unify.
2. **wren project + connection wiring**: the committed example ships the semantic layer only;
   dispatch RUN should make the bound project queryable (project + connection) at run time
   without hand-copying agent files into the project dir.
3. **genbi runtime**: pin/install a `wren` build with `genbi`/`cube` to complete decision #6.

## eval MVP — the closed loop, with numbers (`eval/`)

Built the execution-based eval slice: `warble-eval-compare` (Rust, deterministic result-set match)
- 14 golden cases over jaffle_shop + a runner that replays each question through the dispatched
`answer_query` agent under two tier bindings and scores results → Pareto.

- **Both `strong→opus` and `strong→haiku` scored 100% accuracy on all 14** questions (simple-agg
  through multi-join, time-grain, column pivots, top-N dates, a semantic edge, cents-vs-dollars).
  Cost: opus ~$0.33 vs haiku ~$0.11 (**\~3×**); haiku often lower latency too.
- **Closed-loop conclusion (data-driven, not guessed):** at this scale the semantic layer carries
  the text-to-SQL difficulty → downgrade `strong→cheap` for ~3× savings at no accuracy loss. This is
  the `eval → tier → binding → re-eval` loop the framework is really about.
- **Ties into the POC:** eval consumes the headless `structured_output_capture` capability (#6); the
  per-step tiers it would ablate are the v0.2 named steps (#1); comparing results needs the agent to
  emit structured output (the v0.3 render envelope, #2). The three connect.
- **Bounds:** small well-described MDL → no accuracy gap surfaced (a *positive* product signal —
  Wren's semantic layer makes cheap models reliable). Finding a tier gap needs a larger/messier
  schema or ambiguous NL. Single run per case (no variance); cost is subscription-computed. See
  `eval/README.md`.

## Verdict

The central claim holds on a real runtime: **one data-native front-end (compile) + a thin,
enum-keyed back-end (dispatch), with IR JSON as the language-neutral seam**, drives a real agent
that answers through the semantic layer. The gaps are exactly the ones predicted — they mark the
line where a file-install back-end must give way to a programmatic dispatcher.

## Second back-end — `claude-agent-sdk` (TS, in-loop `query()`) — findings

The predicted "programmatic dispatcher" was built as a second reference back-end
(`dispatcher/claude-agent-sdk`, TypeScript) driving `@anthropic-ai/claude-agent-sdk`'s in-loop
`query({options})`. It consumes the **same `ir.json`** the Rust front-end emits — no Rust link, no
shared types — so the IR seam is exercised across languages, not just within the Rust workspace. The
mapping stays enum-keyed and thin (`3 realization + 4 outcome + 3 trigger`), and unsupported enum
values loud-fail identically to the file target.

Live evidence (against `@anthropic-ai/claude-agent-sdk@0.1.77`, subscription login):

- **Cross-language seam holds** — the TS back-end deserializes both compiler goldens
  (`examples/render-demo`, `examples/demo-agent`), resolves their capabilities against `claude-agent-sdk:local`, and
  assembles a valid `query({options})`; the SDK loop authenticates, streams, and returns a captured
  result. 28 offline tests (IR parse, capability resolve, enum→options mapping, trace, guardrail) +
  three live smokes.
- **Wall-hit #1 (per-step tier) → native, in-loop.** A multi-tier skill is realized via SDK `agents`
  (a driver at the reserved `orchestrator` tier delegating to one model-bound subagent per step) with
  **no static files**. Live run confirmed all three models ran (`modelUsage` showed
  sonnet driver + opus `plan_step` + haiku `compose_step`). On this target `llm:per_step_tier` is
  *native*; on the file target it is *realize-via(subagents)* — same IR, different legalization.
- **Wall-hit #3 (guardrail enforcement) → runtime, semantic.** `read_only_execution` is enforced by
  a `canUseTool` callback that inspects every tool call live. Confirmed: an agent that tried
  `psql -c 'select 1'` was **denied before execution** with a reason fed back to the model, and the
  denial was recorded — enforcement the file target's static allow/deny strings cannot do.
- **Wall-hit #5 (per-step trace) → captured.** `trace.json` carries per-run cost/latency (the Pareto
  fields the eval loop needs) plus `modelUsage` (per-model = **per-tier** cost). Nuance found:
  subagent turns are **not** surfaced as top-level `assistant` messages in the default stream, so the
  per-step `steps[]` array reflects main-loop turns; `modelUsage` is the authoritative per-tier
  attribution.
- **One renderer, two back-ends.** The render step shells out to `warble render` (the Rust reference
  renderer); a fenced/prose-wrapped envelope produced byte-identical, deterministic HTML across runs —
  the same bytes the file target's programmatic flavor produces.

Bound (unchanged from the POC): a full **real-numbers** data e2e needs the `wren` CLI + a queryable
DuckDB project (the committed example ships the semantic layer only, and `wren` is a separate
install). Everything above is verified independently of that data runtime. See
`dispatcher/claude-agent-sdk/{README,SDK-NOTES}.md`.

## Phase 1.3 — hero facets

The render envelope gained a top-level `verified: boolean` facet and a new `definition` block
(`sql`, `source_tables[]`, `filters[]`), rendered identically by the one Rust reference renderer on
both back-ends. Wall-hit #2's verify step (G2) is now spelled out as a hard, explicit gate — run the
query, validate the result, repair and re-run, else `REFUSE` — rather than left implicit in the
agent's judgment. The `definition` card is deliberately **shallow** (G3): run-level provenance (the
SQL that ran) only. Formal semantic lineage now exists at compile time as of Phase 2
(MDL introspection → the `blast_radius` DAG), but that is a *separate* surface from this
answer card; enriching the card itself with unit/owner/formal-metric lineage remains later work. Follow-up #1 above is now closed: the single-agent (non-split) path also writes
`.claude/settings.json`, matching the split path — no back-end writes a root `settings.json` anymore.

## Phase 3 — the +Assertive litmus (`monitor_freshness`)

This is the phase whose deliverable is a *conclusion*, not a feature. `monitor_freshness` is the first
component that is **structurally different** from the GenBI four — it moves four anatomy positions at
once (`type: assertive`, `realization_kind: tool`, `trigger: scheduled`, `effect.outcome: assertion`)
— and it was built deliberately to try to break the abstraction fixed while only one shape (GenBI
render) existed. The test (vision §14): can one set of anatomy fields express both the GenBI *render*
verb and the freshness *assert* verb without the spine growing?

**Headline result: the IR spine did not grow.** `git diff dd6344c..HEAD -- core/` is empty. Every
change is in the *back-end* dispatchers, the examples, and the eval — never in the language-neutral
IR (`core/`). Turning the scaffolded +Assertive extension points into real handlers cost +340/−68
lines across the six dispatcher files, and adding the `monitor_freshness` component itself cost **zero**
dispatcher lines (it is a component of a now-supported type). The five falsifiable questions, each
answered against what was actually built:

| # | Question | Verdict | Evidence |
| --- | --- | --- | --- |
| **Q1** | Can the spine absorb the `assertion` outcome with **no new spine field**? | **PASS** | `verdict_type`/`emits` ride the existing `effect.outcome` (optional-parsed since 1.1). The front-end compiled the component with zero changes to `core/model.rs`/`compile.rs`; the golden shows `outcome: { kind: assertion, verdict_type, emits }`. No new top-level field. |
| **Q2** | Can `scheduled` use the existing trigger field, mechanism **borrowed**? | **PASS** | `trigger.kind=scheduled` rode the free-string trigger arm; cadence went through `params` (`expected_cadence`). The dispatcher realizes it via cron/launchd/CI (named only in `RUN.md`, a back-end artifact); the capability report shows `scheduler: realize-via (runtime)`. `cron` never appears in the IR. |
| **Q3** | Can `emits`/notify be **borrowed** (no alert DSL in the composition layer)? | **PASS** | `emits: [freshness_breach]` generalized to pub/sub → implied `event_bus` (realize-via, symmetric to a consuming `event` trigger). `notify_slack`/`open_ticket` are `borrowed_actions` gated by `notify_channel` (realize-via, MCP). No alert DSL in `profile.yml`; the severity conditional lives in the `assess_severity` step hook (invariant #3). |
| **Q4** | Does `tool` realization dispatch via the **same enum handler** (not per-component)? | **PASS** | Dispatch keys only on `(realization_kind, trigger.kind, outcome.kind)`. The change was +1 support arm each + one `build_assertion_section` + one `status` renderer — a `+1 handler` shape, not a rewrite. There is **no `if verb == …` branch** anywhere in the dispatchers; the only `freshness`/`orders` strings are illustrative envelope examples and the `{verb}` command template. |
| **Q5** | Does the profile composition layer stay free of conditionals/loops? | **PASS** | `monitor-agent/profile.yml` only mounts the component and binds `model: orders`. The one piece of conditional logic (severity grading) lives in `steps/assess_severity.md` (`conditional: true`), and the fresh/stale decision is deterministic SQL in the agent's own body — neither is in the profile. |

**All five pass → the abstraction is general → decision #7 (lock the profile syntax) is unlocked.**
The same `component.yml`/`profile.yml` anatomy expresses the analytical/render verb and the
assertive/assert verb; the differences are all *values in existing fields* (a different `type`,
`realization_kind`, `trigger.kind`, `outcome.kind`), plus borrowed capabilities and a new stdlib
render block — none of which is a new spine axis.

### The core assert is deterministic (decision D1)

The fresh/stale verdict is `max(timestamp)` vs cadence — a reproducible SQL comparison, **not** an LLM
call. The single `llm_step` (`assess_severity`, cheap, `conditional`) only grades *how bad* a breach
is, and only when already stale. This keeps the assertion **execution-evaluable**: `detection_accuracy`
is scored against synthetic controllable-timestamp ground truth with no model in the loop and no drift
(`eval/runner/tests/freshness_detection.rs`), and `severity_calibration` is the smaller cheap-judge
surface calibrated against deterministic reference labels (live calibration runtime-gated).

### verify = assertion? (resolving the deferred backlog decision)

`backlog-verify-first-class.md` deferred first-classing `verify` until a second, structurally different
verify shape appeared, and predicted that Phase 3's `assertion` outcome would very likely *be* that
shape. It is. **Conclusion: do not open a first-class `effect.verify`.** Concretely:

- The assertion's verdict envelope carries the **same** top-level `verified` facet as GenBI's
  per-answer verify (G2), and the **same** `warble render` envelope path renders both (the `status`
  block is just another stdlib block alongside `kpi_card`/`definition`). Per-result verify is a
  *degenerate assertion*: "assert the result set is legitimate" is an assertion whose verdict is
  `verified: true/false`.
- So verify lives on **two existing axes**, not a new one: (a) the `verified` facet available on any
  outcome (already shipped), and (b) a full `outcome: assertion` component when producing the verdict
  *is* the component's purpose. A separate `effect.verify` would be a redundant fourth thing that
  overlaps both — exactly the "redundant axis, breaks the unification" the backlog warned against.
- The one honest distinction is *when* it runs (an inline self-check facet on an analytical component
  vs. a standalone assertive component), but that is a composition choice, not a schema axis. The
  backlog is closed: **verify is expressed as an assertion sub-behavior; no new axis.**

### Honest limitation (does not affect Q1–Q5)

`model_has_timestamp` is currently evaluated **existentially** (does *any* bound model carry a
DATE/TIMESTAMP column?), ignoring the `args: { model: "$param:model" }` it carries in the IR. It still
genuinely gates — a project whose models are all timestamp-less fails to compile
(`cli/tests/freshness_precondition.rs`), the companion to the passing monitor-agent golden — so the
"one model with a timestamp, one without" litmus holds at the project level. Honoring the per-`$param`
model argument (gating on the *specific* bound model) needs compile-time resolution of param
placeholders into predicate args; it is a precondition-precision refinement, orthogonal to the
abstraction questions, and is deferred rather than forced into this phase.
