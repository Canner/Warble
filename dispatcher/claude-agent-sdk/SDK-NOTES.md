# M0 — Agent SDK `query()` surface (reconciled)

Verified against `@anthropic-ai/claude-agent-sdk@0.1.77` type definitions
(`node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/sdk/{coreTypes,runtimeTypes}.d.ts`).
Every field this back-end relies on exists; the notable refinements are below.

## Since `@anthropic-ai/claude-agent-sdk@0.3`

The back-end now builds against `^0.3.296`. 0.1.77 bundled Claude Code 2.0.77, whose driver resent a
duplicated `tool_use` block after the first `Task` subagent returned
(``messages.N.content.M: `tool_use` ids must be unique``): three of three live `answer_query` runs
in a per-step-tier split ended on that API 400, and two of two passed on 0.3. What changed:

- Claude Code ships as a per-platform optional dependency (a native `claude` binary) rather than a
  bundled `cli.js`; `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` and `zod@4` are peer
  dependencies.
- `canUseTool` returns `Promise<PermissionResult | null>`; `null` means the callback already answered
  out-of-band. `composeCanUseTool` cannot compose the floor with an answer it never saw, so an
  embedder's `null` becomes a denial. The guard's own callback never returns `null`
  (`DecidingCanUseTool`). `updatedInput` on an allow is optional; absent means the input is
  unchanged.
- The callback's options carry a required `requestId`.
- A bare tool name in `allowedTools` is auto-approved before `canUseTool` runs, and the SDK now warns
  about it (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). That was already this back-end's model: `Read` and
  `Task` are listed on purpose, `Read` is gated by a `PreToolUse` hook, and `Bash` stays out of
  `allowedTools` so every call reaches the guard.
- An MCP server built with `createSdkMcpServer` validates arguments with zod 4 before the handler
  runs; a key typed as a union containing `z.unknown()` is still required.

The table below is the original M0 reconciliation against 0.1.77.

## `query({ prompt, options })` — `Options` fields used by this back-end

| plan assumption | SDK reality | note |
| --- | --- | --- |
| `model` | `model?: string` (free-form) | top-level model is a free string (any alias/id). |
| `systemPrompt` | `string \| { type:'preset', preset:'claude_code', append? }` | as assumed — plain string or preset+append. |
| `allowedTools` / `disallowedTools` | both `string[]` | plus `tools?: string[] \| {type:'preset',preset:'claude_code'}` for the base built-in set. |
| `permissionMode` | `'default'\|'acceptEdits'\|'bypassPermissions'\|'plan'\|'delegate'\|'dontAsk'` | SDK adds `delegate`/`dontAsk` beyond the plan's list. |
| `mcpServers` | `Record<string, McpServerConfig>` | ✓ |
| `agents` (per-step tier) | `Record<string, AgentDefinition>` | **per-agent `model` is a restricted union** `'sonnet'\|'opus'\|'haiku'\|'inherit'`, NOT free-form (unlike top-level `model`). See below. |
| `hooks.PreToolUse` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | PreToolUse sync output supports `hookSpecificOutput.permissionDecision: 'allow'\|'deny'\|'ask'` + `permissionDecisionReason`. |
| `canUseTool` | `(toolName, input, {…}) => Promise<PermissionResult>` | deny result carries `message` (guidance fed back to the model) + `interrupt?`. |
| `settingSources` | `('user'\|'project'\|'local')[]` | **omitted/empty ⇒ NO filesystem settings loaded (SDK isolation)** — we omit it to stay hermetic; wren `strict_mode` is read by the `wren` CLI itself, not Claude. |
| `cwd` | `cwd?: string` | ✓ bound wren project. |
| `includePartialMessages` | `boolean` | emits `SDKPartialAssistantMessage` (`type:'stream_event'`). |
| `maxTurns` | `number` | plus bonus `maxBudgetUsd?`. |

## usage / cost (trace, §4.5)

`SDKResultMessage` (subtype `'success'`) carries: `total_cost_usd`, `usage: NonNullableUsage`
(input/output/cache tokens), `modelUsage: { [model]: ModelUsage{ inputTokens, outputTokens,
cacheReadInputTokens, cacheCreationInputTokens, costUSD, … } }`, `duration_ms`, `duration_api_ms`,
`num_turns`, `permission_denials`.

Per-step granularity: each `SDKAssistantMessage.message` (a `BetaMessage`) carries its own `usage`
and a `parent_tool_use_id`; subagent turns are attributable via `parent_tool_use_id` (and the
`canUseTool`/hook `agentID`). `modelUsage` already aggregates cost per model — i.e. per tier when
each tier maps to a distinct model. This is the per-step trace the file target can't produce.

## Resolved open questions

- **#2 `canUseTool` vs `PreToolUse` hook** → use **`canUseTool`** as the primary read-only runtime
  enforce: it is purpose-built ("called before each tool execution to determine allow/deny/ask"),
  and its `deny` result returns a structured `message` guiding the model. A `PreToolUse` hook can
  also deny-with-reason (`permissionDecision:'deny'` + `permissionDecisionReason`); we keep it as a
  secondary/observing option, not the primary gate.
- **#1 per-step tier in-loop** → `agents` with per-agent `model` works for the standard core tiers
  (`strong→opus`, `cheap→haiku`) since those map onto the alias union. A **custom tier** whose model
  is not one of `sonnet/opus/haiku` cannot ride on `agents[].model`; fallback there is top-level
  model switching (`Query.setModel()` in streaming-input mode) or multiple `query()` calls marshaled
  via the IR `consumes`/`produces` contract. MVP uses the aliases, so `agents` suffices.

## Structured output (bonus, not on the critical path)

`outputFormat: { type:'json_schema', schema }` + `SDKResultMessage.structured_output` could force the
`{ blocks, summary }` envelope shape. We deliberately still capture the final `result` text and shell
out to `warble render` (its `parseEnvelope` tolerates fencing) — one renderer, reused, which keeps
this apples-to-apples with the file target. `outputFormat` is noted as a later hardening option.
