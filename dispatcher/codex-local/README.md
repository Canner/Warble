# `@warble/codex-local`

`codex:local` is Warble's model-level local Codex dispatcher. It consumes the same compiled
`ir.json` as every other back-end; it does not read profile YAML and it does not route through the
Claude SDK dispatcher.

The one-shot capability profile supports Setup and a closed generic assertion contract. The
assertion arm is selected solely from complete IR anatomy (`assertive` / `tool` / `scheduled` /
`assertion`) plus exact capability and guardrail closure, never from a profile, component ID, or
verb. It is deliberately stateless: each external/manual activation supplies one invocation and
Warble returns one result. It owns no scheduler, cron/launchd entry, automation registry,
notification destination, run history, Codex Scheduled task, or persistent thread.

Setup keeps its existing profile:

- analytical `skill` realization;
- `one_shot` trigger and `none` outcome;
- exactly one unconditional `strong` step;
- locked `setup_execution` scope `"."`;
- exactly two capabilities: `llm:strong` and one of `source_connect` or `context_build`;
- exactly one locked guardrail: `setup_execution` with scope `"."`.

The persistent-session path supports the canonical three-step read-only Ask shape and the canonical
two-step `generate_dashboard` shape. It maps each
IR `llm_call` to a named Codex custom agent, binds `cheap` and `strong` independently, verifies child
thread role/model attribution, and enforces exact `produces` to `consumes` marshalling. The parent may
only orchestrate. A successful generate skips repair; a failed generate permits exactly one strong
repair attempt, whose failure loud-fails the run. Any flattening, wrong agent/model/tool, or malformed
child envelope is an isolation/parity violation. Dashboard planning must successfully introspect
through the allowlisted Wren MCP, composition must successfully query through it, and the terminal
value must validate against the IR-declared KPI/table/chart/definition render contract. The validated
render envelope is the consumer-persistable artifact output; neither parent nor child receives file
mutation access. If only the best-effort render envelope is invalid, the runtime preserves the
terminal answer, emits `render_degraded`, and exposes no artifact reference; execution, isolation,
or data failures still loud-fail.

## Isolation contract

Runtime dispatch launches `codex exec` with an ephemeral configuration that ignores user config and
project rules, disables project-root discovery and project-document loading, uses approval policy
`never` plus a read-only sandbox, disables shell/file
mutation/web/browser/app/plugin/skill/delegation surfaces, and exposes only an explicit MCP
`enabled_tools` allowlist. OpenAI/Codex API-key billing variables are removed from the child
environment; authentication remains owned by the installed Codex CLI and is never read or copied by
this package.

The JSONL mapper also treats any shell, file-change, web, image, child-agent, non-allowlisted MCP,
unfinished MCP, or tool-free successful turn as an isolation violation and loud-fails the run.
Stream events retain only MCP call identity and success state; raw arguments, results, and errors are
never emitted. Timeout, cancellation, and mapper failures terminate the Codex process group with a
bounded TERM-to-KILL escalation so MCP descendants cannot survive the dispatch.

Persistent interactive sessions use `codex app-server` and retain the same sandbox, feature
disablement, billing-environment sanitization, required MCP server, and exact enabled-tool
allowlist. Their conversation source of truth is Codex thread history. Warble stores and returns
only stable thread/turn references, message item identities without transcript text, and sanitized
allowlisted MCP artifact references. It does not reconstruct transcripts into prompts or use
workspace files as conversation storage.

For analytical components, Warble writes one mode-0600 custom-agent TOML layer per IR step into a private temporary directory
for the lifetime of the runtime. The parent config contains only collaboration roles; each child
layer carries its own model and exact MCP allowlist, disables further delegation, and inherits the
read-only/approval boundary. The directory is removed when the runtime closes and never contains
credentials.

The caller must provide `CodexSessionRuntime` with
`externalAuthentication: "provisioned"` and a dedicated persistent `codexHome` that:

- is an existing absolute directory outside the project working directory;
- is not the default Codex home and contains no `config.toml`;
- was authenticated externally before Warble starts; and
- remains caller-owned so thread history survives app-server restarts.

For example, provision and authenticate it directly with Codex (choose a private path outside the
project):

