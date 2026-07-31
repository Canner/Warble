# `@warble/codex-local`

`codex:local` is Warble's model-level local Codex dispatcher. It consumes the same compiled
`ir.json` as every other back-end; it does not read profile YAML and it does not route through the
Claude SDK dispatcher.

The initial capability profile is deliberately Setup-only:

- analytical `skill` realization;
- `one_shot` trigger and `none` outcome;
- exactly one unconditional `strong` step;
- locked `setup_execution` scope `"."`;
- exactly one domain capability: `source_connect` or `context_build`.

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

The JSONL mapper also treats any shell, file-change, web, image, or child-agent item as an isolation
violation and loud-fails the run.

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
