# Warble roadmap

Behavior maturity is staged so each step adds a small, orthogonal set of primitives — never a
rewrite. The dispatcher dispatches on three orthogonal IR enums (`realization_kind`,
`outcome.kind`, `trigger.kind`), so a new capability is `+1 handler`, and adding a component of an
*existing* type is `0` dispatcher changes.

| Stage | Adds (realization / outcome / trigger + capabilities) | Unlocks | State |
| --- | --- | --- | --- |
| **MVP** | `skill` · `render`/`none` · `one_shot` · tier binding · `read_only` guardrail · render-to-artifact · basic trace | GenBI (analytical dashboards, Q&A) | ✅ v1 |
| **+ Assertive** | `tool` · `assertion` outcome · `scheduled` trigger · event emit · notify channel | data-quality monitoring | ▫ scaffolded |
| **+ Mutating** | `gated-tool` · `mutation` outcome · human approval · dry-run · `write_authz` · version control | pipeline maintenance (edit/apply with rollback) | ▫ scaffolded |
| **+ Orchestrating** | `dispatch` outcome · `subagent_dispatch` · router chat | multi-agent | ▫ scaffolded |

"Scaffolded" = the IR arm is a documented, loud-failing extension point today (see the handler maps
in `dispatcher/claude-code-cli/src/emit.rs` and the arm tests in `dispatcher/claude-code-cli/tests/emit_tests.rs`); the
capability it will borrow is named inline (impl-notes §5.1).

## Cross-cutting, not tied to one stage
- **Fine-grained MDL binding** — reconnect the compiler to the semantic engine so the binding is
  metric/grain-level, not a coarse project path. This is what unlocks the `blast_radius` guardrail
  (semantic lineage) — the one `provided_by: warble` capability, and the moat.
- **Second back-end (Agent SDK `query()` loop)** — the design north-star reference dispatcher;
  proves the IR is a real seam by targeting a non-file runtime. v1 keeps the CLI file target.
- **Bindings** (`wasm` / `py` / `napi`) — the sans-IO core's payoff: client-side compile, embed in
  a service. Laid out for, not built.
- **UI** (authoring + results) — web front-end.

## Eval
Execution-based eval (`eval/`) already turns "which tier is good enough" into a measured Pareto
(accuracy vs cost vs latency) over tier→model bindings. The long-term bottleneck is golden-truth
generation (curate → capture-confirmed → synthetic), not the runner.
