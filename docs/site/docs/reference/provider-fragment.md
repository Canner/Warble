---
title: "Provider fragment spec"
description: "The dispatch-time capability binding (--provider) that supplies domain capabilities a back-end deliberately does not hardcode."
---

<!-- @generated from docs/spec/provider-fragment.md by scripts/gen-reference.mjs — do not edit; edit the spec and re-run `npm run gen:reference` -->

A **provider fragment** supplies a capability that a back-end deliberately does not know about: an
external service, and the tools that reach it. It is loaded at dispatch (`--provider <file>`,
repeatable) and composed with the target's built-in profile.

This exists so warble never hardcodes whose product realizes a capability. A component declares
`required_capabilities: [remote_agent_ask]`; nothing in warble says what satisfies that. The
fragment is the only place a concrete service appears, so swapping services changes a file — not the
component, not the profile, not the compiled IR.

## Why this doc exists

Two back-ends parse this format independently — `dispatcher/vercel/src/provider.rs` and
`dispatcher/claude-code-cli/src/provider.rs` — with no shared code, because the types they compose
into (each target's own `CapabilityProfile`) are per-target by design. That is the same arrangement
[`binding-spec`](/reference/binding-spec) describes for the tier→model binding, and it needs the same
thing: a written contract both implementations are held to, plus a shared conformance fixture
(`dispatcher/conformance-fixtures/provider-composition.json`) that fails whichever side drifts.

## Substrate vs domain — what belongs in a fragment

A target's built-in profile declares **substrate** capabilities: properties of the runtime itself.
LLM tiers, the render and structured-output contracts, the authz/approval/blast-radius gates,
version control, context isolation. These are true of the runtime regardless of what anyone builds
on it, and a fragment may not redefine them.

Everything else is **domain**: it names something outside the runtime. SQL execution against a
particular engine, semantic-model access, an external agent service, notify/scheduler transports
wired to specific systems. These belong in fragments.

The test is not "is it important" but "does the answer depend on which product is deployed". If yes,
it is domain.

## File shape

Either a single fragment, or `{ providers: [ ... ] }`.

```yaml
fragment_version: "0.1"
provider: remote-agent        # provenance and error text only — never an identity for merge rules
engine: claude-code           # must match the target's engine, or the fragment is rejected
mode: interactive             # optional; omitted ⇒ both modes. A non-matching mode is SKIPPED, not
                              # an error, so one file can carry a headless and an interactive half.

capabilities:
  remote_agent_ask:
    outcome: realize-via      # native | realize-via | degrade | fail
    via: mcp:remote_agent
    provided_by: runtime      # runtime | warble | none
    criticality: required     # safety-critical | required | best-effort

tools:
  remote_agent_ask:
    names:                    # or `name:` for the single-tool case
      - mcp__remote_agent__ask
      - mcp__remote_agent__answer_clarification
    source: mcp:remote_agent/ask
```

`name`/`names` is the callable **as the target's engine spells it** — for Claude Code the allowlist
entry, for a harness-driven target the registered tool name. One capability may grant several: asking
a service and answering the question it asks back are one ability, two callables.

`source` is where it is realized: `mcp:<server>/<tool>`, or a bare mechanism label carrying neither
`:` nor `/` (e.g. `native`).

## Composition rules

Applied over the flattened fragment set, in order, before anything is written:

1. A fragment may **add** a capability the base lacks, or **raise a base `fail` into support**.
2. It may **never** redefine a capability the base owns — safety-critical unconditionally, or any
   outcome other than `fail`. This is what stops a fragment restating `human_approval`.
3. **At most one fragment may claim a capability**, across both maps. Ownership is the fragment's
   *index in the loaded set*, never its `provider` string: that string comes from the file, so two
   fragments both claiming `provider: acme` would otherwise not collide and the later would silently
   win.
4. A `tools` entry needs its capability's profile entry to exist — from the base, or from the same
   fragment — by the time it is processed.
5. A capability no fragment supplies stays unknown, and unknown **aborts dispatch**. There is no
   quiet fallback; that is the point of moving domain capabilities out of the target.

### Validation

- **Source grammar** — `mcp:<server>/<tool>` with both parts non-empty, or a bare label.
- **`via`/`source` coherence** — an `mcp:<S>/<tool>` source requires `via: mcp:<S>`, so the
  resolution report and the tool binding cannot name different servers.
- **Grant/source agreement** (claude-code) — every granted name must start with `mcp__<server>__` for
  the server in `source`. A grant that cannot come from its own server produces an allowlist entry
  matching nothing: an agent told it has a tool it cannot call.

## What a fragment cannot do

It cannot register the server. On the claude-code target the fragment says *which tools to grant*;
whatever actually answers them is host configuration (`.mcp.json`), and the server name in the
fragment must match the one the host registers. Nothing type-checks that seam — it is a convention
between two files, and the grant/source agreement check above is the closest thing to a guard.
