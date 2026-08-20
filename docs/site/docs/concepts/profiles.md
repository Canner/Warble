---
title: Profiles
description: "Profiles declare which components an agent mounts, their supported mount fields, and the Wren, raw-source, or external context it binds."
---

A profile is the authored entry point for a specific agent. The effective compile-time behavior is
a resolved combination of that profile, the components it mounts, and the context binding; concrete
models, credentials, and runtime mechanisms remain dispatch/runtime inputs. Keeping the authored
selection and supported mount fields in one YAML file makes that part diffable and reviewable.

## `Profile = Harness + Context`

A profile binds two things you declare separately:

- **Harness** — *which behaviors* the agent has (the components it mounts) and their supported mount overrides.
- **Context** — what those behaviors operate over: a Wren project, raw source, external layer, or a
  host-defined binding kind.

A component never names a concrete dataset — it only declares the *shape* of context it needs. The
concrete binding lives only in the profile. That separation is what lets the same component (say,
`generate_dashboard`) be mounted by ten different profiles against ten different semantic layers
without modification.

## A profile does exactly three things

1. **Binds a context** — points indirectly, via `context/binding.yml`, at a typed context locator.
2. **Mounts components** — lists which components run, supplying any binds they require and
   applying the supported per-mount overrides.
3. **Carries global config metadata** — `config.tier_policy` is retained in the IR, but no shipped
   compiler, dispatcher, or evaluator currently uses it to make a tier decision.

A profile has **no control flow**: no `if`, no loops, no edges between components. Composition is
a flat list of mounts, deliberately, so a profile stays something you can read top to bottom.

```yaml
profile: orders-analytics

context:
  project: ./context/binding.yml      # indirection to the bound wren project

config:
  tier_policy: cost_sensitive          # optional metadata, carried into the IR

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

`components[].config` is accepted by the profile parser but is not applied by the current compiler.
Do not use it to override parameter defaults, thresholds, cadence, or any other behavior. Likewise,
`config.tier_policy` is carried as metadata only; it does not bias tier selection in shipped code.

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
