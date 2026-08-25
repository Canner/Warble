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

`--target` accepts `claude-code:headless` (default), `claude-code:interactive`,
`codex:interactive`, `vercel`, `vercel:headless`, or `vercel:interactive`. The Vercel family is a
separate back-end: it branches off before any Claude-Code-specific flag parsing, has its own IR
handling, and takes `--provider <path>` fragments instead of the render-flavor/model-tier knobs
below.

### Native Sessions purposes

The native interactive targets also accept an opt-in closed purpose allowlist:

```bash
warble dispatch examples/analysis-agent/ir.golden.json \
  --target claude-code:interactive --purpose analysis \
  --native-scope /server-owned/analysis-scope.json --out /server-owned/bound-project
```

`--purpose` is exactly `analysis`, `setup`, or `context_enrichment`. It is not a generic profile,
agent, prompt, environment, executable, argv, or cwd selector. Each value fixes the kind of scope
descriptor the session may carry, and nothing else — it names no profile. The caller declares the
entry point it wants in that descriptor, and Warble checks the declaration against the compiled IR
before writing anything: the named verb must match exactly one component, that component's `id`
must equal the verb, and it must be a one-shot skill with no outcome and no deterministic
enrichment apply.
Every v2 purpose also requires an immutable, server-derived `--native-scope` JSON descriptor.
`setup` accepts only a `bootstrap` descriptor without a project binding; `analysis` and
`context_enrichment` accept only `bound_project` descriptors with opaque project identity,
generation, and revision. The descriptor's canonical `cwd` must exactly equal `--out`; it is not a
caller-selected cwd. GenBI creates the descriptor and later compares the emitted binding values to
its active canonical binding before spawn. Warble only verifies and materializes it; it does not
own session lifecycle. There is deliberately no `--cwd` override, and native Sessions reject
`--context-project` rather than accepting a caller-selected project path.

For Codex native Sessions, the unchanged scope v1 contract may additionally contain a closed
server-owned `wren_runtime` chain: the installed
`wren` shim, `tool_root/bin/wren` launcher, `tool_root/bin/python` symlink, resolved Python
interpreter, and their runtime roots. Warble canonicalizes and verifies every hop, the launcher
shebang, venv metadata, executable bits, and the exact editable-source root named by the venv's
closed `.pth` file before it writes any artifact. The owned Codex config
then grants read-and-execute access only to that closure; the session workspace is the sole
writable project scope. The descriptor cannot select browser inputs, credentials, executables,
PATH, filesystem permissions, or network access, and the runtime values never enter the launch
spec or skill Markdown.

The v2 spec carries only dispatcher-authored vendor selection semantics: Claude receives the
allowlisted `--agent` argv selected for the purpose, while Codex names the allowlisted repository
skill it discovers. It does not carry prompt text, credentials, environment, session identity, or
a shell command. Existing purpose-less native enrichment dispatch remains launch-spec v1 during the
migration; consumers can continue to read it unchanged while a Sessions runtime explicitly opts
into v2. `--purpose` is rejected by every non-native target, including the Vercel target family.

```bash
# Claude Code file target; fragment must declare engine: claude-code
warble dispatch ir.json --target claude-code:headless --out agent \
  --provider providers/claude-code-genbi.yaml

# Vercel target; fragment must declare engine: vercel
warble dispatch ir.json --target vercel --out bundle \
  --provider providers/vercel-genbi.yaml
```

Claude Code file targets and Vercel both compose repeatable provider fragments. Every fragment's
`engine` must match the selected target; `codex:interactive` rejects `--provider`. A bare dispatch
with no matching provider loud-fails any component that needs an unresolved domain capability
(`sql_execution`, `genbi_build`, `scheduler`, …), naming it.

The model-level `codex:local` peer target is not a `warble dispatch --target` value. Its standalone
TypeScript dispatcher reads the same IR directly:

```bash
cd dispatcher/codex-local
node dist/cli.js manifest ../../genbi-setup/ir.golden.json \
  --server-command /absolute/path/to/setup-mcp \
  --source-tool connect_source --context-tool build_context
```

The public dispatcher commands are profile-agnostic: `dispatch`, `manifest`, and `describe` read
the IR and use `--component` when a scoped component must be selected. They derive the supported
native execution contract from that component's declared shape rather than from profile-named CLI
verbs. The one-shot path accepts the profile's single-strong-step onboarding shapes. The persistent
app-server path accepts both the canonical three-step analytical shape and the canonical two-step
dashboard shape, mapping their cheap/strong steps to named custom agents with exact per-step MCP
allowlists; a pinned read-only enrichment shape uses the same generic commands. Dashboard output
is validated against the IR render contract and surfaced as a consumer-persistable render artifact;
best-effort render degradation is explicit and never fabricates an artifact. Runtime Setup dispatch
uses an isolated,
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

The output directory is not itself runnable Rust or JS. For the `claude-code:*` targets, it holds
agent configuration for the `claude` CLI to drive (the running agent then queries data through the
`wren` CLI). `claude-code:interactive` writes native Claude artifacts plus a `RUN.md` and launch
specification; the caller starts the interactive CLI and owns its PTY, prompt, transcript, and
session lifecycle. `codex:interactive` similarly writes repo-scoped `AGENTS.md` and
the purpose-selected `.agents/skills/<name>/SKILL.md` for the native Codex TUI, plus its `RUN.md`
and launch specification; it never starts Codex or uses `codex exec`. A native Sessions v3 dispatch
also owns MCP discovery: `.mcp.json` for Claude or `.codex/config.toml` for Codex, with a
server-derived opaque credential and no consumer-side configuration rewrite. Codex's owned config
also contains only the fixed native Wren permission profile above, never a broad home, credential,
browser, or PATH grant. The launch spec keeps
the credential, session identity, project identity, generation, revision, capability set, and
artifact path out of agent payload, prompt, argv, and environment (apart from Codex's dedicated
opaque credential variable at process launch). The host binds that credential to live state when
the MCP client connects. The `vercel` targets emit a
deployable bundle instead of agent files, so there's no `RUN.md`; running it is a matter of
deploying that bundle to its serverless host.

## What gets emitted, per target

- `claude-code:headless` / `claude-code:interactive` — static `.claude/agents/*.md` files (plus
  `.mcp.json` and `mcp-steps.json` when a hybrid realization needs them). No SDK, no runtime
  process — just files a `claude` invocation reads.
- `codex:interactive` — repo-scoped `AGENTS.md`, purpose-selected
  `.agents/skills/<name>/SKILL.md`, and—when a native Sessions purpose is requested—owned
  `.codex/config.toml` with the fixed, least-privilege Wren runtime permission profile (plus
  native MCP discovery for v3) for the native Codex TUI. No runtime process is started by Warble.
- `vercel` / `vercel:headless` / `vercel:interactive` — a deployable bundle for a serverless host,
  composed from the base substrate profile plus whatever `--provider` fragments you supplied.
- `codex:local` — no static agent artifact; the standalone dispatcher prepares target-resolved
  Setup, Ask, or dashboard manifests/descriptions and drives isolated one-shot or persistent Codex
  sessions.

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
