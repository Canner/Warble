# `@warble/codex-local`

`codex:local` is Warble's model-level local Codex dispatcher. It consumes the same compiled
`ir.json` as every other back-end; it does not read profile YAML and it does not route through the
Claude SDK dispatcher.

The caller explicitly chooses `--transport exec|turn|orchestrate`:

- `exec` runs each step in a fresh isolated process, with ordered output marshalling and optional final repair.
- `turn` runs each step in an isolated process and durable thread. Only declared inputs cross steps. A persistent session binds exactly one step; changing its authority requires a fresh thread, never resume.
- `orchestrate` maps a sequential step chain to named, independently tiered child agents.

Declared capabilities and guardrails are validated against target rules, not exact profile-family sets.
Unsupported requirements, host-only components, and unresolved slots fail before execution.
Composition edges require the explicit component bindings described below; ordinary preparation rejects them.
Repeat `--step-tool <step>=<tool>` to grant tools and `--require-tool <step>` to require a successful call.
Unbound steps receive no tools; required steps without grants and unknown step names fail closed.
Selected-component CLI calls accept only that component's step names. Library preparation also accepts
bindings for sibling components in the same IR, allowing one shared profile configuration; execution
always uses only the active step's grants.

The orchestration transport maps each
IR `llm_call` to a named Codex custom agent, binds `cheap` and `strong` independently, verifies child
thread role/model attribution, and enforces exact `produces` to `consumes` marshalling. The parent may
only orchestrate. A successful generate skips repair; a failed generate permits exactly one strong
repair attempt, whose failure loud-fails the run. Any flattening, wrong agent/model/tool, or malformed
child envelope is an isolation/parity violation. Tool names and successful-call requirements belong
to the caller, never to step position. `render_contract` or `artifact_write` capabilities select
render-envelope behavior; the number of render blocks does not select it. The terminal
value must validate against the IR-declared render contract. The validated
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
unfinished MCP, or tool-free successful turn when the caller requires a tool as an isolation violation and loud-fails the run.
Stream events retain only MCP call identity and success state; raw arguments, results, and errors are
never emitted. Timeout, cancellation, and mapper failures terminate the Codex process group with a
bounded TERM-to-KILL escalation so MCP descendants cannot survive the dispatch.

Persistent interactive sessions use `codex app-server` and retain the same sandbox, feature
disablement, billing-environment sanitization, required MCP server, and exact enabled-tool
allowlist. Their conversation source of truth is Codex thread history. Warble stores and returns
only stable thread/turn references, message item identities without transcript text, and sanitized
allowlisted MCP artifact references. It does not reconstruct transcripts into prompts or use
workspace files as conversation storage.

Host-only provenance metadata lives in a private directory under the dedicated Codex home. It
records a binding digest and host-started turn IDs, never prompts, credentials or tool results.
Resume/fork require the same step binding; existing threads without provenance fail closed.
Historical MCP artifacts are omitted for turns not recorded by the host, even if their prompts
claim to be a privileged step. Treat the dedicated home as host-owned state, not untrusted input.
Metadata persists for the lifetime of its durable thread; closing a runtime does not delete it.
Retain it alongside the thread when backing up the dedicated home. Deleting it revokes Warble
resume/fork access to that thread; there is no automatic retention or recovery policy.

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

node dist/cli.js manifest ../../examples/provision-agent/ir.golden.json \
  --server-command /absolute/path/to/setup-mcp \
  --transport exec --step-tool attach=attach_source --step-tool compose=compose_context \
  --require-tool attach --require-tool compose

node dist/cli.js dispatch ../../examples/provision-agent/ir.golden.json \
  "attach a disposable source" --component attach_source \
  --project /absolute/path/to/project \
  --server-command /absolute/path/to/setup-mcp \
  --transport exec --step-tool attach=attach_source --require-tool attach --stream-json

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

`dispatch`, `manifest`, and `describe` are the only IR commands. All require `--transport`;
`turn` and `orchestrate` also require `--component`. The old capability-named tool flags are
removed without aliases. These examples bind a profile's actual step names to its MCP tools:

