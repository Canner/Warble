# `@warble/codex-local`

`codex:local` is Warble's model-level local Codex dispatcher. It consumes the same compiled
`ir.json` as every other back-end; it does not read profile YAML and it does not route through the
Claude SDK dispatcher.

The initial capability profile is deliberately Setup-only:

- analytical `skill` realization;
- `one_shot` trigger and `none` outcome;
- exactly one unconditional `strong` step;
- locked `setup_execution` scope `"."`;
- exactly two capabilities: `llm:strong` and one of `source_connect` or `context_build`;
- exactly one locked guardrail: `setup_execution` with scope `"."`.

Everything else loud-fails. In particular, this package does not claim Ask, multi-agent, conditional
repair, or per-step tier parity.

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
