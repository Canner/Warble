---
title: "Pi hybrid launch"
description: "Standalone limited pi TUI with separate public and private model bindings and Cedar disclosure boundaries."
---

<!-- @generated from docs/spec/pi-hybrid.md by scripts/gen-reference.mjs — do not edit; edit the spec and re-run `npm run gen:reference` -->

`pi:hybrid` is a separate standalone target for a **limited pi TUI**. The public planner uses
pi-agent-core; the UI uses pi-tui. It does not start stock pi InteractiveMode, extend native
Sessions launch v5, or claim full `warble-component-host/1` conformance. IR remains **0.9**.

## Dispatch and launch

```sh
warble dispatch ir.json --target pi:hybrid --hybrid-config runtime.json --out ./session
node /absolute/path/to/dispatcher/pi/dist/cli.js launch ./session
```

The `@warble/pi` package remains private while the runtime is under development. Build it from
the same checkout as the binary with `just install-pi-ts build-pi-ts`. Node **22.19 or newer**
and a POSIX terminal are required. The generated `RUN.md` describes launch; dispatch never
executes a model. The launcher refuses non-TTY input and has no resume/import options.

`--hybrid-config` is accepted only by `pi:hybrid`. Native-session, provider-fragment, slot and
non-default file-target configuration flags are rejected. Existing `pi:interactive` remains
unchanged and does not silently gain this runtime's composition capabilities.

The new output directory contains `launch.json`, `launch.sha256` and `RUN.md`. Existing outputs
are never overwritten. Dispatch validates the executable IR subset and closed binding shape
before output. The launcher repeats validation, validates Cedar, checks artifact and explicit
adapter digests, then checks actual adapter/tool bindings before any provider request. Hashes
check corruption/version drift; they do not authenticate files against a malicious actor who
can replace both the trusted artifact and its digest.

## Configuration and ownership

`runtime.json` has format `warble-pi-hybrid-config/1` with these required fields:

| Field | Meaning |
|---|---|
| `entry` | Exact advertised IR entrypoint |
| `policy` | Deployment Cedar policy; independent from the session selection |
| `adapter` | Explicit absolute `path` and SHA-256 of a trusted host module |
| `selections` | Named `{metadata, components, approvedAnswers}` choices |
| `models` | Named public model bindings |
| `projects` | Named projects, each with `privateModels[component][tier]` |
| `defaults` | Initial `{policy, model, project}` names from those maps |

Each model binding contains `zone`, opaque `deployment`, `api`, `model`, `baseUrl` and
`credentialEnv`. Public APIs are `openai-completions` and `anthropic-messages`; private children
currently support OpenAI-compatible completions. Secrets are resolved only from explicitly
named environment variables at launch, not from pi credential stores or model catalogs. Do not
put secrets in Cedar literals, IDs or adapter code. A private zone is a trusted operator claim,
not automatic verification of endpoint ownership. Non-loopback endpoints require HTTPS.

The adapter exports `loadProject(project)` returning `metadata` plus `children[component]`.
Each child supplies its own classified `context`, exact read-only `tools`, and trusted
`projection`/`validate` logic (with an optional deny-only judge). It never receives authority
or transport-permit APIs. Its code and transitive dependencies are trusted host code; digest
checking the entry file is not a sandbox or a complete dependency attestation. Wren-specific
loading/query logic belongs to the consumer adapter, never to the compiler.

Private tool execution receives an invocation-scoped `AbortSignal`. It remains live
through successful child exit and result projection, then aborts on invocation completion,
failure, timeout or cancellation. Adapters can bind single-use host query evidence to this
lifetime: validate it during projection and discard unused evidence on abort. A subprocess's
shorter lifetime must not invalidate successful evidence before projection.

The launch envelope has independent format `warble-pi-hybrid/1`, exact `runtimeVersion` and
`piVersion`, and embeds the compiled `ir` and closed `config`. It contains private instructions
and references and must stay host-owned. The public prompt receives only root instructions
and authorized metadata; the entire envelope is never injected into the model.

## Executable subset

