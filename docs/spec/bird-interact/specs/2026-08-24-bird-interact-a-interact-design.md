# BIRD-Interact a-interact Eval Design

## Goal

Add a BIRD-Interact Lite evaluation to Warble that measures a Warble data agent
using Wren against the official `a-interact` protocol. The resulting score must
be produced by BIRD's official database environment and scorer, not Warble's
one-shot golden-table comparator.

## Ownership boundary

- BIRD owns task loading, the user simulator, per-task databases, action
  observations, phase transitions, ground truth, and scoring.
- Warble owns the system-agent service, compiled agent behavior, model session,
  allowed tool surface, action trace, and run metadata.
- Wren owns semantic SQL planning. It does not own benchmark state or scoring.

The official BIRD orchestrator keeps its existing `system_agent` HTTP boundary.
Warble supplies a replacement service that implements `/init_session`,
`/run_session`, and `/health`. The official user-simulator and DB-environment
services remain unchanged.

The executable upstream reference is pinned to BIRD-Interact commit
`451fe2c3518ee1cf908d8139e2913483bd519381`. Upgrading that pin is an explicit
eval-contract change: the compatibility fixtures and differential test must be
regenerated and reviewed at the same time.

## Repository layout

All implementation lives in the Warble repository:

```text
eval/
  bird-interact/
    README.md
    package.json
    tsconfig.json
    src/
      cli.ts
      server.ts
      session.ts
      protocol.ts
      bird-client.ts
      wren-planner.ts
      tools.ts
      types.ts
    tests/
      protocol.test.ts
      wren-planner.test.ts
      tools.test.ts
      server.test.ts
  bird-interact-agent/
    profile.yml
    context/binding.yml
    components/bird_interact/component.yml
    components/bird_interact/steps/solve.md
```

The implementation is an isolated TypeScript package. It consumes the existing
`@warble/claude-agent-sdk` package and the Anthropic Agent SDK instead of adding
BIRD-specific branches to the generic Rust golden runner.

## Executable protocol contract

The adapter exposes only these nine model-callable tools:

| Tool | Bird-coin cost | Destination |
| --- | ---: | --- |
| `execute_sql` | 1 | Wren planner, then BIRD `/execute` |
| `get_schema` | 1 | BIRD `/schema` |
| `get_all_column_meanings` | 1 | BIRD `/all_column_meanings` |
| `get_column_meaning` | 0.5 | BIRD `/column_meaning` |
| `get_all_external_knowledge_names` | 0.5 | BIRD `/knowledge_names` |
| `get_knowledge_definition` | 0.5 | BIRD `/knowledge` |
| `get_all_knowledge_definitions` | 1 | BIRD `/knowledge` |
| `ask_user` | 2 | user simulator `/ask` |
| `submit_sql` | 3 | Wren planner when applicable, then BIRD `/submit` |

The adapter deducts cost before executing a tool. When a non-submit action is
unaffordable it is rejected and the agent is instructed to call `submit_sql`.
The rejected action is not executed, does not reduce `budget_remaining`, and is
not added to the official-compatible `tool_trajectory`; an additive
`rejected_actions` diagnostic may record it with `charged: false`. An
unaffordable `submit_sql` is allowed as the final free exit and sets
`budget_remaining` to `-1`, matching the pinned ADK callback. A submit that
reduces the budget exactly to zero also stores `-1`. Every successfully invoked
tool response includes the remaining-budget note while the resulting budget is
non-negative.

The initial budget is provided by the official orchestrator in `/init_session`
state. Warble records it but does not recalculate or override it. A pure helper
will also implement the current official formula for contract tests and local
diagnostics:

```text
6 + 2 * (critical ambiguity count + knowledge ambiguity count) + 2 * patience
```

## Session and phase behavior

One task maps to one in-memory Warble session keyed by `task_id`. A reset init
replaces an existing task session. A subsequent run resumes the prior Agent SDK
session when a session id exists.

`submit_sql` updates the state returned by BIRD:

- a phase-1 pass adds the returned reward, marks phase 1 complete, and changes
  the current phase to 2 when a follow-up exists;