```bash
mkdir -p /absolute/private/path/warble-codex-home
CODEX_HOME=/absolute/private/path/warble-codex-home codex login
```

Warble never reads or copies the resulting credentials. Session lifecycle operations are `start`,
`resume`, `read`, `turn`, `steer`, `interrupt`, and `fork`. Timeout, protocol failure, and app-server
disconnects close the process tree and yield an explicit failed or resume-required session state.

MCP command arguments are configuration, not a credential transport. Do not place passwords,
tokens, connection strings, or other secret values in `--server-arg`; the Setup MCP server must
obtain any credentials through its own approved mechanism.

## Commands

```bash
npm ci
npm run check-types
npm test
npm run build

node dist/cli.js manifest ../../genbi-setup/ir.golden.json \
  --server-command /absolute/path/to/setup-mcp \
  --source-tool connect_source --context-tool build_context

node dist/cli.js dispatch ../../genbi-setup/ir.golden.json \
  "connect a disposable source" --component connect_source \
  --project /absolute/path/to/project \
  --server-command /absolute/path/to/setup-mcp \
  --source-tool connect_source --context-tool build_context --stream-json

# authenticated subscription picker data; no thread or turn is started
node dist/cli.js list-models --project /absolute/path/to/project \
  --codex-home /absolute/private/path/warble-codex-home --timeout 10000
```

`list-models` starts a read-only app-server transport, paginates `model/list` with hidden models
disabled, and emits exactly one versioned JSON object. It only returns model ID, display name,
description, default state, and supported reasoning efforts; authentication, runtime, timeout, and
protocol failures are sanitized into the same JSON contract. It never starts a Codex thread or turn.
`--codex-home`, `--codex-bin`, and `--project` select the same local identity/runtime inputs as the
other commands; omitting `--codex-home` uses the caller's normal logged-in Codex identity.

`dispatch`, `manifest`, and `describe` are the only IR commands. The dispatcher selects the
supported native contract from the selected component's IR shape and requires `--component` for
scoped contracts; profile families are never encoded as CLI verbs. Analytical execution uses
explicit tier bindings and purpose-built Wren MCP tools. `answer_query` or `generate_dashboard`
select the analytical contract; the latter runs strong planning followed by cheap composition and
emits a `render_artifact` event before its terminal answer:

For an assertion, the scheduler (or manual caller) stays the trusted activation authority and must
first execute the read-only Wren operation. The invocation JSON records that successful operation,
its model/timestamp/timing evidence. The effective model and cadence are read only from compiled,
pinned IR `binds`; the caller may not override them. `source: "wren"` is only a typed caller
claim, not cryptographic provenance; a deployment needing independent attestation must validate or
sign the envelope before calling Warble. A fresh reading never starts Codex. A stale reading starts
one ephemeral cheap-model severity turn with no MCP tools; Warble validates `warn`/`critical` plus a
bounded rationale, assembles the verdict, and returns the IR-declared signal for caller-owned
routing:

```bash
node dist/cli.js dispatch ../../examples/monitor-agent/ir.golden.json \
  --component monitor_freshness --cheap-model <cheap-model> \
  --invocation '{
    "activation":{"authority":"external","kind":"scheduled","occurrence_id":"run-1","occurred_at":"2026-08-17T12:00:00Z"},
    "evidence":{"source":"wren","operation":"read_only_sql","success":true,"read_only":true,"model":"orders","timestamp_column":"updated_at","observed_at":"2026-08-17T12:00:00Z","latest_timestamp":"2026-08-15T12:00:00Z"}
  }'
```

The returned `freshness_breach` is a signal for the caller's notification transport; this package
does not persist or deliver it. Event-triggered, gated-tool/mutating, incomplete/ambiguous, or
capability-incomplete shapes wall-hit before Codex starts.

