---
title: Hybrid local + cloud inference
description: "How to run one profile with a cheap step on a local OpenAI-compatible endpoint and a strong step on cloud Claude in the same run, by swapping only the --models-config binding."
---

Hybrid inference means one dispatched agent runs some steps against a local model and others
against cloud Claude, in the same run, with **no change to the compiled IR**. Tier
(`strong`/`cheap`) is git-static — it's authored in the component and lands unchanged in the IR;
which concrete model and provider each tier resolves to is a dispatch-time binding. See
[Tiers & model binding](/concepts/tiers-and-model-binding) for why that split exists.

## The binding

Write a `--models-config` YAML that routes `cheap` to a local, OpenAI-compatible endpoint (e.g.
ollama) and `strong` to cloud Claude:

```yaml
# hybrid-cheap-local.yml
tiers:
  strong: opus
  cheap:
    provider: openai_compat
    endpoint: http://localhost:11434/v1
    model: qwen2.5
  orchestrator: sonnet
```

`provider` is an open string — `openai_compat` is one of two names Warble gives special parsing to
(it requires `endpoint`); anything else passes through opaquely. See the
[binding spec](/reference/binding-spec) for the full shape.

**1. Dispatch with the hybrid binding**

```bash
warble dispatch ir.json --target claude-code:headless --out agent \
    --models-config hybrid-cheap-local.yml \
    --hybrid-realization mcp-server
```

`--hybrid-realization` picks how the file target realizes the local step: `bash-script` (default —
an emitted Bash script the driver runs, needs `Bash(bash:*)` in the allowlist) or `mcp-server` (the
local step becomes an MCP tool call, with no bash widening needed).

**2. Run the driver — the MCP server is spawned for you**

On `mcp-server`, dispatch also emits a `.mcp.json` registering `warble mcp-serve` as a stdio MCP
server, plus the `mcp-steps.json` it reads (local step → endpoint/model/system). You never run
`warble mcp-serve` yourself — `claude` spawns it over stdio when the agent starts, driven by the
emitted config:

```bash
claude -p "How many orders are there in total?" --agent answer_query \
    --mcp-config agent/.mcp.json \
    --allowedTools Read "Bash(wren:*)" "mcp__warble__local_infer"
```

The agent calls the `mcp__warble__local_infer` tool for the local (`cheap`) step and drives its own
cloud turns for everything else; `warble mcp-serve --steps agent/mcp-steps.json` is the
process `claude` launches under the hood.

:::note
On `bash-script`, skip `--mcp-config` and widen the allowlist to `Bash(bash:*)` instead — the local
step runs as an emitted script rather than an MCP call. Both realizations read the same
`--models-config` binding; only how the local step is invoked differs.
:::

## Why this doesn't touch the IR

The component's steps still just declare `tier: cheap` / `tier: strong` — nothing in the profile,
component, or compiled IR names `qwen2.5`, `ollama`, or `opus`. Swapping the binding file is enough
to move a step between providers, which is also what makes the eval loop's tier→model ablation
possible without recompiling anything (`warble-eval run --models opus,haiku`). See
[Evaluating a profile](/guides/evaluating) for that loop, and the
`examples/hybrid-llm` project in the repo for a complete worked setup (ollama + a queryable
jaffle project) exercising both realizations end to end.
