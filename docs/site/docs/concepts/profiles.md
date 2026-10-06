---
title: Profiles
description: "Profiles declare which components an agent mounts, their supported mount fields, and the Wren, raw-source, or external context it binds."
---

A profile is the authored entry point for a specific agent. The effective compile-time behavior is
a resolved combination of that profile, the components it mounts, and any required context binding; concrete
models, credentials, and runtime mechanisms remain dispatch/runtime inputs. Keeping the authored
selection and supported mount fields in one YAML file makes that part diffable and reviewable.

## `Profile = Harness + optional Context`

A profile declares behaviors and, when they need it, context:

- **Harness** — *which behaviors* the agent has (inline components or library mounts) and their supported mount overrides.
- **Context** — what those behaviors operate over: a Wren project, raw source, external layer, or a
  host-defined binding kind.

A component never names a concrete dataset — it only declares the *shape* of context it needs. The
concrete binding lives only in the profile. That separation is what lets the same component (say,
`generate_dashboard`) be mounted by ten different profiles against ten different semantic layers
without modification.

A text-only behavior can omit `context` entirely. Semantic predicates, context requirements,
context-sourced parameters and project placeholders require an explicit binding. Start with the
[single-file tutorial](/getting-started/first-profile), then extract a component when reuse helps.

## What a profile declares

1. **Optionally binds a context** — points indirectly, via `context/binding.yml`, at a typed context locator.
2. **Declares behaviors** — defines components inline or mounts reusable components, supplying any binds they require and
   applying the supported per-mount overrides.
A profile has **no control flow**: no `if`, no loops, no edges between components. Composition is
a flat list of mounts, deliberately, so a profile stays something you can read top to bottom.

```yaml
profile: orders-analytics

context:
  project: ./context/binding.yml      # indirection to the bound wren project

components:
  - use: generate_dashboard
    bind:
      topic_default: "orders overview" # supplies a declared bind-family param
    tier_overrides:
      compose_layout: strong           # retunes one step's tier for this mount only
```

## Supported mount resolution

Nothing in a profile is applied by convention. `warble compile` resolves the component together
with the supported mount fields and the bound context into each IR node:

```
IR node = resolved( component ⊕ supported mount fields ⊕ context )
```

A mount can supply `bind` values, retune an individual step's tier (`tier_overrides`), replace the
component's `brief`, or replace its `realization_kind`. Its `guardrails` field is a map from a
guardrail name to a patch whose only supported field is `locked`. A patch may not touch a guardrail
whose component default is locked, and a required bind may not be omitted; both are compile-time
loud-fails. The tier→concrete-model mapping, database connections, and dispatch target are
runtime/dispatch-time bindings, not profile fields.

Non-null `components[].config` is rejected: earlier versions accepted it but never applied it.
Remove it to preserve the previous behavior; use `bind` for an intentional change to a declared
parameter. Omission/null are equivalent. Profile-level `config.capability_ceiling` is unaffected.

:::tip
Because a profile is plain YAML with no runtime state in it, two profiles that mount the same
components against different contexts are trivially comparable in a diff — the review surface for
"what does this agent actually do" is the profile file itself.
:::

## Where to go next

- **[Components](/concepts/components)** — The reusable behavior units a profile mounts.
- **[Context binding](/concepts/context-binding)** — What a profile's `context.project` actually resolves to.

For the full field-by-field mount vocabulary and merge rules, see the
[profile schema reference](/reference/profile-schema).
