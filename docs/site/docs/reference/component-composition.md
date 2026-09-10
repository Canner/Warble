---
title: "Component composition"
description: "The specified same-profile component-call contract — authorization, identity, entry visibility, isolation, normalized results, budgets, and target support."
---

<!-- @generated from docs/spec/component-composition.md by scripts/gen-reference.mjs — do not edit; edit the spec and re-run `npm run gen:reference` -->

This document defines how one component may invoke another component mounted in the **same
profile**. It is an authoring, compile, preparation, and runtime contract; it is not a workflow
language and it does not make a profile callable.

> **Status: compiler, closure preparation, and the first Agent SDK runtime realization are
> implemented in IR v0.8.** The compiler accepts `components[].entrypoint` and `llm_steps[].component_calls`,
> validates the materialized graph, and every shipped reader retains the resulting fields. Scoped
> preparation resolves only the selected root's transitive closure; whole-profile inspection reports
> selectable entries, internal mounts, dependencies, closure availability, and the target's invocation
> realization. `claude-agent-sdk:local` executes the deliberately narrow first slice through
> dispatcher-owned, step-scoped fresh child runs. Other shipped targets still wall-hit instead of
> dropping or inlining an edge.

The design has three separate axes:

1. **authorization** — a step declares which mounted components it may call, under local aliases;
2. **entry eligibility** — a mount declares whether a caller may start it directly;
3. **realization** — a target decides whether it can enforce the call with isolated authority.

Keeping them separate preserves the existing model: a profile is a materialized governed scope, a
component is a callable behavior, and a caller or session chooses the entry form.

## 1. Authoring contract

`component_calls` is an optional list on one `llm_steps[]` entry:

```yaml
# components/dashboard/component.yml
id: dashboard
verb: dashboard
type: analytical
realization_kind: skill

llm_steps:
  - name: plan_dashboard
    tier: strong
    prompt_ref: steps/plan_dashboard.md
    produces: dashboard_plan
  - name: compose_dashboard
    tier: strong
    prompt_ref: steps/compose_dashboard.md
    consumes: [dashboard_plan]
    component_calls:
      - alias: answer
        component: answer_query

required_capabilities:
  - llm:strong
guardrails:
  - { name: read_only_execution, locked: true }
trigger: { kind: one_shot }
effect: { render_blocks: [], outcome: { kind: none } }
```

The profile mounts both components. A mount may separately opt out of direct entry:

```yaml
components:
  - use: dashboard
  - use: answer_query
    entrypoint: false
```

Each call declaration has exactly two fields:

| Field | Contract |
| --- | --- |
| `alias` | A step-local name matching `[a-z_][a-z0-9_]*`. It is unique within that step and is the only callee name exposed to that step at runtime. |
| `component` | The exact `use` identity of one component mount in the materialized profile. It is static authoring data; the model cannot supply or rewrite it. |

`component_calls` is the complete machine-checked allowlist for that step. The step's rendered
`prompt_ref` decides **when**, **how many times**, and **with what request** to use an authorized
alias. Putting a component id only in prompt prose grants nothing. Conversely, declaring an edge
does not schedule it: a run may take the edge zero, one, or several times, subject to the root
budget.

The runtime exposes only the alias. The request payload contains no component id, mount id, model,
tool, capability, or target mechanism, so model output cannot redirect a call.

### 1.1 This does not extend step artifact flow

`consumes` and `produces` retain their existing meaning: ordered, named artifacts between steps of
**one component invocation**. They never name another component, create a component edge, carry a
child transcript, or imply that a child runs.

Component-call ordering, repetition, and choice stay in the caller step's prompt and runtime
interaction. The profile and IR gain no loop, branch, join, fan-out, or scheduling syntax. A
conditional step contributes all of its declared call edges to static validation even when its
`when` guard may skip the step at runtime.

## 2. Mounted identity and overlays