```bash
node dist/cli.js manifest ../../examples/analysis-agent/ir.golden.json \
  --component answer_query \
  --orchestrator-model <driver-model> --cheap-model <cheap-model> --strong-model <strong-model> \
  --server-command /absolute/path/to/wren \
  --server-arg serve --server-arg mcp --server-arg=--project \
  --server-arg /absolute/path/to/wren-project --server-arg=--quiet \
  --transport orchestrate --step-tool resolve_intent=get_context \
  --step-tool generate_sql=run_sql --step-tool repair_sql=run_sql \
  --require-tool generate_sql --require-tool repair_sql

node dist/cli.js dispatch ../../examples/analysis-agent/ir.golden.json "top customers" \
  --component answer_query --project /absolute/path/to/wren-project \
  --codex-home /absolute/private/path/warble-codex-home \
  --orchestrator-model <driver-model> --cheap-model <cheap-model> --strong-model <strong-model> \
  --server-command /absolute/path/to/wren \
  --server-arg serve --server-arg mcp --server-arg=--project \
  --server-arg /absolute/path/to/wren-project --server-arg=--quiet \
  --transport orchestrate --step-tool resolve_intent=get_context \
  --step-tool generate_sql=run_sql --step-tool repair_sql=run_sql \
  --require-tool generate_sql --require-tool repair_sql --stream-json

node dist/cli.js dispatch ../../examples/analysis-agent/ir.golden.json "build an orders dashboard" \
  --component generate_dashboard --project /absolute/path/to/wren-project \
  --codex-home /absolute/private/path/warble-codex-home \
  --orchestrator-model <driver-model> --cheap-model <cheap-model> --strong-model <strong-model> \
  --server-command /absolute/path/to/wren \
  --server-arg serve --server-arg mcp --server-arg=--project \
  --server-arg /absolute/path/to/wren-project --server-arg=--quiet \
  --transport orchestrate --step-tool plan_dashboard=get_context --step-tool compose_layout=run_sql \
  --require-tool plan_dashboard --require-tool compose_layout --stream-json
```

Read-only enrichment uses explicit `turn` transport with a pinned context binding.
It uses the same generic operations and an isolated app-server session; the
host-executed `apply_changes` contract always wall-hits before an app-server process can start:

```bash
node dist/cli.js dispatch ../../examples/propose-apply-agent/ir.golden.json "inspect available context" \
  --component survey_context --project /absolute/path/to/wren-project \
  --codex-home /absolute/private/path/warble-codex-home \
  --server-command /absolute/path/to/wren \
  --server-arg serve --server-arg mcp --server-arg=--project \
  --server-arg /absolute/path/to/wren-project --server-arg=--quiet \
  --transport turn --step-tool survey=get_context --step-tool survey=read_raw_material \
  --require-tool survey --stream-json
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


## Same-profile component invocation

For a composed profile, use `--transport orchestrate --component-bindings bindings.json`.
The binding file owns every reachable component's models, exact MCP tools by step, and explicit
host-provided context. Do not combine it with the ordinary server/model/step-tool flags.

```json
{
  "components": {
    "summary": {
      "transport": "orchestrate",
      "models": { "orchestrator": "driver-model", "cheap": "small-model", "strong": "large-model" },
      "context": "Host-provided context for the summary component.",
      "mcp": { "name": "data", "command": "/absolute/path/to/server", "toolsByStep": { "compose": [] } }
    },
    "measure": {
      "transport": "orchestrate",
      "models": { "orchestrator": "driver-model", "cheap": "small-model", "strong": "large-model" },
      "context": "Host-provided context for the measuring component.",
      "mcp": { "name": "data", "command": "/absolute/path/to/server", "toolsByStep": { "query": ["read_measurement"] }, "requireTool": ["query"] }
    }
  },
  "limits": { "maxAttempts": 16, "maxSteps": 30, "timeoutMs": 60000 }
}
```

```sh
warble-codex-local manifest profile.ir.json --component summary --transport orchestrate --component-bindings bindings.json
warble-codex-local dispatch profile.ir.json 'Summarize the measurements' --component summary --transport orchestrate --component-bindings bindings.json --project /absolute/project --codex-home /absolute/provisioned-codex-home
```

The logical alias-to-callee edges come exclusively from compiled IR. Step names are scoped to each
component's binding record. `manifest`/`describe` validate the complete reachable closure without
starting a process. A root with missing bindings or an unsupported reachable callee is unavailable.
Non-empty or malformed context preconditions are unsupported even when the IR records a passing
check: those records do not attest arguments or the bound runtime context. Empty or omitted
preconditions remain eligible. The canonical Hub dashboard therefore still fails preparation due
to its answer callee's context precondition; this path does not bypass it.
The library equivalents are `prepareComponentInvocation`, `buildInvocationManifest` and
`runComponentInvocation`; the runner accepts only the immutable plan returned by preparation.

The runtime uses host-sequenced fresh ephemeral app-server threads, not the model-driven legacy
orchestrator. `cheap`/`strong` select each step's model; `orchestrator` is retained in the common
binding shape but no driver model is started for composition. Calls use the experimental namespaced
`dynamicTools` / `item/tool/call` protocol (schema checked against Codex CLI 0.146.0); unsupported
protocols fail closed. No live-model compatibility claim is made by the deterministic fixtures.

Default hard limits: depth 8, 32 child attempts, 40 total step starts, 12 own steps per child,
120 seconds for the root, 64 KiB request and 1 MiB normalized result. Overrides may only lower them.
These are **not model-turn limits**: a Codex turn may run multiple model/tool iterations. Hard
`maxTurns`, `maxModelTurns` and `maxCostUsd` are rejected. Observed token usage is aggregate telemetry.
Cancellation closes admission and terminates process trees; children never persist results or
session provenance. The detailed eligibility, authority and budget contract is in
[`component-composition.md`](../../docs/spec/component-composition.md).
