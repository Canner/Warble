# Warble glossary

The load-bearing terms. See `ir-schema.md` for the IR contract and `capability-model.md` for how
required capabilities resolve against a runtime target.

| Term | Meaning |
| --- | --- |
| **Profile** | The git-authoritative declaration of a data agent's behavior: which components it mounts, their config/overrides, guardrails, and the semantic context it binds to. Declarative data (YAML), the source of truth. |
| **Component** | A reusable behavior unit ("data verb") — a manifest (declarative) plus optional tool/hook code. Carries a `type` (analytical/assertive/mutating/orchestrating) and a `realization_kind`. The unit of reuse. |
| **Context binding** | What a profile is pointed at: a semantic layer (a wren project / MDL) — and, later, knowledge. As of v0.3 the binding is *fine-grained*: a `ContextLoader` introspects the MDL at compile time (metrics/dimensions/grains + lineage), alongside the retained coarse project path. |
| **MDL** | Modeling Definition Language — the semantic-layer format (models, metrics, dimensions, relationships) a wren project declares. Loaded via the `bindings/mdl-context` adapter into the context manifest the compiler consumes; see Context binding above. |
| **IR** | The language-neutral intermediate representation the front-end emits and every back-end consumes — the seam. Carries resolved prompts, per-step tiers + I/O contract, guardrails, render contract, required capabilities. |
| **Front-end** | The compiler (Rust): parse → merge defaults ⊕ overrides → validate → emit IR. Runtime-agnostic; the data-native part Warble owns. Sans-IO. |
| **Back-end / dispatcher** | Legalizes the IR onto one runtime and emits a native agent. Thin and swappable; Warble ships four reference back-ends (a Claude Code file target, a serverless-bundle target, a Claude Agent SDK in-loop target, and a standalone Codex local model-level peer target). |
| **Realization kind** | How a component connects to the LLM: `skill` (in-loop instructions), `tool` (an independently-invoked call), `gated-tool` (tool + approval gate). Set by component type; the dispatcher reads it. Deriving per-step tier is realization-kind-independent: any kind's divergent step tiers are captured as `llm:per_step_tier`, never silently collapsed. *Honoring* it at emission time is not uniform — `skill` and `tool` split into a driver + per-step subagents; a `gated-tool` with divergent tiers loud-fails at compile instead of splitting, because the generic tool-builder grants its mutation guardrail's write/edit authority to the whole node, and splitting would hand that authority to every subagent alongside the approval-gated driver, duplicating write access outside the two-phase approval lifecycle (dry-run → blast-radius → human approval → apply). |
| **Tier** | An abstract model class (`strong` / `cheap`), not a concrete model. The IR carries tiers; the dispatcher binds tier → concrete model at dispatch. Per-step tier heterogeneity is realized runtime-generally (e.g. subagents on the CLI target). |
| **Guardrail** | A declared constraint on a component (e.g. `read_only_execution`, `artifact_write` with a scope). `locked: true` guardrails cannot be weakened by a profile — a compile-time loud-fail. |
| **Capability** | Something a component *requires* of its runtime (`sql_execution:read_only`, `render_contract`, `scheduler`, …). Resolved per target as native / realize-via / degrade / fail; safety-critical never silently degrades. |
| **Capability manifest** | The runtime-agnostic advertisement projected from the IR — verbs, context, required capabilities, render contract — that a meta-harness consumes to call a profile without absorbing its execution. |
| **Render contract** | The typed-block output contract (`kpi_card` / `table` / `chart` / `narrative` …). Two flavors: **programmatic** (agent emits a `{blocks}` envelope; Warble's reference renderer produces HTML deterministically) and **prompt** (agent writes the file itself). |
| **Trigger** | What starts a component: `one_shot` and `scheduled` (cron) are implemented; `event` (pub/sub) remains a scaffolded extension point. |
| **Outcome** | The effect kind a component produces: `none` (render-only), `assertion`, and `mutation` are implemented; `dispatch` remains a scaffolded extension point. |
| **Wall-hit** | An IR arm a given target can't realize. Warble loud-fails rather than emit something silently wrong — the honest boundary that keeps back-ends thin. |
