# Warble authoring guide — profiles, components, and the rest

This is the conceptual reference for **authoring** Warble: what a *profile* is, what a *component*
is, how they bind to a *context*, and what every field means. For the compiled output see
[`ir-schema.md`](./ir-schema.md); for how required capabilities resolve against a runtime see
[`capability-model.md`](./capability-model.md); for one-line term definitions see
[`glossary.md`](./glossary.md).

Everything here is **declarative data** (YAML). You do not write control flow, prompts-as-code, or
runtime glue — you *declare* behavior, and `warble compile` resolves it into the IR.

---

## 1. The mental model: `Profile = Harness + Context`

A Warble agent's behavior is the sum of two things you declare separately:

- **Harness** — *which behaviors* the agent has (the components it mounts) and how they're configured.
- **Context** — *what data/semantics* those behaviors operate over (a wren semantic project).

A **profile** binds a Harness to a Context. A **component** is one reusable behavior ("data verb")
that knows *what shape* of context it needs but never names a concrete dataset. The concrete binding
lives only in the profile. That separation is what makes components reusable and shareable.

### Three layers — put each field in the right place

| Layer | Holds | Analogy |
| --- | --- | --- |
| **Component** (`component.yml`) | the contract + defaults + requirements — **no concrete scope, no instance values** | a function signature / a dbt package |
| **Profile** (`profile.yml`) | binds a Context + mounts components + supplies binds + overrides defaults | the call site / dbt vars |
| **IR** (compiler output) | `resolved(component defaults ⊕ profile overrides ⊕ context)` | the compiled call |

Iron rule: a component never contains a concrete binding like `analytics.orders` — that belongs to
the profile. The component only declares *"I need a context of this shape."*

```
profile.yml + components/*/ + context/binding.yml
        │
        ▼  warble compile
      ir.json     ← resolved(component ⊕ profile ⊕ context)
        │
        ▼  warble dispatch --target claude-code:headless
   .claude/agents/…  ← a runnable agent
```

---

## 2. Component — a reusable behavior

A component is a **directory** (declarative manifest + prompt templates + optional code/eval):

```
components/<name>/
├── component.yml        # the manifest — all authoring fields (pure data; portable)
├── steps/               # one prompt template per LLM step (may contain {{placeholders}})
│   └── <step>.md
├── hooks.(rs|ts|py)     # optional: imperative escape hatch (tool/tier-routing) — the ONE place code lives
└── eval/                # optional: eval templates + golden fixtures
```

`component.yml` is pure data; code is a *sibling file it points at*, never inlined — this keeps
"the manifest is data, the mechanism is code" cleanly separated.

### `component.yml`, field by field

Fields marked **[spine]** exist on every component (stable across types); **[type]** are
type-specific. Real example — the `generate_dashboard` analytical component (`examples/demo-agent/`):

```yaml
# ── identity & type [spine] ──
id: generate_dashboard
verb: generate_dashboard
type: analytical                 # analytical | assertive | mutating | orchestrating
realization_kind: skill          # skill | tool | gated-tool (defaulted from `type`, overridable)

# ── context requirements (a shape, NOT a binding) [spine] ──
binding_mode: runtime_selected   # runtime_selected | pinned
context_requirements:            # human-readable shape strings; free text, not compile-validated
  - "a wren project (semantic layer) to build dashboards over"
context_precondition:            # structured predicates; compile validates against a closed vocabulary
  - { predicate: has_metric }
  - { predicate: has_groupable_dimension }

# ── inputs the profile must / may supply, or the runtime injects ──
params:
  - { name: topic_default, bind: optional, default: "overview" }   # profile-bound
  - { name: connection,     source: runtime-injected }              # runtime-injected; not in git

# ── behavior defaults (profile may override the overridable ones) [spine] ──
llm_steps:
  - { name: plan_dashboard, tier: strong, prompt_ref: steps/plan_dashboard.md, produces: query_plan }
  - { name: compose_layout, tier: cheap,  prompt_ref: steps/compose_layout.md,
      consumes: [query_plan], produces: dashboard_summary }
trigger: { kind: one_shot }      # one_shot | scheduled | event
guardrails:
  - { name: read_only_execution, locked: true }   # safety floor: never mutate data
required_capabilities:
  - sql_execution:read_only
  - genbi_build
  - llm:per_step_tier
  - llm:strong
  - llm:cheap
borrowed_actions: []

# ── output [effect: render blocks + typed outcome] ──
effect:
  render_blocks: [chart, table, kpi_card]
  outcome:
    kind: none                   # none | assertion | mutation | dispatch

# ── evaluation [spine] ──
eval:
  template_ref: eval/
  metrics: [answer_relevance, chart_appropriateness]
```

