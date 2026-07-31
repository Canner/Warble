---
title: Adding a new back-end
description: "How to add a new dispatcher target that legalizes the same IR onto a different runtime, by realizing IR enum arms rather than special-casing components."
---

A back-end (Warble calls it a dispatcher) is a new **consumer of `ir.json`** — nothing more. Every
back-end reads the same compiled IR that the front-end compiler emits, and its whole job is to
legalize that IR onto one specific runtime: bind tiers to concrete models, resolve required
capabilities, and emit whatever the runtime needs to actually run — static files, an in-process
loop, a deployable bundle. Adding a target never touches `core/` (the compiler) or any other
back-end, because none of them share anything except the IR document itself.

## The contract: dispatch on enums, never on identity

Every back-end is built the same way: it branches on three closed IR enums —
`realization_kind`, `outcome.kind`, and `trigger.kind` — and never on a component's id or verb. A
back-end that special-cased `if verb == "explain_change"` could only ever serve the components it
had personally been told about. A back-end that instead reads `realization_kind: skill` or
`outcome.kind: mutation` serves *every* component with that shape, including ones written after the
back-end shipped. This is what keeps a back-end thin: it's a translation table from IR shape to
runtime mechanism, not a registry of known behaviors. See [Targets & wall-hits](/concepts/targets-and-wall-hits)
for the full principle, and [the IR](/concepts/ir) for what those enums actually carry.

## Loud-fail on what you can't realize

The enum vocabulary is closed, but no target has to realize every arm on day one. When a back-end
is asked to dispatch an arm it doesn't support — a `gated-tool` realization on a target with no
approval channel, a `scheduled` trigger on a target with no cron — it must **loud-fail**: a clear,
compile- or dispatch-time error naming the unsupported arm. It must never guess at what the
component "probably meant" and emit a best-effort approximation. This is the wall-hit contract, and
it's what lets a thin back-end stay trustworthy: everything it *does* emit, it emits correctly, and
everything it can't, it says so plainly rather than quietly.

Adding support for a new arm later is additive — one new handler in your dispatcher — never a
rewrite of the paths that already work. The [IR schema reference](/reference/ir-schema) lists the
full enum vocabulary, including the arms that are documented extension points today.

## The shipped back-ends as models

Warble ships independent back-ends on genuinely different runtimes, which is itself the proof that
the IR is a real seam and not an artifact of one implementation's internals:

- **`claude-code-cli/`** (Rust) — emits static Claude Code agent files (`.claude/agents/*.md`).
  No SDK, no runtime process; it folds directly into the `warble` binary. Look here for the model
  of a *file-emitting* back-end: dispatch produces artifacts on disk, and the runtime that consumes
  them (`claude -p --agent …`) is a separate process started later.
- **`claude-agent-sdk/`** (TypeScript) — drives the Claude Agent SDK's in-loop `query()` at
  runtime instead of emitting files. It links no Rust at all; it only reads the same `ir.json` that
  the Rust compiler produced. Look here for the model of an *in-process* back-end, where dispatch
  and execution are the same running program, and runtime guardrail enforcement (rather than only
  static generation) becomes possible.

A third target, **`vercel`**, is a wholly separate back-end aimed at a deployable serverless bundle
rather than either of the above shapes — composed with domain **provider** fragments instead of the
file target's render-flavor/model-tier knobs. It's a useful third data point for how differently two
back-ends can realize the same IR while both staying honest about what they can't do.

**`codex-local/`** is a fourth, model-level peer back-end. It drives an isolated local Codex CLI
process and initially realizes only the single-step Setup slice. Its narrow capability profile is a
worked example of shipping a useful subset without weakening the wall-hit contract: it branches on
IR enums, guardrails, and capabilities, never on a component id, and rejects Ask/multi-step shapes
until their orchestration semantics are implemented.

## What doesn't change when you add one

Because every back-end is an independent consumer of the same seam:

- The front-end compiler (`core/`) emits identical IR regardless of which back-ends exist.
- No back-end reads another back-end's output, or `profile.yml` directly — only `ir.json`.
- A new target's unsupported arms are simply wall-hits on day one, not blockers to shipping a
  narrower slice first (the MVP tier, say, before assertive or mutating components).

If your change is to the compiler or to a component rather than a new target, see
[Contributing](/community/contributing) for the invariants that govern those changes instead.
