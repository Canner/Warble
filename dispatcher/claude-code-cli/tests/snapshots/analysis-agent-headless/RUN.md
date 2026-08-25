# Running `analysis-agent`

Run each agent from this directory (so `.claude/` and `.wren/` are picked up).

This profile emits 4 component agents; each is invoked on its own.

- Bound wren project: `../jaffle-wren`

## `explore_model`

```sh
claude -p "<data question>" --agent explore_model
```

- Trigger: `one_shot` (single headless invocation, no scheduling/event wiring in this POC).

## `answer_query`

```sh
claude -p "<data question>" --agent answer_query
```

- Trigger: `one_shot` (single headless invocation, no scheduling/event wiring in this POC).
- Per-step tiers are realized as subagents (`answer_query__resolve_intent`=haiku, `answer_query__generate_sql`=opus, `answer_query__repair_sql`=opus); the driver (sonnet) only routes + marshals between them via the Task tool.

## `generate_dashboard`

```sh
# 1. run the agent (read-only) and capture its render envelope
claude -p "<data question>" --agent generate_dashboard --output-format json > result.json
# 2. render the captured envelope to a dashboard deterministically
warble render result.json --out dashboard.html
```

- Trigger: `one_shot` (single headless invocation, no scheduling/event wiring in this POC).
- Per-step tiers are realized as subagents (`generate_dashboard__plan_dashboard`=opus, `generate_dashboard__compose_layout`=haiku); the driver (sonnet) only routes + marshals between them via the Task tool.
- Render output: `generate_dashboard` stays fully read-only and emits a `{ blocks, summary }` render envelope as its final message; `warble render` turns that into `dashboard.html` deterministically (no LLM in the render step).

## `explain_change`

```sh
# 1. run the agent (read-only) and capture its render envelope
claude -p "<data question>" --agent explain_change --output-format json > result.json
# 2. render the captured envelope to a dashboard deterministically
warble render result.json --out dashboard.html
```

- Trigger: `one_shot` (single headless invocation, no scheduling/event wiring in this POC).
- Render output: `explain_change` stays fully read-only and emits a `{ blocks, summary }` render envelope as its final message; `warble render` turns that into `dashboard.html` deterministically (no LLM in the render step).