The first implementation deliberately supports **one mount per component id per materialized
profile**. `components[].use` is both source lookup and mounted identity. Compiling two mounts with
the same `use` is a loud error; there is no implicit instance number and no "first/last mount wins"
rule.

This constraint is narrower than a general mounted-instance model and keeps every current surface
consistent:

- `component_calls[].component` resolves to exactly one mount;
- direct component selection and manifest identity keep using the existing component id/verb;
- an overlay `mount` adds one identity and may set its `entrypoint` and binds;
- an overlay `unmount` removes that identity before graph validation;
- an overlay bind patch changes only that mount's effective bind values. It cannot retarget a call,
  change the caller's allowlist, or change entry eligibility.

After the complete overlay is applied, the compiler re-runs uniqueness, alias, target, and graph
checks. Removing a mount that a surviving step references is therefore a compile error naming the
caller step, alias, and missing mount. An overlay never auto-mounts a referenced component. A
callee runs with its own effective binds after overlay application; caller binds are neither
inherited nor supplied as overrides.

Supporting repeated mounts later requires a distinct, explicit mounted-instance identity across
profiles, overlays, IR, manifests, entries, traces, output naming, and call targets. It cannot be
introduced by relaxing the duplicate check.

## 3. Entry eligibility is not call eligibility

`components[].entrypoint` is an optional mount boolean. Its default is `true`, preserving the
meaning of profiles authored before the field exists.

| Surface | `entrypoint: true` | `entrypoint: false` |
| --- | --- | --- |
| direct component dispatch | eligible | rejected before execution |
| caller-declared `agent` entry | eligible | rejected before execution |
| caller-declared `scope` inventory/delegation | advertised and selectable | omitted from the selectable inventory |
| manifest/display | present, marked entry-eligible | present, marked callee-only |
| `component_calls` target | eligible | eligible |

Entry eligibility is orthogonal to the caller-declared native session entry kind. `agent` still
pins one entry; `scope` still starts at the profile scope and lets the driver select among the
advertised entries. Neither entry kind is inferred from call edges, and a callee-only mount does
not create a new entry kind.

Callability also does not imply invisibility. A shared component may remain `entrypoint: true` and
also be the target of several call edges. Authors use `false` only when direct entry would be an
invalid product surface, not merely because another component reuses it.

A scoped run prepares the union of the transitive closures of every entry it advertises. A pinned
run prepares only the selected entry's closure. A whole-profile manifest reports every mount and
each entry's availability/closure, but display preparation is not an executable plan and cannot be
passed to a runner without executable preflight.

## 4. Static call graph

Compilation constructs a directed graph over mounted identities. For every
`llm_steps[].component_calls[]` entry it adds `caller component -> callee component`, including
edges declared on conditional steps.

Compilation loud-fails on:

- a duplicate mount identity;
- a duplicate alias within one step;
- an alias or component value that is empty or syntactically invalid;
- a callee absent from the post-overlay profile;
- a self-edge; or
- any directed cycle.

Cycle diagnostics contain one complete closed path, for example
`dashboard -> answer_query -> dashboard`. The traversal is deterministic by profile, step, then
declaration order so the same input yields the same diagnostic.

A diamond and shared leaves are valid: `A -> B`, `A -> C`, `B -> D`, `C -> D` is not a cycle.
Several aliases, including aliases on different steps, may target the same callee. Static edges are
authorization possibilities, not invocation counts, so calling a previously completed callee
again is valid and starts a fresh invocation.

## 5. Preparation and transitive readiness

Preparation produces two distinct collections:

```text
entry plans          roots that this operation may start
prepared callees     immutable mount records addressable only through authorized edges
```

Reachable callees are never appended to the entry-plan list and never started merely because they
were prepared. A mounted component may appear in both collections when it is entry-eligible and
also called by another entry, but each invocation still has exactly one parent except for the root.

For a selected entry, preparation follows the complete transitive graph and resolves **exactly**
that closure. Every reachable node must be ready before the root model starts:

