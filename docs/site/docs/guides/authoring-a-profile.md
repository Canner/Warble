---
title: Authoring a profile
description: "Write a profile.yml from scratch: mount components, bind a context, apply supported per-component overrides, and compile it to IR."
---

A profile is the one file that declares what a specific agent *is* — which components it mounts,
any context they need, and the supported per-mount resolution fields. This guide walks
through mounting a reusable data component with explicit context and supported overrides. For the underlying model, see
[Profiles](/concepts/profiles); for the exhaustive field list, see the
[profile schema reference](/reference/profile-schema).

For a first harness, use the [single-file tutorial](/getting-started/first-profile) and
`check → preview → build`. This guide covers reusable data components and explicit context.
Backend integrators can retain the separate compile/dispatch path.

**1. Lay out the project**

This data-connected example uses a `profile.yml`, a reusable component directory, and a
context binding with a host-produced snapshot:

```
orders-analytics/
  profile.yml
  components/
    generate_dashboard/
      component.yml
      steps/
  context/
    binding.yml
    context.json
```

Simple behaviors can live inline in `profile.yml`; context can be omitted when no mounted behavior
needs it. You don't have to author every mounted component's directory yourself — components can also
resolve from a shared Hub library. See [Mounting components](/guides/mounting-components) for how
resolution across sources works.

**2. Write profile.yml and mount components**

`profile.yml` names the profile and lists what it mounts:

```yaml
profile: orders-analytics

context:
  project: ./context/binding.yml

components:
  - use: generate_dashboard
    bind:
      topic_default: "orders overview"
```

`components` is a flat list — a profile has no control flow, so there are no conditionals or edges
between mounts. Each entry either mounts a reusable component with `use` or defines a behavior
inline; this example uses a library mount.

**3. Bind a context**

`context.project` points indirectly at the bound context through `context/binding.yml`, which must
declare its `kind` — there is no default:

```yaml
# context/binding.yml
kind: prepared
project: ../jaffle-wren            # the bound layer's identity
document: context/context.json     # the projection its owner wrote
```

The host reads its data or semantic format and writes `context/context.json` as a
[prepared-context document](/reference/profile-schema#43-prepared--the-host-resolved-it). `document` is resolved
relative to the Warble project directory, not the binding file. Keep `project` as the bound layer's
identity; Warble does not inspect that directory to populate the snapshot.

Every mounted component's `context_precondition` gets checked against that snapshot.
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

Non-null `components[].config` is rejected because it was previously ignored. Remove it to
preserve the old effective behavior, or deliberately use a supported mount field such as `bind`.

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
one IR document containing a resolved node per mounted component:

```
IR node = resolved( component ⊕ supported mount fields ⊕ context )
```

## What you get

`ir.json` carries one resolved node per mount — effective `bind` values, `tier_overrides` baked
into `llm_calls[].tier`, a resolved `realization_kind` and `brief`, and guardrails normalized to a
single `locked` boolean. A prepared binding carries metrics and dimensions from the host's snapshot;
a raw-source binding contributes an empty semantic inventory plus raw-shape probe results, while an
external binding omits `context_binding.resolved`. That IR is what a back-end consumes next.

## Gotchas

- Non-null `components[].config` is a compile error. Earlier versions silently ignored it.
  Remove it to retain the previous behavior, or intentionally use `bind` for declared parameters;
  see [migration guidance](/reference/profile-schema#migrating-ignored-mount-configuration).

- A component `params[].bind: required` that your profile doesn't supply under `bind:` is a
  compile-time loud fail — there's no implicit default for a required bind.
- Unknown component, mount and profile `context` fields are rejected. The author commands
  (`check`, `preview`, `build`) also reject unknown top-level profile/config fields; low-level
  `compile` retains its compatibility behavior for those fields. Binding files allow host-defined
  extension fields; that does not make an arbitrary field a supported CLI setting.
- A guardrail patch only changes `locked`; it cannot tune a threshold, cadence, routing target, or
  any other guardrail value. There is no way to loosen a component guardrail that is already locked.

- **[Profiles](/concepts/profiles)** — The Harness + optional Context model this page builds on.
- **[Profile schema](/reference/profile-schema)** — Every profile and mount-entry field, exhaustively.
