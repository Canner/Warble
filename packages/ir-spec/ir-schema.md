# Warble IR — the compile contract (`warble_ir_version: 0.6`)

The IR is the **language-neutral seam** between the Warble front-end (`warble compile`) and any
back-end. The v1 reference back-end is the Claude Code CLI target (`warble dispatch`, Rust); other
runtimes are other thin back-ends. Both sides depend only on this document — not on each other's
internals.

`warble compile <project-dir> -o ir.json` reads a Warble project (profile + components +
context binding) and emits **one** IR JSON document with `"warble_ir_version": "0.6"` — the
current, live contract the compiler emits today. (Earlier drafts of this doc kept the per-step-tier
shape in a separate "v0.2 (proposed)" section; that has been folded into the contract below now
that it is implemented and wired into the built core/dispatcher.) The shape below is what the
dispatcher consumes.

> Scope note (v0.3+): context binding is **fine-grained**. The host injects a `ContextLoader`
> selected for the binding kind, and the compiler **evaluates** every `context_precondition`
> against that bound context — not merely validates vocabulary membership. The IR records passing
> checks in `precondition_result.checks`; a Wren-project adapter also fills
> `context_binding.resolved` with metrics/dimensions/grains and lineage, while a raw-source adapter
> answers the constitutive probes and an external adapter emits no resolved block. A precondition
> that is answerable-and-false, or that the adapter **cannot answer** at all, is a
> loud compile-time fail — so an emitted IR only ever contains passing checks. See
> [`context_precondition`](#context_precondition-closed-predicate-vocabulary) and the
> [v0.3 binding](#v03--fine-grained-context-binding) section below.
>
> The coarse `context_binding.project` locator is **retained**: Wren-project back-ends use it to run
> `wren`, while other binding kinds give it adapter-specific meaning. Fine-grained binding is
> additive, not a replacement.

---

> **Umbrella model:** how the IR's declared capabilities are matched against a target runtime at
> dispatch (native / realize-via / degrade / fail) is defined in `capability-model.md`. The v0.3
> section below is a specific capability resolved under that model.

## IR version compatibility

`warble_ir_version` is a closed, exact-match contract, not a semver range: every back-end accepts
**only** the version(s) listed below and loud-fails naming both the rejected and the supported
version on anything else — there is no best-effort or partial parse of an unrecognized version.

| Consumer | Accepted `warble_ir_version` | Where the accepted version is declared |
| --- | --- | --- |
| `core` (`warble compile`) | emits `0.6` | the `"warble_ir_version"` literal in `core/src/compile.rs` |
| `dispatcher/claude-code-cli` | `0.6` | `SUPPORTED_IR_VERSION` in `dispatcher/claude-code-cli/src/ir.rs` |
| `dispatcher/vercel` | `0.6` | `SUPPORTED_IR_VERSION` in `dispatcher/vercel/src/emit.rs` |
| `dispatcher/claude-agent-sdk` | `0.6` | `SUPPORTED_IR_VERSIONS` in `dispatcher/claude-agent-sdk/src/ir.ts` |
| `dispatcher/codex-local` | `0.6` | `SUPPORTED_IR_VERSION` in `dispatcher/codex-local/src/ir.ts` |

Each back-end copies this value rather than importing it from `core` or from another back-end: a
back-end shouldn't need a Rust dependency edge just to know a version string, and independent copies
are what make the core-owned lockstep test below a meaningful check rather than a formality. (This is in the
same spirit as invariant 2 (zero-wren) in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md#invariants--preserve-these), though that invariant itself
only constrains what `core` and the components may depend on, not what depends on them.) Three of
the four back-ends (`vercel`, `claude-agent-sdk`, `codex-local`) also stamp the version onto emitted
artifacts as advisory `min`/`max` metadata — for example, the `vercel` bundle's own
`compat.min_ir_version` / `compat.max_ir_version`. The Codex manifest derives that advisory pair
directly from its enforcement constant instead of copying the value again. Artifact compatibility
is informational, not itself an input enforcement check.

`@warble/claude-agent-sdk` and `@warble/codex-local` additionally each declare a `peerDependencies`
entry on [`@warble/ir-spec`](../../packages/ir-spec) — a dedicated npm package whose own version *is*
the IR version (see [IR version to npm version mapping](#ir-version-to-npm-version-mapping) below) —
plus an advisory `"warble": { "irVersion": "0.6" }` field in the same `package.json`. This makes the
IR version a dispatcher speaks visible in the npm dependency graph without opening the package.
**Neither dispatcher imports `@warble/ir-spec`** — the peer is a declaration, not a dependency edge,
and each dispatcher keeps enforcing its own copy of `SUPPORTED_IR_VERSION`(S) above. `@warble/ir-spec`
also bundles this document itself (as `ir-schema.md`, alongside `index.js`/`index.d.ts`) as a frozen
snapshot for the IR version it publishes — a published npm version is immutable, so a snapshot as of
that version is worth more than a live link back to this file on `main`, which points at whatever the
spec later became. `just publish-check` fails if `packages/ir-spec/ir-schema.md` and this document
ever diverge, since a publish is exactly the point that drift becomes irreversible; re-sync it with
`cp docs/spec/ir-schema.md packages/ir-spec/ir-schema.md` whenever this document changes. Counting the
producer (what `core` actually emits) alongside every independent consumer/advisory copy, the
`@warble/ir-spec` package's own version, its `index.js` and `index.d.ts` version constants/literals,
both dispatchers' peer declarations, both dispatchers' advisory `warble.irVersion` fields, and the
spec title, there are **eighteen** locations that must agree:

| # | Location | Kind | Checked by |
| --- | --- | --- | --- |
| 1 | `core/src/compile.rs` — the `"warble_ir_version"` literal it emits | Producer | `core/tests/ir_version_lockstep_tests.rs` |
| 2 | `dispatcher/claude-code-cli/src/ir.rs` `SUPPORTED_IR_VERSION` | Enforcement | `core/tests/ir_version_lockstep_tests.rs` |
| 3 | `dispatcher/vercel/src/emit.rs` `SUPPORTED_IR_VERSION` | Enforcement | `core/tests/ir_version_lockstep_tests.rs` |
| 4 | `dispatcher/claude-agent-sdk/src/ir.ts` `SUPPORTED_IR_VERSIONS` | Enforcement | `core/tests/ir_version_lockstep_tests.rs` |
| 5 | `dispatcher/codex-local/src/ir.ts` `SUPPORTED_IR_VERSION` | Enforcement + manifest advisory source | `core/tests/ir_version_lockstep_tests.rs` |
| 6 | `dispatcher/vercel/src/emit.rs` `MIN_SUPPORTED_IR_VERSION` | Advisory | `core/tests/ir_version_lockstep_tests.rs` |
| 7 | `dispatcher/vercel/src/emit.rs` `MAX_SUPPORTED_IR_VERSION` | Advisory | `core/tests/ir_version_lockstep_tests.rs` |
| 8 | `dispatcher/claude-agent-sdk/src/manifest.ts` `MIN_SUPPORTED_IR_VERSION` | Advisory | `core/tests/ir_version_lockstep_tests.rs` |
| 9 | `dispatcher/claude-agent-sdk/src/manifest.ts` `MAX_SUPPORTED_IR_VERSION` | Advisory | `core/tests/ir_version_lockstep_tests.rs` |
| 10 | This document's title (`warble_ir_version: 0.6`) | Spec | `core/tests/ir_version_lockstep_tests.rs` |
| 11 | `packages/ir-spec/package.json` `"version"` (mapped `x.y` -> `x.y.0`) | Producer (npm) | `core/tests/ir_version_lockstep_tests.rs` |
| 12 | `packages/ir-spec/index.js` `IR_VERSION` | Advisory | `core/tests/ir_version_lockstep_tests.rs` |
| 13 | `dispatcher/claude-agent-sdk/package.json` `peerDependencies["@warble/ir-spec"]` (mapped `x.y` -> `x.y.x`) | Declaration | `core/tests/ir_version_lockstep_tests.rs` |
| 14 | `dispatcher/claude-agent-sdk/package.json` `warble.irVersion` | Advisory | `core/tests/ir_version_lockstep_tests.rs` |
| 15 | `dispatcher/codex-local/package.json` `peerDependencies["@warble/ir-spec"]` (mapped `x.y` -> `x.y.x`) | Declaration | `core/tests/ir_version_lockstep_tests.rs` |
| 16 | `dispatcher/codex-local/package.json` `warble.irVersion` | Advisory | `core/tests/ir_version_lockstep_tests.rs` |
| 17 | `packages/ir-spec/index.d.ts` `export declare const IR_VERSION` type literal | Advisory (type) | `core/tests/ir_version_lockstep_tests.rs` |
| 18 | `packages/ir-spec/index.d.ts` default-export `IR_VERSION` type literal | Advisory (type) | `core/tests/ir_version_lockstep_tests.rs` |

This table's scope is contract-bearing declarations — constants and literals something actually
compares against — not every place `warble_ir_version` appears in prose. Each back-end's `ir` module
doc comment also mentions the current version for a human skimming the file (e.g. `//! Typed view of
the Warble IR (warble_ir_version: 0.6)`); nothing checks those comments, and a version bump can leave
them stale without breaking anything. They are deliberately not extra rows — update them as a
courtesy to the reader, not because a test requires it.

`core/tests/ir_version_lockstep_tests.rs` is the sole cross-target lockstep owner: it text-parses
every contract-bearing declaration above and asserts that each equals the version core emits (rows
11–15 first pass the emitted version through the mapping below, since they are npm identifiers, not
copies of the raw `x.y` string). The target-local `ir_version_tests.rs` files only exercise their own
unsupported-version rejection and no-partial-output behavior; they do not scrape other targets'
sources. (`core/src/lib.rs`'s doctest and `core/tests/compile_tests.rs` also assert row 1's literal
directly, but aren't listed as separate lockstep-tested locations — they self-guard, failing the
moment `compile.rs` changes without a matching update there.) When `warble_ir_version` changes,
update all eighteen rows in the same change.

### IR version to npm version mapping

`@warble/ir-spec` is **not** version-locked to the Cargo workspace version (`0.4.0` and friends,
tracked separately — see [`RELEASING.md`](../../RELEASING.md#ir-version-vs-crate-version)); it moves
only when `warble_ir_version` moves, on its own release line. The mapping from IR version to npm
version is fixed and mechanical:

- IR version `x.y` maps to npm version `x.y.0` — the patch component is **always** zero.
- A dispatcher's `peerDependencies["@warble/ir-spec"]` range is `x.y.x` — e.g. IR `0.6` is npm
  version `0.6.0` and peer range `0.6.x`.
- An IR version with anything other than exactly two dot-separated numeric components (a three-part
  `x.y.z`, or a non-numeric component) has **no defined mapping** and is rejected by
  `core/tests/ir_version_lockstep_tests.rs` at the point it tries to compute rows 11, 13, and 15 — it
  panics rather than guessing a truncated or extended version.

This mapping is what a future releaser bumping `warble_ir_version` needs to reproduce by hand when
publishing the next `@warble/ir-spec` version (row 11) and updating both dispatchers' peer ranges
(rows 13 and 15) — see the bump procedure in [`RELEASING.md`](../../RELEASING.md).

### When `warble_ir_version` must change

Any change to the IR shape requires a version bump — **including a purely additive one** (a new
optional field, a new enum arm nothing yet emits, a key that quietly defaults when absent). This is
not a formality; it is the precondition for the exact-match policy above to mean anything.

An additive field shipped without a version bump is invisible to enforcement. A back-end built
against the previous shape keeps declaring the same `warble_ir_version`, so the version check passes
and the back-end never even notices a new field exists; an unrecognized key is dropped during
deserialization and the consumer behaves exactly as it did before. Nothing fails, loud or otherwise,
and there is no signal anywhere that the wire contract moved. The version bump *is* the mechanism
that turns "the IR grew" into an observable event. Skip it, and additive growth becomes undetectable
growth — the exact-match check has nothing left to compare against, because both sides still agree on
a version number that no longer describes the same contract.

Bumping unconditionally also keeps a retreat path open. Widening the accepted-version policy later —
for example, moving from a single exact version to an accepted range — is a non-breaking relaxation
of what is enforced today. Starting from a wide range and later narrowing it is a breaking change for
whoever came to depend on the wider behavior in the meantime. Exact-match is the strictest available
starting point, so keeping it strict now is what preserves the option to loosen it later without
having already given up the ability to say no.

None of this is free: a bump touches all eighteen places above — held together by the core-owned Rust
lockstep test — *and* it invalidates any artifact a consumer has already stored from a previous IR version — a
committed bundle or compiled snapshot built against the old version now names a version no current
back-end accepts, and must be regenerated rather than merely re-read.

## Top-level shape

```jsonc
{
  "warble_ir_version": "0.6",
  "profile": "orders-analytics",          // profile.yml `profile:`
  "context_binding": {                    // resolved from profile `context:` + context/binding.yml
    "project": "examples/jaffle-wren",    // coarse path to a wren project (retained for back-ends)
    "binding_mode": "runtime_selected",
    "resolved": {                         // v0.3 fine-grained binding — what the ContextLoader learned
      "metrics": [                        // declared cube measures + implicit numeric columns
        { "name": "total_revenue", "declared": true, "additivity": "additive" },
        { "name": "avg_order_value", "declared": true, "additivity": "non_additive" },
        { "name": "amount", "declared": false }        // implicit column: additivity not expressible
      ],
      "dimensions": [ { "name": "status", "temporal": false }, { "name": "order_date", "temporal": true } ],
      "time_dimensions": ["order_date"],
      "models": ["customers", "orders", /* … */],
      "lineage": { "nodes": 15, "edges": 12, "resolvable": true }   // summary only; full DAG stays in the adapter
      // when the project carries consumer artifacts, `lineage` additionally reports
      //   "consumers": { "queries": 2, "dashboards": 1 }            // query:/dashboard: node counts
      // and, when construction had to degrade (e.g. a consumer's SQL didn't parse),
      //   "diagnostics": ["query:broken: statement did not parse as SQL; …"]   // no silent caps
      // — both keys are ABSENT (not empty) on a project without consumers/degradations,
      // so pre-consumer IRs are byte-identical.
    }
  },
  "config": {},                           // reserved profile-level config block; no fields today
  "components": [ /* one resolved component node, see below */ ]
}
```

### `config` — emptied in 0.6

`config` carried one field, `tier_policy`, from the first IR through `0.5`. `0.6` removes it, and
the block is now emitted as `{}`.

`tier_policy` was a profile-wide tier stance (`cost_sensitive`) that the compiler was meant to
resolve into per-step tiers. Only the field ever landed. No back-end read it, its value was never
validated against any vocabulary, and compiling the same profile with `cost_sensitive`, `null`, or
an invented string produced byte-identical dispatch output — so a profile declaring it advertised
cost control it did not have.

It was removed rather than implemented because the rule it needs does not exist and the obvious
rule is measurably wrong: eval puts a blanket downgrade of `answer_query` at no accuracy cost and
~3× cheaper on a clean schema, and at 0.93 → 0.60 execution accuracy on a messy one. Which steps
are safe to downgrade is a property of the **bound context**, not of the profile, so a static
profile-level string cannot express it. Per-step `tier_overrides` on a mount remains the honest
control (see [`profile-schema.md`](./authoring.md#61-tiers-not-model-names)).

The block itself stays so that profile-level config which *can* be honored is an additive change
rather than the reintroduction of a removed key.

## Component node (resolved: component fields ⊕ supported profile mount fields)

```jsonc
{
  "id": "generate_dashboard",
  "verb": "generate_dashboard",
  "type": "analytical",                   // analytical | assertive | mutating | constitutive | orchestrating
  "realization_kind": "skill",            // required in component.yml; a profile mount may replace it
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
    // predicate must be from the closed vocabulary — see below. Compile validates membership AND
    // evaluates each predicate against the bound context via the injected ContextLoader.
  ],
  "params": [                             // always emitted, may be []
    { "name": "topic_default", "bind": "optional", "default": "overview" },  // profile-bound (bind)
    { "name": "connection", "source": "runtime-injected" }                    // runtime-injected, not in git
  ],
  "binds": {                              // additive; present only when >=1 bind-family param has a value
    "topic_default": "overview"           // mount didn't supply one, so this is the declared default
  },
  "precondition_result": {                // per-predicate evaluation outcome (v0.3, see §checks)
    "status": "pass",                     // always "pass" in emitted IR — a failing predicate loud-fails
    "checks": [                           // one entry per declared context_precondition, in order
      { "predicate": "has_metric", "outcome": "pass" },
      { "predicate": "has_groupable_dimension", "outcome": "pass" }
    ]
  },
  "brief": "…shared framing for every step, placeholders substituted…",  // additive; present only when authored — see below
  "prompt_fragment": "…rendered skill instructions…",  // see §prompt rendering
  "llm_calls": [                          // per-step tier, order preserved from component llm_steps
    { "name": "plan_dashboard", "tier": "strong", "conditional": false, "when": null,
      "consumes": [], "produces": "query_plan",
      "prompt": "<plan_dashboard.md rendered, placeholders substituted, no ## header>" },
    { "name": "compose_layout", "tier": "cheap", "conditional": false, "when": null,
      "consumes": ["query_plan"], "produces": "dashboard_summary",
      "prompt": "<compose_layout.md rendered>" }
    // a conditional step instead carries e.g. "conditional": true, "when": { "guard": "on_failure", "target": "generate_sql" }
    // — see `llm_calls[].when` below
  ],
  "guardrails": [                         // resolved; `locked` is the normalized lock-state
    { "name": "read_only_execution", "locked": true }
    // `scope`/`threshold` appear only when authored; their meaning is guardrail/target-specific,
    // e.g. another component may emit { "name": "artifact_write", "locked": true, "scope": "." }
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
may be `[]`.** `predicate` must be one of exactly eleven names:

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
| `source_introspectable` |
| `raw_docs_readable` |

`args` is optional per entry (predicate-specific, e.g. a metric/dimension name to check). An arg
value may be the literal to check, or a **bind reference** `"$param:<name>"` naming one of the
component's own `params[]` entries — compile substitutes it with that param's *effective* value
(the profile mount's supplied bind, or else the param's declared `default`; see
[`params`](#params) and [Resolution rules](#resolution-rules)) before evaluating the predicate.
`$param:<name>` naming a param the component doesn't declare is a loud compile-time fail (an
authoring bug, caught immediately rather than surfacing later as a confusing "unanswerable").
A declared param with no effective value (an unsupplied `bind: optional` param with no `default`)
makes the referencing precondition **unanswerable** — the same refuse-rather-than-guess outcome as
an unanswerable predicate, not a silent skip. The IR always carries the **resolved** value in
`context_precondition[].args`, never the unresolved `"$param:<name>"` template — a back-end reading
the IR never needs to know binding happened. Compile validates vocabulary membership (an unknown
predicate name is a loud fail) **and evaluates each predicate against the bound context** through
the injected `ContextLoader`. Evaluation has three outcomes:

- **pass** — the predicate holds; recorded in `precondition_result.checks`.
- **fail (answerable-and-false)** — the predicate is answerable but does not hold → loud compile
  fail (`… not satisfied by the bound semantic layer`).
- **unanswerable** — the active adapter cannot express the answer → a *different* loud fail
  (`… cannot be evaluated …`), never a silent false. `metric_additive` is unanswerable without a
  declared metric; a pinned `model_has_timestamp` is unanswerable when its model is undeclared; and
  the two raw-shape predicates are unanswerable on adapters that cannot probe raw input.

`metric_additive` is the one semantic predicate. **Existential by default** (no `args`): it passes
iff the layer declares at least one additive metric, fails if declared metrics exist but none are
additive, and is unanswerable if no declared metric exists at all. **Pinned** (`args: { metric:
<name> }`): the named metric must be a declared measure — additive → pass, non-additive → fail, not
declared → unanswerable. The per-metric decision a general component needs at *run* time (which
metric did the user pick?) stays a runtime guard; compile time proves a valid target exists and that
additivity is decidable in this Context.

`model_has_timestamp` follows the same existential/pinned shape. **Existential by default** (no
`args`): passes iff *any* declared model has a timestamp column, never unanswerable (a project with
zero models still has a well-defined — false — answer). **Pinned** (`args: { model: <name> }`,
typically via `$param:` against a `bind`-family param naming a model): the named model must be
declared — has a timestamp → pass, no timestamp → fail, not a declared model at all →
unanswerable. This is what makes `binding_mode: pinned` meaningful for a component like
`monitor_freshness`: binding the component to a specific, timestampless model is caught at compile
time instead of failing confusingly at run time.

`source_introspectable` and `raw_docs_readable` are the constitutive raw-shape predicates. A
`RawSourceContext` answers them with `Some(true)` (pass) or `Some(false)` (answerable fail);
MDL-only and external adapters return `None` (unanswerable), which is a loud compile failure rather
than a guessed false. They are used with a `kind: raw_source` binding before an MDL exists.

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

#### `binds`

An object, **additive: present only when the component has at least one `bind`-family param with
an effective value; omitted entirely otherwise** (no empty `{}`). Keys are param names; values are
each param's *effective* value — the profile mount's supplied bind, or else the param's declared
`default` when the mount didn't supply one. `source: runtime-injected` params are never included
(their value doesn't exist until dispatch/run time). This is the one place in the IR a back-end (or
a human reading `ir.json`) can see, without cross-referencing `profile.yml`, exactly what a
component was bound to at compile time — the same map compile itself uses to resolve `$param:`
references in `context_precondition[].args` (see above), so the two are always consistent with each
other by construction.

```jsonc
"params": [
  { "name": "model", "bind": "required" },
  { "name": "expected_cadence", "bind": "optional", "default": "24h" }
],
"binds": { "model": "orders", "expected_cadence": "24h" }
// "model" came from the profile mount's `bind:`; "expected_cadence" fell back to its default
// because the mount didn't supply one.
```

#### `llm_calls[].conditional`

A boolean, **always emitted, defaults to `false`.** It marks a step that only runs sometimes; *why*
it's conditional is carried separately in `when` (below), not in this flag. The composition layer
stays declarative: `conditional`/`when` name a closed-vocabulary guard, never a condition
expression — the actual mechanics of what to do (retry, skip, escalate) live inside the step's own
hook/prompt, never in the profile/composition layer. This keeps invariant #3 (the composition layer
never grows a data-flow DSL) intact.

#### `llm_calls[].when` (closed guard vocabulary, additive since v0.3)

`{ "guard": <name>, "target": <string> }`, or `null` — **always emitted as a key** (present with a
`null` value when the step isn't conditional, mirroring `produces`'s always-present-key style; never
omitted). `guard` must be one of exactly three names:

| `guard` | `target` | Meaning |
| --- | --- | --- |
| `on_failure` | an upstream step name | Runs only if that step failed |
| `on_flag` | a dotted `artifact.field` | Runs only if that boolean field on a produced artifact is true |
| `on_missing` | an artifact name | Runs only if that artifact was not produced |

Compile enforces the full `(conditional, when)` matrix as a loud fail:

- `conditional: true` with no `when` — refused; bare `conditional: true` no longer implies a
  condition.
- `when` present without `conditional: true` — refused; a guard with nothing to guard is refused
  rather than silently ignored.
- an unknown `guard` name, an empty `target`, or an `on_flag` target with no `.` — all refused.

This shape was introduced as part of the `0.3` IR contract. Whether — and how — a back-end realizes
`when` is a per-back-end decision, not a schema requirement; any future shape change still requires
an IR version bump under the policy above. As of this writing:

- `dispatcher/vercel` realizes it as one of two well-defined shapes: an `on_failure` guard
  targeting the immediately-preceding call folds into that call's own bounded repair loop; every
  other guard in the closed vocabulary is an independent step whose guard the bundle *consumer*
  evaluates deterministically at runtime (see `dispatcher/vercel/src/classify.rs`). A `when`/
  `conditional` shape outside the closed vocabulary — an unrecognized guard name, or `conditional`
  and `when` disagreeing about whether a guard exists — fails loudly at emit time rather than
  being silently folded into either shape.
- `dispatcher/claude-agent-sdk` realizes it at runtime via a hybrid-staged executor (see
  `dispatcher/claude-agent-sdk/src/run.ts` / `conditional.ts`).
- `dispatcher/claude-code-cli` does not yet realize it — this back-end has no deterministic
  runtime to evaluate a guard against, so it still treats `conditional` as an opaque flag and
  tolerates `when` without acting on it (see `dispatcher/claude-code-cli/src/ir.rs`).

A back-end that ignores `when` must do so as a documented, deliberate choice (as `claude-code-cli`
does above) — never as a silent fallback for a guard shape it was simply never taught to recognize.

#### `guardrails[].scope` / `threshold` and the `locked`/`overridable` normalization

`scope` and `threshold` are passthrough fields — each is present in the resolved IR **only when
authored** on the component. Their meaning is selected by `name` and the target: for example,
`artifact_write.scope` and `context_write_authz.scope` define distinct path boundaries, while a
threshold is guardrail-specific structured policy. The compiler preserves these values but does
not itself validate path containment or assign a universal meaning to every scope; a target that
claims support must consume the relevant field at its enforcement seam. Dropping a scope from a
scoped write guardrail widens the represented write boundary and is not a semantics-preserving
fallback. Both fields are omitted when not authored.

Authoring may declare `locked` and/or `overridable` on a guardrail, but the **IR only ever emits
`locked`** as its normalized lock-state. It is the single source of truth for whether a guardrail
is locked, while downstream consumers may also inspect the guardrail's `name`, `scope`, and
`threshold` to select and configure enforcement. At compile:

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

#### `brief` (additive since v0.5)

Optional free-form text, authored on the component (or replaced wholesale by a profile mount, see
[`profile-schema.md`](./authoring.md#3-profile--bind-a-harness-to-a-context)) and rendered with the
same `{{project}}` / `{{project_name}}` placeholder substitution as step prompts (§Prompt
rendering). Emitted **once, on the node itself** — never per-step — and present in the IR only when
authored; a component with no `brief` produces IR byte-identical to before this field existed.
Every back-end that assembles a system prompt places it in the same position: after the
machine-generated preamble, before the body, on both the driver and every subagent. See
[`profile-schema.md`](./authoring.md#brief--authored-framing-shared-across-every-step) for the
authoring rule, the token-cost note, and the eval-invalidation note.

#### `description` / `examples` (additive, optional)

`description` is a string and `examples` a list of strings, both authored on the component and both
emitted onto the node only when authored and non-empty. They are part of the first released `0.5`
contract; a component with neither omits both fields. That omission preserves the compact serialized
shape, but does not relax the rule above: any future change to these fields' IR shape requires a
version bump.

Unlike `brief` they take **no placeholder substitution**: they describe the component to whoever is
choosing between components, and a description that only reads correctly once a project is bound
cannot serve a skill list published to another agent.

Both are validated at compile time rather than shipped broken: a `{{...}}` placeholder in either
field, or `examples` with no `description` (which every consumer reaches *through* the description),
is a loud failure.

Consumers are selectors, never the running agent's behavior: a back-end applies `description` to the
agent that *is* the component (including a per-step-split driver, whose internal subdivision is not
what the component is for) and leaves everything inside the component — per-step subagents and a
context-isolation child alike — its own internally-scoped line. Absent, a back-end synthesizes a line
from the node's shape instead. See
[`profile-schema.md`](./authoring.md#description--examples--what-the-component-is-for).

---

## Resolution rules (front-end `warble compile` must implement)

1. **Parse** `profile.yml`, each mounted `components/<id>/component.yml`, and `context/binding.yml`.
   Each `component.yml` is checked against `deny_unknown_fields` (applies to `component.yml` only,
   not `profile.yml` / `context/binding.yml`): an authoring field the schema
   does not recognize is a loud compile-time fail (never silently ignored).
2. **Merge** `IR.node = component fields ⊕ supported profile mount fields`:
   - `profile.components[].config` is accepted by the parser but ignored by the compiler; it does
     not override defaults, cadence, thresholds, or any other behavior.
   - `profile.components[].tier_overrides.{step}` overrides that step's `tier` in `llm_calls`.
   - `realization_kind`: the component's required authored value unless the profile mount replaces it.
3. **Fill required binds**: every component `params[].bind: required` must be supplied by
   `profile.components[].bind`. Missing → **compile error** (loud fail). Then **resolve effective
   binds**: for every `bind`-family param (required or optional), its effective value is the
   mount-supplied bind, or else the param's declared `default`, or else absent (only possible for
   `bind: optional` with no `default`). This effective-binds map feeds both the IR's additive
   `binds` facet (§`binds`, emitted only when non-empty) and the next step.
4. **Resolve `$param:<name>` references and evaluate `context_precondition`**: every entry's
   `predicate` must be a member of the closed eleven-name vocabulary (unknown → loud fail). Before
   evaluation, any `args` value of the form `"$param:<name>"` is substituted with that param's
   effective value from step 3 — `<name>` not naming a declared param → **compile error** (loud
   fail); naming a declared param with no effective value → the precondition is **unanswerable**
   (below), not silently evaluated against a missing value. The IR's `context_precondition[].args`
   always carries the **resolved** value, never the `"$param:<name>"` template. The predicate is
   then **evaluated** against the bound context via the injected `ContextLoader`:
   answerable-and-false → loud fail; unanswerable (`can_answer=false`) → a distinct loud fail; pass
   → recorded in `precondition_result.checks`.
5. **Validate `params` shape**: each entry must declare exactly one of `bind`/`source`; `source`, if
   present, must be `"runtime-injected"`. Violations → **compile error** (loud fail).
6. **Normalize `guardrails[].locked`**: resolve authored `locked`/`overridable` down to a single
   `locked` boolean per the rule above; contradictory or absent declarations → **compile error**
   (loud fail).
7. **context_binding**: `project` = resolved path from `context/binding.yml` `project:`
   (kept as-authored: relative paths stay relative to the project-dir). `binding_mode` from component.
   (v0.3) `resolved` = the fine-grained block the `ContextLoader` produces from MDL introspection
   (metrics/dimensions/grains + lineage summary). The coarse `project` path is retained alongside it.
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
| unparseable context | the bound project does not assemble/parse (coarse floor) | `context precondition failed: bound project '<path>' is not a parseable wren project …` |
| unknown precondition predicate | `context_precondition[].predicate` not in the closed 11-name vocabulary | `unknown context_precondition predicate '<name>' on component '<id>' …` |
| precondition not satisfied | a predicate is answerable but evaluates false against the bound context | `context precondition '<name>' not satisfied by the bound semantic layer for component '<id>'` |
| precondition unanswerable | the adapter cannot express the answer (e.g. `metric_additive` with no declared metric, a raw-shape predicate on an MDL-only adapter, or a `$param:` reference with no effective value) | `context precondition '<name>' … cannot be evaluated … Refusing rather than answering wrongly.` |
| `$param:` references an undeclared param | a `context_precondition[].args` value is `"$param:<name>"` and `<name>` is not one of the component's own `params[]` | `precondition arg '<key>' on component '<id>' references '$param:<name>', but '<name>' is not a declared param of this component` |
| param bind/source exclusion | a `params[]` entry declares both `bind` and `source`, or neither | `param '<name>' must declare exactly one of 'bind' or 'source' for component '<id>'` |
| unknown param source | `params[].source` present but not `"runtime-injected"` | `unknown param source '<value>' for param '<name>' on component '<id>'` |
| contradictory/absent guardrail lock state | a `guardrails[]` entry declares neither `locked` nor `overridable`, or declares both with conflicting values | `guardrail '<name>' on component '<id>' must declare exactly one (agreeing) of 'locked'/'overridable'` |
| unknown authoring field | `component.yml` (the `ComponentFile` and its nested structs) contains a field the schema does not recognize | `unknown field '<name>'` (serde `deny_unknown_fields`) — note: applies to `component.yml` only in this phase, not `profile.yml` / `context/binding.yml` |
| conditional step missing `when` | `llm_steps[].conditional: true` with no `when` | `conditional step '<name>' on component '<id>' has no 'when' guard — …` |
| `when` guard without `conditional` | `llm_steps[].when` present but `conditional` is not `true` | `step '<name>' on component '<id>' declares a 'when' guard but is not 'conditional: true' …` |
| unknown `when` guard name | `llm_steps[].when.guard` not in the closed 3-name vocabulary (`on_failure`/`on_flag`/`on_missing`) | `unknown guard '<name>' in step '<step>' of component '<id>' …` |
| `when` guard invalid target | `llm_steps[].when.target` is empty, or `guard: on_flag` with a non-dotted target | `guard '<name>' in step '<step>' of component '<id>' has an empty target` / `… expects a dotted 'artifact.field' target …` |

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
`warble compile ./examples/render-demo -o ir.json` similarly must equal
`examples/render-demo/ir.golden.json`. Both goldens use the current v0.6 contract:
`context_requirements`, `context_precondition`, and `params` are always present (possibly `[]`, as
on `dashboard`), while `eval` appears only on `generate_dashboard` and `scope: "."` appears only on
render-demo's authored `artifact_write` guardrail.

---

## v0.3 — fine-grained context binding

Where v0.2 carried a coarse project path and *declared* preconditions, v0.3 made the front-end
**probe the bound context**. A host injects a `ContextLoader` (the trait lives in core, sans-IO).
The same binding crate now supplies `MdlContext` for Wren projects and `RawSourceContext` for raw
constitutive input; hosts may supply other adapters.

## What lands in the IR
- For a Wren project, `context_binding.resolved` carries the compiler's introspection result: `metrics`
  (`{name, declared, additivity?}` — a declared cube measure carries inferred additivity; an
  implicit numeric column does not), `dimensions` (`{name, temporal}`), `time_dimensions`, `models`,
  and a `lineage` summary (`{nodes, edges, resolvable}`, plus optional `consumers` counts and
  `diagnostics` — see `blast-radius.md` §3; both keys are omitted when empty). The full lineage DAG
  stays in the adapter; the IR carries only the summary. A raw-source adapter emits an empty
  semantic inventory while answering its raw-shape probes; an external adapter omits `resolved`.
- `precondition_result.checks` — one `{predicate, outcome}` per declared precondition, all `pass`
  (a non-pass loud-fails before emit).

## Predicate evaluation
The eleven predicates evaluate **loose for existence, strict for semantics**: `has_metric` /
`has_*_dimension` / `model_has_timestamp` are satisfied by a matching cube member *or* a plain model
column (so a cube-less project can still answer data questions), while `metric_additive` is
answerable only over a declared metric (see the `context_precondition` section above). This is why
`examples/jaffle-wren` gained a `revenue` cube — it gives the layer a declared, additive metric so
`metric_additive` is decidable. `source_introspectable` and `raw_docs_readable` instead probe a raw
source through `RawSourceContext`; an MDL-only adapter returns unanswerable for both.

## `blast_radius` (read path)
The adapter self-builds a lineage DAG (`model → relationship / cube → metric / dimension`, plus view
references), and core computes `LineageGraph::blast_radius(node)` = the transitive downstream closure
+ worst `Severity` (`Semantic > Structural > Compatibility > None`). This is exposed as read-only
analysis on the read path, and the same query also serves as an enforcement gate for *mutating*
applies. This is the one `provided_by: warble`
capability — see `capability-model.md` §6/§7.1, whose coarse-binding loud-fail is now lifted because
fine-grained binding exists.

---

## v0.3 — render contract (typed blocks + renderer registry)

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
  { "type": "kpi_card",  "fields": { "label": "string", "value": "number|string", "unit": "string?", "delta": "number?" } },
  { "type": "table",     "fields": { "columns": "string[]", "rows": "row[]" } },
  { "type": "chart",     "fields": { "chart_type": "bar|line|pie|area|scatter", "x": "string", "series": "string[]", "rows": "row[]" } },
  { "type": "narrative", "fields": { "title": "string?", "text": "string" } },
  { "type": "diff",      "fields": { "path": "string?", "diff": "string" } }
]
```

The `diff` block is the stdlib block for a **mutating** component's dry-run proposal (added for
`edit_pipeline`): the target `path` and the raw unified-`diff` text, rendered HTML-escaped
inside a `<pre>` (never re-parsed as markup). It is the presentational facet of the change a reviewer
approves — it does not itself apply anything.

The `narrative` block is the stdlib text/prose block (added for `explain_change`, whose output is a
data-native explanation, not a chart). The reference renderer emits an optional `title` heading plus
the escaped `text` body (blank lines → paragraphs); it is deliberately minimal — prose, not a
rich-markdown surface. A component whose output is an explanation declares `render_blocks:
[narrative]`; because both back-ends render through `warble render`, no per-back-end renderer change
is needed.

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

### Provenance: `verified` and per-block `definition`

Two optional additions to the envelope let a reviewer check a rendered answer against its source
instead of trusting the prose alone:

- **`verified` (envelope-level boolean, optional)** — whether the agent actually ran the query it is
  reporting on (via the `wren` CLI) versus recalling/estimating a figure. Absent means unknown, not
  false; a component whose steps always execute before rendering may set it unconditionally.
- **`definition` (per-block, optional)** — attached to a data-bearing block (typically `kpi_card` or
  `table`) to carry how the number was produced: `{ "sql": "...", "source_tables": ["..."],
  "filters": ["..."] }`. This is presentational provenance for the renderer to show alongside the
  block (e.g. an expandable "how was this computed" panel) — it does not feed back into computation
  and is not itself re-executed.

Both are additive optional fields on the existing envelope/block shapes above, not a new block type;
a renderer or consumer that doesn't recognize them ignores them.

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
enforcement points** (see [`enforcement-seam.md`](./enforcement-seam.md)):
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
