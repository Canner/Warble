---
title: CLI reference
description: "Every warble subcommand — compile, dispatch, render, manifest, mcp-serve, blast-radius, and eval — with flags and usage examples."
---

`warble` is one native binary covering the whole CLI-target path: a Warble project compiles to IR
JSON, IR dispatches to a runtime target (Claude Code agent files, or a vercel bundle), and a captured
agent envelope renders to a deterministic dashboard. Build it with `cargo build --release -p
warble-cli` (or `just release`); the binary lands at `target/release/warble`.

## `compile`

Compile a Warble project (profile + components + context binding) into IR JSON.

| Arg / flag | Description |
| --- | --- |
| `project_dir` (positional) | The Warble project directory. |
| `-o, --out <path>` | Where to write the IR JSON. |
| `--component-dir <path>` | An additional Local-precedence component source directory (immediate children are `<id>/component.yml`). Repeatable. This is how a host outside this checkout mounts its own component library alongside the Hub, e.g. a product-specific set of components. Local sources (this flag + the project's own `components/` dir) all outrank Hub, but two Local sources defining the same id is an ambiguous, loud-fail configuration — no rule says which wins. |
| `--hub-dir <path>` | Override the Hub component library root (defaults to this checkout's own `hub/components`). Lets a host point at a Hub library that lives outside this checkout. |

```bash
warble compile examples/render-demo -o ir.json
```

## `dispatch`

Dispatch a compiled IR to a runtime target: Claude Code agent files, Codex discovery artifacts, or
a vercel bundle.

The vercel target is a wholly separate back-end (its own IR type, no render-flavor/model-tier/
hybrid-realization knobs) — it branches off before any claude-code-specific flag parsing, and rejects
`--provider` if the target isn't vercel.

| Arg / flag | Description |
| --- | --- |
| `ir` (positional) | The compiled IR JSON file. |
| `--target <name>` | Target runtime: `claude-code:headless` (default) \| `claude-code:interactive` \| `codex:interactive` \| `vercel` \| `vercel:headless` \| `vercel:interactive`. |
| `--out <path>` | Output directory for the emitted agent/bundle. |
| `--render-flavor <flavor>` | *(claude-code target only)* Render flavor for render-contract components: `programmatic` (default) \| `prompt`. |
| `--models-config <path>` | *(claude-code target only)* Tier→model config YAML (a `tiers:` map). Takes precedence over the inline `--strong`/`--cheap`/`--orchestrator` flags when given. See [Tier-to-model binding spec](/reference/binding-spec). |
| `--strong <model>` | *(claude-code target only)* Model for the `strong` tier (inline tier→model binding; ignored if `--models-config` given). Default: `opus`. |
| `--cheap <model>` | *(claude-code target only)* Model for the `cheap` tier. Default: `haiku`. |
| `--orchestrator <model>` | *(claude-code target only)* Model for the per-step-tier driver's routing loop. Default: `sonnet`. |
| `--hybrid-realization <mode>` | *(claude-code target only)* How a HYBRID binding's local step is realized on the file target: `bash-script` (default) \| `mcp-server`. |
| `--context-injection <mode>` | *(claude-code target only)* Embed a deterministic schema digest only (`schema-only`, default), or the digest plus host-loaded business rules (`schema+knowledge`). Modes select normalized context facets, not a context provider. |
| `--context-project <path>` | *(claude-code target only)* Trusted bound-project override used by the current host adapter to load `knowledge/rules/*.md` for `schema+knowledge`; the caller must ensure it matches the project represented by the IR. Optional when the authored project path resolves relative to the IR file; otherwise `schema+knowledge` loud-fails rather than silently omitting rules. |
| `--purpose <name>` | *(native interactive targets only)* Closed native Sessions purpose: `analysis` \| `setup` \| `context_enrichment`. Requires `--native-scope`, validates the matching profile and materializable entry, and emits launch-spec v2 with dispatcher-authored vendor selection. With `--native-mcp`, emits the producer-owned v3 discovery contract. Omit to retain the v1 enrichment launch contract. Rejected by every non-native target. |
| `--native-scope <path>` | *(with native `--purpose` only)* Immutable server-derived scope JSON. Its `cwd` must canonically equal `--out`; `setup` requires a bootstrap scope, while analysis/context require an opaque bound-project identity plus generation and revision. The runtime uses those binding values for stale-binding validation before spawn. |
| `--native-mcp <path>` | *(with native `--purpose` only)* Exact server-derived native-session MCP descriptor JSON. Enables launch-spec v3 and producer-owned Claude/Codex discovery. It is closed to `{version:"1",url,credential}`: unknown or missing fields, malformed/non-HTTPS/non-bounded URLs, whitespace or control characters, and unsupported versions fail before output writes. |
| `--provider <path>` | *(vercel target only)* A provider fragment file (YAML) contributing domain capabilities + tool bindings on top of the base substrate profile — repeatable. The base vercel target resolves only substrate capabilities (llm tiers, render contract, approval, VCS, …); a bare dispatch with no `--provider` loud-fails any component that requires a domain capability (`sql_execution`, `genbi_build`, `scheduler`, …), naming which one is unresolved. |

```bash
# Claude Code file target
warble dispatch ir.json --target claude-code:headless --out agent \
    --render-flavor programmatic \
    --context-injection schema+knowledge --context-project path/to/wren-project

# vercel target, with a domain provider fragment
warble dispatch ir.json --target vercel --out bundle \
    --provider providers/genbi.yaml
```

### Native Sessions MCP discovery (launch-spec v3)

Pass `--native-mcp` only with a server-selected native `--purpose` and its matching
`--native-scope`. The descriptor is an exact, short-lived producer input:

```json
{
  "version": "1",
  "url": "https://mcp.example.test/native",
  "credential": "opaque-connection-credential"
}
```

Warble owns the vendor discovery artifacts and records them in
`.warble/interactive-ownership.json`: Claude receives `.mcp.json` with the fixed
`genbi_session` HTTP server and its bearer header; Codex receives
`.codex/config.toml` with that fixed server and the dedicated
`WARBLE_MCP_CONNECTION_CREDENTIAL` bearer-token environment variable. The host supplies the
opaque credential to that one Codex environment variable at native-process launch; it never
appends, rewrites, or otherwise claims either vendor configuration after materialization.

The v3 launch spec deliberately contains neither the descriptor credential/URL nor the native
scope's project identity, generation, or revision. The host resolves the opaque credential to its
live session, vendor, project, generation, revision, and capability binding server-side whenever
the MCP client connects. Rotate by issuing a new credential and materializing a fresh owned output
root; revocation is host-side rejection. For cleanup, delete discovery artifacts only when the
ownership marker and every manifest digest still match—modified, missing, collided, or symlinked
paths are not Warble-owned cleanup targets. Never log, copy into a prompt, or persist the raw
descriptor/credential in host-visible diagnostics.

### Setup recovery report (v1)

For a native `setup` dispatch with v3 discovery, the generated Claude and Codex Setup instructions
use the same `genbi_session.report_setup_recovery` tool contract. Its input is one closed object:

```json
{
  "version": "1",
  "sequence": 1,
  "phase": "connect",
  "state": "working",
  "code": "in_progress"
}
```

`version` is exactly `"1"`; `sequence` is a positive safe integer and must increase for each
report accepted by the host; `phase` is `connect` or `context`. The only valid state/code pairs are
`working`/`in_progress`, `needs_input`/`user_action_required`,
`needs_decision`/`continue_or_stop`, `retryable_failure`/`retryable`, and
`reported_complete`/`completion_reported`. `needs_decision` alone also requires exactly
`"decision": { "kind": "continue_or_stop", "choices": ["continue", "stop"] }`; a decision
is forbidden for every other state. Unknown fields and values are rejected. The contract contains
no free text, identity, paths, commands, prompts, credentials, tool payloads, or arbitrary options.

`reported_complete` is an agent report, never host-validated completion. The host owns
authentication, sequence fencing, durable projection, actions, and completion validation. Do not
infer reports from terminal bytes, process exit, or tool results; if the agent cannot truthfully
report, it may stay silent and the host records its own lifecycle outcome.

## `render`

Render a captured agent envelope into a self-contained `dashboard.html`.

| Arg / flag | Description |
| --- | --- |
| `input` (positional) | Envelope JSON file, or `-` for stdin. |
| `-o, --out <path>` | Where to write the HTML. |
| `--title <string>` | Optional dashboard title. |

```bash
warble render result.json --out dashboard.html
```

## `manifest`

Emit a profile's capability manifest from its IR.

| Arg / flag | Description |
| --- | --- |
| `ir` (positional) | The compiled IR JSON file. |
| `-o, --out <path>` | Write to this path instead of stdout. |

```bash
warble manifest ir.json
```

This is the target-agnostic capability manifest (a projection of the IR: declared capabilities,
component verbs, render contract). It is distinct from the `claude-agent-sdk` back-end's own
`manifest` subcommand (`warble-agent-sdk manifest`), which emits a **target-resolved**, bundle-shaped
display snapshot (resolved capabilities, steps, guardrails, output schema) for `claude-agent-sdk:local`.

The standalone `codex-local` dispatcher has the same kind of target-resolved manifest. Its public
surface is always `dispatch`, `manifest`, or `describe` plus the compiled IR; `--component` selects
a scoped component when required. It derives the supported Setup, analytical, or enrichment
execution contract from the parsed component's IR shape, not from a profile-named CLI verb. Like
the Agent SDK's own `manifest`, it is neither `warble manifest` nor reachable through `warble
dispatch --target` — see [Dispatching to a target](/guides/dispatching) for the full invocation.

## `mcp-serve`

Run the stdio MCP server for the file target's hybrid (`mcp-server`) realization: exposes a
`local_infer` tool that runs a binding's local step on an OpenAI-compatible endpoint. Registered by
the emitted `.mcp.json`; spawned by `claude` over stdio — not run by hand.

| Arg / flag | Description |
| --- | --- |
| `--steps <path>` | Path to the emitted `mcp-steps.json` (local step → endpoint/model/system). |

```bash
warble mcp-serve --steps agent/mcp-steps.json
```

## `blast-radius`

Compute a node's blast radius against a Warble project's bound wren project, and gate a pending
mutating apply against it. See [Blast radius](/reference/blast-radius) for the underlying
model.

| Arg / flag | Description |
| --- | --- |
| `project_dir` (positional) | The Warble project directory (contains `profile.yml` + `context/binding.yml`). |
| `--node <id>` | The lineage node id to compute the blast radius of (e.g. `model:orders`). |
| `--max-severity <level>` | Escalate when the radius severity is strictly above this: `none` \| `compatibility` \| `structural` \| `semantic`. |
| `--max-downstream <n>` | Escalate when the downstream count is strictly above this. |
| `--protected <ids>` | Comma-separated node ids that force a hard block if touched. Default: empty. |

Exit codes carry the decision so a caller can branch on it without parsing output: `0` = allow, `10`
= escalate (route to human approval), `11` = block (protected asset — no escalation path). A
resolution/parse error prints `error: ...` to stderr and exits `1`. Stdout is a single pretty-printed
JSON object: `{ "seed", "downstream", "severity", "decision", "reason" }`.

```bash
warble blast-radius examples/mutate-agent --node model:orders \
    --max-severity structural --max-downstream 5 --protected model:payments
```

## `eval`

Eval utilities for the tier/model ablation loop. This reference covers `eval compare` and `eval run`
— the two subcommands exercised by the day-to-day eval loop. Additional subcommands:

- `eval gate` — CI gate (G4): compares a candidate `eval run` report against a committed baseline
  and fails the build (non-zero exit) if a metric regresses beyond `--tolerance`.
- `eval ablate` — per-step tier ablation: holds every step at `--base-tier`, re-binds one named
  `llm_calls[]` step at a time to each swept tier, re-dispatches the IR, re-runs the goldens, and
  prints a per-step accuracy-vs-cost Pareto.
- `eval verify-context` — computes the git SHA of the bound MDL files and flags a mismatch against
  the golden's pinned `context_version` as stale (non-zero exit); `--stamp` re-pins to the current
  SHA, `--reverify --agent-dir <dir>` re-runs the goldens on the stale MDL to see which cases moved.
- `eval capture` — turns one confirmed run into a *candidate* golden case — never auto-accepted; a
  human moves it into the set.
- `eval compliance` — scores a dispatched agent's tool-call trace against the IR's declared
  guardrails: a pure, deterministic, zero-LLM check across the five checkable guardrails
  (`read_only_execution`, `must_dry_run`, `blast_radius_limit`, `human_approval`, `write_authz`);
  exits `1` on any violation, so it's as cheap to gate on every PR as a unit test.
- `eval monitor-report` — joins one clean and one injected `eval run --record-answers` report with
  the driftwood injection manifest, emits precision / recall / false-alarm / attribution metrics,
  and exits non-zero when the verified freshness pair or clean-baseline hard line fails.

Run `warble eval --help` for the full flag list on any of these.

### `eval compare`

Compare an expected vs actual result set. Reads a `CompareRequest` JSON from stdin and writes a
`CompareResult` JSON to stdout; exits non-zero when the comparison fails.

```bash
warble eval compare < request.json
```

### `eval run`

Replay golden questions through a dispatched agent under each tier→model binding and print a Pareto.

| Arg / flag | Description |
| --- | --- |
| `--project <path>` | A queryable wren project (connection + data); agent files are installed here for the run. |
| `--agent-dir <path>` | A dispatched agent output dir (contains `.claude/agents/…`). |
| `--golden <path>` | Golden cases YAML. |
| `--models <list>` | Comma-separated model bindings to ablate. Default: `opus,haiku`. |
| `--out <path>` | Write the full JSON report here. |
| `--parallel <n>` | Concurrent cases per binding (`1` = serial). `4`-`8` is a good speedup; note that under contention the per-case latency column also measures queueing. Default: `1`. |
| `--tags <list>` | Only run goldens carrying at least one of these tags (comma-separated). Empty = all. |
| `--sample <spec>` | Sub-sample the (tag-filtered) goldens for a smoke run: `N` (count), a fraction `0.2` / `20%`, or `per-tag[:K]` (`K` per tag; the smoke default). Omit for a full run. |
| `--no-cache` | Bypass the trace cache: re-run every case (new LLM calls) and refresh its cached result. Without this, cases whose `(case, agent, model, context)` is unchanged are re-scored from cache with 0 LLM calls, so changing only a golden's `expected` re-scores in seconds. |
| `--cache-dir <path>` | Trace cache directory. Default: `<project>/.warble/eval-cache`. |
| `--samples <n>` | Repeated samples per case (pass-rate methodology). `1` (default) is today's single-run behavior; `>1` distinguishes a genuinely flaky case from run-to-run noise. |
| `--record-answers` | Also record each sample's actual result-set value (not just pass/fail), so a flaky case's report shows a distinct-answer distribution. Off by default — heavier to store. |

```bash
warble eval run --project examples/jaffle-wren --agent-dir agent \
    --golden goldens.yaml --models opus,haiku --parallel 4
```

### `eval monitor-report`

Join the raw verdict envelopes preserved by two one-case live runs with their injection manifest:

```bash
warble eval monitor-report \
    --manifest driftwood-stopped_updates.manifest.yaml \
    --clean-report monitor-clean-report.json \
    --injected-report monitor-injected-report.json \
    --out monitor-report.json
```

The JSON report's `by_tag` carries `recall`, `precision`, `false_alarm_rate`, and
`attribution_accuracy`, each with its numerator and denominator. The command gates verified
clean/injected envelopes, a passing runner verdict for both halves, detection of the injected
freshness breach, zero clean-baseline false anomalies, and the manifest's severity label.
