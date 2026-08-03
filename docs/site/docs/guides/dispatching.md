---
title: Dispatching to a target
description: "How to run warble dispatch to legalize a compiled IR onto a runtime target and emit a native agent, and what happens when the IR hits a wall-hit."
---

`warble dispatch` takes a compiled IR and legalizes it onto one runtime target, emitting that
target's native agent. This page walks through the command; for the enum-keyed model behind it —
why a target loud-fails instead of guessing — see
[Targets & wall-hits](/concepts/targets-and-wall-hits).

**1. Compile an IR**

Dispatch always starts from a compiled IR, not a project directory:

```bash
warble compile examples/render-demo -o ir.json
```

**2. Pick a target and dispatch**

```bash
warble dispatch ir.json --target claude-code:headless --out agent
```

`--target` accepts `claude-code:headless` (default), `claude-code:interactive`, `vercel`,
`vercel:headless`, or `vercel:interactive`. The two families are genuinely separate back-ends: the
`vercel` target branches off before any Claude-Code-specific flag parsing, has its own IR handling,
and takes `--provider <path>` fragments instead of the render-flavor/model-tier knobs below.

```bash
# vercel target, with a domain provider fragment
warble dispatch ir.json --target vercel --out bundle --provider providers/genbi.yaml
```

A bare `vercel` dispatch with no `--provider` loud-fails any component that needs a domain
capability (`sql_execution`, `genbi_build`, `scheduler`, …), naming which one is unresolved.

The model-level `codex:local` peer target is not a `warble dispatch --target` value. Its standalone
TypeScript dispatcher reads the same IR directly:

```bash
cd dispatcher/codex-local
node dist/cli.js manifest ../../genbi-setup/ir.golden.json \
  --server-command /absolute/path/to/setup-mcp \
  --source-tool connect_source --context-tool build_context
```

The one-shot path accepts the profile's single-strong-step onboarding shapes. The persistent
app-server path also accepts the canonical three-step Ask shape and maps its cheap/strong steps to
named custom agents with exact per-step MCP allowlists. Runtime Setup dispatch uses an isolated,
ephemeral `codex exec`
configuration, an exact MCP tool allowlist, a read-only sandbox, and no inherited API-key billing
environment. The dispatcher rejects additional capabilities/guardrails, non-allowlisted or
unfinished MCP traces, and successful turns that never complete an allowed MCP call; streamed tool
events omit raw arguments/results. It does not change the IR or route through a Claude back-end.

**3. (claude-code targets) choose a render flavor**

```bash
warble dispatch ir.json --target claude-code:headless --out agent \
    --render-flavor programmatic
```

`--render-flavor programmatic|prompt` only applies to `claude-code:*` targets — it controls who
writes the rendered dashboard, and is covered in full in [Rendering](/guides/rendering).

The same targets accept `--context-injection schema-only|schema+knowledge`. Both modes embed a stable
schema digest from compiled IR so the agent can skip routine discovery. `schema+knowledge` also embeds
the bound project's business rules; pass `--context-project <project-root>` when the authored
relative project path cannot be resolved beside the IR. Dispatch fails loudly instead of treating
an unresolved project as an empty knowledge layer. `--context-project` is a trusted override: its
caller is responsible for pointing at the same project represented by the IR. The emitted
`context-report.json` records mode
and content fingerprints without copying business-rule text into report metadata.

Injection modes describe how much normalized context reaches the agent; they do not identify its
provider. Provider-specific host adapters (the current Wren MDL adapter, or future OSI/dbt adapters)
must normalize their source into the same runtime-neutral payload before dispatch. This keeps
provider parsing out of the dispatcher and avoids a mode per vendor.

**4. Run the emitted agent**

The output directory is not itself runnable Rust or JS. For the `claude-code:*` targets, it's agent
configuration for the `claude` CLI to drive (the running agent then queries data through the `wren`
CLI). `warble dispatch` writes a `RUN.md` alongside the emitted files for those targets, with the
exact invocation (typically `claude -p "<question>" --agent <name>`) — follow it rather than
guessing at flags. The `vercel` targets emit a deployable bundle instead of agent files, so there's
no `RUN.md`; running it is a matter of deploying that bundle to its serverless host.

## What gets emitted, per target

- `claude-code:headless` / `claude-code:interactive` — static `.claude/agents/*.md` files (plus
  `.mcp.json` and `mcp-steps.json` when a hybrid realization needs them). No SDK, no runtime
  process — just files a `claude` invocation reads.
- `vercel` / `vercel:headless` / `vercel:interactive` — a deployable bundle for a serverless host,
  composed from the base substrate profile plus whatever `--provider` fragments you supplied.
- `codex:local` — no static agent artifact; the standalone dispatcher prepares target-resolved
  Setup or Ask manifests/descriptions and drives isolated one-shot or persistent Codex sessions.

## When a target can't realize an arm

Every back-end is a translation table from the IR's closed enums (`realization_kind`,
`outcome.kind`, `trigger.kind`) to a runtime mechanism — never a lookup by component id. When the
IR asks for an arm a target doesn't yet realize (a `scheduled` trigger on a target with no cron, for
instance), dispatch **loud-fails**: a clear, non-zero-exit error naming the unsupported arm, not a
best-effort guess. That's a wall-hit — see [Targets & wall-hits](/concepts/targets-and-wall-hits) for
why the boundary is drawn this way, and the [CLI reference](/reference/cli) for every flag.

:::note
`--strong`, `--cheap`, `--orchestrator`, and `--models-config` also apply to `claude-code:*`
targets — they bind tiers to concrete models at dispatch time. See
[Hybrid inference](/guides/hybrid-inference) for the local+cloud case, and the
[binding spec](/reference/binding-spec) for the full format.
:::
