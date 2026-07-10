# Hybrid LLM (local + cloud) — spike example

**One sentence:** the *same* compiled `answer_query` IR runs its `cheap` step on a local open-source
model (ollama) and its `strong` step on cloud Claude, in one run — and `warble eval` measures which
steps are safe to push local. Only the injected `--models-config` (layer-3 binding) differs between
all-cloud and hybrid; the IR, components, and profile never change.

> Design source of truth: `plans/warble-framework/impl-plans/spike-hybrid-llm.md` (D1–D7, M0–M3).
> Findings: [`FINDINGS.md`](./FINDINGS.md). This README is the runbook.

## What "hybrid" means here

Two axes are split (vision §9.2): a component's steps declare a **tier** (`cheap`/`strong`) — git-static,
portable, in the IR — and a deployment **binding** maps each tier to a concrete
`{provider, endpoint, model}` — runtime-injected, in `--models-config`, never in git. Cloud-vs-local
lives entirely on the binding axis. Swap the binding, the same IR runs cloud or local.

Two providers, two realizations:

| provider | how a step runs | binding example |
| --- | --- | --- |
| `anthropic` | the Claude Agent SDK loop (`query()`) — subscription or API key | `strong: opus` |
| `openai_compat` | a direct OpenAI-compatible call (e.g. ollama `/v1`) the back-end makes itself | `cheap: { provider: openai_compat, endpoint: …, model: qwen2.5 }` |

A local step **cannot** ride the SDK's `agents[].model` (a restricted `sonnet\|opus\|haiku\|inherit`
alias union that loud-fails on a local id). So when any step binds to a non-Anthropic provider, the
back-end drives the steps itself — one isolated invocation per step, marshaling `produces`→`consumes`
between them (the `hybrid-staged` mode). All-cloud paths are unchanged.

## Bindings in this folder

| file | what | consumed by |
| --- | --- | --- |
| `bindings/all-cloud.yml` | reference: every tier → cloud Claude | both back-ends |
| `bindings/hybrid-cheap-local.yml` | **the headline**: `cheap`→ollama, `strong`→cloud | Agent SDK back-end (per-step) |
| `bindings/all-local-direct.yml` | every tier → ollama, via direct routing (no proxy) | Agent SDK back-end |
| `bindings/ablation-cheap-local.yml` | string form for `warble eval ablate` (proxy per-name routing) | file target + LiteLLM |
| `litellm-config.yaml` | Anthropic-API-over-ollama proxy (M1 whole-session; M3 per-name routing) | `claude` runtime |

---

## Offline proof (no ollama, no Claude needed) — run this first

`scripts/dryrun-demo.sh` compiles nothing live: it slices the committed `answer_query` node out of
`genbi-default/ir.golden.json` and dry-runs the Agent SDK back-end under both bindings, printing the
per-step provider routing. This is the architectural claim, verifiable on any machine:

```bash
examples/hybrid-llm/scripts/dryrun-demo.sh
```

Expected: all-cloud → `sdk-split` (3 Claude subagents); hybrid → `hybrid-staged`, `resolve_intent`
on LOCAL qwen2.5, `generate_sql`/`repair_sql` on CLOUD opus — same IR, no SDK agents on the hybrid path.

The routing decision, binding parse, and marshaling are also unit-tested (offline):
`dispatcher/claude-agent-sdk/tests/{route,models,localClient}.test.ts` and
`dispatcher/claude-code-cli/tests/models_tests.rs`.

---

## Live runs (gated on local infra)

**Quick reproduce (scripts):** once `scripts/setup.sh` has ollama + LiteLLM up and you have a wren
DuckDB profile for jaffle (default name `jaffle-shop`):

```bash
examples/hybrid-llm/scripts/live-m2.sh          # full mixed run: intent local, SQL cloud (one dispatch)
examples/hybrid-llm/scripts/live-m3.sh          # all-cloud baseline vs cheap→local Pareto + verdict
```

