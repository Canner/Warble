---
title: "Enforcement seam"
description: "How a dispatched target actually enforces a guardrail at runtime — the four enforcement points and the two enforcement layers."
---

<!-- @generated from docs/spec/enforcement-seam.md by scripts/gen-reference.mjs — do not edit; edit the spec and re-run `npm run gen:reference` -->

A component's IR carries `guardrails` as declarative data (`locked`/`overridable`, scopes, criticality
— see [`capability-model`](/reference/capability-model) for how they resolve per target). This document
is about the other half: how a dispatched target actually *enforces* a guardrail at runtime, once
resolution has decided it applies. The two concerns are independent — capability resolution answers
"can this target realize this constraint at all", enforcement answers "given that it can, what stops
a component from violating it while it runs."

## 1. Four enforcement points

Every constraint a component can be under maps to exactly one of four points, each independently
authorized:

| Point | Applies to | What it gates |
| --- | --- | --- |
| `read_only_execution` | analytical / assertive components | All data access must go through the read-only semantic layer; no raw warehouse access, no destructive shell. |
| `artifact_write` | render output (scoped) | Writes are confined to a declared artifact directory (e.g. a dashboard output path). |
| `data_write` | mutating components | The gated *apply* of a diff — requires a dry-run and/or human approval before it takes effect. |
| `context_write` | constitutive components (scoped) | Edits to the semantic context (models/knowledge) are confined to a declared scope, distinct from `artifact_write`. |

These are the same four points named in the repo's architecture notes; this document is their single
canonical description.

## 2. Two enforcement layers, and why both exist

A guardrail is only as strong as its weakest enforcement layer, so targets that can enforce at more
than one layer should use all of them — they check different things and a gap in one is not
compensated by the other.

### 2.1 Static allow/deny (file target)

The file back-end (`dispatcher/claude-code-cli`) has no runtime hook into the host agent loop, so it
can only emit a **static** settings file: an allowlist/denylist of tool names and bash patterns,
fixed at dispatch time. This is necessary but not sufficient — it cannot inspect the *content* of a
call (e.g. distinguish a safe `wren` invocation from an unsafe one) or react to what a step actually
tries to do.

### 2.2 Runtime interception (SDK target)

The SDK back-end (`dispatcher/claude-agent-sdk`) drives the agent loop itself, so it can enforce at
**runtime** via the SDK's `canUseTool` callback (`dispatcher/claude-agent-sdk/src/guardrails.ts`):
every tool call is inspected as it happens, and a denial is fed back to the model as a reason rather
than failing silently or crashing the run. Concretely:

- **`read_only_execution`**: `Bash` is allowed only for `wren` CLI invocations (data access through
  the semantic layer); destructive patterns (`rm`, `sudo`, `chmod`, …) and shell redirection are
  blocked outright regardless of the command's first token.
- **`artifact_write`**: `Write`/`Edit` are allowed only inside a resolved, path-boundary-safe artifact
  scope (an exact-match or true separator boundary — a naive prefix check would wrongly admit a
  sibling directory that merely shares a prefix).
- **`data_write`** (mutating apply): the guard **cannot itself grant an apply** — approval is borrowed
  from the embedding host's own approval channel. Absent that channel, the guard **denies by default
  (fail-closed)** and records why, rather than assuming approval that was never actually given.
- **`context_write`** (constitutive): a *third*, independently-scoped gate — a write outside the
  declared context scope is denied immediately with a distinguishable "scope violation" reason, before
  the approval question is even reached; a write inside the scope still falls through to the same
  fail-closed approval gate as `data_write`. The two denial reasons are kept distinguishable so a
  trace can tell which gate fired.

The static layer (2.1) still runs underneath the SDK target too — `Bash` is available but not
auto-allowed, and destructive patterns are excluded from what the SDK ever offers the model in the
first place. Runtime interception is additive, not a replacement.

## 3. Data-layer enforcement is orthogonal: `strict_mode`

Read-only access to the semantic layer itself is enforced one level further down, inside the `wren`
CLI's own `strict_mode` configuration — independent of and underneath the artifact/escape gate
described above. A component's `read_only_execution` guardrail governs what the *agent* is allowed to
invoke; `strict_mode` governs what the *semantic layer* is willing to execute even when invoked. The
two must agree, but they are enforced by different processes and neither substitutes for the other.

## 4. `blast_radius` as the mutating-path gate

For mutating components, the enforcement question isn't only "is this write authorized" but "is this
write *safe to apply at all* given what it touches downstream." That question is answered by
`blast_radius` (see [`blast-radius`](/reference/blast-radius) §6–§7): the lineage-derived severity and
downstream count feed a gate decision — `Allow` / `Escalate` / `Block` — computed from a dry-run
*before* any apply is attempted. `Escalate` routes to human approval instead of auto-applying;
`Block` refuses outright with no escalation path, because the change touches a protected asset. This
gate composes with, rather than replaces, the `data_write` enforcement point above: a change can
clear the blast-radius gate and still require the approval that `data_write` demands.

## 5. Fail-closed is the load-bearing default

Every enforcement point above defaults to **deny** for anything not explicitly permitted, and an
approval-gated apply defaults to **denied** rather than silently assumed-approved when no approval
channel is available. This mirrors the same "loud-fail over silent wrong behavior" principle that
governs unsupported IR arms elsewhere in the dispatch model: an enforcement gap should surface as a
denial a caller can see and act on, never as a write that quietly went through.

## 6. Where this lives today

| Point | Static config | Runtime code |
| --- | --- | --- |
| `read_only_execution` | `dispatcher/claude-code-cli` settings emission; `dispatcher/claude-agent-sdk/src/options.ts` tool allowlist | `dispatcher/claude-agent-sdk/src/guardrails.ts` (`canUseTool` bash gate) |
| `artifact_write` | scope declared in the component's IR | `guardrails.ts` (`withinScope` check) |
| `data_write` | — | `guardrails.ts` (mutation branch); `cli/src/gate.rs` (blast-radius `GateDecision`) |
| `context_write` | — | `guardrails.ts` (`contextScope` branch) |
| semantic-layer read-only | `wren` project config (`strict_mode`) | enforced inside the `wren` CLI itself |

## 7. Summary

Guardrails are declared once in the IR and resolved once per target (`capability-model`), but
*enforced* at up to three independent layers depending on what the target can do: static tool
allow/deny, runtime interception of individual tool calls, and a data-layer check inside the semantic
layer itself. A target that only has the static layer is weaker by construction, not by omission —
which is exactly why the SDK target's runtime `canUseTool` interception is the meaningful
differentiator described in this document, and why `blast_radius` exists as a purpose-built gate for
the one enforcement point (mutating writes) where a static or purely-syntactic check can't tell you
whether a change is safe.