- the follow-up question is returned in the tool result so the same model run
  can continue with the same conversation and ledger;
- a phase-2 pass marks the task complete;
- a failed submission leaves the phase open when budget remains;
- any submission made as the free budget-exhaustion exit ends the task after
  the submission result is recorded.

The DB-environment `/submit` response is authoritative for correctness and
phase outcome. Its pinned schema is:

```text
passed: boolean
message: string
reward: number = 0
phase_completed: 1 | 2 | null
has_follow_up: boolean = false
follow_up_query: string | null
```

Warble never derives a pass, phase, or reward from SQL. It only mirrors the
pinned official system-agent state transitions from that response. Warble may
mutate `total_reward`, `phase1_completed`, `phase2_completed`, `current_phase`,
`task_done`, and `_last_submit_raw` as follows:

- `passed=false`: store `_last_submit_raw`; do not change phase flags or reward;
- `passed=true, phase_completed=1, has_follow_up=true`: add the returned reward,
  set `phase1_completed=true`, set `current_phase=2`, keep `task_done=false`, and
  call user-simulator `/phase_transition`;
- `passed=true, phase_completed=1, has_follow_up=false`: add the reward, set
  `phase1_completed=true`, set `current_phase=2`, and set `task_done=true`;
- `passed=true, phase_completed=2`: add the reward, set
  `phase2_completed=true`, and set `task_done=true`.

After any real submission, a negative remaining budget prevents another model
turn. This can terminate immediately after a successful phase-1 submission
even when BIRD returned a follow-up, exactly as the pinned callback's
`before_model_callback` does. The adapter never evaluates SQL correctness
itself.

The system-agent HTTP compatibility schemas at the pinned commit are:

```text
POST /init_session
request:  {task_id: string, mode: string = "a-interact",
           state: object = {}, reset: boolean = true}
response: {task_id: string, mode: string, session_id: string,
           adk_available: true}

POST /run_session
request:  {task_id: string, message: string,
           mode: string = "a-interact"}
response: {task_id: string, mode: string, session_id: string,
           response: string, state: object, adk_available: true}
```

The state received from `/init_session` is authoritative input from the
orchestrator. In addition to the phase fields above, Warble may mutate only its
agent-runtime fields: `budget_remaining`, `dialogue_history`,
`tool_trajectory`, `adk_events`, `model_turns`, and the additive
`rejected_actions` diagnostic.

The pinned orchestrator initializes these required state fields:

| Field | Initial value/source |
| --- | --- |
| `task_id` | dataset `instance_id` |
| `db_name` | dataset `selected_database` |
| `user_query` | dataset `amb_user_query` |
| `current_phase` | `1` |
| `budget_remaining`, `initial_budget` | orchestrator-calculated budget |
| `total_reward` | `0` |
| `dialogue_history`, `tool_trajectory`, `adk_events` | empty arrays |
| `phase1_completed`, `phase2_completed`, `task_done` | `false` |

The model's initial user turn is exclusively `/run_session.message`; Warble
does not synthesize a second prompt from `state.user_query`. The state copy is
retained for traceability and compatibility with the pinned official service.

## Wren planning boundary

Each BIRD database maps to a Wren project below a configured project root:
`<wren-project-root>/<db_name>`. The planner invokes `wren dry-plan` without a
shell and captures stdout as native PostgreSQL SQL.

- `execute_sql` plans `SELECT`, `WITH`, and `EXPLAIN` before calling BIRD. All
  other statements bypass Wren and are sent unchanged to BIRD `/execute`, so
  the pinned official service produces its standard
  `Only SELECT queries allowed in execute_sql` observation after the action has
  been charged.
- `submit_sql` plans those read/query statements before calling BIRD.
- Management statements such as DDL and DML bypass Wren planning and are sent
  unchanged to BIRD `/submit`, because the official submit environment owns
  isolated mutations and their test cases.
- A Wren planning error is returned to the agent as a tool error after the
  action has already been charged; the BIRD endpoint is not called.