Both bypass the local usage proxy for the cloud step (`env -u ANTHROPIC_BASE_URL`) so Opus is used via
your direct login. `setup-queryable-jaffle.sh` builds the queryable project they depend on. The manual
commands below spell out each step.

Prereqs: [ollama](https://ollama.com) serving a model, Python `litellm[proxy]`, and a Claude
subscription/API key for the cloud steps. `scripts/setup.sh` installs/pulls what it can.

```bash
# 0. bring up the local model + proxy
ollama serve &                       # http://localhost:11434
ollama pull qwen2.5                  # or a smaller tag, e.g. qwen2.5:0.5b, to prove the channel
pip install 'litellm[proxy]'
litellm --config examples/hybrid-llm/litellm-config.yaml --port 4000 &
```

### M0 — channel check (proxy → ollama, one sentence)

```bash
ANTHROPIC_BASE_URL=http://localhost:4000 claude -p "say hello in five words"
```
Proves LiteLLM's Anthropic API over ollama answers. If tool-use/streaming is flaky here, that bounds
how far the whole-session all-local path (M1) can go — note it, then continue.

### M1 — whole-session binding swap (same IR, cloud vs local)

Same dispatch, twice; only `ANTHROPIC_BASE_URL` changes. (Uses the file target / `claude` CLI.)
```bash
warble compile eval/answer-agent -o /tmp/aq.ir.json
warble dispatch /tmp/aq.ir.json --out /tmp/aq-agent           # tier→model = default aliases
# all-cloud:
(cd <queryable-jaffle-project> && claude -p "how many orders?" --agent answer_query --allowedTools Read 'Bash(wren:*)')
# all-local: point the whole session at the proxy (litellm-config.yaml M1 block → ollama)
ANTHROPIC_BASE_URL=http://localhost:4000 (cd <queryable-jaffle-project> && claude -p "how many orders?" --agent answer_query --allowedTools Read 'Bash(wren:*)')
```
Local accuracy may be poor — the point is portability + channel, not accuracy.

### M2 — per-step hybrid (the spike body)

The Agent SDK back-end routes per step from `hybrid-cheap-local.yml`: `cheap` → ollama directly,
`strong` → cloud Claude, marshaling state between them.
```bash
# slice answer_query into a standalone IR (the full genbi-default IR also has a realize-render
# component, which is out of hybrid-staged POC scope):
node -e "const ir=require('./genbi-default/ir.golden.json'); ir.components=ir.components.filter(c=>c.verb==='answer_query'); require('fs').writeFileSync('/tmp/aq.ir.json',JSON.stringify(ir))"
cd dispatcher/claude-agent-sdk
npx tsx src/cli.ts dispatch /tmp/aq.ir.json "how many orders?" \
  --models-config ../../examples/hybrid-llm/bindings/hybrid-cheap-local.yml \
  --project <queryable-jaffle-project> --out ./run-hybrid
# trace.json shows each step's provider+model → proves ollama AND cloud Claude were both called.
```
Add `--dry-run` (no `"question"`, no infra) to inspect the plan without calling anything.

### M3 — eval Pareto ({all-cloud} vs {cheap→local})

`warble eval ablate` re-dispatches one step at a time and scores the goldens. It drives the file
target, so per-step local rides the LiteLLM proxy's per-name routing (point `ANTHROPIC_BASE_URL` at
the proxy with the M3 model_list block active):
```bash
warble compile genbi-default -o /tmp/genbi.ir.json    # or eval/answer-agent for the single-step substrate
ANTHROPIC_BASE_URL=http://localhost:4000 \
warble eval ablate --project <queryable-jaffle-project> --ir /tmp/genbi.ir.json \
  --golden eval/golden/jaffle/cases.yaml \
  --models-config examples/hybrid-llm/bindings/ablation-cheap-local.yml \
  --base-tier strong --sweep strong,cheap --out /tmp/ablation.json
```
Output: per-step accuracy/cost/latency Δ and a "cheapest tier at/above the accuracy floor" verdict per
step — i.e. which steps are safe to push local. See [`FINDINGS.md`](./FINDINGS.md).
