---
title: Authoring a profile
description: "Write a profile.yml from scratch: mount components, bind a context, apply supported per-component overrides, and compile it to IR."
---

A profile is the one file that declares what a specific agent *is* — which components it mounts,
what context they run against, and the supported per-mount resolution fields. This guide walks
through building one with more than one mounted component and real overrides. For the underlying model, see
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
    bind:
      topic_default: "orders overview"
```

`components` is a flat list — a profile has no control flow, so there are no conditionals or edges
between mounts, only a top-to-bottom list of `{ use: ... }` entries.

**3. Bind a context**

For the default `wren_project` kind, `context.project` points indirectly at the bound project
through `context/binding.yml`:

```yaml
# context/binding.yml
kind: wren_project       # default when omitted
project: ../jaffle-wren
```

Every mounted component's `context_precondition` gets checked against whatever this resolves to.
Use `kind: raw_source` for a constitutive pre-MDL input or `kind: external` for an uninspected
opaque locator. See [Binding a context](/guides/binding-context) for what each adapter can answer.

**4. Apply supported per-component overrides**

A mount entry (`components[]`) can provide binds and use the overrides the compiler resolves without
touching the component's own manifest:

```yaml
components:
  - use: generate_dashboard
    bind:
      topic_default: "orders overview"   # supplies a declared bind-family param
    tier_overrides:
      compose_layout: strong             # retunes one step's tier for this mount only
    guardrails:
      verbosity:
        locked: true
    realization_kind: skill
    brief: "Answer with the operational summary first."
```

- `bind` supplies values for the component's declared `bind`-family params; required binds must be
  supplied, and optional binds otherwise use their component default when one exists.
- `tier_overrides` retunes an individual `llm_steps` entry's `tier` for this mount only.
- `guardrails` is a map keyed by guardrail name. Each patch supports only `locked`; it can change a
  guardrail whose component default is not locked.
- `realization_kind` replaces the component's authored value, and `brief` replaces the component's
  brief wholesale.

`components[].config` is accepted but not applied by the current compiler. Do not use it to override
parameter defaults, thresholds, cadence, or other component behavior. `config.tier_policy` is
carried into the IR as metadata but has no shipped decision consumer.

:::warning
A guardrail authored with `locked: true` on the component (a safety floor like
`read_only_execution` or `human_approval`) cannot be weakened by any profile override — attempting
to do so is a compile-time error, not a warning. Only guardrails the component declared
`overridable: true` can have their resolved `locked` value patched from a profile.
:::

A profile also cannot supply the tier-to-model mapping, database connections, or which runtime you
dispatch to — those are dispatch-time bindings, not authored behavior.

**5. Compile it**

```bash
warble compile orders-analytics -o ir.json
```

`warble compile` resolves each component with its supported mount fields and the bound context into
one IR document per mounted component:

```
IR node = resolved( component ⊕ supported mount fields ⊕ context )
```

## What you get

`ir.json` carries one resolved node per mount — effective `bind` values, `tier_overrides` baked
into `llm_calls[].tier`, a resolved `realization_kind` and `brief`, and guardrails normalized to a
single `locked` boolean. A Wren-project binding also contributes introspected metrics/dimensions;
a raw-source binding contributes an empty semantic inventory plus raw-shape probe results, while an
external binding omits `context_binding.resolved`. That IR is what a back-end consumes next.

## Gotchas

- A component `params[].bind: required` that your profile doesn't supply under `bind:` is a
  compile-time loud fail — there's no implicit default for a required bind.
- `deny_unknown_fields` rejects a typo'd field name in `component.yml` at compile time. It does not
  (yet) cover `profile.yml` or `context/binding.yml` — an unknown field there is currently ignored
  rather than caught.
- A guardrail patch only changes `locked`; it cannot tune a threshold, cadence, routing target, or
  any other guardrail value. There is no way to loosen a component guardrail that is already locked.

- **[Profiles](/concepts/profiles)** — The Harness + Context mental model this page builds on.
- **[Profile schema](/reference/profile-schema)** — Every profile and mount-entry field, exhaustively.
