---
title: "Roadmap & status"
description: "Warble's behavior maturity staging — MVP through Assertive and Mutating to the scaffolded Orchestrating stage — plus cross-cutting work and the eval loop."
---

<!-- @generated from docs/roadmap.md by scripts/gen-reference.mjs — do not edit; edit the roadmap and re-run `npm run gen:reference` -->

Behavior maturity is staged so each step adds a small, orthogonal set of primitives — never a
rewrite. Ordinary dispatcher paths branch on three orthogonal IR enums (`realization_kind`,
`outcome.kind`, `trigger.kind`), so a new capability is `+1 handler`, and adding a component of an
*existing* type is `0` dispatcher changes. Native Sessions first select an authorized profile and
entry agent through their separate closed purpose allowlist.

| Stage | Adds (realization / outcome / trigger + capabilities) | Unlocks | State |
| --- | --- | --- | --- |
| **MVP** | `skill` · `render`/`none` · `one_shot` · tier binding · `read_only` guardrail · render-to-artifact · basic trace | GenBI (analytical dashboards, Q&A) | ✅ v1 |
| **+ Assertive** | `tool` · `assertion` outcome · `scheduled` trigger · event emit · notify channel | data-quality monitoring | ✅ built — eval-validated |
| **+ Mutating** | `gated-tool` · `mutation` outcome · human approval · dry-run · `write_authz` · version control · **`blast_radius` gate** | host-integrated pipeline maintenance (proposal, gate, caller-owned apply/rollback) | ⚠️ gate primitives + compatible emission built; `edit_pipeline` wall-hits |
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

**+ Mutating has shipped gate primitives and a bounded compatible-emission slice, not a complete
hosted mutation lifecycle.** `gated-tool` and `mutation` have handlers keyed on IR shape, while
`blast_radius` supplies the read-path policy used to gate a proposed change. The
`blast_radius_limit` guardrail runs `LineageGraph::blast_radius` at dry-run and blocks or escalates
to `human_approval` when the radius exceeds its threshold or touches a protected asset
(`warble blast-radius`, exposed as a CLI). `human_approval` is **locked**: a compatible single-tier
gated-tool can emit on the interactive target, while headless correctly loud-fails because it has no
human approval channel. `write_authz` and `version_control` (checkpoint/rollback) remain borrowed;
the `diff` render block presents a proposal rather than applying it.

The shipped `edit_pipeline` fixture is **not** in that compatible-emission slice. Its
`assess_blast_radius: cheap` and `generate_edit: strong` steps require divergent per-step tiers.
Splitting a gated tool would duplicate write authority outside its approval gate, so both Claude
file targets loud-fail before emission instead of collapsing tiers or producing a partial agent.
The deterministic mutating test exercises the real gate and scripts a throwaway approval,
apply, and rollback lifecycle as a **host-owned** example. Warble does not ship that orchestrator or
an end-to-end live apply loop.

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
  invariant #3 holds in the meantime: no DSL in the composition layer.
- **Fine-grained MDL binding** — ✅ **built (read-path)**. A `ContextLoader` trait (`core`, sans-IO)
  + an MDL adapter (`bindings/mdl-context`, on `wren-core-base`; **core stays zero-wren**) resolve the
  binding to metric/grain level plus a lineage DAG, so `context_precondition` predicates are
  *evaluated* against real MDL at compile time (IR **v0.3**). `metric_additive` remains a real
  compile-time predicate (existential by default, pinnable to a specific metric), but the flagship
  `explain_change` component no longer gates on it: data-shape/richness preconditions
  (`metric_additive` / `has_time_dimension` / `has_groupable_dimension`) were dropped from that
  component in favor of gating at the sub-agent level, and the per-metric additivity check now runs
  at **runtime** via the `additivity_guard` guardrail instead. This unlocks `blast_radius` — the one
  `provided_by: warble` capability, and the moat — as a **read-only** query (see
  [`blast-radius`](/reference/blast-radius)). It also *gates a mutating apply*: the
  `blast_radius_limit` guardrail runs the same query at dry-run and blocks/escalates the
  `edit_pipeline` change (read-path → enforcement).
- **Second back-end (Agent SDK `query()` loop)** — ✅ **MVP built** (`dispatcher/claude-agent-sdk`,
  TypeScript; target `claude-agent-sdk:local`). Proves the IR is a real cross-language seam (Rust
  front-end → TS back-end consuming the same `ir.json`, no Rust link) and closes three file-target
  wall-hits: per-step tier realized **in-loop** via SDK `agents` (native, no static files),
  `read_only_execution` enforced at **runtime** via a `canUseTool` gate, and **per-step/per-tier**
  cost/latency captured from the message stream into `trace.json`. Render reuses `warble render`.
  Verified live (SDK loop drive, runtime guardrail interception, per-tier model routing,
  deterministic render); a full real-numbers data e2e still needs the `wren` CLI + a queryable
  project (runtime prereq, same as the file target). v1 keeps the CLI file target as reference.
- **Codex local back-end (peer target)** — ✅ **built** (`dispatcher/codex-local`,
  TypeScript; standalone — not a `warble dispatch --target` value, consumes the same `ir.json`
  directly). Realizes the single-step Setup onboarding shape via an isolated, ephemeral `codex exec`
  run, and — via a separate persistent `codex app-server` session — two Ask-family shapes: the
  canonical three-step read-only Ask shape (an unconditional cheap step, an unconditional strong
  step consuming it, and an `on_failure` strong repair), which covers `answer_query` and any other
  component sharing that exact shape; and the canonical two-step `generate_dashboard` shape (an
  unconditional strong planning step with no consumes and one output, then an unconditional cheap
  composition step consuming that plan, with the same single-strong-repair-on-failure rule), whose
  terminal value must validate against the IR-declared KPI/table/chart/definition render contract.
  The validated render envelope is emitted as a `render_artifact` event and is the only persistable
  output; a render-only failure preserves the terminal answer and emits `render_degraded` instead of
  an artifact reference, while execution, isolation, or data failures still loud-fail. Each Ask and
  dashboard step maps to a named, model- and MCP-tool-scoped Codex custom agent; the runtime verifies
  child thread role/model attribution on every turn. A separate `list-models` command starts a
  read-only app-server transport — no thread or turn — to return the authenticated Codex model
  catalog (model ID, display name, description, default state, supported reasoning efforts),
  sanitizing authentication/runtime/timeout/protocol failures into the same versioned JSON contract.
  No inherited API-key billing environment; MCP call identity/success is retained in stream events
  but raw arguments/results never are.
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
lives at `Canner/Warble`; `.github/workflows/eval.yml` now runs the committed jaffle smoke baseline
on relevant pull requests and remains manually runnable. It skips cleanly without the
`CLAUDE_CODE_OAUTH_TOKEN` secret (including fork PRs) instead of producing a credential-related false
failure. The long-term bottleneck stays golden-truth generation (curate → capture-confirmed →
synthetic), not the runner.