| Field | Meaning | Who sets / changes it |
| --- | --- | --- |
| `id` / `verb` | identity; `verb` names the action the agent exposes | component author |
| `type` | one of the four behavior types (see §5) | component author |
| `realization_kind` | how it connects to the LLM: `skill` (in-loop instructions) / `tool` (its own tier-bound call) / `gated-tool` (tool + approval gate). Defaulted from `type`. | author (profile may override) |
| `binding_mode` | `runtime_selected` (interactive — target chosen at query time) or `pinned` (needs a fixed target, e.g. a monitor) | intrinsic to the component |
| `context_requirements` | human-readable shape strings — what shape of context this needs, in prose. Free text; **not** compile-validated (Hub/docs discoverability only) | author |
| `context_precondition` | structured predicates `{ predicate, args? }`; `predicate` must be one of a **closed 9-name vocabulary** (§2.1). Compile validates vocabulary membership **and** (v0.3) evaluates each predicate against the bound MDL via the injected `ContextLoader` — see §2.1 | author |
| `params[].bind` / `params[].source` | `bind: required` → the profile MUST supply it; `bind: optional` → may, with `default`; `source: runtime-injected` → supplied by the runtime at dispatch/run time, never committed to git. Exactly one of `bind`/`source` per param — declaring both or neither is a compile error | profile supplies binds; runtime supplies injected params |
| `llm_steps[]` | ordered steps; each declares a `tier` + prompt template + named I/O (`consumes`/`produces`) + optional `conditional`/`when` — see §6.2.1 | author (profile may override tiers) |
| `llm_steps[].conditional` | `true` → the step only runs when its `when` guard holds. Defaults to `false`. `conditional: true` with no `when` is a compile-time loud fail (v0.3+) — see §6.2.1 | author |
| `llm_steps[].when` | `{ guard, target }` — the closed-vocabulary guard deciding whether a `conditional` step runs (§6.2.1). Required whenever `conditional: true`; a compile error if present without `conditional: true` | author |
| `trigger.kind` | what starts it (see §7) | author |
| `guardrails[]` | declared constraints; `locked: true` cannot be weakened by a profile (see §4) | author locks; profile may tune overridable ones |
| `guardrails[].overridable` ↔ `.locked` | authoring declares exactly one (agreeing values on both is fine); the IR always resolves and emits only `locked` — it's the single source of truth downstream. `overridable: true` normalizes to `locked: false`. Declaring both with conflicting values, or neither, is a compile error | author |
| `required_capabilities` | what the component needs of its runtime (see §8) | author |
| `borrowed_actions` | external actions it uses (notify, ticket, …), borrowed from the runtime | author |
| `effect.render_blocks` | the typed output blocks it produces (see §6.3) | author |
| `effect.outcome.kind` | its side-effect kind: `none` / `assertion` / `mutation` / `dispatch` (stable 4-value union; type-specific facets like `verdict_type`/`target`/`routable_scope` may ride on top — parsed, but not yet consumed by the MVP analytical back-ends) | author |
| `eval` | `{ template_ref, metrics: [...] }` — structured eval config; present only when authored | author |