- context binding and preconditions;
- effective mount binds;
- every step's tier-to-model/provider binding;
- selected slot variants;
- assets and their integrity/path constraints;
- explicit and implied capabilities;
- guardrail and effect enforcement;
- call eligibility and target support; and
- request/result limits and a root budget ledger.

An unreachable sibling with a missing model, slot, asset, capability, guardrail realization, or
context requirement does not block a pinned dispatch. A scope entry resolves the union of all
advertised entries' closures because the driver may choose any of them. Whole-profile emitters keep
their existing all-profile atomicity, but an executable target that cannot realize any reachable
call edge must wall-hit rather than emit a partially working scope.

The prepared registry is immutable for one root run. Every hop resolves its callee from that
registry; no runtime source lookup, overlay mutation, auto-mount, or late capability widening is
permitted.

## 6. Target-neutral request and result envelopes

The logical invocation boundary transports JSON, not transcripts or runtime objects.

### 6.1 Request

```jsonc
{
  "request": "Answer the revenue question needed for the first dashboard panel.",
  "input": {
    "question": "What was net revenue last month?",
    "panel": "net_revenue"
  }
}
```

- `request` is a required, non-empty UTF-8 string.
- `input` is an optional JSON object; absent normalizes to `{}`.
- The caller transcript, hidden reasoning, tool state, artifacts, and environment are not inherited.
  Anything the callee needs from the caller must be copied deliberately into `input`.
- Alias-to-callee binding is host state and is never accepted from this payload.
- The first slice caps the UTF-8 JSON serialization at **65,536 bytes**. Oversize requests are
  rejected before a child starts; they are never truncated.

The callee receives its own compiled prompt/brief, profile context, binds, slots, assets, model,
capabilities, and guardrails plus this request. It does not receive the caller's authorities.

### 6.2 Success

A successful call has one of two output kinds:

```jsonc
{
  "status": "ok",
  "output": {
    "kind": "value",
    "value": {
      "columns": ["month", "net_revenue"],
      "rows": [["2026-08", 42000]],
      "summary": "Net revenue was 42,000.",
      "verified": true,
      "definition": { "sql": "...", "source_tables": ["orders"] }
    }
  },
  "provenance": {
    "verified": true,
    "definition": { "sql": "...", "source_tables": ["orders"] }
  }
}
```

`kind: value` preserves a non-rendering component's terminal JSON value unchanged. This directly
supports the existing tabular terminal shape `{columns, rows, summary, verified, definition}`
without a component-id special case. When the value is an object with standard `verified` and/or
`definition` members, normalization copies them to the outer `provenance` field while preserving
the original value.

A component with non-empty `effect.render_blocks` instead returns:

```jsonc
{
  "status": "ok",
  "output": {
    "kind": "render",
    "blocks": [{ "type": "table", "columns": ["month"], "rows": [["2026-08"]] }],
    "summary": "One verified panel."
  },
  "provenance": { "verified": true }
}
```

The child's render envelope is validated generically against the callee's own
`effect.render_blocks`. Per-block `definition` stays on its block. The child does **not** run a
renderer or write an artifact; the validated envelope becomes a value in the caller run. Only the
root invocation may choose a render flavor and persist the final result.

The first slice caps the complete normalized result at **1,048,576 UTF-8 JSON bytes**. A larger or
non-conforming value becomes `invalid_result`; it is never partially returned or truncated.

### 6.3 Refusal and error

Refusal is a valid, non-success result and is never converted into prose success:

```json
{ "status": "refused", "code": "callee_refused", "message": "The request is outside the bound context." }
```

Execution/contract failure uses a stable envelope:

```json
{ "status": "error", "code": "transient_transport", "message": "The child run did not complete.", "retryable": true }
```

The initial cross-target code vocabulary is:

