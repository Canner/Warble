# Hybrid LLM spike — findings

Branch `spike/hybrid-llm` off `bd8b749`. Scope: prove that the *same* compiled IR runs a `cheap` step
on a local open-source model and a `strong` step on cloud Claude, purely by swapping the layer-3
binding — and that `warble eval` can say which steps are safe to push local. Design doc:
`plans/warble-framework/impl-plans/spike-hybrid-llm.md`.

## Headline result (proven offline)

The 3-step `answer_query` IR (`resolve_intent`@cheap → `generate_sql`@strong → `repair_sql`@strong),
dispatched by the Agent SDK back-end under two bindings, unchanged IR both times:

```
ALL-CLOUD  (all-cloud.yml)           HYBRID  (hybrid-cheap-local.yml)
  mode        : sdk-split              mode        : hybrid-staged
  providers   : [anthropic]            providers   : [openai_compat, anthropic]
  SDK agents? : true                   SDK agents? : false
    resolve_intent -> haiku              resolve_intent  => LOCAL qwen2.5 @ localhost:11434
    generate_sql   -> opus               generate_sql    => CLOUD opus
    repair_sql     -> opus               repair_sql      => CLOUD opus
```

Reproduce with no infra: `examples/hybrid-llm/scripts/dryrun-demo.sh`.

## What changed (and what deliberately did NOT)

Hybrid lives entirely in **layer 3 (binding) + back-end realization** — vision §9.2. Zero changes to
the IR schema, the components, the profiles, or the front-end compiler (`git diff` confirms). The
edits:

- **Binding format (D3)** — `--models-config` tier values gained an optional
  `{ provider, endpoint?, model }` map form; a bare string stays Anthropic shorthand, so every existing
  config and all-cloud path is byte-identical. Mirrored in Rust (`models.rs`) and TS (`models.ts`).
- **Per-step provider routing (D4)** — new `dispatcher/claude-agent-sdk/src/route.ts` decides the mode
  (`single` / `sdk-split` / `hybrid-staged`) and resolves each step's binding; `options.ts` takes the
  hybrid path when any step is non-Anthropic (building **no** SDK `agents`, so the local model never
  hits the `agents[].model` alias union that would loud-fail); `run.ts` gains a staged executor that
  drives each step on its own provider and marshals `produces`→`consumes`; `localClient.ts` is a tiny
  OpenAI-compat client for local steps.

Invariants held: routing never entered the composition layer (it's binding + back-end); tiers never
gained model/provider names (those are binding-only); the generic HTTP call is a thin borrowed client,
not a differentiated capability.

## The two-back-end reality (why M1/M3 differ from M2)

- **Agent SDK back-end (TS)** drives the loop itself, so it can route **per step** to different
  providers in one run. This is where real hybrid (M2) lives.
- **File target (Rust) + `claude` CLI** — used by `warble eval` — is whole-session single-provider.
  Per-step local there rides a **LiteLLM proxy** that routes by model *name* (opus→cloud, qwen2.5→local),
  or a whole-session `ANTHROPIC_BASE_URL` redirect for all-local. No warble change needed for that path.

So M2 exercises the new code directly; M1 (whole-session swap) and M3 (eval ablation) reuse existing
machinery plus the proxy.

## M3 — how the eval answers "which step can go local"

`warble eval ablate` holds every step at `--base-tier strong` (cloud) and moves one step at a time to
the swept `cheap` tier (bound to the local model via `ablation-cheap-local.yml` + proxy), re-running the
goldens. For each step it reports accuracy/cost/latency Δ vs the all-cloud baseline and picks the
cheapest tier that stays at/above the accuracy floor — i.e. the per-step "safe to push local?" verdict.
The command is in the README (M3). This closes vision §9.2's loop: **eval → tier → binding → re-eval**.

Expected shape (to be filled with live numbers): a step like `resolve_intent` (NL→intent, no SQL) is
the prime local candidate — it should hold accuracy on a small local model at ~zero marginal cost;
`generate_sql`/`repair_sql` (correctness-critical, tool-using) are the ones most likely to regress
local. The jaffle MDL is small and clean, so a capable local model may pass even all-local — that would
itself be a signal (the semantic layer makes cheap models reliable); teasing out a real tier gap needs a
harder schema (spike §7 risk #3). Record honestly.

## Live-gated (not run here) and why

This machine has neither ollama nor litellm installed, and `ANTHROPIC_BASE_URL` already points at a
local usage proxy. So the wire-level runs — **M0** (proxy→ollama one-shot), **M1** (whole-session swap),
**M2 live** (a real mixed run), **M3 live** (Pareto numbers) — are scripted and documented but not
executed. Everything that proves the *architecture* is offline and green:

- unit tests: `route.test.ts`, `models.test.ts`, `localClient.test.ts` (TS); `models_tests.rs` (Rust)
- the dry-run demo above (real IR, real CLI, both bindings)

Bring the infra up with `scripts/setup.sh` and follow the README to produce the live numbers.

## Risks confirmed (spike §7)

1. **M2 is real engineering, not config.** The hybrid-staged executor is a third, provider-aware
   realization path (isolated per-step invocation + marshaling), exactly as flagged. Kept minimal:
   no streaming/retries in the local client; **conditional** steps (e.g. `repair_sql`) are skipped in
   the staged POC (logged, not silent); a **realize-render** component under hybrid is a loud wall-hit
   rather than a silent drop (`answer_query`, the demo, is render-none).
2. **Proxy fidelity bounds M1/M3-live.** Anthropic-Messages-over-ollama tool-use/streaming through
   LiteLLM is the untested risk; M0 gates it before leaning on it.

## Acceptance (spike §6)

| criterion | status |
| --- | --- |
| IR / components / profile zero-diff | ✅ `git diff` touches only binding format + back-end + examples |
| M1: same IR, all-cloud & all-local both run | ⏳ live-gated (scripted; whole-session proxy path) |
| M2: single run, `resolve_intent` local + `generate_sql` cloud | ✅ routing proven offline (dry-run + tests); ⏳ live wire gated |
| M3: {all-cloud} vs {cheap→local} Pareto + verdict | ⏳ live-gated (ablation wired; methodology + configs ready) |
| invariants (routing not in composition, tiers model-free, borrowed generic) | ✅ |
| workspace green + clippy/fmt clean; tests cover binding parse + provider dispatch | ✅ |