> **Compiler coverage.** The compiler resolves and validates every field shown above, including
> `context_precondition`, `params[].source`, `llm_steps[].conditional`/`when`, the `guardrails`
> `locked`/`overridable` normalization, and `eval`. `manifest` is **not** an authoring field at
> all — it's a projection `warble manifest` derives from the compiled IR, never written in
> `component.yml`. `component.yml` is also checked with `deny_unknown_fields` (this check applies to
> `component.yml` only, not `profile.yml` / `context/binding.yml`): any field the
> schema doesn't recognize is a **compile-time loud fail**, never silently ignored. See
> [`ir-schema.md`](./ir-schema.md) for the exact resolved shape and the full compile-time-checks
> table.

### 2.1 `context_precondition` predicate vocabulary

`context_precondition[].predicate` must be one of exactly nine names — an unknown predicate is a
compile-time loud fail:

`mdl_parseable`, `has_metric`, `has_queryable_dimension`, `has_time_dimension`,
`has_groupable_dimension`, `metric_additive`, `model_has_timestamp`, `lineage_resolvable`,
`wren_project_exists`.

Each entry may carry an optional `args` map (predicate-specific, e.g. a metric/dimension name).
Compile checks that the predicate name is a member of this vocabulary **and (v0.3) evaluates it
against the bound MDL** via the injected `ContextLoader`: a predicate that is answerable-and-false,
or unanswerable in this semantic format (e.g. `metric_additive` with no declared metric), is a loud
compile fail. `metric_additive` is existential by default and pinnable via `args: { metric: … }`.

---

## 3. Profile — bind a Harness to a Context

A profile does exactly three things: **bind a Context**, **mount components** (supplying their
required binds and overriding overridable defaults), and set **global config**. A profile has
**no control flow** — no `if`, no loops, no edges between components.

Minimal profile (`examples/render-demo/profile.yml`) — mount one component, inherit its defaults:

```yaml
profile: render-demo

context:
  project: ./context/binding.yml   # indirection to the bound wren project

config:
  tier_policy: null                # optional profile-level tier policy

components:
  - use: dashboard                 # mount the `dashboard` component as-is
```

A profile that supplies config/overrides (`examples/demo-agent/profile.yml`):

```yaml
profile: orders-analytics

context:
  project: ./context/binding.yml

config:
  tier_policy: cost_sensitive      # profile-level tier policy

components:
  - use: generate_dashboard
    config:
      topic_default: "orders overview"   # override an overridable default
```

The full mount-entry vocabulary (`components[]`):

| Field | Meaning |
| --- | --- |
| `use` | which component to mount (by `id`; may later carry a version / Hub source) |
| `bind` | supplies the component's `params[].bind: required` (a pinned target, scope, …) |
| `config` | overrides that instance's overridable defaults (thresholds, cadence, …) |
| `tier_overrides` | overrides an individual step's `tier`, e.g. `{ compose_layout: strong }` |
| `realization_kind` | override the component's default realization kind |
| `guardrails` | tune overridable guardrails — **attempting to weaken a `locked` one is a compile error** |

**What is NOT in a profile** (all runtime-injected, or a different layer): tier → concrete model
mapping, cloud/local choice, database connections, and which runtime/back-end you dispatch to.

---

## 4. Context binding

`context.project` in the profile points (indirectly) at the bound wren project. The indirection
file (`context/binding.yml`) holds the actual path, relative to the Warble project dir:

```yaml
# examples/render-demo/context/binding.yml
project: ../jaffle-wren
```

**Binding (v0.3) is fine-grained:** the authored `project:` still points at a *whole* wren project
(the coarse path back-ends need), but the compiler now introspects the MDL through the injected
`ContextLoader` — resolving metrics/dimensions/grains and building a lineage DAG — and evaluates
every precondition against it. This is what unlocks the semantic `blast_radius` guardrail (read
path; `capability-model.md` §7.1). A missing/unparseable project still fails loudly.

