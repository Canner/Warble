<!-- warble-interactive-artifact target=claude-code:interactive profile=explore_model,answer_query,generate_dashboard,explain_change -->
# Running `analysis-agent` interactively

Read `.warble/interactive-launch.json` and start the native Claude Code TUI from its canonical `cwd` with its `argv`.

```sh
claude
```

That starts a native interactive session with no agent selected: a plain session in this directory, which has this profile's agents on disk but none of them in charge. Do not rely on it delegating to them by itself. Select the component whose behavior you want instead:

```sh
claude --agent explore_model
claude --agent answer_query
claude --agent generate_dashboard
claude --agent explain_change
```

The caller owns the PTY, prompt, transcript, and session lifecycle either way.

Agents emitted by this profile:

- `explore_model`
- `answer_query` — subagents: `answer_query__resolve_intent`, `answer_query__generate_sql`, `answer_query__repair_sql`
- `generate_dashboard` — subagents: `generate_dashboard__plan_dashboard`, `generate_dashboard__compose_layout`
- `explain_change`
