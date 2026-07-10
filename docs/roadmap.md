# Warble roadmap

Behavior maturity is staged so each step adds a small, orthogonal set of primitives — never a
rewrite. The dispatcher dispatches on three orthogonal IR enums (`realization_kind`,
`outcome.kind`, `trigger.kind`), so a new capability is `+1 handler`, and adding a component of an
*existing* type is `0` dispatcher changes.

| Stage | Adds (realization / outcome / trigger + capabilities) | Unlocks | State |
| --- | --- | --- | --- |
| **MVP** | `skill` · `render`/`none` · `one_shot` · tier binding · `read_only` guardrail · render-to-artifact · basic trace | GenBI (analytical dashboards, Q&A) | ✅ v1 |
| **+ Assertive** | `tool` · `assertion` outcome · `scheduled` trigger · event emit · notify channel | data-quality monitoring | ✅ built (litmus passed) |
| **+ Mutating** | `gated-tool` · `mutation` outcome · human approval · dry-run · `write_authz` · version control | pipeline maintenance (edit/apply with rollback) | ▫ scaffolded |
| **+ Orchestrating** | `dispatch` outcome · `subagent_dispatch` · router chat | multi-agent | ▫ scaffolded |

"Scaffolded" = the IR arm is a documented, loud-failing extension point today (see the handler maps
in `dispatcher/claude-code-cli/src/emit.rs` and the arm tests in `dispatcher/claude-code-cli/tests/emit_tests.rs`); the
capability it will borrow is named inline (impl-notes §5.1).

**+ Assertive is now built** (the litmus — see `design-notes.md` "Phase 3"). `tool` · `scheduled` ·
`assertion` are real handlers in both back-ends, keyed purely on the three IR enums; `scheduler` /
`event_bus` / `notify_channel` resolve **realize-via** (borrowed cron / pub-sub / MCP), and a `status`
render block joins the stdlib. Crucially the IR spine (`core/`) was untouched — the assertion outcome
rides the existing `effect.outcome`, so adding `monitor_freshness` cost zero dispatcher lines. The
still-scaffolded rows are `+Mutating` (`gated-tool` · `mutation` · human approval) and `+Orchestrating`
(`dispatch`), plus the `event` *trigger* (activation by an inbound event) which stays a handler
wall-hit even though its `event_bus` transport is now borrowable.

## Cross-cutting, not tied to one stage
- **Component composition (sub-component calls)** — *deliberately deferred, not missing.* The
  catalog describes `generate_dashboard`/`explain_change` as "internally reusing `answer_query`",
  but Warble has no sub-component call mechanism today: each component is a self-contained set of
  `llm_steps`. In Phase 1.2 that reuse is realized by **inlining the query behavior into each
  component's step prompts** (the step instructs the agent to run queries through `wren`), and
  "reuse `answer_query`" stays a *concept*, not literal wiring. A real composition mechanism touches
  IR + caller semantics (it belongs with the `+Orchestrating`/manifest work), so it waits until
  after the litmus. This keeps Phase 1 inside the proven single-component dispatch model
  (invariant #3: the composition layer never grows a data-flow DSL).
- **Fine-grained MDL binding** — ✅ **built (read-path)**. A `ContextLoader` trait (`core`, sans-IO)
  + an MDL adapter (`bindings/mdl-context`, on `wren-core-base`; **core stays zero-wren**) resolve the
  binding to metric/grain level plus a lineage DAG, so `context_precondition` predicates are
  *evaluated* against real MDL at compile time (IR **v0.3**), and `metric_additive` is now enforced
  (existential) for `explain_change`. This unlocks `blast_radius` — the one `provided_by: warble`
  capability, and the moat — as a **read-only** query today (see [`blast-radius.md`](./blast-radius.md));
  using it to *gate a mutating apply* is the `+Mutating` stage.
- **Second back-end (Agent SDK `query()` loop)** — ✅ **MVP built** (`dispatcher/claude-agent-sdk`,
  TypeScript; target `claude-agent-sdk:local`). Proves the IR is a real cross-language seam (Rust
  front-end → TS back-end consuming the same `ir.json`, no Rust link) and closes three file-target
  wall-hits: per-step tier realized **in-loop** via SDK `agents` (native, no static files),
  `read_only_execution` enforced at **runtime** via a `canUseTool` gate, and **per-step/per-tier**
  cost/latency captured from the message stream into `trace.json`. Render reuses `warble render`.
  Verified live (SDK loop drive, runtime guardrail interception, per-tier model routing,
  deterministic render); a full real-numbers data e2e still needs the `wren` CLI + a queryable
  project (runtime prereq, same as the file target). v1 keeps the CLI file target as reference.
- **Bindings** (`wasm` / `py` / `napi`) — the sans-IO core's payoff: client-side compile, embed in
  a service. Laid out for, not built.
- **UI** (authoring + results) — web front-end.

## Eval
Execution-based eval (`eval/`) turns "which tier is good enough" into a measured Pareto (accuracy vs
cost vs latency) over tier→model bindings. The **closed loop is built** (`warble eval` subcommands):
`ablate` (per-step tier ablation — which step can drop to cheap without losing accuracy), `gate` (CI
regression gate, non-zero exit on drop), `verify-context` (golden `context_version` vs MDL SHA →
stale detection + `--reverify`), and `capture` (a confirmed run → candidate golden). The
`.github/workflows/eval.yml` gate is a template pending a remote (the repo is local-only). The
long-term bottleneck stays golden-truth generation (curate → capture-confirmed → synthetic), not the
runner.