```bash
node dist/cli.js manifest ../../genbi-default/ir.golden.json \
  --component answer_query \
  --orchestrator-model <driver-model> --cheap-model <cheap-model> --strong-model <strong-model> \
  --server-command /absolute/path/to/wren \
  --server-arg serve --server-arg mcp --server-arg=--project \
  --server-arg /absolute/path/to/wren-project --server-arg=--quiet \
  --inspect-tool get_context --query-tool run_sql

node dist/cli.js dispatch ../../genbi-default/ir.golden.json "top customers" \
  --component answer_query --project /absolute/path/to/wren-project \
  --codex-home /absolute/private/path/warble-codex-home \
  --orchestrator-model <driver-model> --cheap-model <cheap-model> --strong-model <strong-model> \
  --server-command /absolute/path/to/wren \
  --server-arg serve --server-arg mcp --server-arg=--project \
  --server-arg /absolute/path/to/wren-project --server-arg=--quiet \
  --inspect-tool get_context --query-tool run_sql --stream-json

node dist/cli.js dispatch ../../genbi-default/ir.golden.json "build an orders dashboard" \
  --component generate_dashboard --project /absolute/path/to/wren-project \
  --codex-home /absolute/private/path/warble-codex-home \
  --orchestrator-model <driver-model> --cheap-model <cheap-model> --strong-model <strong-model> \
  --server-command /absolute/path/to/wren \
  --server-arg serve --server-arg mcp --server-arg=--project \
  --server-arg /absolute/path/to/wren-project --server-arg=--quiet \
  --inspect-tool get_context --query-tool run_sql --stream-json
```

Read-only enrichment is selected by the enrichment component's pinned context binding and exact
capabilities. It uses the same generic operations and an isolated app-server session; the
host-executed `apply_enrichment` contract always wall-hits before an app-server process can start:

```bash
node dist/cli.js dispatch ../../genbi-enrich-context/ir.golden.json "inspect available context" \
  --component inspect_context --project /absolute/path/to/wren-project \
  --codex-home /absolute/private/path/warble-codex-home \
  --server-command /absolute/path/to/wren \
  --server-arg serve --server-arg mcp --server-arg=--project \
  --server-arg /absolute/path/to/wren-project --server-arg=--quiet \
  --semantic-tool get_context --raw-material-tool read_raw_material --stream-json
```

The committed test suite uses a fake Codex executable and a disposable non-secret MCP server. The
authenticated live smoke is opt-in:

```bash
WARBLE_CODEX_LIVE_SMOKE=1 npm run smoke:live
```

That command spends one local Codex model call. It must not run in normal CI.

The persistent-session gate is separate and requires the dedicated home above:

```bash
WARBLE_CODEX_SESSION_LIVE_SMOKE=1 \
WARBLE_CODEX_SESSION_HOME=/absolute/private/path/warble-codex-home \
npm run smoke:session-live
```

It spends one model call, then restarts app-server and verifies that the original thread and history
resume. It never defaults to the user's normal Codex home and must not run in normal CI.
`WARBLE_CODEX_JS_ENTRY=/absolute/path/to/codex.js` may be set in a restricted environment that can
spawn Node but cannot execute Codex's `env node` launcher directly.

The authenticated Ask parity gate uses the same dedicated home and a disposable MCP server. It
verifies the cheap/strong named child roles, effective models, exact `run_sql` attribution, and the
successful no-repair path without reading a real data source:

```bash
WARBLE_CODEX_ASK_LIVE_SMOKE=1 \
WARBLE_CODEX_SESSION_HOME=/absolute/private/path/warble-codex-home \
npm run smoke:ask-live
```

This opt-in gate spends one parent turn plus two child-agent turns and must not run in normal CI.
It proves Codex delegation and named-tool attribution against the disposable protocol fixture; it
does not boot a real Wren project. The production tool binding uses Wren MCP's read-only
`get_context` and `run_sql` tools shown in the commands above.

The dashboard parity gate uses the same fixture but requires strong planning, cheap composition,
successful `get_context`/`run_sql` calls, a verified KPI/chart/table/definition envelope, and the
stable render-artifact reference:

```bash
WARBLE_CODEX_DASHBOARD_LIVE_SMOKE=1 \
WARBLE_CODEX_SESSION_HOME=/absolute/private/path/warble-codex-home \
npm run smoke:dashboard-live
```

It spends one parent turn plus two child-agent turns and must not run in normal CI. Real-project
dashboard persistence is the consuming GenBI integration gate, not part of this disposable protocol
smoke.
