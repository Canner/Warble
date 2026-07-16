---
title: Enforcing safe mutations
description: "How to run warble blast-radius to gate a pending mutating apply, read its Allow/Escalate/Block decision, and cap severity or downstream count with --max-severity / --max-downstream / --protected."
---

`warble blast-radius` computes a node's downstream lineage closure and turns it into a gate
decision a mutating component's apply can branch on. For the underlying query and severity model,
see [Blast radius & enforcement](/concepts/blast-radius); this page covers running the gate itself.

**1. Compute the radius of a candidate change**

```bash
warble blast-radius examples/jaffle-wren --node model:orders \
    --max-severity structural --max-downstream 5 --protected model:payments
```

`project_dir` is a Warble project directory (contains `profile.yml` + `context/binding.yml`);
`--node <id>` is the lineage node id to compute the radius of, e.g. `model:orders` or
`metric:revenue.total_revenue`.

**2. Read the decision off the exit code**

The exit code carries the decision so a caller can branch on it without parsing output:

| Exit code | Decision |
| --- | --- |
| `0` | Allow |
| `10` | Escalate — route to human approval |
| `11` | Block — a protected asset was touched, no escalation path |

A resolution/parse error prints `error: ...` to stderr and exits `1` — distinct from all three gate
outcomes. Stdout, on a successful run, is a single pretty-printed JSON object:
`{ "seed", "downstream", "severity", "decision", "reason" }`.

## The two knobs that trigger an escalation

- **`--max-severity <level>`** — escalate when the computed radius severity is strictly above this
  level. Accepts `none`, `compatibility`, `structural`, or `semantic`, in that ascending order (a
  downstream metric — `semantic` — is the most dangerous, because it changes numbers without
  erroring).
- **`--max-downstream <n>`** — escalate when the downstream node count is strictly above `n`,
  independent of severity. A change touching many `structural` nodes can escalate on count alone
  even if no single node is `semantic`.

Either threshold being exceeded routes to `Escalate` (exit `10`), not an automatic block — the
apply still needs a human approval channel to actually go through, per the `data_write`
enforcement point in [Enforcement seam](/reference/enforcement-seam).

## `--protected` — a hard floor, not a threshold

`--protected <ids>` is a comma-separated list of node ids that force `Block` (exit `11`) the moment
the radius touches any of them, regardless of where severity or downstream count land. There's no
escalation path for a protected hit — it's not "ask a human," it's "this asset does not move
without an explicit change to the guardrail itself." Use it for the assets you never want gated by
threshold alone: a finance-facing dashboard, a metric feeding a compliance report.

:::warning
Safety-critical guardrails never silently degrade. If a mutating component's target has no human
approval channel wired up, the gate's `Escalate` decision has nowhere to route to fail-closed
rather than assumed-approved — a headless target with `human_approval` unresolved is a
compile-time loud-fail, not a skipped step. The gate deciding `Allow`/`Escalate`/`Block` and the
apply actually being authorized are two separate checks; clearing blast-radius doesn't bypass the
approval `data_write` otherwise demands.
:::

## Where this fits in a mutating component's lifecycle

The gate runs **between dry-run and apply** — a mutating component computes the radius of its
intended change first, and only proceeds to the actual write if the decision is `Allow` (or an
`Escalate` clears human approval). This composes with the other enforcement points rather than
replacing them: `data_write` still governs whether the write is authorized at all; blast-radius
answers the narrower question of whether it's *safe*, given what's downstream. See
[Blast radius & enforcement](/concepts/blast-radius) for the mental model and
[Blast radius reference](/reference/blast-radius) for the exact graph types, node-id scheme, and
the current, deliberate limits on what the lineage graph reaches.
