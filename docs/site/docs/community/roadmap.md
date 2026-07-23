---
title: Roadmap & status
description: "Warble's behavior maturity staging — MVP through Assertive and Mutating to the scaffolded Orchestrating stage — plus cross-cutting work and the eval loop."
---

Behavior maturity is staged so each step adds a small, orthogonal set of primitives — never a
rewrite. The dispatcher dispatches on three orthogonal IR enums (`realization_kind`,
`outcome.kind`, `trigger.kind`), so a new capability is `+1 handler`, and adding a component of an
*existing* type is `0` dispatcher changes.

| Stage | Adds (realization / outcome / trigger + capabilities) | Unlocks | State |
| --- | --- | --- | --- |
| **MVP** | `skill` · `render`/`none` · `one_shot` · tier binding · `read_only` guardrail · render-to-artifact · basic trace | GenBI (analytical dashboards, Q&A) | ✅ v1 |
| **+ Assertive** | `tool` · `assertion` outcome · `scheduled` trigger · event emit · notify channel | data-quality monitoring | ✅ built |
| **+ Mutating** | `gated-tool` · `mutation` outcome · human approval · dry-run · `write_authz` · version control · **`blast_radius` gate** | pipeline maintenance (edit/apply with rollback) | ✅ built |
| **+ Orchestrating** | `dispatch` outcome · `subagent_dispatch` · router chat | multi-agent | ▫ scaffolded |

"Scaffolded" = the IR arm is a documented, loud-failing extension point today (see the handler maps
in `dispatcher/claude-code-cli/src/emit/` and the arm tests in `dispatcher/claude-code-cli/tests/emit_tests.rs`); the
capability it will borrow is named inline.

**+ Assertive is now built** (validated against the monitor_freshness component and its eval
goldens). `tool` · `scheduled` ·
`assertion` are real handlers in both back-ends, keyed purely on the three IR enums; `scheduler` /
`event_bus` / `notify_channel` resolve **realize-via** (borrowed cron / pub-sub / MCP), and a `status`
render block joins the stdlib. Crucially the IR spine (`core/`) was untouched — the assertion outcome
rides the existing `effect.outcome`, so adding `monitor_freshness` cost zero dispatcher lines.

**+ Mutating is now built too** (validated against the edit_pipeline component and its eval
goldens). `gated-tool` ·
`mutation` are real handlers in both back-ends, again keyed only on the three enums and again with
`core/` untouched (the mutation outcome rides `effect.outcome`; `target`/`change_type` are optional
facets, parsed but not required). The payoff is the moat moving from read-path to **enforcement**:
`blast_radius` — the one `provided_by: warble` capability — now *gates* a production change. The
`blast_radius_limit` guardrail runs the read-path `LineageGraph::blast_radius` at dry-run and
blocks / escalates to `human_approval` when the radius exceeds its threshold or touches a protected
asset (`warble blast-radius`, exposed as a CLI). `human_approval` is **locked** and resolves `fail` on
`claude-code:headless` (no human — safety-critical, never silently degraded), so a mutating component
loud-fails there and must run interactive / with an external approval channel; `write_authz` +
`version_control` (git checkpoint/rollback) are borrowed. A `diff` render block joins the stdlib.

The still-scaffolded rows are `+Orchestrating` (`dispatch` outcome) plus the `event` *trigger*
(activation by an inbound event) which stays a handler wall-hit even though its `event_bus` transport
is now borrowable.

## Cross-cutting, not tied to one stage
- **Component composition (sub-component calls)** — *deliberately deferred, not missing.* The
  catalog describes `generate_dashboard`/`explain_change` as "internally reusing `answer_query`",
  but Warble has no sub-component call mechanism today: each component is a self-contained set of
  `llm_steps`. That reuse is realized today by **inlining the query behavior into each component's
  step prompts** (the step instructs the agent to run queries through `wren`), so "reuse
  `answer_query`" stays a *concept*, not literal wiring. A real composition mechanism touches IR +
  caller semantics (it belongs with the `+Orchestrating` work) and stays deferred until that lands —
  the composition layer deliberately never grows a data-flow DSL in the meantime.
- **Fine-grained MDL binding** — ✅ **built (read-path)**. A `ContextLoader` trait (`core`, sans-IO)
  + an MDL adapter (`bindings/mdl-context`, on `wren-core-base`; **core stays zero-wren**) resolve the
  binding to metric/grain level plus a lineage DAG, so `context_precondition` predicates are
  *evaluated* against real MDL at compile time (IR **v0.3**), and `metric_additive` is now enforced
  (existential) for `explain_change`. This unlocks `blast_radius` — the one `provided_by: warble`
  capability, and the moat — as a **read-only** query (see [Blast radius & enforcement](/reference/blast-radius)).
  It also *gates a mutating apply*: the `blast_radius_limit` guardrail runs the same query at
  dry-run and blocks/escalates the `edit_pipeline` change (read-path → enforcement).
- **Second back-end (Agent SDK `query()` loop)** — ✅ **MVP built** (`dispatcher/claude-agent-sdk`,
  TypeScript; target `claude-agent-sdk:local`). Proves the IR is a real cross-language seam (Rust
  front-end → TS back-end consuming the same `ir.json`, no Rust link) and closes three file-target
  wall-hits: per-step tier realized **in-loop** via SDK `agents` (native, no static files),
  `read_only_execution` enforced at **runtime** via a `canUseTool` gate, and **per-step/per-tier**
  cost/latency captured from the message stream into `trace.json`. Render reuses `warble render`.
  Verified live (SDK loop drive, runtime guardrail interception, per-tier model routing,
  deterministic render); a full real-numbers data e2e still needs the `wren` CLI + a queryable
  project (runtime prereq, same as the file target). v1 keeps the CLI file target as reference.
- **Hybrid LLM (BYO-LLM, local + cloud)** — ✅ **built**. The same compiled IR runs a `cheap` step on a
  local open-source model (ollama) and a `strong` step on cloud Claude *in one run*, by swapping only
  the layer-3 `--models-config` binding — IR / components / profile unchanged (the portability claim,
  made concrete). Realized as the capability `llm:per_step_provider` (distinct from `per_step_tier`; a
  binding-time gate loud-fails if a target can't route a non-native provider), with four realizations
  (SDK staged-executor / in-process-mcp; file target bash-script / `warble mcp-serve`). Proven:
  portability + per-step mixing + accuracy holds; **not** proven: cost savings (needs a harder schema).
  See `examples/hybrid-llm/` and `docs/spec/capability-model.md` §7.2.
- **Bindings** (`wasm` / `py` / `napi`) — the sans-IO core's payoff: client-side compile, embed in
  a service. Laid out for, not built.
- **UI** (authoring + results) — web front-end.

## Eval
Execution-based eval (`eval/`) turns "which tier is good enough" into a measured Pareto (accuracy vs
cost vs latency) over tier→model bindings. The **closed loop is built** (`warble eval` subcommands):
`ablate` (per-step tier ablation — which step can drop to cheap without losing accuracy), `gate` (CI
regression gate, non-zero exit on drop), `verify-context` (golden `context_version` vs MDL SHA →
stale detection + `--reverify`), and `capture` (a confirmed run → candidate golden). The repo now
lives at `Canner/Warble`; the `.github/workflows/eval.yml` gate runs on manual `workflow_dispatch` for
now, with a ready-to-enable `pull_request` trigger and a committed baseline — flip it on (and set the
`CLAUDE_CODE_OAUTH_TOKEN` secret) to make it a live PR gate. The long-term
bottleneck stays golden-truth generation (curate → capture-confirmed → synthetic), not the runner.