---

## 5. Component types → realization kind

The `type` classifies the behavior; it gives a default `realization_kind` (how it wires to the LLM):

| `type` | default `realization_kind` | why | v1 |
| --- | --- | --- | --- |
| `analytical` | `skill` | read-only query/render; the driver runs it in-loop | ✅ implemented |
| `assertive` | `tool` | monitoring: its own tier + an alerting boundary | ✅ implemented |
| `mutating` | `gated-tool` | edits: tool + a hard human-approval gate | ✅ implemented |
| `orchestrating` | `skill` | routes to sub-agents; callees are called as tools | ▫ scaffolded |

`analytical`, `assertive`, and `mutating` are realized end to end. `orchestrating` remains a
documented, loud-failing extension point (dispatching it is a clean "wall-hit" error, never a wrong
agent).

---

## 6. Steps, tiers, and the render contract

### 6.1 Tiers (not model names)

A step declares a **tier** — an abstract capability class — not a concrete model:

- `strong` — the capable/expensive tier (v1 dispatches this to `opus` on the Claude Code target).
- `cheap` — the fast/cheap tier (v1 → `haiku`).

Tiers travel in the IR; the *dispatcher* binds tier → concrete model at dispatch time. This is what
lets the eval loop ablate `strong→opus` vs `strong→haiku` over the same profile.

Tiers are set — and re-set — at three layers, each overriding the one before it:

**1. Component default** — each step names its tier (`component.yml`):

```yaml
llm_steps:
  - { name: plan_dashboard, tier: strong, prompt_ref: steps/plan_dashboard.md, produces: query_plan }
  - { name: compose_layout, tier: cheap,  prompt_ref: steps/compose_layout.md,
      consumes: [query_plan], produces: dashboard_summary }
```

**2. Profile per-step override** — a mount may retune a specific step's tier (`profile.yml`):

```yaml
components:
  - use: generate_dashboard
    tier_overrides:
      compose_layout: strong      # this instance runs compose_layout at `strong`, not the cheap default
```

**3. Profile tier policy** — a profile-level hint (`config.tier_policy`) that biases how tiers are
chosen/read for the whole profile:

```yaml
config:
  tier_policy: cost_sensitive     # or null to leave it unset
```

Resolution order is component default → `tier_overrides` (per step) → carried into the IR's
`llm_calls[].tier`.

### 6.1.1 Defining tier → model (at dispatch)

Which **concrete model** each tier becomes is deliberately *not* in the profile — it is a
**dispatch-time binding**, so the same compiled IR can run against different models (that's exactly
the axis the eval loop ablates). Tier names are an **open vocabulary**: `strong`/`cheap` are the
standard core (use them to keep components portable), but you may define your own tiers at whatever
granularity you like. A step whose tier has no binding is a **loud-fail** at dispatch.

**A tier→model config file** (`--models-config`) — deployment-scoped, not committed with a profile:

```yaml
# models.yaml
tiers:                       # tier name → model alias; declaration order = priority (earliest = strongest)
  strong: claude-opus-4-8
  cheap:  claude-haiku-4-5
  local:  qwen2.5            # a custom tier — any name you like
  orchestrator: claude-sonnet-5   # reserved tier: the per-step-tier split's routing-loop model
```

`orchestrator` is a **reserved core tier**: it's a dispatch role (the driver of a per-step-tier
split), not something a component declares on a step. It lives in the same `tiers` map so the config
has a single concept — a tier is just a named model role. It's only required when a component
actually splits; if omitted then, dispatch fails loudly naming it.

```bash
warble dispatch ir.json --target claude-code:headless --out agent --models-config models.yaml
```

**Or the inline shortcut** for the three standard tiers (no file):

```bash
# defaults shown; override any of them
warble dispatch ir.json --out agent \
  --strong opus \
  --cheap  haiku \
  --orchestrator sonnet      # sets the reserved `orchestrator` tier (the split driver)
```

