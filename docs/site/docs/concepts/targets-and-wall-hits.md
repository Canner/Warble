---
title: Targets & wall-hits
description: "A wall-hit is an IR arm a given back-end target can't realize; Warble loud-fails rather than emit something silently wrong, which is what keeps back-ends thin and honest about their boundaries."
---

## Dispatch on enums, never on identity

Every back-end legalizes the same IR onto one runtime, and every back-end is built the same way: it
branches on three closed IR enums — `realization_kind`, `outcome.kind`, and `trigger.kind` — and
never on a component's id or verb. A back-end that special-cased `if verb == "explain_change"` would
be unable to serve any component it hadn't personally been told about; one that reads
`realization_kind: skill` or `outcome.kind: mutation` serves *every* component with that shape,
including ones written after the back-end shipped. This is what keeps a back-end thin: it's a
translation table from IR shape to runtime mechanism, not a registry of known behaviors.

## A wall-hit is a loud boundary, not a silent one

Because the enum vocabulary is closed but not every target realizes every arm yet, a target will
sometimes be asked to dispatch an arm it doesn't support — a `gated-tool` realization on a target
with no approval channel, a `scheduled` trigger on a target with no cron. When that happens, the
target must **loud-fail**: a clear, compile/dispatch-time error naming the unsupported arm, never a
best-effort guess at what the component "probably meant." This is the same principle that governs
capability resolution generally (see [Capabilities & guardrails](/concepts/capabilities-and-guardrails)) —
an honest boundary beats a quiet wrong answer every time, and it's what lets a thin back-end stay
trustworthy: everything it *does* emit, it emits correctly, and everything it can't, it says so.

Adding support for a new arm is additive — one new handler — never a rewrite of the dispatcher's
existing paths.

## The reference targets

Warble ships two reference back-ends today that prove the IR is a real cross-language seam, plus a
target aimed at a different kind of host entirely:

| Target | Language | What it emits |
| --- | --- | --- |
| `claude-code:headless` / `:interactive` | Rust, folded into the `warble` binary | Static Claude Code agent files (`.claude/agents/*.md`) — no SDK, no runtime process. |
| `claude-agent-sdk:local` | TypeScript | An in-loop `query()` session — the SDK back-end drives the agent loop itself rather than emitting files, which is also what lets it enforce guardrails at runtime instead of only statically. |
| `vercel` | — | A deployable bundle for a serverless host; a wholly separate back-end from the Claude Code file target, composed with domain **provider** fragments rather than the file target's render-flavor/model-tier knobs. |

Two file-target back-ends realizing the *same* MVP slice on genuinely different runtimes — one static
files, one an in-loop process — is the proof that the IR is a seam and not an artifact of one
implementation's internals.

See [How Warble works](/concepts/how-warble-works) for where dispatch sits in the overall
compile-to-agent pipeline, the [CLI reference](/reference/cli) for every `--target` and its flags,
and [Adding a back-end](/community/adding-a-backend) for what a new target actually has to implement.