The root and leaves must be analytical `skill` / `one_shot` / `none` components with exactly one
unconditional step. The root owns static `component_calls`; each alias reaches a non-entrypoint
leaf with its own exact tier binding. There is no hidden public planner inside the private tool.
Leaf non-LLM capabilities and borrowed actions must match exact host-bound read-only tools.

Multi-step, conditional, nested, repair, consumes/produces, slots, nontrivial context
requirements/preconditions, render/persistence and unsupported guardrail shapes refuse.
`genbi-report` is not downgraded to chat. The runtime's public tool schema accepts only
`{request: string}`; component/step/provider/endpoint/tool overrides are not model arguments.

## Disclosure and lifecycle

The TUI shows model, project, selection, deployment-policy digest, epoch, requested/effective
metadata, unavailable requested documents and tool names. A selection with no metadata produces a blind planner; there is no full-context
fallback. Public tool aliases require both the compiled edge and Cedar invocation permission.
Read authority and answer disclosure remain independent.

The commands are `/help`, `/reset`, `/policy <name>`, `/metadata`, `/metadata none`,
`/metadata kind=doc,doc kind=*`, `/evidence [number]`, `/model <name>`, `/project <name>` and `/quit`.
Bare `/metadata` lists only adapter document IDs permitted by the deployment ceiling for
the current project and public recipient. The catalog and unavailable names are operator-only;
they are never added to the public prompt. An override replaces the entire metadata selection,
while component and answer permissions stay those of the configured base preset. Wildcards
are explicit, bounded to loaded documents, and cannot override deployment denies. Missing or
denied documents are shown as unavailable, without falling back to another document or content.
Malformed categories, IDs, duplicates or oversized commands refuse without changing the epoch.
`/reset`, `/model` and `/project` preserve the custom selection; `/policy` replaces it with
the named preset. Custom selections are in-memory only. Other settings remain selected from
immutable configured maps. A valid change cancels the old agent,
private processes and network work before creating an empty epoch. Unknown commands, shell,
resume/import/fork/tree, compaction, export/share and reload are refused. No project instructions,
user extensions, skill/template files, MCP servers or attachments are discovered. Text such as
`@path` stays text. There is no session-file persistence; terminal scrollback remains visible.
The UI states that **already-sent data cannot be recalled**.

### Local evidence references

Successful, policy-approved tool results receive host-issued short references such as `[1]`.
The TUI replaces recognized adapter evidence UUIDs with those references and adds a separate
`Tool data` footer even when the model omits a citation. Unknown or ambiguous UUID references
and nonexistent numeric references display as unavailable. A reference identifies a tool result;
it does not verify that the model interpreted or cited that result correctly.

`/evidence` lists retained records; `/evidence 1` shows the tool request, UTC completion time,
approved result, project, epoch, policy digest and effective metadata document IDs. The request
is model-authored intent, not a verified query definition; completion time is not data freshness.
Dates, metrics and timezone appear only where supplied in the approved result. The command
never retrieves private SQL, source provenance, hidden rule text or the private evidence ledger.
Adapter validation determines the strength of data verification; the runtime does not independently
audit its domain semantics. Model interpretation remains unverified.

Records and display mappings stay in host memory and never enter model context or tool schemas.
Provider history retains the original opaque IDs. `HybridPlanner.evidence(number?)` returns
detached local snapshots; `formatAnswer(text)` is a display-only helper, while `prompt(text)`
retains its original model-text API. Keep these host methods out of model tools.
The ledger retains at most 32 records and 2 MiB, evicting oldest records as necessary. Settings
changes, reset, fatal request failure and close clear it; numbers increase across epochs within
the same process so old references cannot silently resolve to new results. Restart begins a new
session. This is neither persistent audit storage nor erasure of terminal scrollback.

All public model calls originate from a private host-owned Agent instance. Its transcript
contains public input/model output and projected tool results only. No extension/payload hook
can add data. The pinned provider serializer feeds a mandatory fetch wrapper, which checks the
complete serialized body, one-use permit, artifact authority, fixed destination, explicit
credential and current epoch. There is no alternative transport, auto-compaction, background
cache warming or transparent retry; unsupported extra attempts fail closed. Anthropic uses its
fixed `/v1/messages?beta=true` SDK path and explicit API-key headers.

