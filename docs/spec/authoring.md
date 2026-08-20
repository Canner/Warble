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
| **Component** (`component.yml`) | the contract + defaults + requirements — **no concrete context binding or instance bind values** | a function signature / a dbt package |
| **Profile** (`profile.yml`) | binds a Context + mounts components + supplies binds and supported mount fields | the call site / dbt vars |
| **IR** (compiler output) | `resolved(component ⊕ supported mount fields ⊕ context)` | the compiled call |

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

A component is a **directory** (declarative manifest + prompt templates + optional eval):

```
components/<name>/
├── component.yml        # the manifest — all authoring fields (pure data; portable)
├── steps/               # one prompt template per LLM step (may contain {{placeholders}})
│   └── <step>.md
└── eval/                # optional: eval templates + golden fixtures
```

`component.yml` is pure data. The current manifest schema has no field for a hook or sibling code
file; a hook-related field is rejected as unknown. Imperative runtime integration is not an
authoring surface of the current component manifest.

### `component.yml`, field by field

Fields marked **[spine]** exist on every component (stable across types); **[type]** are
type-specific. Real example — the `generate_dashboard` analytical component (`examples/demo-agent/`):

```yaml
# ── identity & type [spine] ──
id: generate_dashboard
verb: generate_dashboard
type: analytical                 # analytical | assertive | mutating | constitutive | orchestrating
realization_kind: skill          # required; shipped components conventionally use skill | tool | gated-tool

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

# ── behavior fields (a profile may apply only the supported mount fields) [spine] ──
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
| `type` | one of the five shipped component families (see §5) | component author |
| `realization_kind` | how it connects to the LLM. Shipped components conventionally use `skill` (in-loop instructions), `tool` (its own tier-bound call), or `gated-tool` (tool + approval gate). This required field is not defaulted from `type`; a profile may replace it. | author (profile may override) |
| `binding_mode` | `runtime_selected` (interactive — target chosen at query time) or `pinned` (needs a fixed target, e.g. a monitor). `pinned` is realized by a `bind`-family param plus a `context_precondition` referencing it via `$param:<name>` (§2.1) — the component author wires the two together; `binding_mode` alone is descriptive, not enforced | intrinsic to the component |
| `context_requirements` | human-readable shape strings — what shape of context this needs, in prose. Free text; **not** compile-validated (Hub/docs discoverability only) | author |
| `context_precondition` | structured predicates `{ predicate, args? }`; `predicate` must be one of a **closed 11-name vocabulary** (§2.1). An `args` value may be `"$param:<name>"`, resolved against the component's own effective binds before evaluation (§2.1). Compile validates vocabulary membership and evaluates each predicate against the bound context through the injected `ContextLoader` — see §2.1 | author |
| `params[].bind` / `params[].source` | `bind: required` → the profile MUST supply it; `bind: optional` → may, with `default`; `source: runtime-injected` → supplied by the runtime at dispatch/run time, never committed to git. Exactly one of `bind`/`source` per param — declaring both or neither is a compile error. Every `bind`-family param's **effective value** (mount-supplied, else `default`) is carried in the IR's additive `binds` facet — see [`ir-schema.md`](./ir-schema.md#binds) | profile supplies binds; runtime supplies injected params |
| `llm_steps[]` | ordered steps; each declares a `tier` + prompt template + named I/O (`consumes`/`produces`) + optional `conditional`/`when` — see §6.2.1 | author (profile may override tiers) |
| `llm_steps[].conditional` | `true` → the step only runs when its `when` guard holds. Defaults to `false`. `conditional: true` with no `when` is a compile-time loud fail (v0.3+) — see §6.2.1 | author |
| `llm_steps[].when` | `{ guard, target }` — the closed-vocabulary guard deciding whether a `conditional` step runs (§6.2.1). Required whenever `conditional: true`; a compile error if present without `conditional: true` | author |
| `trigger.kind` | what starts it (see §7) | author |
| `guardrails[]` | declared constraints; `locked: true` cannot be weakened by a profile (see §4). A profile patch can change only `locked` on an unlocked guardrail. | author locks; profile may patch an unlocked guardrail's `locked` value |
| `guardrails[].overridable` ↔ `.locked` | authoring declares exactly one (agreeing values on both is fine); the IR always resolves and emits only `locked` — it's the single source of truth downstream. `overridable: true` normalizes to `locked: false`. Declaring both with conflicting values, or neither, is a compile error | author |
| `required_capabilities` | what the component needs of its runtime (see §8) | author |
| `borrowed_actions` | external actions it uses (notify, ticket, …), borrowed from the runtime | author |
| `effect.render_blocks` | the typed output blocks it produces (see §6.3) | author |
| `effect.outcome.kind` | its side-effect kind: `none` / `assertion` / `mutation` / `dispatch` (stable 4-value union; type-specific facets like `verdict_type`/`target`/`routable_scope` may ride on top — parsed, but not yet consumed by the MVP analytical back-ends) | author |
| `eval` | `{ template_ref, metrics: [...] }` — structured eval config; present only when authored | author |
| `brief` | optional free-form text, shared across every step of this component (see below) | author (profile mount may replace it wholesale, §3) |
| `description` | optional one-or-two-sentence statement of what this component is *for* — written for whoever is choosing between components, not for the agent running one (see below) | author |
| `examples` | optional list of example requests this component is the right destination for | author |

> **Compiler coverage.** The compiler resolves and validates every field shown above, including
> `context_precondition`, `params[].source`, `llm_steps[].conditional`/`when`, the `guardrails`
> `locked`/`overridable` normalization, and `eval`. `manifest` is **not** an authoring field at
> all — it's a projection `warble manifest` derives from the compiled IR, never written in
> `component.yml`. `component.yml` is also checked with `deny_unknown_fields` (this check applies to
> `component.yml` only, not `profile.yml` / `context/binding.yml`): any field the
> schema doesn't recognize is a **compile-time loud fail**, never silently ignored. See
> [`ir-schema.md`](./ir-schema.md) for the exact resolved shape and the full compile-time-checks
> table.

#### `brief` — authored framing shared across every step

A component's steps (`steps/*.md`) each carry their own free-form prompt, but there was previously
no place to put framing that all of them share — role, purpose, audience ("you serve business
users who don't write SQL; confirm the metric definition before answering"). `brief` is that place:
one optional free-form string on the component, rendered with the same `{{project}}` /
`{{project_name}}` placeholder substitution as step prompts and emitted onto the IR node (not
per-step, see [`ir-schema.md`](./ir-schema.md)). Every back-end that assembles a system prompt
places it in the same spot: after the machine-generated preamble, before the body — on the driver
*and* on every subagent, since its whole point is framing shared by all of them.

```yaml
id: answer_query
verb: answer_query
brief: |
  You are a senior data analyst serving business users who don't write SQL. Their questions are
  often ambiguous about exactly what they mean — confirm the metric definition before answering.
```

**Authoring rule (the drift guard):** `brief` holds framing shared by all steps; `steps/*.md` holds
what is specific to one step. If a sentence is only needed by one step, it does not belong in
`brief` — otherwise `brief` gradually absorbs the step prompts and the two surfaces stop meaning
anything distinct.

**Do not conflate the fields that all sound like "what this component is":**

| Field | Reaches the model? | Drives |
| --- | --- | --- |
| `context_requirements` | No — free text, humans/Hub discovery only | Nothing at runtime; documentation only |
| `description` + `examples` | Only as metadata a *selector* reads | Whether this component is **chosen** for a request |
| `brief` | Yes — assembled into the system prompt every turn | The subagent's *behavior* once it is running |

#### `description` / `examples` — what the component is for

`brief` frames how the steps run, for an agent that is already running them. `description` answers a
different question, asked by someone who has not chosen yet: *should this request go here at all?*
Its readers are all selectors — the runtime's own agent selection (Claude Code matches on the emitted
frontmatter `description`), the emitted scope inventory, and a remote agent reading a published skill
list over a protocol like A2A.

```yaml
id: explain_change
verb: explain_change
description: >-
  Explain why a metric moved: decompose the change across time and the dimensions that drive it,
  then report the contributing drivers as a narrative. Use it for causal "why did this move"
  questions, not for retrieving the number itself.
examples:
  - "Why did revenue drop last month?"
  - "Which regions explain the spike in refunds?"
```

**Write the boundary, not just the behavior.** Every analytical component in a data profile can be
described as "answers questions about the data", and a selector cannot act on that. The closing
clause — what this component is *not* for — is the half that discriminates.

**These are the one thing the back-end cannot synthesize.** With no `description`, back-ends fall
back to a line derived from the IR shape (`analytical skill that renders no render blocks (outcome:
none)`), which states what the component *is* and nothing about when to send work to it. That
fallback keeps dispatch working; it does not make selection work.

**Entry agents only.** A back-end applies `description` to the agent that *is* the component,
including the driver of a per-step-tier split. A step is not a destination a selector may choose, so
lending it the component's purpose would advertise it as an entry point.

**No placeholder substitution**, unlike `brief` and step prompts: a description that only makes sense
once a project is bound cannot serve a skill list published to other agents. A `{{...}}` placeholder
in either field is therefore a **compile-time loud fail** rather than text that ships unrendered.

**`examples` requires `description`.** Every consumer reaches the examples through the description —
appended to it for a target whose agent format has no examples concept, or projected beside it for one
that does — so examples alone would be silently dropped. That is also a compile-time loud fail.

**Where an authored purpose stops.** A back-end applies it to the agent that *is* the component, and
to nothing inside it: a per-step subagent and a context-isolation child both keep a synthesized,
internally-scoped line. The isolation child is the case that matters most — it holds the tools its
parent deliberately does not, so advertising it with the component's purpose would offer a walled
interior as an equal destination.

**These change eval numbers**, for the same reason `brief` does — see the note below.

**Token cost is N+1×.** `brief` is emitted into the driver and every subagent, every turn — keep it
to a few sentences (guidance, not a hard limit).

**`brief` changes eval numbers.** It is part of the compiled artifact; "framing doesn't affect
logic" is false for LLMs. Changing a component's `brief` invalidates prior `execution_accuracy` /
`tier_cost_pareto` eval runs for that component, the same way changing a `steps/*.md` prompt would.

**Compatibility.** `component.yml` is parsed with `deny_unknown_fields`, so adding `brief` to a
component is backward compatible for a current warble binary, but that component will **loud-fail
on an older binary** that doesn't yet recognize the field — see `CHANGELOG.md`.

### 2.1 `context_precondition` predicate vocabulary

`context_precondition[].predicate` must be one of exactly eleven names — an unknown predicate is a
compile-time loud fail.

#### Authoritative predicate table

| Predicate | What it asks |
| --- | --- |
| `mdl_parseable` | Whether the adapter reports the bound context as parseable. |
| `has_metric` | Whether `ContextLoader.metrics()` is non-empty. |
| `has_queryable_dimension` | Whether `ContextLoader.dimensions()` is non-empty. |
| `has_time_dimension` | Whether `ContextLoader.time_dimensions()` is non-empty. |
| `has_groupable_dimension` | The same current check as `has_queryable_dimension`: whether `dimensions()` is non-empty. |
| `metric_additive` | Whether a declared metric is additive. |
| `model_has_timestamp` | Whether a model has a timestamp. |
| `lineage_resolvable` | Whether the adapter's lineage graph reports `resolvable`. |
| `wren_project_exists` | The same current coarse check as `mdl_parseable`: `ContextLoader.is_parseable()`. |
| `source_introspectable` | On `RawSourceContext`, whether parsed `schema.json` has any table with at least one column. |
| `raw_docs_readable` | On `RawSourceContext`, whether `docs/` contains at least one regular file. |

Each entry may carry an optional `args` map (predicate-specific, e.g. a metric/dimension name). An
`args` value may instead be a **bind reference**, `"$param:<name>"`, naming one of the component's
own `params[]` entries: compile substitutes it with that param's effective value (the profile
mount's supplied bind, or else the param's declared `default` — see §3) before evaluating the
predicate. `$param:<name>` naming a param the component doesn't declare is a compile-time loud
fail; a declared param with no effective value makes the precondition **unanswerable** rather than
evaluating against nothing. This is how `binding_mode: pinned` becomes real: a `monitor_freshness`
component pins its target model by declaring `params: [{ name: model, bind: required }]` and
`context_precondition: [{ predicate: model_has_timestamp, args: { model: "$param:model" } }]` —
mounting it against a timestampless (or nonexistent) model is now a compile-time loud fail instead
of a silent pass.

Compile checks that the predicate name is a member of this vocabulary and evaluates it against the
bound context through the injected `ContextLoader`. A predicate that is answerable-and-false, or
unanswerable in the bound context, is a loud compile fail. `metric_additive` is unanswerable when
no declared metric exists. `source_introspectable` and `raw_docs_readable` are answerable only when
the context adapter supports raw-source probes; MDL-only adapters return unanswerable for them.
For those two probes, `Some(true)` means pass, `Some(false)` means answerable-and-false, and `None`
means this adapter cannot answer the raw-shape question. Both non-pass outcomes abort compilation,
but they produce distinct failure classes.
`metric_additive` is existential by default and pinnable via `args: { metric: … }`.
`model_has_timestamp` follows the same shape: existential by default (passes iff any declared model
has a timestamp), pinnable via `args: { model: <name> }` (declared-with-timestamp → pass,
declared-without → fail, not declared → unanswerable).

---

## 3. Profile — bind a Harness to a Context

A profile does exactly two things: **bind a Context** and **mount components** (supplying their
required binds and supported mount fields). A profile has no control flow — no `if`, no loops, no
edges between components.

Minimal profile (`examples/render-demo/profile.yml`) — mount one component, inherit its defaults:

```yaml
profile: render-demo

context:
  project: ./context/binding.yml   # indirection to the bound wren project

components:
  - use: dashboard                 # mount the `dashboard` component as-is
```

A profile that supplies a bind (`examples/demo-agent/profile.yml`):

```yaml
profile: orders-analytics

context:
  project: ./context/binding.yml

components:
  - use: generate_dashboard
    bind:
      topic_default: "orders overview"   # supplies a declared bind-family param
```

The full mount-entry vocabulary (`components[]`):

| Field | Meaning |
| --- | --- |
| `use` | which component to mount, by `id` — resolved against Local and Hub component sources (§3.1) |
| `bind` | supplies values for the component's `bind`-family params (both `required` and `optional`) — a pinned target, scope, … . An unsupplied `bind: optional` param falls back to its declared `default`; missing with no `default` leaves it without an effective value (only safe if nothing references it via `$param:`, see §2.1). Every effective value — supplied or defaulted — reaches the IR's additive `binds` facet |
| `config` | accepted by the profile parser but not applied by the current compiler; do not use it to override defaults, thresholds, cadence, or other behavior |
| `tier_overrides` | overrides an individual step's `tier`, e.g. `{ compose_layout: strong }` |
| `realization_kind` | replaces the component's authored realization kind; the component field itself is required and has no type-derived default |
| `guardrails` | map of guardrail name to a patch containing only `locked`; attempting to patch a component guardrail that is locked is a compile error |
| `brief` | replaces the mounted component's own `brief` **wholesale** — never merged. Absent on the mount, the component's own `brief` (if any) is used unchanged; present on the mount, it fully replaces the component's `brief` (even to the empty string), and there is no trace of the component's own text in the IR |

**What is NOT in a profile** (all runtime-injected, or a different layer): tier → concrete model
mapping, cloud/local choice, database connections, and which runtime/back-end you dispatch to.

### 3.1 Component source resolution: Local vs Hub

`use` doesn't say *where* an `id` resolves from — that's decided by `warble compile` against two
source kinds:

- **Local** — the profile's own `components/` dir, plus any `--component-dir <path>` (repeatable).
  This is how a profile author defines its own components, or a host mounts a product-specific
  library alongside the Hub.
- **Hub** — the shared, portable component library (`hub/components/` in this checkout by default;
  `--hub-dir <path>` overrides the root for the whole compile). An `id` with no matching Local source
  falls through to the Hub.

All Local sources outrank the Hub. Within the Local tier there is **no priority order**: two Local
sources defining the same `id` is an ambiguous configuration and a compile-time loud fail, never
"first one wins" or "last flag wins." An `id` missing from every Local source *and* the Hub is a
plain "unknown component id" compile error — resolution does not fall back any further than these
two tiers.

---

## 4. Context binding

For the default `wren_project` binding kind, `context.project` in the profile points indirectly at
the bound wren project. The indirection file (`context/binding.yml`) holds the actual path, relative
to the Warble project dir:

```yaml
# examples/render-demo/context/binding.yml
project: ../jaffle-wren
```

**A `wren_project` binding is fine-grained:** the authored `project:` still points at a *whole* wren project
(the coarse path back-ends need), but the compiler now introspects the MDL through the injected
`ContextLoader` — resolving metrics/dimensions/grains and building a lineage DAG — and evaluates
every precondition against it. This is what unlocks the semantic `blast_radius` guardrail (read
path; `capability-model.md` §7.1). A missing/unparseable project still fails loudly.

### 4.1 `kind` — which sort of context this is

A binding may declare what kind of context it names. It defaults to `wren_project`, which is what
every binding written before the field existed meant, so omitting it changes nothing:

```yaml
kind: wren_project      # default — a wren project directory
project: ../jaffle-wren
```

`kind` is an **open string**, opaque to the compiler — the same treatment `tier` gets in the IR and
`provider` gets in the models binding, and for the same reason: the set of context kinds belongs to
whoever hosts warble, not to warble. Two kinds are resolved natively:

| `kind` | what `project` names | adapter |
| --- | --- | --- |
| `wren_project` (default) | a directory holding `wren_project.yml` | `MdlContext` |
| `raw_source` | a directory holding `schema.json` — the constitutive family's pre-MDL input | `RawSourceContext` |
| `external` | a locator for a layer held elsewhere — nothing is read | `ExternalContext` |

Declaring it replaces guessing. Previously the adapter was inferred from what the bound directory
happened to contain, so a `schema.json` directory bound as a semantic layer was silently accepted as
a raw source; now that is an error naming the kind to declare instead.

### 4.2 `external` — the layer is not here

```yaml
kind: external
project: remote-service://analytics     # a locator, never a path; warble reads nothing
```

For a profile that delegates its analysis, the semantic layer lives wherever the answers come from.
`external` says so: no I/O at compile, and a bound context that **answers no predicate at all**. Any
`context_precondition` over it is therefore *unanswerable* — the author is told to bind a context
that can answer, rather than having a gate silently evaluated against a layer nobody read.

Two consequences follow, and both are the point rather than side effects:

- **The IR omits `context_binding.resolved` entirely** (absent, not an empty block). Empty
  collections are indistinguishable from a genuinely empty project, so emitting them would state
  "this layer has no metrics" about something no one introspected.
- **Back-ends must not present that absence as knowledge.** The Claude Code target replaces its
  schema digest with an explicit "you know nothing about which models exist; never rule a question
  out on the strength of this absence" — because an empty digest reads to a model as an inventory.

The alternative — binding a convenient local project as a stand-in — is worse than binding nothing.
Nothing checks a stand-in against the layer that actually answers, and a digest describing the wrong
domain makes the agent confidently deny things that exist.

**Any other `kind` is a host's**, resolved through a `ContextResolver` the host passes to
`compile_project_to_ir_with` — the context-side counterpart of supplying your own component sources.
Fields the compiler does not know are preserved for that resolver, and `project` becomes whatever
locator it understands rather than a path:

```yaml
kind: remote_service
project: remote-service://analytics     # never interpreted here; echoed into the IR and {{project}}
project_id: 42               # a field only the host's resolver reads
```

This is how a profile binds a semantic layer that is not a directory at all — one held by a service
that will answer the questions itself, say.

**Compile stays offline.** `warble compile` must be runnable without network access or credentials,
so the seam never obliges a resolver to fetch anything. A host binding a remote layer resolves from a
snapshot it pulled earlier, or returns a loader that declines the schema probes via
`ContextLoader::can_answer`. Declining is a supported position, not a broken one: a declined
predicate is reported as *unanswerable* ("cannot be evaluated … Refusing rather than answering
wrongly"), never as an answerable `false`. A component that declares no schema preconditions
compiles against such a context unimpeded — which is what a profile that delegates its analysis
elsewhere should be doing anyway.

What such a binding does **not** buy on its own is drift detection: whether the bound layer still
matches what the service serves is the host resolver's question to answer.

---

## 5. Component types and realization kind

The `type` classifies the behavior. `realization_kind` says how it wires to the LLM and is a
required authored field; the parser does not derive it from `type`. The table records the
conventions used by shipped components:

| `type` | conventional `realization_kind` | why | v1 |
| --- | --- | --- | --- |
| `analytical` | `skill` | read-only query/render; the driver runs it in-loop | ✅ implemented |
| `assertive` | `tool` | monitoring: its own tier + an alerting boundary | ✅ implemented |
| `mutating` | `gated-tool` | edits: tool + a hard human-approval gate | ✅ implemented |
| `constitutive` | `gated-tool` | reads a raw source and proposes a scoped semantic-context mutation | ✅ implemented |
| `orchestrating` | `skill` | routes to sub-agents; callees are called as tools | ▫ scaffolded |

`constitutive` reuses the four-valued outcome union: it emits `kind: mutation` with
`target: context`, not a fifth outcome arm. It binds `kind: raw_source` input and uses
`source_introspectable` or `raw_docs_readable`; the shipped `RawSourceContext` adapter answers
those probes. `bootstrap_mdl` and `enrich_knowledge` are the reference components, with
`context_write_authz.scope` confining their proposed writes to `models/` and `knowledge/`.

`analytical`, `assertive`, `mutating`, and `constitutive` have shipped compiler and dispatcher
paths, though target support remains subject to each dispatcher's wall-hit matrix. `orchestrating`
remains a documented, loud-failing extension point.

---

## 6. Steps, tiers, and the render contract

### 6.1 Tiers (not model names)

A step declares a **tier** — an abstract capability class — not a concrete model:

- `strong` — the capable/expensive tier (v1 dispatches this to `opus` on the Claude Code target).
- `cheap` — the fast/cheap tier (v1 → `haiku`).

Tiers travel in the IR; the *dispatcher* binds tier → concrete model at dispatch time. This is what
lets the eval loop ablate `strong→opus` vs `strong→haiku` over the same profile.

Tiers are set — and re-set — at two authoring layers, with the mount override taking precedence:

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

The effective tier is the component-authored tier, optionally replaced by `tier_overrides` for that
step, then carried into the IR's `llm_calls[].tier`.

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
- **`overridable: true`** — normalizes to `locked: false` in the resolved IR. A profile may patch
  only the resulting `locked` value, using a map-shaped mount patch such as
  `guardrails: { verbosity: { locked: true } }`; it cannot tune threshold, cadence, alert routing,
  or other guardrail data. A guardrail must declare exactly one of `locked`/`overridable` (agreeing
  values on both is fine); declaring both with conflicting values, or neither, is a compile-time
  loud-fail.

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

#### `context_isolation` — keep the working-out out of the caller's context

A component doing multi-step work leaves that work where it runs: the tool calls, the intermediate
queries, the repairs. In a conversation the user is reading, that is noise between them and their
answer. `context_isolation` declares that it must not land there.

The claude-code targets realize it by running the **whole component in one child agent**, so the
caller sees a single delegation and a single result. Note the granularity: the `llm:per_step_tier`
split *also* uses child agents, but one per step, which means the parent marshals every artifact
between them and each one passes through the context being protected. Isolation is the coarser
boundary, and it is the one that works for this.

The two therefore conflict, and isolation wins: a component declaring both runs all its steps in one
child at one model (the strongest tier declared). That is a real loss of per-step tiering, so it is
recorded — the child's markdown carries the tier-collapse comment and `capability-report.json` gets
an `isolation` block naming the model the steps collapsed onto.

Isolation is a property of the *process*, not of the answer. A component that also wants its
derivation kept out of the answer text should say so in its `effect.render_blocks` — a `definition`
block demotes the method to its own field rather than deleting it, which keeps the answer readable
without making it unauditable.

---

## 9. How it all resolves

```
IR node = resolved( component  ⊕  supported mount fields  ⊕  context )
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
