# Warble IR — the compile contract (`warble_ir_version: 0.2`)

The IR is the **language-neutral seam** between the Warble front-end (`warble compile`) and any
back-end. The v1 reference back-end is the Claude Code CLI target (`warble dispatch`, Rust); other
runtimes are other thin back-ends. Both sides depend only on this document — not on each other's
internals.

`warble compile <project-dir> -o ir.json` reads a Warble project (profile + components +
context binding) and emits **one** IR JSON document with `"warble_ir_version": "0.2"` — the
current, live contract the compiler emits today. (Earlier drafts of this doc kept the per-step-tier
shape in a separate "v0.2 (proposed)" section; that has been folded into the contract below now
that it is implemented and wired into the built core/dispatcher.) This POC resolves a **single
analytical component**; the shape below is what the dispatcher consumes.

> Scope note (POC): context binding is **coarse** — it points at a whole wren project path and
> does **not** introspect MDL. `binding_mode` is carried through, and `context_precondition`
> predicates are declared and validated for **closed-vocabulary membership** at compile time, but
> no predicate is *evaluated* against MDL yet (that is deferred to a later phase / a
> `ContextLoader`; see [`context_precondition`](#context_precondition-closed-predicate-vocabulary)
> below).

---

> **Umbrella model:** how the IR's declared capabilities are matched against a target runtime at
> dispatch (native / realize-via / degrade / fail) is defined in `capability-model.md`. The v0.3
> section below is a specific capability resolved under that model.

## Top-level shape

```jsonc
{
  "warble_ir_version": "0.2",
  "profile": "orders-analytics",          // profile.yml `profile:`
  "context_binding": {                    // resolved from profile `context:` + context/binding.yml
    "project": "examples/jaffle-wren",    // path to a wren project (relative to project-dir, or absolute)
    "binding_mode": "runtime_selected"
  },
  "config": {
    "tier_policy": "cost_sensitive"       // profile.yml config.tier_policy (nullable)
  },
  "components": [ /* one resolved component node, see below */ ]
}
```

## Component node (resolved: component defaults ⊕ profile overrides)

```jsonc
{
  "id": "generate_dashboard",
  "verb": "generate_dashboard",
  "type": "analytical",                   // analytical | assertive | mutating | orchestrating
  "realization_kind": "skill",            // skill | tool | gated-tool  (default derived from type, profile-overridable)
  "context_binding": {                    // per-node; POC = same coarse project as top-level
    "project": "examples/jaffle-wren",
    "binding_mode": "runtime_selected"
  },
  "context_requirements": [               // human-readable shape strings — always emitted, may be []
    "a wren project (semantic layer) to build dashboards over"
  ],
  "context_precondition": [               // structured predicates — always emitted, may be []
    { "predicate": "has_metric" },
    { "predicate": "has_groupable_dimension" }
    // "args" is optional per entry, e.g. { "predicate": "has_metric", "args": { "name": "revenue" } }
    // predicate must be from the closed vocabulary — see below. Compile validates membership only;
    // it does not evaluate predicates against MDL (deferred to ContextLoader, a later phase).
  ],
  "params": [                             // always emitted, may be []
    { "name": "topic_default", "bind": "optional", "default": "overview" },  // profile-bound (bind)
    { "name": "connection", "source": "runtime-injected" }                    // runtime-injected, not in git
  ],
  "precondition_result": {                // coarse check outcome (see §checks)
    "status": "pass",                     // pass | fail
    "checks": ["project path exists and contains wren_project.yml"]
  },
  "prompt_fragment": "…rendered skill instructions…",  // see §prompt rendering
  "llm_calls": [                          // per-step tier, order preserved from component llm_steps
    { "name": "plan_dashboard", "tier": "strong", "conditional": false,
      "consumes": [], "produces": "query_plan",
      "prompt": "<plan_dashboard.md rendered, placeholders substituted, no ## header>" },
    { "name": "compose_layout", "tier": "cheap", "conditional": false,
      "consumes": ["query_plan"], "produces": "dashboard_summary",
      "prompt": "<compose_layout.md rendered>" }
  ],
  "guardrails": [                         // resolved; `locked` is the single source of truth
    { "name": "read_only_execution", "locked": true }
    // "threshold" appears only when authored, e.g. { "name": "alert_routing", "locked": false, "threshold": 5 }
  ],
  "trigger": { "kind": "one_shot" },      // one_shot | scheduled | event
  "required_capabilities": [              // union of component declarations
    "sql_execution:read_only", "genbi_build", "llm:strong", "llm:cheap"
  ],
  "borrowed_actions": [],
  "eval_ref": "generate_dashboard.eval",  // legacy reference string; retained for back-compat
  "eval": {                               // structured form; present only when authored
    "template_ref": "eval/",
    "metrics": ["answer_relevance", "chart_appropriateness"]
  },
  "effect": {
    "render_blocks": [
      { "type": "chart", "fields": {} }, { "type": "table", "fields": {} }, { "type": "kpi_card", "fields": {} }
    ],
    "outcome": {
      "kind": "none"                      // none | assertion | mutation | dispatch — stays this 4-value union
      // optional facets below are parsed today but not yet consumed by the MVP (analytical) back-ends
      // — forward-declared, not silently dropped. See §effect.outcome facets.
      // "verdict_type", "emits"                    (assertive)
      // "target", "change_type"                    (mutating)
      // "routable_scope"                            (orchestrating)
    }
  }
}
```

### New/expanded fields, one by one

#### `context_requirements`

An array of human-readable shape strings — what "shape" of context this component needs, in
prose (not a binding). **Always emitted, may be `[]`** (as it is on the `dashboard` component in
`examples/render-demo/ir.golden.json`, which declares no requirements). Not machine-checked today; it exists
for discoverability (Hub listings, docs) alongside the machine-checked `context_precondition`.

#### `context_precondition` (closed predicate vocabulary)

An array of structured predicates, each `{ "predicate": <name>, "args"?: {…} }`. **Always emitted,
may be `[]`.** `predicate` must be one of exactly nine names:

| Predicate |
| --- |
| `mdl_parseable` |
| `has_metric` |
| `has_queryable_dimension` |
| `has_time_dimension` |
| `has_groupable_dimension` |
| `metric_additive` |
| `model_has_timestamp` |
| `lineage_resolvable` |
| `wren_project_exists` |

`args` is optional per entry (predicate-specific, e.g. a metric/dimension name to check). **Compile
validates vocabulary membership only** — an unknown predicate name is a loud compile-time fail (see
the checks table). Compile does **not** evaluate predicates against the bound MDL; that evaluation
is deferred to a later phase (a `ContextLoader` that actually introspects the wren project). Until
then, a passing compile only means the predicate name is well-formed, not that it holds.

#### `params`

An array, **always emitted, may be `[]`.** Each entry is exactly one of two shapes:

- **Profile-bound**: `{ "name", "bind": "required" | "optional", "default"? }` — supplied (or
  defaulted) by the profile at compile time; see [Resolution rules](#resolution-rules).
- **Runtime-injected**: `{ "name", "source": "runtime-injected" }` — supplied by the runtime at
  dispatch/run time, never committed to git (e.g. a database `connection`, or `model_binding`,
  the tier→concrete-model binding).

An entry must declare **exactly one** of `bind` or `source` — declaring both, or neither, is a loud
compile-time fail. The only accepted `source` value today is `"runtime-injected"`; any other value
is also a loud compile-time fail.

#### `llm_calls[].conditional`

A boolean, **always emitted, defaults to `false`.** It marks a step that only runs when all of its
`consumes` slots are available. The composition layer stays declarative: `conditional` is a flag,
not a condition expression — the actual WHEN-logic (what to do if the inputs aren't there) lives
inside the step's own hook/prompt, never in the profile/composition layer. This keeps invariant #3
(the composition layer never grows a data-flow DSL) intact.

#### `guardrails[].threshold` and the `locked`/`overridable` normalization

`threshold` is a passthrough field — present in the resolved IR **only when authored** on the
component (e.g. an alert-routing guardrail's cadence/threshold value); omitted otherwise.

Authoring may declare `locked` and/or `overridable` on a guardrail, but the **IR only ever emits
`locked`** — it is the single source of truth downstream. At compile:

- authoring may declare exactly **one** of `locked` or `overridable` (`overridable: true` normalizes
  to `locked: false`);
- declaring **both**, if they agree (`locked: true` + `overridable: false`, or `locked: false` +
  `overridable: true`), is accepted and normalized the same way;
- declaring **both** with a contradiction, or declaring **neither**, is a loud compile-time fail.

#### `eval` and `eval_ref`

`eval_ref` is the legacy synthesized reference string (`"<id>.eval"`) — kept for back-compat with
tooling that only needs a pointer. `eval` is the newer **structured form**, `{ "template_ref",
"metrics": [...] }`, present **only when authored** on the component (see `dashboard` in
`examples/render-demo/ir.golden.json`, which has no `eval` block and only `eval_ref`, vs. `generate_dashboard`
in `examples/demo-agent/ir.golden.json`, which has both). `eval` is what can actually drive an eval loop
(concrete metrics + template); `eval_ref` remains only a reference string.

#### `effect.outcome` facets

`outcome.kind` stays the stable 4-value union (`none | assertion | mutation | dispatch`) — the spine
does not grow a new arm. On top of `kind`, authoring may declare type-specific facets that are
**parsed and passed through the IR today but not yet consumed by the MVP (analytical) back-ends**:
they are forward-declared, not silently dropped.

| Facet | For `type` | Meaning |
| --- | --- | --- |
| `verdict_type` | `assertive` | the shape of the assertion's verdict |
| `emits` | `assertive` | events this outcome may publish (routing) |
| `target` | `mutating` | what's being mutated, e.g. `data` vs `context` |
| `change_type` | `mutating` | the kind of mutation |
| `routable_scope` | `orchestrating` | what this dispatch may route to |

---

## Resolution rules (front-end `warble compile` must implement)

1. **Parse** `profile.yml`, each mounted `components/<id>/component.yml`, and `context/binding.yml`.
   Every parsed document is checked against `deny_unknown_fields`: an authoring field the schema
   does not recognize is a loud compile-time fail (never silently ignored).
2. **Merge** `IR.node = component defaults ⊕ profile overrides`:
   - `profile.components[].config` overrides overridable component fields (e.g. cadence, thresholds; none load-bearing for this component).
   - `profile.components[].tier_overrides.{step}` overrides that step's `tier` in `llm_calls`.
   - `realization_kind`: component default (from `type`) unless profile overrides.
3. **Fill required binds**: every component `params[].bind: required` must be supplied by
   `profile.components[].bind`. Missing → **compile error** (loud fail).
4. **Validate `context_precondition`**: every entry's `predicate` must be a member of the closed
   nine-name vocabulary. Unknown predicate → **compile error** (loud fail). Compile does not
   evaluate predicates against MDL.
5. **Validate `params` shape**: each entry must declare exactly one of `bind`/`source`; `source`, if
   present, must be `"runtime-injected"`. Violations → **compile error** (loud fail).
6. **Normalize `guardrails[].locked`**: resolve authored `locked`/`overridable` down to a single
   `locked` boolean per the rule above; contradictory or absent declarations → **compile error**
   (loud fail).
7. **context_binding**: `project` = resolved path from `context/binding.yml` `project:`
   (kept as-authored: relative paths stay relative to the project-dir). `binding_mode` from component.
   **No MDL introspection.**
8. **prompt rendering** (see below) → `prompt_fragment` and per-step `llm_calls[].prompt`.
9. **tier**: carry the step's tier **name** as a string in `llm_calls` (the standard core is
   `strong`/`cheap`, but the vocabulary is open — a component may use custom tier names); do **not**
   resolve it to a concrete model (that is the dispatcher's runtime-injected job — see the
   `ModelConfig` / `warble dispatch --models-config` binding in `authoring.md` §6.1.1).

## Compile-time checks — all loud-fail (non-zero exit + clear message)

| Check | Trigger | Error |
| --- | --- | --- |
| bind-required | a `params[].bind: required` not supplied by profile | `missing required bind '<name>' for component '<id>'` |
| locked-guardrail override | profile tries to remove/weaken a `guardrails[].locked: true` | `cannot override locked guardrail '<name>' on component '<id>'` |
| coarse precondition | `context_binding.project` path missing or no `wren_project.yml` | `context precondition failed: <path> is not a wren project` |
| unknown precondition predicate | `context_precondition[].predicate` not in the closed 9-name vocabulary | `unknown context precondition predicate '<name>' for component '<id>'` |
| param bind/source exclusion | a `params[]` entry declares both `bind` and `source`, or neither | `param '<name>' must declare exactly one of 'bind' or 'source' for component '<id>'` |
| unknown param source | `params[].source` present but not `"runtime-injected"` | `unknown param source '<value>' for param '<name>' on component '<id>'` |
| contradictory/absent guardrail lock state | a `guardrails[]` entry declares neither `locked` nor `overridable`, or declares both with conflicting values | `guardrail '<name>' on component '<id>' must declare exactly one (agreeing) of 'locked'/'overridable'` |
| unknown authoring field | `component.yml` (the `ComponentFile` and its nested structs) contains a field the schema does not recognize | `unknown field '<name>'` (serde `deny_unknown_fields`) — note: applies to `component.yml` only in this phase, not `profile.yml` / `context/binding.yml` |

`required_capabilities` is **declared only** in this POC (not enforced by the compiler;
enforcement is the dispatcher/runtime's job).

## Prompt rendering

For `realization_kind: skill`, `prompt_fragment` is a single instruction block the dispatcher
drops into the agent's system prompt. The front-end builds it by rendering each
`llm_steps[].prompt_ref` markdown file **in declared order**, joined under `##`-level headers
named by step, with placeholders substituted from coarse context:

- `{{project}}` → `context_binding.project`
- `{{project_name}}` → basename of the project path

Each `llm_calls[]` entry also carries its own **per-step rendered `prompt`** — the same
substitution as `prompt_fragment`, but rendered **per step and without** the `## <name>` header.
This exists because a step must be realizable in isolation on any runtime: isolation severs shared
context, so both the step's own instructions and its named `consumes`/`produces` I/O slots must be
explicit on the step itself. `consumes`/`produces` are named slots only — no conditionals/loops
(that composition-level restraint is what `llm_calls[].conditional`, above, exists to cover without
growing a data-flow DSL). Absent `consumes` → `[]`; absent `produces` → `null`.

**Two realizations of the same IR:**

- `prompt_fragment` (joined) is what an in-loop runtime uses — the driver runs every step against
  one model in one context.
- `llm_calls[].prompt` (per-step) is what a runtime that splits into isolated calls uses — each
  step's prompt plus its `consumes`/`produces` slots is enough to realize it as a standalone
  invocation.

One IR feeds both realizations; nothing here is runtime-specific. `required_capabilities` carries
`llm:per_step_tier` — the generic requirement "every LLM call must run at its declared tier" — and
never names a mechanism.

### Compile-time resolution against a target runtime (loud-fail, per the checks table above)

| Runtime supports… | Realization |
| --- | --- |
| per-step tier natively (in-loop model switch) | run steps in-loop; I/O contract unused |
| only `isolated_invocation` (tier-bound sub-call) | realize each divergent-tier step as an isolated call; marshal via `consumes`/`produces` |
| neither, and the component has heterogeneous tiers | **compile-time loud fail** |

### Runtime-general realization (same IR, borrowed mechanisms)

| Runtime | Satisfies `llm:per_step_tier` by | Needs I/O contract |
| --- | --- | --- |
| Claude Code CLI (static files) | one **subagent** per divergent-tier step (own `model:`); driver marshals | ✅ |
| Claude Agent SDK (programmatic) | `query({options})` picks the model per step — in-loop | ❌ |
| LangGraph | bind each node to its own LLM | ❌ (edges carry it) |
| Omnigent / meta-harness | a tier-bound sub-component it manages | ✅ |

The dispatcher stays enum-keyed and thin: it reads `llm:per_step_tier` + the I/O contract and
maps to whatever its runtime provides. Mechanism (spawn/collect/marshal) is **borrowed**, never a
Warble differentiator.

---

## Golden example

`warble compile ./examples/demo-agent -o ir.json` against the demo project in this repo must produce an
IR equal to `examples/demo-agent/ir.golden.json` (committed alongside, used as the core's fixture test).
`warble compile ./examples/render-demo -o ir.json` similarly must equal `examples/render-demo/ir.golden.json`. Both
goldens are v0.2: note that `context_requirements`, `context_precondition`, and `params` are always
present (possibly `[]`, as on the `dashboard` component in `examples/render-demo`), and that `eval`/`threshold`
only appear where actually authored (only on `generate_dashboard` in `examples/demo-agent`).

---

# v0.3 — render contract (typed blocks + renderer registry)

> Closes wall-hit #2 (render blocks) the same way #1 was closed: the IR declares a
> **runtime-agnostic typed-output contract**; each runtime supplies (or overrides) a **renderer**;
> Warble ships a **default reference renderer (HTML)** so there is an out-of-box result even on a
> plain runtime. **Status:** both render flavors are implemented in the dispatcher (see §4) — the
> IR-side typed `render_blocks` contract is consumed today; the front-end `warble compile` still
> emits `render_blocks` as coarse type names + field schema (no per-runtime renderer selection at
> compile time — that is the dispatcher's job).

## The gap today
`effect.render_blocks` is just type names (`["chart","table","kpi_card"]`), and the agent returns
prose. Nothing downstream can render typed blocks. Two things are missing: (a) a **data contract**
per block type so the agent emits *structured* blocks, and (b) a **renderer** that turns those
blocks into an artifact.

## 1. Typed block contract (Warble stdlib, extensible)
`effect.render_blocks` becomes typed entries carrying each block's field schema. Warble ships a
small stdlib of block types; components may extend it.

```jsonc
"render_blocks": [
  { "type": "kpi_card", "fields": { "label": "string", "value": "number|string", "unit": "string?", "delta": "number?" } },
  { "type": "table",    "fields": { "columns": "string[]", "rows": "row[]" } },
  { "type": "chart",    "fields": { "chart_type": "bar|line|pie|area|scatter", "x": "string", "series": "string[]", "rows": "row[]" } }
]
```

## 2. Agent output envelope (runtime-agnostic, structured — not prose)
The renderable component returns a structured envelope of **block instances** conforming to the
contract, plus optional prose:
```jsonc
{ "blocks": [
    { "type": "kpi_card", "label": "Total customers", "value": 100 },
    { "type": "table", "columns": ["status","orders","revenue"], "rows": [["completed",67,1103], ...] }
  ],
  "summary": "…prose…" }
```

## 3. Renderer registry — `render(target, blocks[]) → artifact`
Warble owns the **contract + a reference renderer (HTML)**; runtimes register/override per target.

| target | how blocks render | provider |
| --- | --- | --- |
| `html` (**default**) | one self-contained `dashboard.html` (KPI cards, HTML tables, JS charts) | Warble reference renderer |
| `markdown` | markdown tables + text (the plain-CLI degrade) | Warble |
| `wren-genbi` | delegate to `wren genbi build/verify/open` | borrowed (wren) |
| `react` / IDE / web host (future) | native components | that runtime |

## 4. Two renderer flavors (default programmatic, prompt fallback) — **implemented**
Selected at dispatch via `warble dispatch … --render-flavor <programmatic|prompt>` (default
`programmatic`). The IR is flavor-agnostic; the flavor lives in the back-end.

- **programmatic (default)** — ✅ implemented: the emitted agent stays **fully read-only** (no
  `Write` tool) and is instructed to emit the `{ blocks, summary }` envelope as its final message.
  The back-end ships a **reference renderer** (`warble render`, `dispatcher/claude-code-cli/src/render.rs`) that
  turns that envelope → a self-contained `dashboard.html` **deterministically** (inline SVG charts,
  no clock/RNG, no external assets → same envelope ⇒ identical bytes). The two-step run is documented
  in the emitted `RUN.md`:
  ```sh
  claude -p "<data question>" --agent dashboard --output-format json > result.json
  warble render result.json --out dashboard.html
  ```
  `warble render` also unwraps the `--output-format json` result object and tolerates the model
  fencing/prose-wrapping the envelope (see `parseEnvelope`).
- **prompt fallback** — ✅ implemented (`--render-flavor prompt`): for when there is no post-step to
  run the renderer, the dispatcher bakes the block contract + "write `dashboard.html`" instruction
  into the prompt and grants the agent **scoped artifact-write**. Works in the pure file model; HTML
  is LLM-produced → non-deterministic.

## 5. Guardrail split this forces (data-write ≠ artifact-write)
Rendering writes a file, but the component is `read_only_execution`. These must be **separate
enforcement points** (vision §3):
- `data:read_only` — never mutate the warehouse (wren `strict_mode`). Unchanged.
- `artifact:write(scoped)` — may write only the output dir (the HTML). Needed **only** on the
  prompt-fallback path; the programmatic path keeps the agent read-only entirely.

## 6. Capability + loud-fail
- Component declares `required_capabilities: [render_contract]` (generic: "the declared blocks must
  be renderable"). Never names `html`/`react` — that is the target's realization.
- Compile against a target: has a renderer for these block types → render; else can degrade to
  `markdown` → warn; else → loud-fail. Same pattern as §5 / per-step-tier.

The IR names **types + data contract + the requirement** only; *how* a chart becomes pixels is the
renderer's job (Warble default HTML, or a runtime override). Contract owned; renderer borrowed/pluggable.
