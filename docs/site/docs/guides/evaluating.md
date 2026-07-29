---
title: Evaluating a profile
description: "How to use warble-eval run to Pareto-compare tier→model bindings over golden cases, and warble-eval compare for a single expected-vs-actual result-set check."
---

`warble-eval` exercises the tier/model ablation loop described in
[Tiers & model binding](/concepts/tiers-and-model-binding): the same dispatched agent, replayed
against different `--models-config` bindings, to see which is cheapest without losing accuracy.
This page covers the two subcommands in the day-to-day loop — `eval run` and `eval compare`. (A few
more subcommands — `ablate`, `verify-context`, `capture`, `gate` — exist for the CI eval gate; run
`warble-eval --help` for the full list.)

## `warble-eval run` — replay goldens, print a Pareto

**1. Have a dispatched agent and a golden set**

`--agent-dir` needs a `warble dispatch` output (contains `.claude/agents/…`); `--project` needs a
queryable wren project — agent files get installed there for the run.

**2. Run it**

```bash
warble-eval run --project examples/jaffle-wren --agent-dir agent \
    --golden goldens.yaml --models opus,haiku --parallel 4
```

`--models` is the comma-separated list of bindings to ablate (default `opus,haiku`); each golden
case runs once per binding, and the Pareto printed at the end compares them on accuracy, cost, and
latency. `--parallel <n>` runs that many cases concurrently per binding — `4`–`8` is a reasonable
speedup, but note that under contention the per-case latency column is also measuring queueing, not
pure model latency.

**3. Narrow or sample for a fast inner loop**

```bash
warble-eval run --project examples/jaffle-wren --agent-dir agent \
    --golden goldens.yaml --tags smoke --sample per-tag:3
```

`--tags` restricts to goldens carrying at least one of the listed tags (empty = all). `--sample`
sub-samples the tag-filtered set for a smoke run: a bare count (`20`), a fraction (`0.2` or `20%`),
or `per-tag[:K]` (`K` per tag — this is the smoke default). Use `--out <path>` to also keep the full
JSON report.

:::tip
Every case result is keyed by `(case, agent, model, context)` in a **trace cache**
(`--cache-dir`, default `<project>/.warble/eval-cache`). An unchanged key re-scores from cache with
**0 LLM calls**, so editing only a golden's `expected` field re-scores in seconds instead of
re-running the model. Pass `--no-cache` to bypass the cache entirely and force fresh LLM calls,
refreshing the cached result as it goes.
:::

## `warble-eval compare` — one expected-vs-actual check

`compare` is the per-case result-set scorer `eval run` uses under the hood — it isn't the CI gate
itself; that's the separate `eval gate` subcommand (see the [CLI reference](/reference/cli)). To
exercise the scorer directly for a single result-set comparison, pipe a `CompareRequest` JSON in on
stdin:

```bash
warble-eval compare < request.json
```

It writes a `CompareResult` JSON to stdout and exits non-zero when the comparison fails — wire it
straight into a CI step without parsing prose.

:::note
Both subcommands assume you already have a dispatched agent to run against — see
[Dispatching to a target](/guides/dispatching) if you haven't emitted one yet. For every flag on
every `eval` subcommand, see the [CLI reference](/reference/cli).
:::
