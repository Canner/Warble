# M0 — Agent SDK `query()` surface (reconciled)

Verified against `@anthropic-ai/claude-agent-sdk@0.1.77` type definitions
(`node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/sdk/{coreTypes,runtimeTypes}.d.ts`).
Every field this back-end relies on exists; the notable refinements are below.

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
