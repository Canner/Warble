---
title: Profiles
description: "Profiles are the git-authoritative declaration of a data agent's behavior: which components it mounts, their config/overrides, guardrails, and the semantic context it binds to."
---

A profile is the one file that says what a specific agent *is*. Everything else Warble compiles —
which components run, how they're configured, what data they can see — is a resolved combination
of the profile with the components it mounts and the context it binds to. Nothing about an agent's
behavior lives anywhere else, which is what makes a profile diffable, reviewable, and safe to check
into git like any other source file.

## `Profile = Harness + Context`

A profile binds two things you declare separately:

- **Harness** — *which behaviors* the agent has (the components it mounts) and how they're tuned.
- **Context** — *what data/semantics* those behaviors operate over (a bound wren project).

A component never names a concrete dataset — it only declares the *shape* of context it needs. The
concrete binding lives only in the profile. That separation is what lets the same component (say,
`generate_dashboard`) be mounted by ten different profiles against ten different semantic layers
without modification.

## A profile does exactly three things

1. **Binds a context** — points (indirectly, via `context/binding.yml`) at a wren project.
2. **Mounts components** — lists which components run, supplying any binds they require and
   overriding whatever they leave overridable.
3. **Sets global config** — a profile-level tier policy hint, and nothing else.

A profile has **no control flow**: no `if`, no loops, no edges between components. Composition is
a flat list of mounts, deliberately, so a profile stays something you can read top to bottom.

```yaml
profile: orders-analytics

context:
  project: ./context/binding.yml      # indirection to the bound wren project

config:
  tier_policy: cost_sensitive          # optional, profile-level hint

components:
  - use: generate_dashboard
    config:
      topic_default: "orders overview" # overrides an overridable component default
    tier_overrides:
      compose_layout: strong           # retunes one step's tier for this mount only
```

## Defaults ⊕ overrides, resolved at compile

Nothing in a profile is applied by convention — `warble compile` explicitly merges component
defaults with profile overrides into each IR node:

```
IR node = resolved( component defaults ⊕ profile overrides ⊕ context )
```

A mount entry can override an overridable default (`config`), retune an individual step's tier
(`tier_overrides`), switch how a component talks to the LLM (`realization_kind`), or tune an
overridable guardrail's threshold. What it **cannot** do is supply a `locked: true` guardrail with
a weaker value, or skip a `bind: required` param — both are compile-time loud-fails, not warnings.
This is also why the tier→concrete-model mapping, database connections, and which back-end you
dispatch to are all deliberately *absent* from the profile: those are runtime/dispatch-time
bindings, not authored behavior.

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
