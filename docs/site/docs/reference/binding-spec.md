---
title: "Tier-to-model binding spec"
description: "The authoritative --models-config tier-to-model binding format (binding_spec_version 1.0) consumed by every back-end."
---

<!-- @generated from docs/spec/binding-spec.md by scripts/gen-reference.mjs — do not edit; edit the spec and re-run `npm run gen:reference` -->

This is the **authoritative, versioned source** for the `--models-config` tier→model binding format
consumed by every back-end. It exists because the binding is parsed independently in two languages
with no shared codegen between them — Rust (`dispatcher/claude-code-cli/src/models.rs`) and TS
(`dispatcher/claude-agent-sdk/src/models.ts`) — so, like `ir-schema` for the compile-time IR, this
doc is what both implementations are written to conform to, not a description generated from either.

> **Umbrella model:** the binding is resolved at **dispatch**, not compile. Tiers travel in the IR
> (`ir-schema`) as open-vocabulary names (`strong`/`cheap`, or custom); which model — and which
> provider — each name becomes is decided here, independently of the compiled IR, so the same IR runs
> against different models/providers without recompiling (the axis the eval loop ablates).

## Why this doc exists

Before this doc, `Provider` was a **closed enum** (`Anthropic | OpenAiCompat`) defined once in
`models.rs` and mirrored by convention in `models.ts` — the "shared seam" was tribal knowledge, not a
declared contract, and a closed enum capped which providers a binding could ever name to "whichever
two are built in." This spec:

1. Makes `provider` an **open string**, opaque to warble — mirroring how the IR already treats `tier`
   as an open string (`ir-schema`). Warble does not validate `provider` against a fixed list.
2. Declares the binding format as a **single, versioned spec** both back-ends implement, instead of a
   convention duplicated per-language.
3. Keeps `anthropic` and `openai_compat` behaving exactly as before — they are the two well-known
   names with special parsing behavior (see below) — so existing configs are unaffected.

## The `--models-config` YAML shape

```yaml
# models.yaml
tiers:                       # tier name → binding; declaration order = priority (earliest = strongest)
  strong: claude-opus-4-8      # shorthand string ⇒ { provider: anthropic, endpoint: null, model }
  cheap:                       # structured map (a layer-3 binding)
    provider: openai_compat
    endpoint: http://localhost:11434/v1
    model: qwen2.5
  local:                       # a novel provider — passes through opaquely, no special handling
    provider: bedrock
    endpoint: https://bedrock.example/v1
    model: anthropic.claude-3-haiku
  orchestrator: claude-sonnet-5   # reserved tier: the per-step-tier split's routing-loop model
```

A tier value is **either**:

- a bare model-alias **string** — shorthand for `{ provider: "anthropic", endpoint: null, model:
  <string> }` (unchanged behavior); or
- a **map** with:
  - `model` (string, **required**) — the model alias/id passed to the runtime.
  - `provider` (string, optional, default `"anthropic"`) — **open string**, opaque pass-through (see
    below).
  - `endpoint` (string, optional) — required when `provider == "openai_compat"`; otherwise unused by
    warble itself (a novel provider may or may not need one — that's the harness's concern).

`orchestrator` is a **reserved core tier** (a dispatch role for the per-step-tier split's driver, not
an authoring tier); it lives in the same `tiers` map as any other tier.

## `provider` is an open string

`provider` is **not** validated against a fixed list. Any string is a valid binding value and
compiles/dispatches cleanly — a binding naming a provider warble has never heard of is **opaque
pass-through**, not an error. Two well-known values get built-in parsing behavior:

| Provider | Behavior |
| --- | --- |
| `anthropic` (default) | Rides the Claude runtime / SDK session. No `endpoint` needed. |
| `openai_compat` | An OpenAI-compatible HTTP endpoint (e.g. ollama's `/v1`). **Requires** `endpoint` — its absence is a loud-fail at parse time (this is the one shape-level check warble performs; it verifies the binding is well-formed, not that the provider is "supported"). |
| anything else | Passes through unchanged. Warble does not know what to do with it structurally, and does not need to — see below. |

**Loud-failing on a genuinely unsupported provider is the consuming harness/back-end's job, not
warble's.** Warble's contract ends at parsing a well-formed `{provider, endpoint?, model}` binding and
handing it to the target; whether a specific back-end can actually *route a call* to an arbitrary
provider string is a runtime/dispatch concern for that back-end (a per-provider adapter registry on
the harness side is the natural home for it, and is future work — not part of this spec). Rejecting an
unrecognized provider at *compile or binding-parse* time — before the harness even gets a chance to
look at it — would defeat the purpose of making this an open string.

## Per-target consumption

- **`claude-code:headless` (the file target, Rust)** only reads `model` — the session's connection is
  owned by the Claude Code runtime (`ANTHROPIC_BASE_URL` whole-session redirect), not per-step. It
  parses the full `{provider, endpoint, model}` shape (so the one `--models-config` format is shared
  across targets) but only `TierBinding::model` feeds emission; `provider`/`endpoint` are read by the
  hybrid-LLM emit path (`emit/hybrid.rs`) to decide whether a step is cloud (`anthropic`) or realized
  as a local-inference script/MCP tool (anything else, provided an `endpoint`).
- **`claude-agent-sdk:local` (the direct-driving TS target)** reads the full binding natively — it
  drives `provider`/`endpoint`/`model` itself per step (`route.ts`), which is what makes hybrid
  local+cloud dispatch possible without touching the IR.

## Versioning

`BINDING_SPEC_VERSION` is declared as a constant in **both** implementations and must match this
doc's version — the three are kept in lockstep deliberately, so this contract does not drift the way
a version constant can when it lives only in code and no one guards it. A test asserts the two
language constants agree (`dispatcher/claude-code-cli/tests/models_tests.rs`); keep this doc's
version in step with them. Bump all three together on any format change:

- Rust: `dispatcher/claude-code-cli/src/models.rs` — `pub const BINDING_SPEC_VERSION: &str = "1.0";`
- TS: `dispatcher/claude-agent-sdk/src/models.ts` — `export const BINDING_SPEC_VERSION = "1.0";`

| Version | Date | Change |
| --- | --- | --- |
| 1.0 | 2026-07-14 | Initial versioned spec. Consolidates the two per-language `Provider` enum copies into this doc; widens `provider` from a closed `anthropic \| openai_compat` enum to an open string (opaque pass-through for any other value). `anthropic`/`openai_compat` behavior is unchanged from the pre-spec enum. |