Statement class is recognized with the same lexical rule as the pinned DB
environment: remove `--` line comments and `/* ... */` block comments, trim,
uppercase, then test the leading token for `SELECT`, `WITH`, or `EXPLAIN`.

The Wren projects used by a conformant run must use identity physical naming.
Column meanings, sample rows, and external knowledge must not be embedded in
the model prompt or exposed through generic Wren context inspection. They are
available only through the charged BIRD actions.

## Warble agent behavior

The eval includes a dedicated Warble profile bound to an `external` context.
This prevents compile-time Wren context introspection from becoming free
benchmark context. The component has one strong-tier step and a prompt that:

- describes the two-phase a-interact objective;
- lists the exact tool costs;
- requires explicit `submit_sql` calls;
- tells the model to continue on a phase-2 follow-up;
- forbids guessing hidden schema or using any access path outside the nine
  tools.

At runtime the adapter prepares this component through Warble, replaces the
generic built-in tool set with one in-process MCP server containing the nine
BIRD tools, and explicitly disallows filesystem, shell, web, and delegation
tools. The component receives only the initial message from the official
orchestrator, whose user-query field is `amb_user_query`.

## HTTP and error behavior

- Requests and responses use JSON and reject malformed shapes with HTTP 400.
- Unknown task ids return HTTP 404.
- A second `/run_session` for the same task while one is active returns HTTP
  409. Different task ids may run concurrently. `reset=true` replaces and
  releases the old in-memory session for that task; otherwise init returns the
  existing session reference.
- Upstream BIRD HTTP failures become tool-visible errors; they do not crash the
  task service.
- Unexpected agent/runtime failures return HTTP 500 and preserve any session
  state already recorded for diagnosis.
- `/health` does not require model credentials or upstream service access.
- Task state and trajectories are isolated by task id; no task may read another
  task's Wren project, budget, dialogue, or results.
- The official Lite run has a bounded task set, so completed session records
  remain available for its final result read and are released when the service
  exits. No non-standard cleanup endpoint is added in the first version.

## Trace and reproducibility

The returned state contains the official fields plus an additive tool
trajectory. Each action record contains tool name, redacted arguments, result
preview, cost, budget before/after, phase, semantic SQL when present, and native
SQL when Wren planning occurred.

The service writes one run directory per task containing agent trace artifacts
and a metadata file with task id, model binding, Warble version/IR hash, Wren
project path/MDL hash when available, service URLs, and timestamps. Secrets and
full database connection values are never persisted.

## Verification strategy

Implementation follows test-first development:

1. Pure protocol tests cover all nine costs, pre-execution deduction, forced
   submission, phase/reward transitions, and task isolation.
2. Planner tests use a fake executable to prove argv/cwd behavior, query versus
   Management routing, stdout handling, and failure handling without requiring
   Wren installation.
3. Tool tests use local fake HTTP servers to prove endpoint payloads, charged
   failures, follow-up continuity, knowledge visibility, and that Wren errors
   do not call BIRD.
4. Server tests exercise real HTTP requests against an in-process service with
   a fake agent runner; no model credentials are required.
5. The Warble profile is compiled in a repository-level smoke test.
6. The README documents an official oracle run, a small live a-interact smoke
   run, and the full Lite run. Live model/BIRD tests remain opt-in because they
   require gated ground truth, PostgreSQL, model credentials, and external
   services.

Before a full measurement, a scripted action sequence must be replayed through
the Warble adapter and the pinned official callbacks to confirm identical
observations, costs, remaining budget, phases, and rewards. The headline metric
is BIRD's official average reward (`0.7 * phase1 + 0.3 * phase2`); tolerant or
Warble-native table comparisons may appear only as secondary diagnostics.

## Non-goals

- Reimplementing the BIRD user simulator, DB environment, scorer, or dataset
  downloader.
- Adding BIRD-specific behavior to Wren core.
- Supporting c-interact.
- Making the current one-shot `warble eval run` understand interactive episodes.
- Claiming leaderboard comparability without a pinned official BIRD commit,
  gated ground truth, oracle pass, and protocol differential test.