| Code | Retryable | Meaning |
| --- | --- | --- |
| `unauthorized_call` | no | the active step has no prepared edge for the alias |
| `unsupported_callee` | no | callee shape or target realization is unavailable |
| `invalid_request` | no | malformed or oversize request |
| `invalid_result` | no | malformed, oversize, or contract-invalid child output |
| `budget_exhausted` | no | admission would exceed a root limit |
| `cancelled` | no | root or ancestor cancellation won the completion race |
| `transient_transport` | yes | an admitted child failed before producing a result and retry is safe |
| `callee_failed` | no | the child completed unsuccessfully for a non-transient reason |

Messages are bounded, sanitized explanations. Provider errors, paths, prompts, stack traces, tool
arguments/results, SQL, secrets, and raw child output never cross this boundary.

## 7. Eligible callees: deliberately narrow first slice

`effect.outcome.kind: none` alone is not evidence that a component is side-effect free. A callee is
eligible only when the target can enforce every row below:

| Facet | First-slice eligible shape | Everything else |
| --- | --- | --- |
| trigger | `one_shot` | `scheduled` / `event` loud-fail `unsupported_callee` |
| realization | `skill` | `tool` / `gated-tool` loud-fail |
| outcome | `none` | `assertion` / `mutation` / `dispatch` loud-fail |
| data authority | read-only, under `read_only_execution` | raw/unrestricted or write authority loud-fail |
| writes | no `artifact_write`, `data_write`, `context_write`, or `setup_execution` | loud-fail before the root model starts |
| render | structured `render_blocks` may return as data; no prompt-render or child renderer | any child-owned render/write path loud-fails |
| actions/transport | no borrowed action, external transport, approval channel, scheduler, or event bus | loud-fail |
| nested calls | allowed only through the same prepared DAG and ledger | ad hoc dispatch or external profile call loud-fails |

Targets may support a smaller subset and wall-hit. They may not infer safety from a component name,
special-case a known family, silently inline a prompt, drop an edge, or claim success while ignoring
the call.

## 8. Capability and authority isolation

A non-empty `component_calls` list implies the target-neutral capability
`component_invocation`. The compiler adds it to the component's and declaring step's effective
capability requirements even when the step authors a narrower `capabilities` list. Authors need
not duplicate it; an explicit duplicate is de-duplicated and grants nothing extra. A profile
`capability_ceiling` must include the implied capability or compilation fails. Its target-profile
contract is:

- `provided_by: runtime`;
- criticality `required`;
- resolution `native` or `realize-via` only when the target supplies the trusted handler described
  here; and
- no `degrade` outcome.

Each callee is resolved independently with its own capabilities and enforcement floor. Its tools,
model, guardrails, context, slots, assets, and authority are never unioned into the caller. The
caller step receives only its own resolved surfaces plus its declared call aliases.

Isolation is checked against **effective authority**, not capability-string absence. A target whose
`genbi_build` and `sql_execution:read_only` both map to the same unrestricted command surface has
not removed SQL authority by deleting one string. Target preparation must classify the authority
of each realization and either provide a genuinely non-SQL projection for the caller or wall-hit.

The required negative conformance test attempts direct SQL from the caller through every granted
surface, including alternate capability realizations, and proves denial while the independently
prepared callee can execute its authorized read-only query. Inspecting `required_capabilities`
alone is not evidence.

## 9. Runtime authorization and Agent SDK realization

Every runtime call is authorized by the tuple:

```text
(root run id, trusted active step id, declared alias) -> prepared callee mount
```

The active step id comes from the dispatcher's immutable execution plan. A model-supplied step
name, prompt text, request field, tool argument, transcript marker, or child claim is untrusted and
cannot select the allowlist. Execution modes that cannot bind an invocation surface to a trusted
active step must reject the composed entry during preflight.

The first Agent SDK realization is dispatcher-owned. Each logical component call starts a **fresh,
non-resumed child `query()`** from the prepared callee record. It does not use nested vendor
Task/Subagent delegation, read a child transcript file, resume the parent session, or add the
callee's tools to the caller. Child execution is separated from the existing root
render/persistence path: it creates no result file, trace file, output directory, or rendered
artifact of its own.

