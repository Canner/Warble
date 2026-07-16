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

Dispatch a compiled IR to a runtime target: Claude Code agent files, or a vercel bundle.

The vercel target is a wholly separate back-end (its own IR type, no render-flavor/model-tier/
hybrid-realization knobs) — it branches off before any claude-code-specific flag parsing, and rejects
`--provider` if the target isn't vercel.

| Arg / flag | Description |
| --- | --- |
| `ir` (positional) | The compiled IR JSON file. |
| `--target <name>` | Target runtime: `claude-code:headless` (default) \| `claude-code:interactive` \| `vercel` \| `vercel:headless` \| `vercel:interactive`. |
| `--out <path>` | Output directory for the emitted agent/bundle. |
| `--render-flavor <flavor>` | *(claude-code target only)* Render flavor for render-contract components: `programmatic` (default) \| `prompt`. |
| `--models-config <path>` | *(claude-code target only)* Tier→model config YAML (a `tiers:` map). Takes precedence over the inline `--strong`/`--cheap`/`--orchestrator` flags when given. See [Tier-to-model binding spec](/reference/binding-spec). |
| `--strong <model>` | *(claude-code target only)* Model for the `strong` tier (inline tier→model binding; ignored if `--models-config` given). Default: `opus`. |
| `--cheap <model>` | *(claude-code target only)* Model for the `cheap` tier. Default: `haiku`. |
| `--orchestrator <model>` | *(claude-code target only)* Model for the per-step-tier driver's routing loop. Default: `sonnet`. |
| `--hybrid-realization <mode>` | *(claude-code target only)* How a HYBRID binding's local step is realized on the file target: `bash-script` (default) \| `mcp-server`. |
| `--provider <path>` | *(vercel target only)* A provider fragment file (YAML) contributing domain capabilities + tool bindings on top of the base substrate profile — repeatable. The base vercel target resolves only substrate capabilities (llm tiers, render contract, approval, VCS, …); a bare dispatch with no `--provider` loud-fails any component that requires a domain capability (`sql_execution`, `genbi_build`, `scheduler`, …), naming which one is unresolved. |

```bash
# Claude Code file target
warble dispatch ir.json --target claude-code:headless --out agent \
    --render-flavor programmatic

# vercel target, with a domain provider fragment
warble dispatch ir.json --target vercel --out bundle \
    --provider providers/genbi.yaml
```

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

- `eval gate` — the CI eval gate: runs the golden suite and fails the build if scores regress.
- `eval ablate` — sweeps a tier→model binding across multiple values in one invocation.
- `eval verify-context` — checks a project's `context_precondition`s resolve before running goldens
  against it.
- `eval capture` — records a dispatched agent's run as a trace for later comparison.

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

```bash
warble eval run --project examples/jaffle-wren --agent-dir agent \
    --golden goldens.yaml --models opus,haiku --parallel 4
```
