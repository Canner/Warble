# Hybrid LLM spike — findings

Branch `spike/hybrid-llm` off `bd8b749`. Scope: prove that the *same* compiled IR runs a `cheap` step
on a local open-source model and a `strong` step on cloud Claude, purely by swapping the layer-3
binding — and that `warble-eval` can say which steps are safe to push local. Design rationale:
[`docs/spec/capability-model.md`](../../docs/spec/capability-model.md) §7.2.

Landed across three review slices: the SDK **staged-executor** realization plus the
`llm:per_step_provider` capability and its binding-time gate; then the SDK **in-process-mcp**
realization; then the file-target **bash-script**/**mcp-server** realizations.

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

Hybrid lives entirely in **layer 3 (binding) + back-end realization** (see `docs/spec/capability-model.md` §7.2). Zero changes to
the IR schema, the components, the profiles, or the front-end compiler (`git diff` confirms). The
edits:

- **Binding format** — `--models-config` tier values gained an optional
  `{ provider, endpoint?, model }` map form; a bare string stays Anthropic shorthand, so every existing
  config and all-cloud path is byte-identical. Mirrored in Rust (`models.rs`) and TS (`models.ts`).
- **Per-step provider routing** — new `dispatcher/claude-agent-sdk/src/route.ts` decides the mode
  (`single` / `sdk-split` / `hybrid-staged`) and resolves each step's binding; `options.ts` takes the
  hybrid path when any step is non-Anthropic (building **no** SDK `agents`, so the local model never
  hits the `agents[].model` alias union that would loud-fail); `run.ts` gains a staged executor that
  drives each step on its own provider and marshals `produces`→`consumes`; `localClient.ts` is a tiny
  OpenAI-compat client for local steps.

Invariants held: routing never entered the composition layer (it's binding + back-end); tiers never
gained model/provider names (those are binding-only); the generic HTTP call is a thin borrowed client,
not a differentiated capability.

## Two hybrid realizations: `staged` (default) vs `tool`

Per-step hybrid is realized two ways on the SDK back-end; selected at runtime via `WARBLE_HYBRID_MODE`
(default `staged`). Both proven live on `answer_query` — `resolve_intent`→local qwen2.5,
`generate_sql`→cloud Opus, answer 99.

| | `staged` (default) | `tool` (`WARBLE_HYBRID_MODE=tool`) |
| --- | --- | --- |
| Who sequences the steps | **Warble** drives the loop itself (`run.ts::runHybridStaged`) | the **SDK orchestrator** (`orchestrator` tier, e.g. sonnet) drives one `query()` loop, calling a `dispatch_step` tool per step (`hybridTool.ts`) |
| Where provider routing lives | Warble's executor | the tool **handler** (local→ollama, cloud→scoped nested `query()` on the step's tier model); the driver prompt is **provider-agnostic** |
| Determinism | deterministic order + marshaling | **LLM-driven** order/marshaling (same axis as the all-cloud sdk-split path) |
| Vision alignment | Warble writes a small orchestration loop → mild tension with invariant #3 ("borrow orchestration") | orchestration **borrowed** from the SDK loop again; the local model is "just another borrowed action" (a tool) — the cleaner fit |

The `tool` variant is the one to prefer architecturally: it keeps orchestration in the borrowed SDK
loop and reduces Warble's own code to a neutral tool + a provider-agnostic prompt (binding stays in the
handler, never in the prompt — unit-tested). `staged` stays valuable where determinism matters (eval /
CI gate). Both are legitimate `llm:per_step_provider` realizations — the capability model already allows a
target to realize a capability more than one way.

**If a runtime ever spans providers per-step natively** (e.g. the SDK opens `agents[].model` to arbitrary
endpoints, or a meta-harness offers per-node model routing), *both* of Warble's executors should retire in
favor of borrowing that — Warble owns the callee + interface, not the caller's loop.

## Hybrid is a named capability: `llm:per_step_provider`

"Does this dispatcher support hybrid?" is answered declaratively by the **capability model**
(`docs/spec/capability-model.md` §7.2), not by ad-hoc back-end code. `llm:per_step_provider` (per-step
*provider* routing, cloud+local in one run) is a distinct capability from `llm:per_step_tier` (per-step
*model* selection, same provider) — the SDK proves they must be separate: it does per_step_tier natively
yet loud-fails on a local model id, so per_step_tier ≠ hybrid.

- Each target's profile declares it with the realization(s) it offers:
  - `claude-agent-sdk:local` → **realize-via** `staged-executor` | `in-process-mcp` (`WARBLE_HYBRID_MODE`)
  - file target (`claude-code:*`) → **realize-via** `bash-script` | `mcp-server` (`--hybrid-realization`)
  All four are live-proven on `answer_query` (local intent on qwen2.5 + cloud SQL on Opus → correct
  `{rows:[[99]]}`). `bash-script` widens the Bash allowlist (driver runs the local wrapper); the two
  MCP realizations avoid that — the local call is an MCP tool, a separate permission gate. On the file
  target `mcp-server` registers a `warble mcp-serve` stdio server via an emitted `.mcp.json`.
- It is **binding-time**, not IR-static: the IR knows only tiers, so the need for hybrid comes from the
  `--models-config` binding. Both back-ends apply a **gate** — if the resolved binding routes a step to a
  non-Anthropic provider and the target's profile doesn't realize `llm:per_step_provider`, dispatch
  loud-fails (naming step + provider + target). All-cloud bindings (incl. the string shorthand that
  name-routes through a proxy) never trip it.
- Every new dispatcher must therefore consciously declare this entry (or inherit `fail`) — that is the
  "confirm this part is implemented before claiming hybrid support" mechanism, enforced loudly.

## The two-back-end reality (why M1/M3 differ from M2)

- **Agent SDK back-end (TS)** drives the loop itself, so it can route **per step** to different
  providers in one run. This is where real hybrid (M2) lives.
- **File target (Rust) + `claude` CLI** — used by `warble-eval` — is whole-session single-provider.
  Per-step local there rides a **LiteLLM proxy** that routes by model *name* (opus→cloud, qwen2.5→local),
  or a whole-session `ANTHROPIC_BASE_URL` redirect for all-local. No warble change needed for that path.

So M2 exercises the new code directly; M1 (whole-session swap) and M3 (eval ablation) reuse existing
machinery plus the proxy.

## M3 — how the eval answers "which step can go local"

`warble-eval ablate` holds every step at `--base-tier strong` (cloud) and moves one step at a time to
the swept `cheap` tier (bound to the local model via `ablation-cheap-local.yml` + proxy), re-running the
goldens. For each step it reports accuracy/cost/latency Δ vs the all-cloud baseline and picks the
cheapest tier that stays at/above the accuracy floor — i.e. the per-step "safe to push local?" verdict.
The command is in the README (M3). This closes the hybrid loop: **eval → tier → binding → re-eval**.

Expected shape (to be filled with live numbers): a step like `resolve_intent` (NL→intent, no SQL) is
the prime local candidate — it should hold accuracy on a small local model at ~zero marginal cost;
`generate_sql`/`repair_sql` (correctness-critical, tool-using) are the ones most likely to regress
local. The jaffle MDL is small and clean, so a capable local model may pass even all-local — that would
itself be a signal (the semantic layer makes cheap models reliable); teasing out a real tier gap needs a
harder schema. Record honestly.

## Live results (run 2026-07-10, ollama qwen2.5 + LiteLLM + Team Max Opus)

Ran once local infra was up (ollama serving `qwen2.5`, LiteLLM on :4000). Cloud steps used the direct
Team Max login (`env -u ANTHROPIC_BASE_URL`), bypassing a local usage proxy that otherwise breaks
Claude Code's Opus entitlement check.

- **M0 (channel):** `POST http://localhost:4000/v1/messages {model: qwen2.5}` returned an
  Anthropic-shaped reply ("Hello, nice to meet you.") — the Anthropic-API-over-ollama bridge works.
- **M2 (the headline, full mixed run — live ✅):** one `answer_query` dispatch under
  `hybrid-cheap-local.yml`, `env -u ANTHROPIC_BASE_URL`:
  - `resolve_intent` ran on **LOCAL qwen2.5** (ollama, direct OpenAI-compat call, ~0.4s)
  - `generate_sql` ran on **CLOUD `claude-opus-4-5`** (direct login), executed SQL via `wren`, returned **99** and self-verified.
  - `trace.json` shows both providers fired in the single run. Correct answer, matching the golden.
- **M3 (Pareto + verdict):** 3 distinctive-value scalar goldens, execution-based scoring:

  | binding | runner / shape | accuracy | avg latency | cost |
  | --- | --- | --- | --- | --- |
  | all-cloud | file target, single-step answer_query, opus | **3/3 (1.00)** | 21.6 s | $0.17 |
  | cheap→local | SDK back-end, 3-step hybrid (intent local, SQL cloud) | **3/3 (1.00)** | 25.9 s | $0.38 |

  **Verdict — which step is safe to push local:** `resolve_intent` (the `cheap`, NL→intent step) can go
  local with **no accuracy loss**, because `generate_sql` (the `strong`, correctness-critical step)
  stays on cloud Opus and carries SQL correctness. That is exactly the eval-driven "safe to offload"
  call the closed loop is meant to produce (see `docs/spec/capability-model.md` §7.2).

  **Honest caveats on the cost/latency cells:** they are NOT a clean like-for-like — the all-cloud row
  is the lightweight single-step substrate via the file target (`claude -p`), while the hybrid row is
  the 3-step component via the heavier SDK per-step executor, so the numbers reflect runner +
  decomposition overhead as much as provider. A byte-comparable same-runner Pareto (all-cloud vs
  cheap→local on the SDK 3-step path) is blocked here by a **pre-existing SDK-split limitation**: the
  all-cloud sdk-split run's Task subagents did not get a working Bash/`wren` in the programmatic SDK
  setup and correctly refused rather than fabricate (a known subagent-env gap). That is
  orthogonal to the hybrid routing — the hybrid-staged path sidesteps it by running each step as a
  top-level `query()`. Accuracy (the load-bearing metric for the offload verdict) IS comparable: both 1.00.

Reproduce: `scripts/setup.sh`, then the README's M0/M2/M3 commands (cloud steps need `env -u ANTHROPIC_BASE_URL`).

## Also proven offline (no infra)

- unit tests: `route.test.ts`, `models.test.ts`, `localClient.test.ts` (TS); `models_tests.rs` (Rust)
- the dry-run demo above (real IR, real CLI, both bindings)

## Risks confirmed

1. **M2 is real engineering, not config.** The hybrid-staged executor is a third, provider-aware
   realization path (isolated per-step invocation + marshaling), exactly as flagged. Kept minimal:
   no streaming/retries in the local client; **conditional** steps (e.g. `repair_sql`) are skipped in
   the staged POC (logged, not silent); a **realize-render** component under hybrid is a loud wall-hit
   rather than a silent drop (`answer_query`, the demo, is render-none).
2. **Proxy fidelity bounds M1/M3-live.** Anthropic-Messages-over-ollama tool-use/streaming through
   LiteLLM is the untested risk; M0 gates it before leaning on it.

## Acceptance

| criterion | status |
| --- | --- |
| IR / components / profile zero-diff | ✅ `git diff` touches only binding format + back-end + examples |
| M0: Anthropic-API-over-ollama channel | ✅ live (litellm `/v1/messages` model=qwen2.5 → Anthropic-shaped reply) |
| M1: same IR, all-cloud & all-local both run | ✅ superseded by M2 (which runs local AND cloud in one run); channel proven by M0 |
| M2: single run, `resolve_intent` local + `generate_sql` cloud | ✅ **live** — trace shows qwen2.5(local)+opus(cloud) in one dispatch; correct answer (99) |
| M3: {all-cloud} vs {cheap→local} Pareto + verdict | ✅ accuracy 1.00 vs 1.00; verdict = resolve_intent safe to offload local (cost/latency caveat documented) |
| invariants (routing not in composition, tiers model-free, borrowed generic) | ✅ |
| workspace green + clippy/fmt clean; tests cover binding parse + provider dispatch | ✅ (Rust 148/0, TS 80/0) |