Before every hop, including object IR supplied by a library caller, the runtime rechecks:

1. the IR version and complete call structure were validated for executable preparation;
2. the active step id belongs to the running prepared node;
3. the alias maps to an immutable edge from that exact step;
4. `component_invocation` is present in the effective requirement and realized by this target;
5. the callee is in the prepared closure; and
6. the callee is not already in the active ancestry stack.

The ancestry check protects against forged or corrupted IR even though valid compiler output is a
DAG. Popping a completed child permits a later fresh call to the same component. Shared leaves in
a diamond are likewise valid. An unauthorized alias or forged step identity is a non-retryable
security failure, not a request the model may repair by choosing another component id.

## 10. Failure, retry, admission, and budgets

One root dispatch owns one ledger shared by the entry and all descendants. The first slice uses
these deterministic defaults unless the host supplies a **lower** value:

| Limit | Default | Accounting rule |
| --- | ---: | --- |
| component-call depth | 8 | root is depth 0; admission of depth 9 is refused |
| admitted component-call attempts | 32 | every admitted initial call and retry counts, including failure/cancellation |
| in-flight component calls | 1 | later requests wait in runtime event order; no parallel child execution |
| request bytes | 65,536 | measured before admission as UTF-8 serialized JSON |
| normalized result bytes | 1,048,576 | measured before delivery to the caller |
| total model turns | 40 | root and every child assistant turn share one counter |
| model turns per child attempt | 12 | admission reserves `min(12, remaining root turns)` for the fresh child |

Admission is atomic: validate authorization, reserve one call attempt and the child turn allowance,
then start the child. A queued call cancelled before admission consumes no call/turn reservation.
Once admitted, an attempt remains charged even if it fails, is cancelled, or completes after
cancellation. The runtime returns unused reserved turns when a child finishes; it never returns the
attempt count.

An active parent Agent SDK query also reserves its maximum permitted turns before any synchronous
component tool handler may admit a descendant. Descendant reservations therefore come only from the
unreserved root balance; parent and child SDK limits can never each promise the same remaining turns.
The runtime preserves the existing dispatch/CLI `maxTurns` value and a composition-specific override
may only lower it.

A caller may retry only `transient_transport`, and each retry is a fresh child run subject to the
same edge, ancestry, and ledger checks. Refusal, authorization, policy, budget, cancellation, and
invalid-output errors are never retryable. Repair steps inside the callee are part of that child
invocation: their model turns and usage count against the root, but they do not become a caller
retry.

`unsupported_callee` is an executable-preflight failure for valid IR: the root model never starts.
`unauthorized_call` (including a forged active-step identity or tampered edge) terminates the root
as a security failure and is emitted only to the host trace/error surface, not returned as an
ordinary value for the model to work around. The remaining refusal/error envelopes may be returned
to the authorized caller step; they never enter `consumes`/`produces` as a successful value.

Provider-reported tokens and monetary cost are charged to root telemetry for every observed call,
including failed and late calls. Warble does not call a dollar limit "hard" unless the target can
reserve an enforceable worst-case before admission; a target asked for such a cap must either make
that reservation or reject composition as unsupported. A completed provider call may never be
hidden from usage merely because its result was discarded.

The current Agent SDK target rejects `maxCostUsd` during composed preflight. The SDK's
`maxBudgetUsd` threshold is evaluated only after provider spend and is therefore not represented as
the hard dollar cap defined by this contract.

### 10.1 Cancellation race

Root or ancestor cancellation closes admission immediately and propagates to every active child.
The cancellation timestamp is the winner boundary: a completion observed after it is recorded as
`late_discarded`, never delivered to the caller, rendered, or persisted. Usage already incurred is
still charged. The root writes no final artifact after cancellation; its single aggregate trace may
record the sanitized cancellation events.

