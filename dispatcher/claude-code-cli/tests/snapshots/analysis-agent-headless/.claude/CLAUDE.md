# Warble scope: `analysis-agent`

This directory is a materialized Warble profile. It is a scope, not an agent: the behavior lives in the agents below, and every session started here runs under this scope's binding and limits. Work that one of these agents covers belongs to that agent — select it rather than reproducing its job yourself.

## Binding

- Semantic project: `../jaffle-wren`
- Data access goes through the `wren` CLI. The data layer runs in strict mode and denies `pg_read_file`, `dblink`, `lo_import` (`.wren/config.json`).

## Agents in this scope

- `explore_model` — Survey the bound semantic model and report what can be asked of it — its models, metrics, dimensions and grain — without querying any rows. Use it to orient before analysis, or when someone asks what data is available; it answers questions *about* the model, not questions *from* the data.
- `answer_query` — Answer one natural-language question about the bound semantic model: resolve the intent, generate SQL against the semantic layer, run it read-only, and repair the query if it fails. Returns a result table with the definitions it relied on. Use it for a single question with a single answer, not for a multi-panel overview. (its steps run as `answer_query__resolve_intent`, `answer_query__generate_sql`, `answer_query__repair_sql`)
- `generate_dashboard` — Build a multi-panel dashboard on a topic: plan which panels answer it, run each panel's query read-only, and compose them into one laid-out result of KPI cards, tables and charts. Use it when someone wants an overview of a subject from several angles rather than one specific answer. (its steps run as `generate_dashboard__plan_dashboard`, `generate_dashboard__compose_layout`)
- `explain_change` — Explain why a metric moved: decompose the change across time and the dimensions that drive it, then report the contributing drivers as a narrative. Needs an additive metric with a time dimension; the specific metric's additivity is checked at run time. Use it for causal "why did this move" questions, not for retrieving the number itself.

An agent named `<agent>__<step>` is one agent's internal step, not an entry point; its own agent drives it.

## Permissions

`.claude/settings.json` pre-approves tools so the session does not prompt for them; it does not restrict what a tool does, and each agent's own `tools:` list decides which of them that agent may use.
Destructive shell patterns (`rm`, `sudo`, `dd`) are denied outright for every agent here.
