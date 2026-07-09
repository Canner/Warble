# Warble IR — the compile contract (`warble_ir_version: 0.1`)

The IR is the **language-neutral seam** between the Warble front-end (`warble compile`) and any
back-end. The v1 reference back-end is the Claude Code CLI target (`warble dispatch`, Rust); other
runtimes are other thin back-ends. Both sides depend only on this document — not on each other's
internals.

`warble compile <project-dir> -o ir.json` reads a Warble project (profile + components +
context binding) and emits **one** IR JSON document. This POC resolves a **single analytical
component**; the shape below is what the dispatcher consumes.

> Scope note (POC): context binding is **coarse** — it points at a whole wren project path and
> does **not** introspect MDL. `binding_mode` is carried through but no metric/grain is resolved
> at compile time (that stays a runtime `introspect` verb).

---

> **Umbrella model:** how the IR's declared capabilities are matched against a target runtime at
> dispatch (native / realize-via / degrade / fail) is defined in `capability-model.md`. The v0.2 /
> v0.3 sections below are specific capabilities resolved under that model.

## Top-level shape

```jsonc
{
  "warble_ir_version": "0.1",
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
  "precondition_result": {                // coarse check outcome (see §checks)
    "status": "pass",                     // pass | fail
    "checks": ["project path exists and contains wren_project.yml"]
  },
  "prompt_fragment": "…rendered skill instructions…",  // see §prompt rendering
  "llm_calls": [                          // per-step tier, order preserved from component llm_steps
    { "name": "plan_dashboard", "tier": "strong" },
    { "name": "compose_layout", "tier": "cheap" }
  ],
  "guardrails": [                         // resolved; locked flag preserved
    { "name": "read_only_execution", "locked": true }
  ],
  "trigger": { "kind": "one_shot" },      // one_shot | scheduled | event
  "required_capabilities": [              // union of component declarations
    "sql_execution:read_only", "genbi_build", "llm:strong", "llm:cheap"
  ],
  "borrowed_actions": [],
  "eval_ref": "generate_dashboard.eval",  // reference only (not expanded in POC)
  "effect": {
    "render_blocks": ["chart", "table", "kpi_card"],
    "outcome": { "kind": "none" }         // none | assertion | mutation | dispatch (POC: none)
  }
}
```

---

## Resolution rules (front-end `warble compile` must implement)

1. **Parse** `profile.yml`, each mounted `components/<id>/component.yml`, and `context/binding.yml`.
2. **Merge** `IR.node = component defaults ⊕ profile overrides`:
   - `profile.components[].config` overrides overridable component fields (e.g. cadence, thresholds; none load-bearing for this component).
   - `profile.components[].tier_overrides.{step}` overrides that step's `tier` in `llm_calls`.
   - `realization_kind`: component default (from `type`) unless profile overrides.
3. **Fill required binds**: every component `params[].bind: required` must be supplied by
   `profile.components[].bind`. Missing → **compile error** (loud fail).
4. **context_binding**: `project` = resolved path from `context/binding.yml` `project:`
   (kept as-authored: relative paths stay relative to the project-dir). `binding_mode` from component.
   **No MDL introspection.**
5. **prompt rendering** (see below) → `prompt_fragment`.
6. **tier**: carry the step's tier **name** as a string in `llm_calls` (the standard core is
   `strong`/`cheap`, but the vocabulary is open — a component may use custom tier names); do **not**
   resolve it to a concrete model (that is the dispatcher's runtime-injected job — see the
   `ModelConfig` / `warble dispatch --models-config` binding in `authoring.md` §6.1.1).

## Compile-time checks — all loud-fail (non-zero exit + clear message)

| Check | Trigger | Error |
| --- | --- | --- |
| bind-required | a `params[].bind: required` not supplied by profile | `missing required bind '<name>' for component '<id>'` |
| locked-guardrail override | profile tries to remove/weaken a `guardrails[].locked: true` | `cannot override locked guardrail '<name>' on component '<id>'` |
| coarse precondition | `context_binding.project` path missing or no `wren_project.yml` | `context precondition failed: <path> is not a wren project` |

`required_capabilities` is **declared only** in this POC (not enforced by the compiler;
enforcement is the dispatcher/runtime's job).

## Prompt rendering

For `realization_kind: skill`, `prompt_fragment` is a single instruction block the dispatcher
drops into the agent's system prompt. The front-end builds it by rendering each
`llm_steps[].prompt_ref` markdown file **in declared order**, joined under `##`-level headers
named by step, with placeholders substituted from coarse context:

- `{{project}}` → `context_binding.project`
- `{{project_name}}` → basename of the project path

(In v0.1, per-step tier heterogeneity survives only in `llm_calls[]`; a single skill body carries
one model — the per-step-tier wall-hit. v0.2 below closes this in a runtime-general way.)

---

## Golden example

`warble compile ./demo-agent -o ir.json` against the demo project in this repo must produce an
IR equal to `demo-agent/ir.golden.json` (committed alongside, used as the core's fixture test).

---

# v0.2 (proposed) — per-step tier as a runtime-general requirement

> Closes the per-step-tier wall-hit **without** leaking any runtime-specific concept into the IR.
> The word "subagent" never appears here; that is one back-end's *realization* of a generic need.
> Not yet wired into the built core/dispatcher (they emit/consume v0.1) — this is the agreed
> target shape.

**Insight:** the author declares only *each step's tier* (intent). Whether a step must become an
**isolated invocation** is a *runtime realization detail* decided by the target runtime's
capability — not an authoring concern, and not something the IR names.

## Two additions to the resolved IR

1. **`llm_calls[]` gains a named I/O contract + a per-step rendered `prompt`** so a step is
   realizable in isolation on any runtime (isolation severs shared context, so both the step's
   own instructions and its inputs/outputs must be explicit):

```jsonc
"llm_calls": [
  { "name": "plan_dashboard", "tier": "strong", "consumes": [],             "produces": "query_plan",
    "prompt": "<plan_dashboard.md rendered, placeholders substituted, no ## header>" },
  { "name": "compose_layout", "tier": "cheap",  "consumes": ["query_plan"], "produces": "dashboard_summary",
    "prompt": "<compose_layout.md rendered>" }
]
```
- `consumes`/`produces` are named slots only — no conditionals/loops (this lives inside component
  anatomy, not the profile composition layer, so invariant #3 holds). Absent `consumes` → `[]`;
  absent `produces` → `null`.
- `prompt` is the same substitution as `prompt_fragment` (`{{project}}`/`{{project_name}}`) but
  **per step and without** the `## <name>` header.
- **`prompt_fragment` (joined) stays** — it is what an in-loop runtime uses; `llm_calls[].prompt`
  is what a runtime that splits into isolated calls uses. One IR feeds both realizations.

Bump `warble_ir_version` to `"0.2"`.

2. **`required_capabilities` gains `llm:per_step_tier`** — the generic requirement "every LLM
   call must run at its declared tier." It never names a mechanism.

## Compile-time resolution against a target runtime (loud-fail, per §5 pattern)

| Runtime supports… | Realization |
| --- | --- |
| per-step tier natively (in-loop model switch) | run steps in-loop; I/O contract unused |
| only `isolated_invocation` (tier-bound sub-call) | realize each divergent-tier step as an isolated call; marshal via `consumes`/`produces` |
| neither, and the component has heterogeneous tiers | **compile-time loud fail** |

## Runtime-general realization (same IR, borrowed mechanisms)

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