`--models-config` takes precedence when both are given. So a `strong` step emits
`model: <strong's model>`, a `cheap` step emits `model: <cheap's model>`, and — when a component's
steps span tiers and are realized as subagents — each subagent gets its tier's model while the
driver gets the `orchestrator` tier. If a component uses `tier: local` and the config doesn't define
`local` (or splits without an `orchestrator` tier), dispatch fails loudly naming the tier. The eval
runner varies this same binding per run (`strong→opus` vs `strong→haiku`) to produce its Pareto.

> **Granularity is target-dependent, and richer per-tier fields already exist today.** A tier value
> may be a structured `{ provider, endpoint?, model }` map, not just a bare model alias — see
> `binding-spec.md` for the full format, versioning, and the open-string `provider` contract. The
> Claude Code CLI target still only *consumes* the `model` field (connection/auth are owned by the
> Claude Code runtime, not the emitted files); the Agent SDK back-end, which drives the model
> directly, reads `provider`/`endpoint` too — that's what makes hybrid local+cloud dispatch possible.

### 6.2 Per-step tier + the I/O contract

A single `skill` component may have steps at **different** tiers (e.g. `plan=strong`,
`compose=cheap`). The author only declares each step's tier (the *intent*). Whether a divergent-tier
step must become an isolated call is a *runtime* detail:

- A runtime that can switch model in-loop just does so.
- The Claude Code CLI target can't (a static agent file has one `model`), so it realizes each
  divergent-tier step as a **subagent**, and the driver marshals state across the boundary using the
  step's named **`consumes` / `produces`** slots.

That is why steps carry `consumes`/`produces`: named slots only, no conditionals or loops (so the
composition layer never grows into a data-flow DSL). The component declares
`required_capabilities: [llm:per_step_tier]` — the generic requirement "every call runs at its
declared tier" — never a mechanism like "subagent".

### 6.2.1 Conditional steps and the `when` guard vocabulary