## 11. Trace and redaction

Only the root owns persistence. Its aggregate in-memory trace may record, for each attempt:

```text
call_id, parent_call_id, caller_mount, trusted_step_id, alias, callee_mount,
attempt, depth, admitted_at, completed_at, status, request_bytes, result_bytes,
model_turns, token/cost telemetry
```

Request/result payloads, prompts, hidden reasoning, SQL, tool names/arguments/results, provider raw
errors, environment values, and secrets are excluded by default. Payload hashes are permitted only
after host redaction and must not be presented as reversible identifiers. Debug logging is an
explicit host-local option but remains subject to the same secret and provider-error redaction
floor. Public errors carry only the stable code and sanitized bounded message from §6.3.

## 12. IR-version boundary and target support

IR v0.8 introduced this authoring and compiled contract atomically across:

- profile/component models and the compiler producer;
- post-overlay validation and goldens;
- `warble_ir_version` and changelog decision;
- every Rust and TypeScript parser/reader, including raw-JSON and typed-object library entries;
- explicit unsupported-target rejection before executable output;
- generated IR schema/reference snapshots;
- `@warble/ir-spec` package version, constants, declarations, and dispatcher peer ranges; and
- every exact-match/min/max version declaration and lockstep test.

No reader may accept v0.8 while dropping `entrypoint` or `component_calls`, and no producer may
emit the shape under v0.7.

Current support matrix:

| Target | Current v0.8 | Realization | Required behavior when unsupported |
| --- | --- | --- | --- |
| Claude Agent SDK | first slice supported | dispatcher-owned, trusted-step-scoped fresh child runs | unsupported callee/provider shapes preflight wall-hit |
| Codex local | no composition | parity against the shared conformance suite | preflight wall-hit |
| Claude Code file targets | no composition | deferred | preflight wall-hit; do not inline prompts |
| Codex interactive file target | no composition | deferred | preflight wall-hit |
| Vercel | no composition | deferred | preflight wall-hit |

Structural/display inspection may report an unavailable composed entry, but it must never produce
an executable plan that bypasses the wall-hit.

The v0.8 preparation implementation separates root entry plans from an immutable prepared-callee
registry. Capability reports preserve that role boundary, and target-specific display manifests
include the `component_invocation` outcome (and its `via` mechanism when one exists). A pinned root
does not inspect an unreachable sibling's model binding, slots, capabilities, assets, or target
handler support. Whole-profile executable emitters start and emit only `entrypoint:true` mounts;
an internal mount is included only through a supported reachable call edge, never as an independent
artifact.

## 13. Conformance and activation gates

One target-neutral fixture suite owns the observable contract. At minimum it covers:

- authorized and unauthorized aliases under a trusted active step;
- dynamic component-id injection attempts;
- caller direct-SQL denial through every effective surface and callee read-only SQL success;
- unique mounts, overlay removal, missing targets, conditional edges, complete cycle paths, a
  diamond, shared leaves, and repeated completed calls;
- pinned-entry closure versus an unreachable sibling with missing model/slot/asset/readiness;
- separation of entry plans and prepared callees;
- tabular value, render blocks, provenance, refusal, invalid/oversize request and result;
- child no-persistence/no-render behavior;
- retry accounting, depth/call/turn admission, cancellation with late completion, trace fields, and
  redaction; and
- mutated raw JSON/object IR with missing implied capability or a tampered alias target.

Deterministic conformance proves mechanism and policy; model-backed evaluation separately measures
whether a caller chooses useful aliases and produces a useful composed answer.

The first executable proof is a Warble-owned Agent SDK litmus profile. It must land and pass before
any canonical shared component is changed to depend on invocation. Promoting a canonical component
is a separate decision that enumerates every mount site and shipped target, records which consumers
are compatible, and explicitly accepts or avoids each regression. A successful SDK litmus alone
does not authorize making existing file, Codex, or serverless consumers unavailable.