Private bytes never stream to the public UI. Results are projected/validated and Cedar-checked
before public pi sees them; errors become fixed unavailable messages. Revocation invalidates
referenced artifacts before a later request can use them. The bounds and process-isolation
limitations in the package README apply; this is not hostile-code containment.

## Execution limits

A host of the private service (`warble-pi-service`, protocol `warble-private-service/1`) may pass
an optional `limits` object in `init`. Every field is optional; an absent field keeps the value
the runtime used before limits existed, so a host that sends no `limits` sees no behavior change.

| Field | Range | Default | Effect |
| --- | --- | --- | --- |
| `deadlineMs` | integer 5000-600000 | 60000 leaf / 90000 root | Child task deadline. One value applies to leaf and root alike when set. The invocation abort is `deadlineMs + 30000` and the process-group SIGKILL backstop is `deadlineMs + 5000`. |
| `maxTokens` | integer 256-65536 | 4096 | Provider completion ceiling (`max_tokens`). |
| `enableThinking` | boolean | omitted | Omitted sends no `chat_template_kwargs`; `true`/`false` is forwarded as `enable_thinking`. Wins over `model.enableThinking`, which remains accepted. `null` is invalid. |
| `maxTurns` | integer 1-64 | 12 | Model turns per child process, including the one tool-free format correction. |
| `maxToolCalls` | integer 1-256 | 16 | Tool calls per child process. |
| `providerMaxRetries` | integer 0-8 | 0 | Retries of provider 408/409/429/5xx and connection errors, honoring `retry-after-ms` and `retry-after`. Retries do not consume `maxTurns`. |
| `providerMaxRetryDelayMs` | integer 100-60000 | 8000 | Longest delay between retries; a longer server-requested delay fails the call instead of waiting. |
| `reasoningBudgetTokens` | reserved | none | Not supported yet; always refused. |

An invalid `limits` value makes `init` answer `{id, error: "invalid_limits", diagnostic}` and the
service stays uninitialised. The diagnostic is the offending field name, `limits` for a value that is
not an object, `unknown_limit` for an unrecognised field, or `unsupported_limit:reasoningBudgetTokens`.
It never echoes host-supplied text.

When the deadline passes, the private child aborts its in-flight provider request, closes the
connection and reports `deadline`. `cancelled` is reserved for the host `cancel` operation and the
invocation abort. The runner's SIGKILL backstop also reports `deadline` if a child cannot respond.

Every `invoke` response carries a `calls` array with one entry per provider attempt, retries included,
and no content:

```json
{"turn": 1, "elapsedMs": 812, "input": 103, "output": 45, "reasoning": 6, "cacheRead": 20,
 "stopReason": "stop", "rawStopReason": "stop", "toolCalls": 0, "status": "ok"}
```

The integer fields are non-negative. `input` excludes cached prompt tokens, which are reported in
`cacheRead`. `stopReason`, `rawStopReason` and `status` are lowercase tokens of at most 32 characters;
`status` is `ok`, `error`, `aborted`, `network_error` or `http_<code>`. A successful response is
`{id, value, calls}`. A failure is `{id, error: "service_unavailable", diagnostic, calls, turns, toolCalls}`.
When a root delegates to a child component, the delegated child's calls precede the root's calls
(completion order, not a merged timeline) and `turn` restarts for each process. Usage from a child that was killed before it
could report is not included.

## Verification scope

Deterministic tests use real pi libraries with local OpenAI/Anthropic SSE fixtures and a PTY,
including generated launch artifacts, private calls, follow-up, all three metadata selections,
command refusal, epoch reset, Ctrl+C and process restart. Public wire bodies, captured synthetic
terminal output and filesystem inventories are checked for denied canaries. Compaction, restore
and export are tested as refused operations with no resulting provider traffic or session files.
Deliberate mutations verify that tests detect removed authorization/validation/transport checks.
These tests do not certify real model/auth combinations, consumer data access or OS sandboxing;
independent review remains a separately recorded acceptance activity.