`llm_steps[].conditional: true` marks a step that only runs sometimes. Before v0.3 the bare boolean
was the whole contract — the WHEN-logic lived entirely in the step's own hook/prompt, invisible to
the compiler. v0.3 makes the *reason* a step is conditional visible (still without introducing a
data-flow DSL — invariant #3): a `conditional: true` step must also declare a `when` guard naming
**why** it's conditional, drawn from a closed 3-name vocabulary:

| `when.guard` | `when.target` | Meaning |
| --- | --- | --- |
| `on_failure` | an upstream step name | Runs only if that step failed |
| `on_flag` | a dotted `artifact.field` | Runs only if that boolean field on a produced artifact is true |
| `on_missing` | an artifact name | Runs only if that artifact was not produced |

```yaml
llm_steps:
  - { name: generate_sql, tier: strong, prompt_ref: steps/generate_sql.md,
      consumes: [query_intent], produces: query_result }
  - { name: repair_sql, tier: strong, prompt_ref: steps/repair_sql.md,
      consumes: [query_result], produces: repaired_result, conditional: true,
      when: { guard: on_failure, target: generate_sql } }
```

Compile enforces the full `(conditional, when)` matrix as a loud fail, never a guess:

- `conditional: true` with **no** `when` — refused. Bare `conditional: true` no longer implies a
  condition; the author must name one.
- `when` present but `conditional` is **not** `true` — refused. A guard with nothing to guard is an
  authoring mistake, not a no-op.
- `when.guard` not in the vocabulary above, an empty `when.target`, or an `on_flag` target with no
  `.` (it must be a dotted `artifact.field`) — all refused.
- `conditional: false` (the default) with no `when` — the ordinary, unconditional case; valid.

The guard travels into the IR as `llm_calls[].when` (`{ guard, target }`, or `null` when the step
isn't conditional) — see [`ir-schema.md`](./ir-schema.md). Like `context_precondition` (§2.1), this
is a closed vocabulary grown only when a real case demands it — no boolean algebra, no expressions,
no imperative logic.

### 6.3 Render contract (`effect.render_blocks`)

`render_blocks` is a list of **typed blocks** the component emits — each a block type plus its field
schema (Warble ships a small stdlib: `kpi_card`, `table`, `chart`; components may extend it):

```yaml
effect:
  render_blocks:
    - type: kpi_card
      fields: { label: string, value: number, unit: "string?" }
    - type: table
      fields: { columns: "string[]", rows: "row[]" }
    - type: chart
      fields: { chart_type: string, x: string, series: "string[]", rows: "row[]" }
```

(Shorthand: a bare `render_blocks: [chart, table, kpi_card]` normalizes to typed entries with empty
field schemas.) The IR declares *types + data contract*; **how** a block becomes pixels is the
renderer's job. Two flavors at dispatch (`--render-flavor`):

- **programmatic** (default) — the agent stays fully read-only and emits a `{ blocks, summary }`
  JSON envelope; `warble render` turns it into a self-contained `dashboard.html` deterministically.
- **prompt** — the agent writes the HTML itself (needs the `artifact_write` guardrail).

---

## 7. Triggers

`trigger.kind` says what starts the component:

| kind | meaning | v1 |
| --- | --- | --- |
| `one_shot` | run once on request (a single headless invocation) | ✅ |
| `scheduled` | run on a cadence (borrows a scheduler) | ✅ |
| `event` | run on a pub/sub event (borrows an event bus) | ▫ scaffolded (loud-fail) |

---

## 8. Guardrails and capabilities

### Guardrails — the safety floor

Guardrails are declared constraints. Each is either:

- **`locked: true`** — a safety floor a profile **cannot** remove or weaken (e.g.
  `read_only_execution` on read-only components; `human_approval` / `must_dry_run` on mutating ones).
  A profile that tries to weaken a locked guardrail is a **compile-time loud-fail**.
- **`overridable: true`** — thresholds, cadence, alert routing, etc., which a profile may tune.
  Authored `overridable: true` normalizes to `locked: false` in the resolved IR — `locked` is the
  only field the IR ever emits, so downstream consumers check one field, not two. A guardrail must
  declare exactly one of `locked`/`overridable` (agreeing values on both is fine); declaring both
  with conflicting values, or neither, is a compile-time loud-fail. An authored, overridable
  guardrail's tuned value (e.g. a threshold) survives into the IR as `guardrails[].threshold`.

Two guardrails are kept on **separate axes** because writing a dashboard file is not the same as
mutating the warehouse:

- `read_only_execution` — never mutate data (enforced via the tool allowlist + wren `strict_mode`).
- `artifact_write` (scoped) — may write only the output dir (the HTML). Needed only on the
  prompt render flavor; the programmatic flavor keeps the agent entirely read-only.

### Capabilities — what the component needs of its runtime

`required_capabilities` lists what the component needs (e.g. `sql_execution:read_only`,
`render_contract`, `llm:per_step_tier`, `scheduler`). At dispatch, each is resolved against the
target's profile as **native / realize-via / degrade / fail**; safety-critical capabilities never
silently degrade, and an unmet required capability aborts with a clear error. See
[`capability-model.md`](./capability-model.md).

---

## 9. How it all resolves

```
IR node = resolved( component defaults  ⊕  profile overrides  ⊕  context )
```

`warble compile <project> -o ir.json` merges the three layers and runs the loud-fail checks:

- `bind: required` not supplied by the profile → **fail**.
- a profile tries to weaken a `locked` guardrail → **fail**.
- context precondition not met (missing `wren_project.yml`) → **fail**.

The resolved IR is then consumed by any back-end (`warble dispatch`). Try it:

```bash
warble compile examples/render-demo -o /tmp/ir.json
warble dispatch /tmp/ir.json --target claude-code:headless --out /tmp/agent
warble manifest /tmp/ir.json        # the capability manifest projected from the IR
```
