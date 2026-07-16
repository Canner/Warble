---
title: Capabilities & guardrails
description: "A capability is something a component requires of its runtime, resolved per target as native / realize-via / degrade / fail and gated by criticality; a guardrail is a declared constraint a locked profile cannot weaken."
---

## Capabilities: what a component needs from its runtime

A **capability** is something a component *requires* of the target it dispatches onto —
`sql_execution:read_only`, `render_contract`, `scheduler`, and so on. Dispatch is not just IR-to-files
translation; it's a capability linker. For every capability the IR requires, it asks the target's
capability profile for one of four outcomes:

| Outcome | Meaning |
| --- | --- |
| **native** | The target provides it directly. |
| **realize-via** | No native support, but a borrowed equivalent exists (per-step tier → subagents; `render_contract` → an HTML renderer). |
| **degrade (warn)** | No faithful support, but an acceptable lossy fallback exists — logged, never silent. |
| **fail** | No support, no acceptable degrade, and the requirement is load-bearing. |

Which outcome is acceptable for an *unsupported* capability is decided by **criticality**. Safety
means unsupported has to be visible, not softened.

:::warning
Safety-critical capabilities — `human_approval`, `write_authz`, `blast_radius` — **never silently
degrade.** Dispatching an approval-gated component onto a headless target with no human in the loop
is a **compile-time loud-fail**, not a step that quietly gets skipped. Best-effort capabilities like
`render_contract` may degrade (e.g. to markdown) with a warning; safety-critical ones may not.
:::

## `provided_by`: who actually supplies it

A second axis matters as much as the outcome: **who provides** the capability once resolved.

| `provided_by` | Meaning | Examples |
| --- | --- | --- |
| `runtime` (borrow) | The target, or something borrowed through it, supplies it. | `subagent_dispatch`, `scheduler`, `human_approval`, `write_authz` |
| `warble` (built-in policy) | Only Warble can compute it, over the semantic model. | `blast_radius` |
| `none` | Nobody supplies it here — degrade or fail. | — |

This is the line between table-stakes and the moat: **borrow every generic capability the runtime
already provides; build only the ones that are genuinely data-native.** Approval, scheduling,
subagent dispatch, and VCS/rollback are all borrowed. The single `provided_by: warble` capability is
[`blast_radius`](/concepts/blast-radius) — the forward downstream closure over the semantic lineage
DAG, which no generic sandbox can compute because it only sees "a file was written," not "that file
defines a metric N dashboards depend on."

## Guardrails: constraints a profile can't quietly weaken

Where a capability is what a component *needs*, a **guardrail** is a constraint declared *on* it —
`read_only_execution`, a scoped `artifact_write`, and so on. Guardrails resolve to a single
`locked` boolean: `locked: true` means no profile mounting that component may weaken it, and trying
to is a **compile-time loud-fail**, not a silently-accepted override. `locked: false` (authored as
`overridable: true`) leaves room for a profile to adjust it, e.g. a threshold.

Declaring a guardrail is only half the story — the other half is how a dispatched target actually
*enforces* it at runtime once resolution has decided it applies. See
[Blast radius & enforcement](/concepts/blast-radius) and the
[enforcement seam reference](/reference/enforcement-seam) for the four enforcement points and the
static-vs-runtime layers each target can bring to bear.

## The capability manifest

Projected from the IR, the **capability manifest** is a runtime-agnostic advertisement — verbs,
context, required capabilities, render contract — that lets a meta-harness (a Hub, an orchestrating
agent) decide whether it can call a profile *without* absorbing its execution. See the
[capability model reference](/reference/capability-model) for the full resolution algorithm and the
per-target capability-profile format.
