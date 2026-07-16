---
title: Authoring a profile
description: "Write a profile.yml from scratch: mount components, bind a context, apply config and per-component overrides, and compile it to IR."
---

A profile is the one file that declares what a specific agent *is* — which components it mounts,
what context they run against, and how their defaults are tuned. This guide walks through building
one with more than one mounted component and real overrides. For the underlying model, see
[Profiles](/concepts/profiles); for the exhaustive field list, see the
[profile schema reference](/reference/profile-schema).

**1. Lay out the project**

A Warble project is a directory with a `profile.yml`, one or more component directories, and a
context binding:

```
orders-analytics/
  profile.yml
  components/
    generate_dashboard/
      component.yml
      steps/
  context/
    binding.yml
```

You don't have to author every mounted component's directory yourself — components can also
resolve from a shared Hub library. See [Mounting components](/guides/mounting-components) for how
resolution across sources works.

**2. Write profile.yml and mount components**

`profile.yml` names the profile and lists what it mounts:

```yaml
profile: orders-analytics

context:
  project: ./context/binding.yml

config:
  tier_policy: cost_sensitive

components:
  - use: generate_dashboard
    config:
      topic_default: "orders overview"
```

`components` is a flat list — a profile has no control flow, so there are no conditionals or edges
between mounts, only a top-to-bottom list of `{ use: ... }` entries.

**3. Bind a context**

`context.project` points, indirectly, at a bound wren project through `context/binding.yml`:

```yaml
# context/binding.yml
project: ../jaffle-wren
```

Every mounted component's `context_precondition` gets checked against whatever this resolves to.
See [Binding a semantic context](/guides/binding-context) for what that check actually does.

**4. Apply config and per-component overrides**

A mount entry (`components[]`) can tune an instance without touching the component's own manifest:

```yaml
components:
  - use: generate_dashboard
    config:
      topic_default: "orders overview"   # overrides an overridable default
    tier_overrides:
      compose_layout: strong             # retunes one step's tier for this mount only
    guardrails:
      - { name: alert_routing, threshold: 10 }
```

- `config` overrides overridable component defaults (thresholds, cadence, a param's default value).
- `tier_overrides` retunes an individual `llm_steps` entry's `tier` for this mount only.
- `guardrails` tunes an **overridable** guardrail's value (like a threshold).

:::warning
A guardrail authored with `locked: true` on the component (a safety floor like
`read_only_execution` or `human_approval`) cannot be weakened by any profile override — attempting
to do so is a compile-time error, not a warning. Only guardrails the component declared
`overridable: true` can be tuned from a profile.
:::

A profile also cannot supply the tier-to-model mapping, database connections, or which runtime you
dispatch to — those are dispatch-time bindings, not authored behavior.

**5. Compile it**

```bash
warble compile orders-analytics -o ir.json
```

`warble compile` merges component defaults with your profile overrides and the bound context into
one IR document per mounted component:

```
IR node = resolved( component defaults ⊕ profile overrides ⊕ context )
```

## What you get

`ir.json` carries one resolved node per mount — the merged `config`/`tier_overrides` baked into
`llm_calls[].tier`, guardrails normalized to a single `locked` boolean, and the context's
introspected metrics/dimensions attached under `context_binding.resolved`. That IR is what any
back-end (`warble dispatch`) consumes next.

## Gotchas

- A component `params[].bind: required` that your profile doesn't supply under `bind:` is a
  compile-time loud fail — there's no implicit default for a required bind.
- `warble compile` runs `deny_unknown_fields` on every parsed document: a typo'd field name in
  `profile.yml` fails the build rather than being silently ignored.
- Guardrail overrides only ever move an **overridable** value; there's no way to loosen a locked
  one from the profile layer, by design.

- **[Profiles](/concepts/profiles)** — The Harness + Context mental model this page builds on.
- **[Profile schema](/reference/profile-schema)** — Every profile and mount-entry field, exhaustively.
