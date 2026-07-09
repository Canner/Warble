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
type-specific. Real example — the `generate_dashboard` analytical component (`demo-agent/`):

```yaml
# ── identity & type [spine] ──
id: generate_dashboard
verb: generate_dashboard
type: analytical                 # analytical | assertive | mutating | orchestrating
realization_kind: skill          # skill | tool | gated-tool (defaulted from `type`, overridable)

# ── context requirements (a shape, NOT a binding) [spine] ──
binding_mode: runtime_selected   # runtime_selected | pinned
context_requirements:            # (forward-looking; see note below)
  - "a wren project (semantic layer) to build dashboards over"
context_precondition:            # (forward-looking) predicate verified after binding
  - "bound project path exists and contains wren_project.yml"

# ── inputs the profile must / may supply ──
params:
  - { name: topic_default, bind: optional, default: "overview" }

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

# ── evaluation [spine] (forward-looking) ──
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
| `params[].bind` | `required` → the profile MUST supply it; `optional` → may, with `default` | profile supplies |
| `llm_steps[]` | ordered steps; each declares a `tier` + prompt template + named I/O (`consumes`/`produces`) — see §6 | author (profile may override tiers) |
| `trigger.kind` | what starts it (see §7) | author |
| `guardrails[]` | declared constraints; `locked: true` cannot be weakened by a profile (see §4) | author locks; profile may tune overridable ones |
| `required_capabilities` | what the component needs of its runtime (see §8) | author |
| `borrowed_actions` | external actions it uses (notify, ticket, …), borrowed from the runtime | author |
| `effect.render_blocks` | the typed output blocks it produces (see §6.3) | author |
| `effect.outcome.kind` | its side-effect kind: `none` / `assertion` / `mutation` / `dispatch` | author |

> **v1 scope note.** The v1 compiler resolves: `id, verb, type, realization_kind, binding_mode,
> params, llm_steps, trigger, guardrails, required_capabilities, borrowed_actions, effect`. The
> richer authoring fields shown above — `context_requirements`, `context_precondition`, `eval`,
> and a derived `manifest` projection — are part of the design and appear in examples, but are
> **not yet parsed** by the v1 compiler (unknown fields are ignored). They document intent today
> and become load-bearing as the compiler grows.

---

## 3. Profile — bind a Harness to a Context

A profile does exactly three things: **bind a Context**, **mount components** (supplying their
required binds and overriding overridable defaults), and set **global config**. A profile has
**no control flow** — no `if`, no loops, no edges between components.

Minimal profile (`render-demo/profile.yml`) — mount one component, inherit its defaults:

```yaml
profile: render-demo

context:
  project: ./context/binding.yml   # indirection to the bound wren project

config:
  tier_policy: null                # optional profile-level tier policy

components:
  - use: dashboard                 # mount the `dashboard` component as-is
```

A profile that supplies config/overrides (`demo-agent/profile.yml`):

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
# render-demo/context/binding.yml
project: ../examples/jaffle-wren
```

**v1 binding is coarse:** it points at a *whole* wren project; the compiler does not introspect the
MDL (no metric/grain-level resolution yet). It runs one precondition — the path exists and contains
`wren_project.yml` — and fails loudly otherwise. Fine-grained MDL binding (which unlocks semantic
guardrails like blast-radius) is a later phase.

---

## 5. Component types → realization kind

The `type` classifies the behavior; it gives a default `realization_kind` (how it wires to the LLM):

| `type` | default `realization_kind` | why | v1 |
| --- | --- | --- | --- |
| `analytical` | `skill` | read-only query/render; the driver runs it in-loop | ✅ implemented |
| `assertive` | `tool` | monitoring: its own tier + an alerting boundary | ▫ scaffolded |
| `mutating` | `gated-tool` | edits: tool + a hard human-approval gate | ▫ scaffolded |
| `orchestrating` | `skill` | routes to sub-agents; callees are called as tools | ▫ scaffolded |

v1 realizes the **analytical / skill** path end to end. The other types are documented, loud-failing
extension points (dispatching an unimplemented one is a clean "wall-hit" error, never a wrong agent).

---

## 6. Steps, tiers, and the render contract

### 6.1 Tiers (not model names)

A step declares a **tier** — an abstract capability class — not a concrete model:

- `strong` — the capable/expensive tier (v1 dispatches this to `opus` on the Claude Code target).
- `cheap` — the fast/cheap tier (v1 → `haiku`).

Tiers travel in the IR; the *dispatcher* binds tier → concrete model at dispatch time. This is what
lets the eval loop ablate `strong→opus` vs `strong→haiku` over the same profile.

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
| `scheduled` | run on a cadence (borrows a scheduler) | ▫ scaffolded (loud-fail) |
| `event` | run on a pub/sub event (borrows an event bus) | ▫ scaffolded (loud-fail) |

---

## 8. Guardrails and capabilities

### Guardrails — the safety floor

Guardrails are declared constraints. Each is either:

- **`locked: true`** — a safety floor a profile **cannot** remove or weaken (e.g.
  `read_only_execution` on read-only components; `human_approval` / `must_dry_run` on mutating ones).
  A profile that tries to weaken a locked guardrail is a **compile-time loud-fail**.
- **overridable** — thresholds, cadence, alert routing, etc., which a profile may tune.

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
warble compile render-demo -o /tmp/ir.json
warble dispatch /tmp/ir.json --target claude-code:headless --out /tmp/agent
warble manifest /tmp/ir.json        # the capability manifest projected from the IR
```
